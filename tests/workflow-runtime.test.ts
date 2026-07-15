import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { workflowRecoverCommand, workflowShowCommand } from "../src/cli/commands/workflow.js";
import {
  acquireResourceLock,
  releaseResourceLock
} from "../src/core/fs/resource-lock.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runExperimentalWorkflowRuntimeSpike } from "../src/experimental/workflow-runtime.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop } from "../src/runtime/runtime-loop.js";
import { StateApplier } from "../src/state/state-applier.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import {
  ProductionWorkflowRuntime,
  ProductionWorkflowRuntimeDisabledError,
  workflowCheckpointPath,
  workflowRunArtifactPath
} from "../src/workflow/runtime.js";
import {
  deriveWorkflowStatus,
  transitionWorkflowNode,
  type WorkflowNodeState,
  type WorkflowRunArtifact
} from "../src/workflow/types.js";
import { createTempProject } from "./test-utils.js";

const enabled = { KAIRON_WORKFLOW_RUNTIME: "1" };

describe("ProductionWorkflowRuntime", () => {
  it("waits for approval, resumes once, and does not duplicate the queued node", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root, { approvalRequired: true });
    await seedApproval(root, "APR-WF-0151");
    const runtime = new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: sequenceClock([
        "2026-07-15T00:00:00.000Z",
        "2026-07-15T00:00:01.000Z",
        "2026-07-15T00:00:02.000Z",
        "2026-07-15T00:00:03.000Z",
        "2026-07-15T00:00:04.000Z",
        "2026-07-15T00:00:05.000Z"
      ])
    });

    const waiting = await runtime.run({
      workflowId: "WF-0151-APPROVAL",
      taskId: task.task_id,
      approvalId: "APR-WF-0151",
      resourceKeys: ["src/workflow-target.ts"],
      retryMaxAttempts: 2
    });

    expect(waiting.artifact).toMatchObject({
      status: "waiting_approval",
      sequence: 1,
      nodes: [
        { id: "approval_gate", status: "waiting_approval", attempt: 0 },
        { id: `task_${task.task_id}`, status: "pending", attempt: 0 }
      ]
    });
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);
    await expect(fileExists(workflowCheckpointPath(root, "WF-0151-APPROVAL", 1))).resolves.toBe(true);

    await new ApprovalQueue(root).decide({
      approvalId: "APR-WF-0151",
      action: "approve"
    });
    const resumed = await runtime.recover("WF-0151-APPROVAL");
    const restarted = await new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: () => new Date("2026-07-15T00:01:00.000Z")
    }).recover("WF-0151-APPROVAL");
    const queue = await new WorkQueue(root).list();

    expect(resumed.artifact.status).toBe("running");
    expect(restarted.artifact.status).toBe("running");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      status: "ready",
      idempotency_key: `WF-0151-APPROVAL:task_${task.task_id}:1`,
      metadata: {
        production_workflow: {
          workflow_id: "WF-0151-APPROVAL",
          node_id: `task_${task.task_id}`,
          feature_flag: "KAIRON_WORKFLOW_RUNTIME"
        }
      }
    });
    expect(restarted.artifact.nodes[1]).toMatchObject({
      status: "dispatched",
      attempt: 1,
      queue_item_id: queue[0].id
    });
  });

  it("reconciles a completed queue node through RuntimeLoop and releases its locks", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    const runtime = new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: () => new Date("2026-07-15T08:00:00.000Z")
    });
    const started = await runtime.run({
      workflowId: "WF-0151-RUNTIME",
      taskId: task.task_id,
      resourceKeys: ["src/runtime-target.ts"]
    });
    const lockPath = started.artifact.nodes[1].resource_locks[0]?.lock_path;

    const tick = await new RuntimeLoop(root, {
      env: enabled,
      now: () => new Date("2026-07-15T08:01:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ run_id: "RUN-WF-0151", result: "ok" })
        }
      }
    }).runTick();
    const artifact = await readJsonFile<WorkflowRunArtifact>(
      workflowRunArtifactPath(root, "WF-0151-RUNTIME")
    );

    expect(tick.action).toBe("processed-item");
    expect(artifact.status).toBe("completed");
    expect(artifact.nodes[1]).toMatchObject({
      status: "completed",
      attempt: 1,
      run_id: "RUN-WF-0151"
    });
    expect(lockPath).toBeDefined();
    await expect(fileExists(path.join(root, lockPath!))).resolves.toBe(false);
    await expect(new WorkQueue(root).list()).resolves.toHaveLength(1);
  });

  it("persists a resource conflict as paused and dispatches after recovery", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    const blocker = await acquireResourceLock(root, "src/shared-target.ts", {
      owner: "other-workflow",
      now: new Date("2026-07-15T09:00:00.000Z"),
      ttlMs: 60_000
    });
    const runtime = new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: () => new Date("2026-07-15T09:00:01.000Z")
    });

    const paused = await runtime.run({
      workflowId: "WF-0151-LOCK",
      taskId: task.task_id,
      resourceKeys: ["src/shared-target.ts"]
    });
    expect(paused.artifact).toMatchObject({
      status: "paused",
      nodes: [
        { status: "skipped" },
        { status: "pending", blocker: "resource_lock_conflict" }
      ]
    });
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);

    await releaseResourceLock(blocker);
    const recovered = await new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: () => new Date("2026-07-15T09:00:02.000Z")
    }).recover("WF-0151-LOCK");

    expect(recovered.artifact.status).toBe("running");
    expect(recovered.artifact.nodes[1]).toMatchObject({
      status: "dispatched",
      attempt: 1
    });
    expect(recovered.artifact.nodes[1]).not.toHaveProperty("blocker");
    expect(recovered.artifact.nodes[1].fencing_token).toBe(
      recovered.artifact.nodes[1].resource_locks[0]?.fencing_token
    );
  });

  it("reads a legacy experimental artifact without enabling production execution", async () => {
    const root = await createInitializedProject();
    await runExperimentalWorkflowRuntimeSpike(root, {
      experimental: true,
      workflowId: "EXP-WF-LEGACY-0151",
      taskId: "TASK-LEGACY-0151",
      objective: "Legacy compatibility",
      approvalRequired: true
    });

    const shown = await new ProductionWorkflowRuntime(root, { env: {} }).show(
      "EXP-WF-LEGACY-0151"
    );
    const text = await workflowShowCommand(root, "EXP-WF-LEGACY-0151");

    expect(shown.artifact).toMatchObject({
      artifact_kind: "workflow_run",
      source: { kind: "experimental_workflow_runtime_spike" },
      status: "ready",
      sequence: 0,
      task_id: "TASK-LEGACY-0151"
    });
    expect(text).toContain("source=experimental_workflow_runtime_spike");
    await expect(fileExists(workflowRunArtifactPath(root, "EXP-WF-LEGACY-0151"))).resolves.toBe(false);
  });

  it("keeps production dispatch disabled without its feature flag", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);

    await expect(
      new ProductionWorkflowRuntime(root, { env: {} }).run({
        workflowId: "WF-0151-DISABLED",
        taskId: task.task_id
      })
    ).rejects.toThrow(ProductionWorkflowRuntimeDisabledError);
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);
    await expect(fileExists(workflowRunArtifactPath(root, "WF-0151-DISABLED"))).resolves.toBe(false);
  });

  it("previews recovery without changing the checkpoint sequence", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    await new ProductionWorkflowRuntime(root, {
      env: enabled,
      now: () => new Date("2026-07-15T10:00:00.000Z")
    }).run({ workflowId: "WF-0151-DRY-RUN", taskId: task.task_id });

    const text = await workflowRecoverCommand(
      root,
      "WF-0151-DRY-RUN",
      { dryRun: true },
      {}
    );
    const stored = await readJsonFile<WorkflowRunArtifact>(
      workflowRunArtifactPath(root, "WF-0151-DRY-RUN")
    );

    expect(text).toContain("Kairon production workflow inspected.");
    expect(stored.sequence).toBe(1);
    await expect(fileExists(workflowCheckpointPath(root, "WF-0151-DRY-RUN", 2))).resolves.toBe(false);
  });
});

describe("workflow state transitions", () => {
  it("derives running and completed state from pure node transitions", () => {
    const pending = nodeFixture();
    const dispatched = transitionWorkflowNode(pending, {
      type: "dispatch",
      at: "2026-07-15T00:00:01.000Z",
      attempt: 1,
      queueItemId: "JOB-0001",
      idempotencyKey: "WF-0001:task:1",
      fencingToken: "fence-1",
      resourceLocks: []
    });
    const completed = transitionWorkflowNode(dispatched, {
      type: "complete",
      at: "2026-07-15T00:00:02.000Z",
      outputDigest: "output"
    });

    expect(deriveWorkflowStatus([dispatched])).toBe("running");
    expect(deriveWorkflowStatus([completed])).toBe("completed");
    expect(() =>
      transitionWorkflowNode(completed, {
        type: "start",
        at: "2026-07-15T00:00:03.000Z"
      })
    ).toThrow("already terminal");
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await writeJsonFileAtomic(path.join(root, ".kairon", "config", "schedule.json"), {
    schema_version: "0.1",
    timezone: "UTC",
    active_work_time: [{ start: "00:00", end: "23:59" }],
    standby_work_time: [],
    maintenance_time: []
  });
  return root;
}

async function createTask(
  root: string,
  options: { approvalRequired?: boolean } = {}
) {
  return new TaskRunner(root, {
    now: () => new Date("2026-07-15T00:00:00.000Z")
  }).createTask({
    title: "T151 production workflow task",
    persona: "researcher",
    approvalRequired: options.approvalRequired
  });
}

async function seedApproval(root: string, approvalId: string): Promise<void> {
  await new StateApplier(root).appendEvent({
    type: "approval.requested",
    actor: "workflow-runtime-test",
    payload: {
      approval: {
        id: approvalId,
        type: "workflow_runtime",
        title: "Production workflow approval",
        actions: ["approve", "reject"]
      }
    }
  });
}

function sequenceClock(values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nodeFixture(): WorkflowNodeState {
  return {
    id: "task_TASK-0001",
    kind: "task",
    status: "pending",
    dependencies: [],
    attempt: 0,
    max_attempts: 1,
    input_digest: "input",
    task_id: "TASK-0001",
    resource_locks: [],
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}
