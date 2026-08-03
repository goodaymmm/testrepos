import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { listIncidents } from "../src/incidents/store.js";
import {
  notifyPendingDiscordWatchdogAlerts
} from "../src/discord/watchdog-notifier.js";
import {
  defaultWatchdogPolicy,
  evaluateWatchdogRules,
  watchdogFingerprint,
  type WatchdogRuleInput
} from "../src/runtime/watchdog-rules.js";
import {
  authorizeWatchdogNotificationRetry,
  getWatchdogAlert,
  listWatchdogAlerts,
  markWatchdogNotification,
  resolveWatchdogAlert,
  runWatchdogCheck,
  sanitizeWatchdogError
} from "../src/runtime/watchdog.js";
import {
  acquireRuntimeLock,
  readRuntimeLockStatus
} from "../src/runtime/runtime-lock.js";
import { RuntimeDaemon } from "../src/runtime/runtime-daemon.js";
import type { RuntimeTickResult } from "../src/runtime/runtime-loop.js";
import { createTempProject } from "./test-utils.js";

describe("runtime watchdog", () => {
  it("evaluates each operational rule with deterministic fingerprints", () => {
    const now = "2026-07-23T00:10:00.000Z";
    const input = baseInput(now);
    input.runtime = {
      locked: true,
      mode: "daemon",
      heartbeat_at: "2026-07-23T00:08:00.000Z",
      stale: true,
      daemon_status: "fatal_error",
      fatal_error_count: 1,
      last_error_code: "DAEMON_FATAL"
    };
    input.daemon_start_times = [
      "2026-07-23T00:06:00.000Z",
      "2026-07-23T00:08:00.000Z",
      "2026-07-23T00:09:00.000Z"
    ];
    input.queue.ready = 20;
    input.failed_notification_times = [
      "2026-07-23T00:06:00.000Z",
      "2026-07-23T00:08:30.000Z",
      "2026-07-23T00:09:30.000Z"
    ];
    input.providers = [
      { id: "codex", status: "suspended", reason: "manual review" }
    ];
    input.task_scheduler = { status: "missing" };

    const findings = evaluateWatchdogRules(input, defaultWatchdogPolicy);

    expect(findings.map((finding) => finding.rule)).toEqual([
      "failed_notifications",
      "fatal_runtime_error",
      "provider_suspended",
      "queue_backlog",
      "restart_loop",
      "stale_heartbeat",
      "task_scheduler_missing"
    ]);
    expect(
      findings.every(
        (finding) =>
          finding.fingerprint ===
          watchdogFingerprint(input.project_id, finding.rule, finding.resource)
      )
    ).toBe(true);
  });

  it("uses inclusive thresholds and does not misclassify future heartbeats", () => {
    const input = baseInput("2026-07-23T00:10:00.000Z");
    input.runtime = {
      locked: true,
      mode: "daemon",
      heartbeat_at: "2026-07-23T00:08:00.000Z",
      stale: false,
      fatal_error_count: 0
    };

    expect(evaluateWatchdogRules(input, defaultWatchdogPolicy)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "stale_heartbeat" })
      ])
    );

    input.runtime.heartbeat_at = "2026-07-23T00:11:00.000Z";
    expect(
      evaluateWatchdogRules(input, defaultWatchdogPolicy).find(
        (finding) => finding.rule === "stale_heartbeat"
      )
    ).toBeUndefined();
  });

  it("honors the configured suspended-provider count threshold", () => {
    const input = baseInput("2026-07-23T00:10:00.000Z");
    input.providers = [{ id: "codex", status: "suspended" }];
    const policy = structuredClone(defaultWatchdogPolicy);
    policy.rules.provider_suspended.threshold = 2;

    expect(
      evaluateWatchdogRules(input, policy).find(
        (finding) => finding.rule === "provider_suspended"
      )
    ).toBeUndefined();

    input.providers.push({ id: "claude", status: "suspended" });
    expect(
      evaluateWatchdogRules(input, policy).filter(
        (finding) => finding.rule === "provider_suspended"
      )
    ).toHaveLength(2);
  });

  it("raises stable remote endpoint, identity, drift, and tunnel findings", () => {
    const input = baseInput("2026-07-23T00:10:00.000Z");
    input.remote = {
      configured: true,
      external_unreachable: true,
      external_unreachable_count: 3,
      identity_bypass: true,
      url_drift: true,
      tunnel_disconnected: true,
      tunnel_disconnected_count: 3
    };

    expect(
      evaluateWatchdogRules(input, defaultWatchdogPolicy).map(
        (finding) => finding.rule
      )
    ).toEqual([
      "remote_external_unreachable",
      "remote_identity_bypass",
      "remote_tunnel_disconnected",
      "remote_url_drift"
    ]);
  });

  it("debounces one transient remote probe failure", () => {
    const input = baseInput("2026-07-23T00:10:00.000Z");
    input.remote = {
      configured: true,
      external_unreachable: true,
      external_unreachable_count: 1,
      identity_bypass: false,
      url_drift: false,
      tunnel_disconnected: true,
      tunnel_disconnected_count: 1
    };

    expect(evaluateWatchdogRules(input, defaultWatchdogPolicy)).toEqual([]);
  });

  it("deduplicates, cools down, resolves, and reopens one fingerprint", async () => {
    const root = await createInitializedProject();
    const first = baseInput("2026-07-23T01:00:00.000Z");
    first.queue.ready = 20;

    const created = await runWatchdogCheck(root, {
      now: new Date(first.now),
      input: first
    });
    expect(created.summary).toMatchObject({
      created: 1,
      open: 1,
      notifications_pending: 1
    });
    const alertId = created.alerts[0]?.alert_id;
    expect(alertId).toMatch(/^ALT-\d{4}$/u);

    const repeated = { ...first, now: "2026-07-23T01:00:01.000Z" };
    await runWatchdogCheck(root, {
      now: new Date(repeated.now),
      input: repeated
    });
    await markWatchdogNotification(root, alertId!, {
      event: "open",
      status: "sent",
      now: new Date("2026-07-23T01:00:02.000Z")
    });

    const insideCooldown = { ...first, now: "2026-07-23T01:10:00.000Z" };
    await runWatchdogCheck(root, {
      now: new Date(insideCooldown.now),
      input: insideCooldown
    });
    expect((await getWatchdogAlert(root, alertId!)).pending_notification).toBeUndefined();

    const afterCooldown = { ...first, now: "2026-07-23T01:15:03.000Z" };
    await runWatchdogCheck(root, {
      now: new Date(afterCooldown.now),
      input: afterCooldown
    });
    expect((await getWatchdogAlert(root, alertId!)).pending_notification?.event).toBe(
      "reminder"
    );

    const recovered = baseInput("2026-07-23T01:15:04.000Z");
    await runWatchdogCheck(root, {
      now: new Date(recovered.now),
      input: recovered
    });
    expect(await getWatchdogAlert(root, alertId!)).toMatchObject({
      status: "resolved",
      resolution_reason: "condition_recovered",
      pending_notification: { event: "resolved" }
    });

    const recurred = { ...first, now: "2026-07-23T01:15:05.000Z" };
    await runWatchdogCheck(root, {
      now: new Date(recurred.now),
      input: recurred
    });
    const alert = await getWatchdogAlert(root, alertId!);
    expect(alert).toMatchObject({
      status: "open",
      recurrence_count: 1,
      pending_notification: { event: "open" }
    });
    expect(alert.occurrence_count).toBe(5);
    expect(await listWatchdogAlerts(root)).toHaveLength(1);
    expect(await listIncidents(root)).toMatchObject([
      {
        incident_id: "INC-0001",
        fingerprint: alert.fingerprint,
        status: "open",
        resources: [
          {
            kind: "watchdog_alert",
            id: alertId,
            status: "open"
          }
        ]
      }
    ]);
  });

  it("queues one escalation during cooldown when severity increases", async () => {
    const root = await createInitializedProject();
    const input = baseInput("2026-07-23T01:30:00.000Z");
    input.queue.ready = 20;
    const initialPolicy = structuredClone(defaultWatchdogPolicy);
    const created = await runWatchdogCheck(root, {
      now: new Date(input.now),
      input,
      policy: initialPolicy
    });
    const alertId = created.alerts[0]!.alert_id;
    await markWatchdogNotification(root, alertId, {
      event: "open",
      status: "sent",
      now: new Date("2026-07-23T01:30:01.000Z")
    });

    const escalatedPolicy = structuredClone(defaultWatchdogPolicy);
    escalatedPolicy.rules.queue_backlog.severity = "critical";
    await runWatchdogCheck(root, {
      now: new Date("2026-07-23T01:30:02.000Z"),
      input: { ...input, now: "2026-07-23T01:30:02.000Z" },
      policy: escalatedPolicy
    });
    await runWatchdogCheck(root, {
      now: new Date("2026-07-23T01:30:03.000Z"),
      input: { ...input, now: "2026-07-23T01:30:03.000Z" },
      policy: escalatedPolicy
    });

    expect(await getWatchdogAlert(root, alertId)).toMatchObject({
      severity: "critical",
      pending_notification: {
        event: "escalated",
        attempts: 0
      }
    });
  });

  it("sanitizes alert evidence and operator resolution reasons", async () => {
    const root = await createInitializedProject();
    const input = baseInput("2026-07-23T02:00:00.000Z");
    input.providers = [
      {
        id: "claude",
        status: "suspended",
        reason: "token=SHOULD_NOT_LEAK auth failure"
      }
    ];
    const result = await runWatchdogCheck(root, {
      now: new Date(input.now),
      input
    });
    const alertId = result.alerts[0]!.alert_id;
    await resolveWatchdogAlert(
      root,
      alertId,
      "credential=ALSO_SHOULD_NOT_LEAK rotated",
      { now: new Date("2026-07-23T02:01:00.000Z") }
    );

    const serialized = await readFile(
      path.join(root, ".kairon", "watchdog", "alerts", `${alertId}.json`),
      "utf8"
    );
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("ALSO_SHOULD_NOT_LEAK");
    expect(serialized).toContain("[redacted]");
  });

  it("sends each pending Discord transition once and records failures safely", async () => {
    const root = await createInitializedProject();
    const input = baseInput("2026-07-23T03:00:00.000Z");
    input.queue.ready = 20;
    const result = await runWatchdogCheck(root, {
      now: new Date(input.now),
      input
    });
    const payloads: unknown[] = [];
    const channel = {
      send: async (payload: unknown) => {
        payloads.push(payload);
        return { id: "discord-message-1" };
      }
    };

    const sent = await notifyPendingDiscordWatchdogAlerts(root, channel, {
      now: () => new Date("2026-07-23T03:00:01.000Z")
    });
    const deduplicated = await notifyPendingDiscordWatchdogAlerts(root, channel, {
      now: () => new Date("2026-07-23T03:00:02.000Z")
    });

    expect(sent).toMatchObject({ sent: 1, failed: 0 });
    expect(deduplicated).toMatchObject({ sent: 0, skipped: 1 });
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads[0])).toContain(result.alerts[0]!.alert_id);
    expect(payloads[0]).toMatchObject({
      enforceNonce: true,
      nonce: expect.any(String)
    });

    const recovered = baseInput("2026-07-23T03:01:00.000Z");
    await runWatchdogCheck(root, {
      now: new Date(recovered.now),
      input: recovered
    });
    const failedPayloads: unknown[] = [];
    const failed = await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async (payload) => {
          failedPayloads.push(payload);
          throw new Error("token=SHOULD_NOT_LEAK delivery failed");
        }
      },
      { now: () => new Date("2026-07-23T03:01:01.000Z") }
    );
    expect(failed.failures[0]?.reason).not.toContain("SHOULD_NOT_LEAK");
    expect(JSON.stringify(await getWatchdogAlert(root, result.alerts[0]!.alert_id)))
      .not.toContain("SHOULD_NOT_LEAK");
    await authorizeWatchdogNotificationRetry(root, result.alerts[0]!.alert_id, {
      authorizationId: "SHR-watchdog-retry-test",
      now: new Date("2026-07-23T03:01:01.500Z")
    });
    const retryPayloads: unknown[] = [];
    const retried = await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async (payload) => {
          retryPayloads.push(payload);
          return { id: "discord-message-retry" };
        }
      },
      { now: () => new Date("2026-07-23T03:01:02.000Z") }
    );
    expect(retried).toMatchObject({ sent: 1, failed: 0 });
    expect(retryPayloads[0]).toMatchObject({
      nonce: (failedPayloads[0] as { nonce: string }).nonce,
      enforceNonce: true
    });
  });

  it("contains and sanitizes watchdog failures without failing the daemon", async () => {
    const root = await createInitializedProject();
    const now = new Date("2026-07-23T04:00:00.000Z");
    await acquireRuntimeLock(root, { mode: "daemon", now, ttlMs: 60_000 });
    const result = await new RuntimeDaemon(root, {
      now: () => now,
      maxTicks: 1,
      runTick: async () => createTick(now.toISOString()),
      watchdogCheck: async () => {
        throw new Error("password=SHOULD_NOT_LEAK watchdog fixture");
      }
    }).run();

    expect(result.stop_reason).toBe("max_ticks");
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({ locked: false });
    const events = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "daemon", "2026-07-23.jsonl")
    );
    const watchdogError = events.find((event) => event.event === "watchdog_error");
    expect(JSON.stringify(watchdogError)).toContain("password=[redacted]");
    expect(JSON.stringify(watchdogError)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("sanitizes standalone watchdog errors", () => {
    expect(
      sanitizeWatchdogError(
        "C:\\Users\\example\\project",
        new Error("Bearer abcdefghijklmnopqrstuvwxyz failed")
      ).message
    ).toBe("Bearer [redacted] failed");
  });
});

function baseInput(now: string): WatchdogRuleInput {
  return {
    project_id: "watchdog-fixture",
    now,
    runtime: {
      locked: false,
      fatal_error_count: 0
    },
    daemon_start_times: [],
    queue: { ready: 0 },
    failed_notification_times: [],
    providers: [],
    task_scheduler: { status: "registered" }
  };
}

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function createTick(createdAt: string): RuntimeTickResult {
  return {
    schema_version: "0.1",
    mode: "active_work",
    base_mode: "active_work",
    active_work_closed: false,
    action: "idle",
    worker_id: "watchdog-test",
    created_at: createdAt
  };
}
