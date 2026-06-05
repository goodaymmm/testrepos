import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { runRecovery } from "../src/cli/commands/recovery.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
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

  it("exposes recovery through the CLI command handler", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(runRecovery(root)).resolves.toContain(
      "Kairon runtime recovery completed."
    );
  });
});

async function readRecoveryArtifact(
  root: string,
  result: RuntimeRecoveryResult
): Promise<RuntimeRecoveryResult> {
  return readJsonFile(path.join(root, result.artifact_path));
}
