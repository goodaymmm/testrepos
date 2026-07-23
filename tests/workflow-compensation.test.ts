import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { StateApplier } from "../src/state/state-applier.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import {
  WorkflowCompensationManager,
  workflowCompensationPlanPath
} from "../src/workflow/compensation.js";
import type { WorkflowDefinition } from "../src/workflow/definition.js";
import {
  ProductionWorkflowRuntime,
  workflowRunArtifactPath
} from "../src/workflow/runtime.js";
import type { WorkflowRunArtifact } from "../src/workflow/types.js";
import { createTempProject } from "./test-utils.js";

describe("workflow compensation", () => {
  it("plans reverse dependency compensation and dispatches only after approval", async () => {
    const root = await createInitializedProject();
    const tasks = await createTasks(root);
    const definition = sequentialDefinition(tasks);
    const definitionPath = path.join(root, "compensation-workflow.json");
    await writeJsonFileAtomic(definitionPath, definition);
    const runtime = new ProductionWorkflowRuntime(root);
    const workQueue = new WorkQueue(root);

    await runtime.run({ definitionPath });
    let queue = await workQueue.list();
    await workQueue.complete(queue[0].id, { result: "first completed" });
    await runtime.recover(definition.workflow_id);
    queue = await workQueue.list();
    const second = queue.find(
      (item) => item.metadata?.production_workflow?.node_id === "second"
    )!;
    await workQueue.fail(second.id, { message: "partial failure" });
    const failed = await runtime.recover(definition.workflow_id);
    expect(failed.artifact.status).toBe("failed");

    const manager = new WorkflowCompensationManager(root);
    const planned = await manager.plan(definition.workflow_id);
    expect(planned.plan).toMatchObject({
      status: "planned",
      reason: "partial_failure",
      steps: [
        {
          source_node_id: "first",
          compensation_task_id: tasks.compensateFirst,
          status: "pending"
        }
      ]
    });
    expect((await workQueue.list()).filter((item) =>
      item.metadata?.workflow_compensation !== undefined
    )).toHaveLength(0);

    await seedApproval(root, "APR-T168-COMPENSATE");
    await expect(
      manager.execute({
        workflowId: definition.workflow_id,
        planId: planned.plan.plan_id,
        approvalId: "APR-T168-COMPENSATE",
        confirm: planned.plan.plan_id
      })
    ).rejects.toThrow("is not approved");
    await new ApprovalQueue(root).decide({
      approvalId: "APR-T168-COMPENSATE",
      action: "approve",
      reason: "approved compensation"
    });
    await expect(
      manager.execute({
        workflowId: definition.workflow_id,
        planId: planned.plan.plan_id,
        approvalId: "APR-T168-COMPENSATE",
        confirm: "WRONG-PLAN"
      })
    ).rejects.toThrow("exact confirmation mismatch");

    const dispatched = await manager.execute({
      workflowId: definition.workflow_id,
      planId: planned.plan.plan_id,
      approvalId: "APR-T168-COMPENSATE",
      confirm: planned.plan.plan_id
    });
    expect(dispatched.plan.status).toBe("running");
    queue = await workQueue.list();
    const compensationItem = queue.find(
      (item) =>
        item.metadata?.workflow_compensation?.plan_id === planned.plan.plan_id
    )!;
    expect(compensationItem).toMatchObject({
      task_id: tasks.compensateFirst,
      metadata: {
        workflow_compensation: {
          workflow_id: definition.workflow_id,
          approval_id: "APR-T168-COMPENSATE"
        }
      }
    });

    const restarted = await manager.execute({
      workflowId: definition.workflow_id,
      planId: planned.plan.plan_id,
      approvalId: "APR-T168-COMPENSATE",
      confirm: planned.plan.plan_id
    });
    expect(restarted.plan.steps[0].queue_item_id).toBe(compensationItem.id);
    expect(
      (await workQueue.list()).filter(
        (item) =>
          item.metadata?.workflow_compensation?.plan_id === planned.plan.plan_id
      )
    ).toHaveLength(1);

    await workQueue.complete(compensationItem.id, { result: "rolled back" });
    const completed = await manager.execute({
      workflowId: definition.workflow_id,
      planId: planned.plan.plan_id,
      approvalId: "APR-T168-COMPENSATE",
      confirm: planned.plan.plan_id
    });
    expect(completed.plan.status).toBe("completed");
    await expect(
      readJsonFile(workflowCompensationPlanPath(root, planned.plan.plan_id))
    ).resolves.toMatchObject({
      status: "completed",
      approval_id: "APR-T168-COMPENSATE"
    });
    const stored = await readJsonFile<WorkflowRunArtifact>(
      workflowRunArtifactPath(root, definition.workflow_id)
    );
    expect(stored.compensation).toMatchObject({
      plan_id: planned.plan.plan_id,
      status: "completed",
      pending_steps: 0
    });
    expect(stored.nodes.find((node) => node.id === "first")?.compensation).toMatchObject({
      status: "completed",
      plan_id: planned.plan.plan_id
    });
  });
});

function sequentialDefinition(tasks: {
  first: string;
  second: string;
  compensateFirst: string;
}): WorkflowDefinition {
  return {
    schema_version: "0.1",
    artifact_kind: "workflow_definition",
    workflow_id: "WF-T168-COMPENSATION",
    objective: "Create a partial failure for compensation.",
    entry_node_id: "first",
    input: {},
    nodes: [
      {
        id: "first",
        type: "task",
        depends_on: [],
        task_id: tasks.first,
        resource_keys: ["src/first.ts"],
        retry: { max_attempts: 1, backoff_seconds: 0 },
        compensation: {
          task_id: tasks.compensateFirst,
          resource_keys: ["src/first.ts"]
        }
      },
      {
        id: "second",
        type: "task",
        depends_on: ["first"],
        task_id: tasks.second,
        resource_keys: ["src/second.ts"],
        retry: { max_attempts: 1, backoff_seconds: 0 }
      }
    ]
  };
}

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
  const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
  (runtime.workflow as Record<string, unknown>).enabled = true;
  await writeJsonFileAtomic(runtimePath, runtime);
  return root;
}

async function createTasks(root: string) {
  const runner = new TaskRunner(root);
  const first = await runner.createTask({
    title: "First",
    persona: "researcher"
  });
  const second = await runner.createTask({
    title: "Second",
    persona: "researcher"
  });
  const compensateFirst = await runner.createTask({
    title: "Compensate first",
    persona: "implementer"
  });
  return {
    first: first.task_id,
    second: second.task_id,
    compensateFirst: compensateFirst.task_id
  };
}

async function seedApproval(root: string, approvalId: string): Promise<void> {
  await new StateApplier(root).appendEvent({
    type: "approval.requested",
    actor: "workflow-compensation-test",
    payload: {
      approval: {
        id: approvalId,
        type: "workflow_compensation",
        title: "Approve workflow compensation",
        actions: ["approve", "reject"]
      }
    }
  });
}
