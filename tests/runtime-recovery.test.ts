import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  acknowledgeRecoveryTarget,
  listRecoveryTargets,
  resolveRecoveryTarget,
  runRecovery,
  showRecoveryTarget
} from "../src/cli/commands/recovery.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { acquireResourceLock } from "../src/core/fs/resource-lock.js";
import {
  inspectRuntimeRecoveryTargets,
  runRuntimeRecovery,
  type RuntimeRecoveryResult
} from "../src/recovery/runtime-recovery.js";
import { readRuntimeLockStatus } from "../src/runtime/runtime-lock.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("runtime recovery", () => {
  it("safely requeues expired non-code-producing claimed queue items", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      payload: {
        persona: "researcher",
        code_producing: false
      }
    });
    await queue.claimById(item.id, "worker-1", {
      now: new Date("2026-06-01T00:00:00.000Z"),
      claimTtlMs: 1000
    });

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:00:02.000Z")
    });

    expect(result.summary.requeued_items).toBe(1);
    expect(result.actions).toContainEqual({
      type: "queue_item_requeued",
      item_id: item.id,
      item_type: "agent.run",
      reason: "Expired non-code-producing queue claim was safely requeued."
    });
    await expect(queue.list("ready")).resolves.toMatchObject([
      {
        id: item.id,
        status: "ready",
        result: {
          recovery: {
            code: "runtime_recovery_safe_requeue"
          }
        }
      }
    ]);
    await expect(readRecoveryArtifact(root, result)).resolves.toMatchObject({
      recovery_id: result.recovery_id,
      summary: {
        requeued_items: 1
      }
    });
  });

  it("creates recovery approvals for ambiguous expired claims without leaking payloads", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      task_id: "TASK-0001",
      payload: {
        code_producing: true,
        api_token: "SHOULD_NOT_LEAK"
      }
    });
    await queue.claimById(item.id, "worker-1", {
      now: new Date("2026-06-01T00:00:00.000Z"),
      claimTtlMs: 1000
    });

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:00:02.000Z")
    });

    expect(result.summary.approvals_requested).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
    const approvalId = result.actions.find(
      (action) => action.type === "approval_requested"
    )?.approval_id;
    expect(approvalId).toMatch(/^APR-\d{4}$/);
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", `${approvalId}.json`))
    ).resolves.toMatchObject({
      type: "runtime_recovery",
      status: "pending",
      recovery_issue: {
        kind: "claimed_timeout",
        target_id: item.id
      }
    });
    await expect(queue.list("claimed")).resolves.toMatchObject([
      {
        id: item.id,
        status: "claimed"
      }
    ]);
  });

  it("escalates partial outboxes without copying outbox body or secrets", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runDir = path.join(root, ".kairon", "runs", "RUN-0001");
    await mkdir(runDir, { recursive: true });
    await writeJsonFileAtomic(path.join(runDir, "runner.json"), {
      schema_version: "0.1",
      kind: "job",
      status: "completed",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json",
      created_at: "2026-06-01T00:00:00.000Z",
      finished_at: "2026-06-01T00:01:00.000Z"
    });
    await writeJsonFileAtomic(path.join(runDir, "outbox.json"), {
      schema_version: "0.1",
      run_id: "RUN-0001",
      api_token: "SHOULD_NOT_LEAK",
      stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR"
    });

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:02:00.000Z")
    });

    expect(result.actions).toEqual([
      expect.objectContaining({
        type: "approval_requested",
        issue: expect.objectContaining({
          kind: "partial_outbox",
          run_id: "RUN-0001",
          outbox_path: ".kairon/runs/RUN-0001/outbox.json"
        })
      })
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("FULL_STDOUT_SHOULD_NOT_APPEAR");
  });

  it("clears stale runtime locks during recovery", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runtime", "lock.json"), {
      owner: "kairon-runtime",
      pid: -1,
      created_at: "2026-06-01T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      mode: "daemon",
      heartbeat_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z"
    });

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:02:00.000Z")
    });

    expect(result.summary.stale_locks_cleared).toBe(1);
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });
  });

  it("clears expired resource-level locks during recovery", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireResourceLock(
      root,
      path.join(root, ".kairon", "approvals", "APR-LOCKED.json"),
      {
        owner: "stale-state-writer",
        now: new Date("2026-06-01T00:00:00.000Z"),
        ttlMs: 1_000
      }
    );

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:00:02.000Z")
    });

    expect(result.summary.resource_locks_cleared).toBe(1);
    expect(result.actions).toContainEqual({
      type: "stale_resource_lock_cleared",
      lock_path: expect.stringContaining(".kairon/runtime/resource-locks/"),
      resource: ".kairon/approvals/APR-LOCKED.json",
      reason: "Expired resource-level state lock was cleared."
    });
  });

  it("recovers stale Discord gateway starting artifacts without preserving secrets", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const gatewayPath = path.join(root, ".kairon", "runtime", "discord", "gateway.json");
    await writeJsonFileAtomic(gatewayPath, {
      schema_version: "0.1",
      status: "starting",
      mode: "gateway",
      bot_token: "SHOULD_NOT_LEAK",
      updated_at: "2026-06-01T00:00:00.000Z"
    });

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:10:00.000Z")
    });

    expect(result.summary.gateway_artifacts_recovered).toBe(1);
    expect(result.actions).toContainEqual({
      type: "gateway_starting_recovered",
      gateway_path: ".kairon/runtime/discord/gateway.json",
      reason: "Discord gateway artifact is stuck in starting state past the recovery threshold."
    });
    await expect(readJsonFile(gatewayPath)).resolves.toMatchObject({
      status: "stopped",
      error_code: "discord_gateway_starting_stale",
      operation: "runtime_recovery",
      bot_token: "[redacted]"
    });
  });

  it("creates approvals for stale git transaction mid-states", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"),
      {
        schema_version: "0.1",
        transaction_id: "GTX-0001",
        task_id: "TASK-0001",
        run_id: "RUN-0001",
        status: "pushing",
        updated_at: "2026-06-01T00:00:00.000Z",
        api_token: "SHOULD_NOT_LEAK"
      }
    );

    const result = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:20:00.000Z")
    });

    expect(result.summary.git_transaction_issues).toBe(1);
    expect(result.actions).toEqual([
      expect.objectContaining({
        type: "approval_requested",
        issue: expect.objectContaining({
          kind: "git_transaction_mid_state",
          target_id: "GTX-0001",
          severity: "high",
          transaction_status: "pushing"
        })
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("exposes recovery through the CLI command handler", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(runRecovery(root)).resolves.toContain(
      "Kairon runtime recovery completed."
    );
  });

  it("lists, shows, and resolves runtime recovery targets by stable fingerprint", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writePartialOutboxFixture(root);

    await expect(listRecoveryTargets(root)).resolves.toContain("target_id=RUN-0001");
    await expect(showRecoveryTarget(root, "RUN-0001")).resolves.toContain(
      "kind=partial_outbox"
    );
    await expect(showRecoveryTarget(root, "RUN-0001")).resolves.not.toContain(
      "SHOULD_NOT_LEAK"
    );

    const resolved = await resolveRecoveryTarget(root, "RUN-0001", {
      reason: "manual outbox cleanup verified"
    });
    expect(resolved).toContain("Kairon recovery target resolved.");
    expect(resolved).toContain(
      "fingerprint=partial_outbox:run:RUN-0001"
    );
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "recovery",
          "resolutions",
          "partial_outbox-run-RUN-0001.json"
        )
      )
    ).resolves.toMatchObject({
      action: "resolved",
      reason: "manual outbox cleanup verified",
      fingerprint: "partial_outbox:run:RUN-0001",
      issue: {
        kind: "partial_outbox",
        target_id: "RUN-0001"
      }
    });

    const inspection = await inspectRuntimeRecoveryTargets(root);
    expect(inspection.summary).toMatchObject({
      targets: 0,
      run_issues: 0,
      resolved_targets: 1
    });
    await expect(listRecoveryTargets(root)).resolves.toBe(
      "No Kairon recovery targets found."
    );

    const recovery = await runRuntimeRecovery(root, {
      now: new Date("2026-06-01T00:02:00.000Z")
    });
    expect(recovery.summary.approvals_requested).toBe(0);
  });

  it("acknowledges runtime recovery targets without leaking transaction secrets", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"),
      {
        schema_version: "0.1",
        transaction_id: "GTX-0001",
        task_id: "TASK-0001",
        run_id: "RUN-0001",
        status: "pushing",
        updated_at: "2026-06-01T00:00:00.000Z",
        api_token: "SHOULD_NOT_LEAK"
      }
    );

    const acknowledged = await acknowledgeRecoveryTarget(root, "GTX-0001", {
      reason: "operator will recover git transaction manually"
    });

    expect(acknowledged).toContain("Kairon recovery target acknowledged.");
    expect(acknowledged).toContain(
      "fingerprint=git_transaction_mid_state:git_transaction:GTX-0001"
    );
    const inspection = await inspectRuntimeRecoveryTargets(root, {
      now: new Date("2026-06-01T00:20:00.000Z")
    });
    expect(inspection.summary.targets).toBe(1);
    expect(inspection.summary.resolved_targets).toBe(0);
    expect(inspection.issues[0]?.fingerprint).toBe(
      "git_transaction_mid_state:git_transaction:GTX-0001"
    );
    const serializedResolution = JSON.stringify(
      await readJsonFile(
        path.join(
          root,
          ".kairon",
          "recovery",
          "resolutions",
          "git_transaction_mid_state-git_transaction-GTX-0001.json"
        )
      )
    );
    expect(serializedResolution).not.toContain("SHOULD_NOT_LEAK");
  });

  it("requires a reason before resolving runtime recovery targets", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writePartialOutboxFixture(root);

    await expect(resolveRecoveryTarget(root, "RUN-0001", { reason: " " })).rejects.toThrow(
      "Runtime recovery resolution reason is required."
    );
  });
});

async function readRecoveryArtifact(
  root: string,
  result: RuntimeRecoveryResult
): Promise<RuntimeRecoveryResult> {
  return readJsonFile(path.join(root, result.artifact_path));
}

async function writePartialOutboxFixture(root: string): Promise<void> {
  const runDir = path.join(root, ".kairon", "runs", "RUN-0001");
  await mkdir(runDir, { recursive: true });
  await writeJsonFileAtomic(path.join(runDir, "runner.json"), {
    schema_version: "0.1",
    kind: "job",
    status: "completed",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    outbox_path: ".kairon/runs/RUN-0001/outbox.json",
    created_at: "2026-06-01T00:00:00.000Z",
    finished_at: "2026-06-01T00:01:00.000Z"
  });
  await writeJsonFileAtomic(path.join(runDir, "outbox.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    api_token: "SHOULD_NOT_LEAK",
    stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR"
  });
}
