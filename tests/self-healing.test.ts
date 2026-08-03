import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { createBoardProjection } from "../src/board/projection.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../src/core/fs/json-file.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
import {
  readIncidentTimeline
} from "../src/incidents/store.js";
import { notifyPendingDiscordWatchdogAlerts } from "../src/discord/watchdog-notifier.js";
import {
  executeSelfHealingRunbook,
  inspectSelfHealingRunbook,
  planSelfHealingRunbook,
  readSelfHealingRun,
  runBoundedSelfHealingTick,
  type SelfHealingDependencies,
  type SelfHealingInspection
} from "../src/recovery/runbook.js";
import {
  getWatchdogAlert,
  runWatchdogCheck
} from "../src/runtime/watchdog.js";
import type { WatchdogRuleInput } from "../src/runtime/watchdog-rules.js";
import { createTempProject } from "./test-utils.js";

describe("bounded self-healing", () => {
  it("validates bounded action budgets and rejects unknown action keys", async () => {
    const root = await createProject();
    const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    expect(validateConfigFile("runtime.json", runtime)).toMatchObject({
      ok: true
    });
    const selfHealing = runtime.self_healing as {
      actions: Record<string, Record<string, unknown>>;
    };
    selfHealing.actions.discord_notification_retry.max_attempts = 0;
    selfHealing.actions.arbitrary_shell = {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 0,
      time_budget_seconds: 1
    };
    expect(validateConfigFile("runtime.json", runtime)).toMatchObject({
      ok: false
    });
  });

  it("defaults to notify_only and rejects unknown or unconfirmed actions", async () => {
    const root = await createProject();
    const dependencies = eligibleDependencies();

    await expect(
      inspectSelfHealingRunbook(root, "arbitrary_shell")
    ).rejects.toThrow("Unknown self-healing runbook");

    const planned = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T00:00:00.000Z") },
      dependencies
    );
    expect(planned).toMatchObject({
      status: "planned",
      mode: "notify_only",
      dry_run: true,
      attempts: []
    });
    await expect(
      executeSelfHealingRunbook(
        root,
        planned.run_id,
        { confirm: "SHR-00000000000000000000" },
        dependencies
      )
    ).rejects.toThrow("must exactly match");

    const suspended = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T00:01:00.000Z")
      },
      dependencies
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      suspension_reason: "notify_only",
      attempts: []
    });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("executes one allowlisted action and records the incident timeline and Board state", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    const dependencies = eligibleDependencies();
    const planned = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T01:00:00.000Z") },
      dependencies
    );

    const completed = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T01:00:01.000Z")
      },
      dependencies
    );
    expect(completed).toMatchObject({
      status: "completed",
      dry_run: false,
      postcondition: {
        status: "passed",
        reason: "verified"
      }
    });
    expect(completed.attempts).toHaveLength(1);
    expect(dependencies.execute).toHaveBeenCalledTimes(1);

    const timeline = await readIncidentTimeline(root, completed.incident_id);
    expect(timeline.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        "self_healing.planned",
        "self_healing.running",
        "self_healing.completed"
      ])
    );
    const board = await createBoardProjection(root);
    expect(board.incidents.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          incident_id: completed.incident_id,
          active_resources: 0
        })
      ])
    );
  });

  it("suspends execution when the precondition digest drifts", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    let digest = "digest-before";
    const execute = vi.fn();
    const dependencies: SelfHealingDependencies = {
      inspect: vi.fn(async () => fixtureInspection({ digest })),
      execute
    };
    const planned = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T02:00:00.000Z") },
      dependencies
    );
    digest = "digest-after";

    const suspended = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T02:01:00.000Z")
      },
      dependencies
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      suspension_reason: "precondition_drift"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires operator approval after the per-incident attempt budget", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    let digest = "digest-first";
    const dependencies: SelfHealingDependencies = {
      inspect: vi.fn(async () => fixtureInspection({ digest })),
      execute: vi.fn(async () => ({
        success: true,
        reason: "verified",
        after_digest: "digest-completed"
      }))
    };
    const first = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T03:00:00.000Z") },
      dependencies
    );
    await executeSelfHealingRunbook(
      root,
      first.run_id,
      {
        confirm: first.run_id,
        now: new Date("2026-07-26T03:00:01.000Z")
      },
      dependencies
    );

    digest = "digest-second";
    const second = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-27T03:01:00.000Z") },
      dependencies
    );
    expect(second).toMatchObject({
      status: "suspended",
      approval_required: true,
      suspension_reason: "attempt_budget_exceeded",
      approval_id: expect.any(String)
    });
    await expect(
      new ApprovalQueue(root).show(second.approval_id!)
    ).resolves.toMatchObject({
      status: "pending",
      type: "self_healing",
      self_healing_run_id: second.run_id
    });
  });

  it("enforces cooldown and creates an approval before retrying the same failed run", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    const selfHealing = runtime.self_healing as {
      actions: Record<
        string,
        {
          max_attempts: number;
          cooldown_seconds: number;
        }
      >;
    };
    selfHealing.actions.workflow_checkpoint_index_rebuild.max_attempts = 2;
    selfHealing.actions.workflow_checkpoint_index_rebuild.cooldown_seconds = 60;
    await writeJsonFileAtomic(runtimePath, runtime);
    const dependencies: SelfHealingDependencies = {
      inspect: vi.fn(async () => fixtureInspection()),
      execute: vi.fn(async () => ({
        success: false,
        reason: "verification_failed",
        after_digest: "digest-after-failure"
      }))
    };
    const planned = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T03:30:00.000Z") },
      dependencies
    );
    const failed = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T03:30:01.000Z")
      },
      dependencies
    );
    expect(failed.status).toBe("failed");

    const coolingDown = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T03:30:30.000Z")
      },
      dependencies
    );
    expect(coolingDown).toMatchObject({
      status: "suspended",
      approval_required: false,
      suspension_reason: "cooldown_active"
    });
    expect(dependencies.execute).toHaveBeenCalledTimes(1);

    const secondFailure = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T03:31:02.000Z")
      },
      dependencies
    );
    expect(secondFailure.status).toBe("failed");
    expect(dependencies.execute).toHaveBeenCalledTimes(2);

    const suspended = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T03:31:10.000Z")
      },
      dependencies
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      approval_required: true,
      suspension_reason: "attempt_budget_exceeded",
      approval_id: expect.any(String)
    });
    await expect(
      new ApprovalQueue(root).show(suspended.approval_id!)
    ).resolves.toMatchObject({
      status: "pending",
      type: "self_healing",
      self_healing_run_id: planned.run_id
    });
  });

  it("does not execute a run that was left running across a restart", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    const dependencies = eligibleDependencies();
    const planned = await planSelfHealingRunbook(
      root,
      "workflow_checkpoint_index_rebuild",
      { now: new Date("2026-07-26T04:00:00.000Z") },
      dependencies
    );
    await writeJsonFileAtomic(
      path.join(
        root,
        ".kairon",
        "recovery",
        "self-healing",
        `${planned.run_id}.json`
      ),
      {
        ...planned,
        status: "running",
        dry_run: false,
        attempts: [
          {
            attempt: 1,
            status: "running",
            started_at: "2026-07-26T04:00:01.000Z",
            before_digest: planned.before_digest
          }
        ]
      }
    );

    const suspended = await executeSelfHealingRunbook(
      root,
      planned.run_id,
      {
        confirm: planned.run_id,
        now: new Date("2026-07-26T04:05:00.000Z")
      },
      dependencies
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      suspension_reason: "interrupted_run",
      approval_required: true
    });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("runs at most one action per bounded_auto tick", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    const dependencies = eligibleDependencies();

    const result = await runBoundedSelfHealingTick(
      root,
      { now: new Date("2026-07-26T05:00:00.000Z") },
      dependencies
    );
    expect(result).toMatchObject({
      status: "completed",
      runbook_id: "workflow_checkpoint_index_rebuild"
    });
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
    await expect(readSelfHealingRun(root, result.run_id!)).resolves.toMatchObject({
      status: "completed"
    });
  });

  it("authorizes exactly one Discord retry and stops after the second failure", async () => {
    const root = await createProject();
    await enableBoundedAuto(root);
    const now = new Date("2026-07-26T06:00:00.000Z");
    const watchdog = await runWatchdogCheck(root, {
      now,
      input: watchdogInput(now.toISOString())
    });
    const alertId = watchdog.alerts[0]!.alert_id;
    await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async () => {
          throw new Error("first delivery failed");
        }
      },
      { now: () => new Date("2026-07-26T06:00:01.000Z") }
    );

    const planned = await planSelfHealingRunbook(
      root,
      "discord_notification_retry",
      {
        targetId: alertId,
        now: new Date("2026-07-26T06:00:02.000Z")
      }
    );
    const completed = await executeSelfHealingRunbook(root, planned.run_id, {
      confirm: planned.run_id,
      now: new Date("2026-07-26T06:00:03.000Z")
    });
    expect(completed.status).toBe("completed");
    await expect(getWatchdogAlert(root, alertId)).resolves.toMatchObject({
      pending_notification: {
        attempts: 1,
        retry_authorization_id: planned.run_id
      }
    });

    await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async () => {
          throw new Error("second delivery failed");
        }
      },
      { now: () => new Date("2026-07-26T06:00:04.000Z") }
    );
    const payloads: unknown[] = [];
    const stopped = await notifyPendingDiscordWatchdogAlerts(
      root,
      {
        send: async (payload) => {
          payloads.push(payload);
          return { id: "must-not-send" };
        }
      },
      { now: () => new Date("2026-07-26T06:00:05.000Z") }
    );
    expect(stopped).toMatchObject({ sent: 0, skipped: 1 });
    expect(payloads).toHaveLength(0);
    const exhausted = await getWatchdogAlert(root, alertId);
    expect(exhausted.pending_notification).toMatchObject({ attempts: 2 });
    expect(exhausted.pending_notification).not.toHaveProperty(
      "retry_authorized_at"
    );
    expect(exhausted.pending_notification).not.toHaveProperty(
      "retry_authorization_id"
    );
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function enableBoundedAuto(root: string): Promise<void> {
  const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
  const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
  const selfHealing = runtime.self_healing as {
    mode: string;
  };
  selfHealing.mode = "bounded_auto";
  await writeJsonFileAtomic(runtimePath, runtime);
}

function eligibleDependencies(): SelfHealingDependencies & {
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(async () => fixtureInspection()),
    execute: vi.fn(async () => ({
      success: true,
      reason: "verified",
      after_digest: "digest-after"
    }))
  };
}

function fixtureInspection(
  options: { digest?: string } = {}
): SelfHealingInspection {
  const digest = options.digest ?? "digest-before";
  return {
    runbook_id: "workflow_checkpoint_index_rebuild",
    status: "eligible",
    reason: "derived_index_mismatch",
    target_id: "workflow-checkpoint-sqlite",
    incident_fingerprint: "self-healing:test-checkpoint",
    severity: "warning",
    title: "Checkpoint recovery",
    summary: "Derived checkpoint mirror requires repair.",
    source_digest: digest,
    before_digest: digest,
    details: {
      status: "mismatch",
      canonical_errors: 0
    }
  };
}

function watchdogInput(now: string): WatchdogRuleInput {
  return {
    project_id: "self-healing-test",
    now,
    runtime: {
      locked: false,
      fatal_error_count: 0
    },
    daemon_start_times: [],
    queue: { ready: 20 },
    failed_notification_times: [],
    providers: [],
    task_scheduler: { status: "registered" }
  };
}
