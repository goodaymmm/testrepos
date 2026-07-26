import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  evaluateAlertPolicy,
  prepareAlertPolicy,
  type AlertPolicy
} from "../src/notifications/alert-policy.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { notifyPendingDiscordWatchdogAlerts } from "../src/discord/watchdog-notifier.js";
import { listIncidents, readIncidentTimeline } from "../src/incidents/store.js";
import {
  getWatchdogAlert,
  runWatchdogCheck,
  type WatchdogAlert,
  type WatchdogPendingNotification
} from "../src/runtime/watchdog.js";
import type { WatchdogRuleInput } from "../src/runtime/watchdog-rules.js";
import { createTempProject } from "./test-utils.js";

describe("alert policy", () => {
  it("diagnoses invalid timezone, duplicate routes, zero budget, and maintenance conflicts", () => {
    const prepared = prepareAlertPolicy({
      timezone: "Not/A-Timezone",
      routes: [
        {
          id: "duplicate",
          provider: "discord",
          minimum_severity: "warning"
        },
        {
          id: "duplicate",
          provider: "discord",
          minimum_severity: "warning"
        }
      ],
      daily_budget: 0,
      maintenance_windows: [
        { start: "23:00", end: "02:00" },
        { start: "01:00", end: "03:00" }
      ]
    });

    expect(prepared.policy.timezone).toBe("UTC");
    expect(prepared.issues).toEqual([
      "invalid_timezone",
      "duplicate_route",
      "daily_budget_zero",
      "maintenance_window_conflict"
    ]);
  });

  it("defers overnight quiet hours but bypasses them for first critical and resolved transitions", () => {
    const policy = policyFixture({
      quiet_hours: [{ start: "22:00", end: "07:00" }]
    });
    const now = new Date("2026-07-24T23:30:00.000Z");
    const warning = alertFixture("warning");
    const open = pendingFixture("open");

    expect(
      evaluateAlertPolicy(policy, warning, open, { now, sent_today: 0 })
    ).toEqual({
      decision: "defer",
      reason: "quiet_hours",
      route_id: "watchdog-discord",
      defer_until: "2026-07-25T07:00:00.000Z"
    });
    expect(
      evaluateAlertPolicy(
        policy,
        alertFixture("critical"),
        pendingFixture("escalated"),
        { now, sent_today: 100 }
      )
    ).toMatchObject({ decision: "send", reason: "none" });
    expect(
      evaluateAlertPolicy(
        policy,
        alertFixture("info", "resolved"),
        pendingFixture("resolved"),
        { now, sent_today: 100 }
      )
    ).toMatchObject({ decision: "send", reason: "none" });
  });

  it("separates reminder, budget, and minimum severity decisions", () => {
    const policy = policyFixture({
      reminder_interval_seconds: 3_600,
      daily_budget: 1
    });
    const alert = {
      ...alertFixture("warning"),
      last_notified_at: "2026-07-24T10:00:00.000Z"
    };

    expect(
      evaluateAlertPolicy(policy, alert, pendingFixture("reminder"), {
        now: new Date("2026-07-24T10:30:00.000Z"),
        sent_today: 0
      })
    ).toMatchObject({
      decision: "defer",
      reason: "reminder_interval",
      defer_until: "2026-07-24T11:00:00.000Z"
    });
    expect(
      evaluateAlertPolicy(policy, alertFixture("warning"), pendingFixture("open"), {
        now: new Date("2026-07-24T11:00:00.000Z"),
        sent_today: 1
      })
    ).toMatchObject({ decision: "aggregate", reason: "daily_budget" });
    expect(
      evaluateAlertPolicy(policy, alertFixture("info"), pendingFixture("open"), {
        now: new Date("2026-07-24T11:00:00.000Z"),
        sent_today: 0
      })
    ).toMatchObject({
      decision: "suppress",
      reason: "below_minimum_severity"
    });
  });

  it("defers during maintenance and sends one aggregate summary after the window", async () => {
    const root = await createInitializedProject();
    await configurePolicy(root, {
      timezone: "UTC",
      maintenance_windows: [{ start: "00:00", end: "01:00" }],
      daily_budget: 50
    });
    const input = baseInput("2026-07-24T00:10:00.000Z");
    input.queue.ready = 20;
    input.providers = [{ id: "codex", status: "suspended" }];
    input.task_scheduler = { status: "missing" };
    const checked = await runWatchdogCheck(root, {
      input,
      now: new Date(input.now)
    });
    expect(checked.alerts).toHaveLength(3);
    const payloads: Record<string, unknown>[] = [];
    const channel = {
      send: async (payload: Record<string, unknown>) => {
        payloads.push(payload);
        return { id: `message-${payloads.length}` };
      }
    };

    const deferred = await notifyPendingDiscordWatchdogAlerts(root, channel, {
      now: () => new Date("2026-07-24T00:11:00.000Z")
    });
    expect(deferred).toMatchObject({ sent: 0, deferred: 3 });
    expect(payloads).toHaveLength(0);

    const released = await notifyPendingDiscordWatchdogAlerts(root, channel, {
      now: () => new Date("2026-07-24T01:01:00.000Z")
    });
    expect(released).toMatchObject({ sent: 1, aggregated: 3, failed: 0 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ enforceNonce: true });
    expect(String(payloads[0]?.content)).toContain("maintenance summary");
    for (const alert of checked.alerts) {
      expect((await getWatchdogAlert(root, alert.alert_id)).pending_notification)
        .toBeUndefined();
    }

    const incidents = await listIncidents(root);
    expect(incidents).toHaveLength(3);
    const timeline = await readIncidentTimeline(root, incidents[0]!.incident_id);
    expect(timeline.some((event) => event.event === "notification.policy")).toBe(true);
    const metrics = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "metrics", "raw", "2026-07-24.jsonl")
    );
    expect(
      metrics.some(
        (metric) => metric.metric === "notification_policy_decision_total"
      )
    ).toBe(true);
  });

  it("sends one individual message and one aggregate when the daily budget is reached", async () => {
    const root = await createInitializedProject();
    await configurePolicy(root, {
      timezone: "UTC",
      maintenance_windows: [],
      daily_budget: 1
    });
    const input = baseInput("2026-07-24T12:00:00.000Z");
    input.queue.ready = 20;
    input.providers = [{ id: "codex", status: "suspended" }];
    input.task_scheduler = { status: "missing" };
    await runWatchdogCheck(root, {
      input,
      now: new Date(input.now)
    });
    const payloads: Record<string, unknown>[] = [];

    const result = await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async (payload: Record<string, unknown>) => {
          payloads.push(payload);
          return { id: `budget-message-${payloads.length}` };
        }
      },
      { now: () => new Date("2026-07-24T12:00:01.000Z") }
    );

    expect(result).toMatchObject({
      sent: 2,
      aggregated: 2,
      failed: 0
    });
    expect(payloads).toHaveLength(2);
    expect(String(payloads[1]?.content)).toContain("budget summary");
  });
});

function policyFixture(overrides: Partial<AlertPolicy> = {}): AlertPolicy {
  return {
    enabled: true,
    timezone: "UTC",
    routes: [
      {
        id: "watchdog-discord",
        provider: "discord",
        minimum_severity: "warning"
      }
    ],
    quiet_hours: [],
    maintenance_windows: [],
    reminder_interval_seconds: 3_600,
    daily_budget: 50,
    ...overrides
  };
}

function alertFixture(
  severity: WatchdogAlert["severity"],
  status: WatchdogAlert["status"] = "open"
): WatchdogAlert {
  return {
    schema_version: "0.1",
    alert_id: "ALT-0001",
    project_id: "fixture",
    fingerprint: "fixture:queue",
    rule: "queue_backlog",
    resource: "queue:ready",
    severity,
    status,
    title: "Fixture",
    summary: "Fixture summary",
    evidence: {},
    cooldown_seconds: 900,
    occurrence_count: 1,
    recurrence_count: 0,
    first_detected_at: "2026-07-24T00:00:00.000Z",
    last_detected_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z"
  };
}

function pendingFixture(
  event: WatchdogPendingNotification["event"]
): WatchdogPendingNotification {
  return {
    event,
    queued_at: "2026-07-24T00:00:00.000Z",
    attempts: 0,
    idempotency_key: `fixture:${event}`
  };
}

function baseInput(now: string): WatchdogRuleInput {
  return {
    project_id: "alert-policy-fixture",
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

async function configurePolicy(
  root: string,
  overrides: Record<string, unknown>
): Promise<void> {
  const configPath = path.join(root, ".kairon", "config", "notifications.json");
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  const current = config.alert_policy as Record<string, unknown>;
  await writeJsonFileAtomic(configPath, {
    ...config,
    alert_policy: {
      ...current,
      ...overrides
    }
  });
}
