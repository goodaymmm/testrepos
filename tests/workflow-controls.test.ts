import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop } from "../src/runtime/runtime-loop.js";
import { StateApplier } from "../src/state/state-applier.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import {
  WorkflowControls,
  workflowCompensationPath
} from "../src/workflow/controls.js";
import {
  ProductionWorkflowRuntime,
  workflowRunArtifactPath
} from "../src/workflow/runtime.js";
import type { WorkflowRunArtifact } from "../src/workflow/types.js";
import { createTempProject } from "./test-utils.js";

const enabled = { KAIRON_WORKFLOW_RUNTIME: "1" };

describe("WorkflowControls", () => {
  it("pauses and resumes dispatch without duplicating the queued node", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    const runtime = new ProductionWorkflowRuntime(root, { env: enabled });
    const started = await runtime.run({
      workflowId: "WF-0152-PAUSE",
      taskId: task.task_id
    });
    const controls = new WorkflowControls(root, { env: enabled });

    const paused = await controls.pause("WF-0152-PAUSE", "operator maintenance");
    const restarted = await new ProductionWorkflowRuntime(root, {
      env: enabled
    }).recover("WF-0152-PAUSE");
    const resumed = await controls.resume("WF-0152-PAUSE");
    const queue = await new WorkQueue(root).list();

    expect(started.artifact.status).toBe("running");
    expect(paused.artifact).toMatchObject({
      status: "paused",
      control: { mode: "paused", last_event_action: "pause" }
    });
    expect(restarted.artifact).toMatchObject({
      status: "paused",
      control: { mode: "paused" }
    });
    expect(resumed.artifact).toMatchObject({
      status: "running",
      control: { mode: "active", last_event_action: "resume" }
    });
    expect(queue).toHaveLength(1);
    await expect(controls.events("WF-0152-PAUSE")).resolves.toMatchObject([
      { sequence: 1, action: "pause", status_after: "paused" },
      { sequence: 2, action: "resume" }
    ]);
  });

  it("requires approval for cancel, releases locks, and writes compensation", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root, true);
    await seedApprovedApproval(root, "APR-WF-0152-CANCEL");
    const runtime = new ProductionWorkflowRuntime(root, { env: enabled });
    const started = await runtime.run({
      workflowId: "WF-0152-CANCEL",
      taskId: task.task_id,
      approvalId: "APR-WF-0152-CANCEL",
      resourceKeys: ["src/cancel-target.ts"]
    });
    const lockPath = started.artifact.nodes[1].resource_locks[0]!.lock_path;
    const controls = new WorkflowControls(root, { env: enabled });

    const cancelled = await controls.cancel("WF-0152-CANCEL", {
      reason: "approved operator cancellation"
    });

    expect(cancelled.artifact.status).toBe("cancelled");
    expect(cancelled.event).toMatchObject({
      action: "cancel",
      approval_id: "APR-WF-0152-CANCEL"
    });
    expect(cancelled.compensation_path).toBe(
      ".kairon/workflows/compensations/WF-0152-CANCEL-000001.json"
    );
    await expect(fileExists(path.join(root, lockPath))).resolves.toBe(false);
    await expect(
      readJsonFile(workflowCompensationPath(root, "WF-0152-CANCEL", 1))
    ).resolves.toMatchObject({
      kind: "workflow_compensation_plan",
      approval_id: "APR-WF-0152-CANCEL",
      released_resource_locks: [{ resource: "src/cancel-target.ts" }]
    });
  });

  it("observes cooperative cancellation after a running handler returns", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root, true);
    await seedApprovedApproval(root, "APR-WF-0152-RUNNING");
    const runtime = new ProductionWorkflowRuntime(root, { env: enabled });
    await runtime.run({
      workflowId: "WF-0152-RUNNING",
      taskId: task.task_id,
      approvalId: "APR-WF-0152-RUNNING"
    });
    const item = (await new WorkQueue(root).list())[0]!;
    let cancellationObserved = false;

    const result = await runtime.executeQueueItem(item, async (context) => {
      await new WorkflowControls(root, { env: enabled }).cancel(
        "WF-0152-RUNNING",
        { reason: "stop after current boundary" }
      );
      cancellationObserved = await context!.isCancellationRequested();
      return { result: "handler finished" };
    });
    const artifact = await readJsonFile<WorkflowRunArtifact>(
      workflowRunArtifactPath(root, "WF-0152-RUNNING")
    );

    expect(cancellationObserved).toBe(true);
    expect(result).toMatchObject({
      status: "cancelled",
      cooperative_cancellation: true
    });
    expect(artifact).toMatchObject({
      status: "cancelled",
      control: { mode: "cancelled" },
      nodes: [{ status: "completed" }, { status: "cancelled" }]
    });
  });

  it("retries only a failed node with a new idempotency key", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    const runtime = new ProductionWorkflowRuntime(root, { env: enabled });
    await runtime.run({ workflowId: "WF-0152-RETRY", taskId: task.task_id });
    await new RuntimeLoop(root, {
      env: enabled,
      handlers: {
        items: {
          "agent.run": async () => {
            throw new Error("expected test failure");
          }
        }
      }
    }).runTick();
    const failed = await runtime.show("WF-0152-RETRY");
    const failedNode = failed.artifact.nodes[1];

    const retried = await new WorkflowControls(root, { env: enabled }).retry(
      "WF-0152-RETRY",
      { nodeId: failedNode.id, reason: "operator retry" }
    );
    const queue = await new WorkQueue(root).list();

    expect(failedNode.status).toBe("failed");
    expect(retried.artifact.nodes[1]).toMatchObject({
      status: "dispatched",
      attempt: 2,
      max_attempts: 3,
      idempotency_key: `WF-0152-RETRY:${failedNode.id}:2`
    });
    expect(queue.map((item) => item.idempotency_key)).toEqual([
      `WF-0152-RETRY:${failedNode.id}:1`,
      `WF-0152-RETRY:${failedNode.id}:2`
    ]);
  });

  it("rejects completed-node retry and serializes concurrent controls", async () => {
    const root = await createInitializedProject();
    const task = await createTask(root);
    const runtime = new ProductionWorkflowRuntime(root, { env: enabled });
    await runtime.run({ workflowId: "WF-0152-COMPLETE", taskId: task.task_id });
    await new RuntimeLoop(root, {
      env: enabled,
      handlers: { items: { "agent.run": async () => ({ result: "ok" }) } }
    }).runTick();
    const completed = await runtime.show("WF-0152-COMPLETE");
    const controls = new WorkflowControls(root, { env: enabled });

    await expect(
      controls.retry("WF-0152-COMPLETE", {
        nodeId: completed.artifact.nodes[1].id
      })
    ).rejects.toThrow("requires a failed node");

    const task2 = await createTask(root);
    await runtime.run({ workflowId: "WF-0152-RACE", taskId: task2.task_id });
    const outcomes = await Promise.allSettled([
      controls.pause("WF-0152-RACE", "first operator"),
      controls.pause("WF-0152-RACE", "second operator")
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
  const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
  const workflow = runtime.workflow as Record<string, unknown>;
  workflow.enabled = true;
  await writeJsonFileAtomic(runtimePath, runtime);
  await writeJsonFileAtomic(path.join(root, ".kairon", "config", "schedule.json"), {
    schema_version: "0.1",
    timezone: "UTC",
    active_work_time: [{ start: "00:00", end: "23:59" }],
    standby_work_time: [],
    maintenance_time: []
  });
  return root;
}

async function createTask(root: string, approvalRequired = false) {
  return new TaskRunner(root).createTask({
    title: "T152 workflow control task",
    persona: "researcher",
    approvalRequired
  });
}

async function seedApprovedApproval(root: string, approvalId: string): Promise<void> {
  await new StateApplier(root).appendEvent({
    type: "approval.requested",
    actor: "workflow-controls-test",
    payload: {
      approval: {
        id: approvalId,
        type: "workflow_control",
        title: "Approve workflow control",
        actions: ["approve", "reject"]
      }
    }
  });
  await new ApprovalQueue(root).decide({
    approvalId,
    action: "approve",
    reason: "approved for test"
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
