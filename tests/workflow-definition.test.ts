import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  workflowValidateCommand
} from "../src/cli/commands/workflow.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import { StateApplier } from "../src/state/state-applier.js";
import {
  evaluateWorkflowCondition,
  WorkflowConditionEvaluationError
} from "../src/workflow/conditions.js";
import {
  validateWorkflowDefinition,
  workflowDefinitionArtifactPath,
  type WorkflowDefinition
} from "../src/workflow/definition.js";
import {
  ProductionWorkflowRuntime,
  workflowRunArtifactPath
} from "../src/workflow/runtime.js";
import type { WorkflowRunArtifact } from "../src/workflow/types.js";
import { createTempProject } from "./test-utils.js";

describe("workflow definitions", () => {
  it("validates typed branch, condition, join, and compensation nodes", () => {
    const result = validateWorkflowDefinition(definitionFixture());

    expect(result.valid).toBe(true);
    expect(result.definition?.nodes).toHaveLength(6);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects cycles, unreachable nodes, invalid joins, and arbitrary code fields", () => {
    const cycle = definitionFixture();
    cycle.nodes[0].depends_on = ["join_all"];
    const cycleResult = validateWorkflowDefinition(cycle);
    expect(cycleResult.valid).toBe(false);
    expect(cycleResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "cycle"
    );

    const invalidJoin = definitionFixture();
    const join = invalidJoin.nodes.find((node) => node.type === "join")!;
    if (join.type === "join") {
      join.policy = "threshold";
      join.threshold = 3;
    }
    const joinResult = validateWorkflowDefinition(invalidJoin);
    expect(joinResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "invalid_join"
    );

    const arbitraryCode = structuredClone(definitionFixture()) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    arbitraryCode.nodes[0].script = "process.exit(0)";
    const codeResult = validateWorkflowDefinition(arbitraryCode);
    expect(codeResult.valid).toBe(false);
    expect(codeResult.diagnostics[0].code).toBe("schema_invalid");
  });

  it("evaluates allowlisted conditions and reports missing values and type mismatches", () => {
    expect(
      evaluateWorkflowCondition(
        {
          source: "input",
          path: "release.channel",
          operator: "eq",
          value: "beta"
        },
        {
          input: { release: { channel: "beta" } },
          nodes: {}
        }
      )
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(
        {
          source: "input",
          path: "release.metadata",
          operator: "eq",
          value: { channel: "beta", enabled: true }
        },
        {
          input: { release: { metadata: { enabled: true, channel: "beta" } } },
          nodes: {}
        }
      )
    ).toBe(true);

    expect(() =>
      evaluateWorkflowCondition(
        {
          source: "input",
          path: "release.missing",
          operator: "eq",
          value: "beta"
        },
        { input: {}, nodes: {} }
      )
    ).toThrow(WorkflowConditionEvaluationError);
    expect(() =>
      evaluateWorkflowCondition(
        {
          source: "input",
          path: "release.channel",
          operator: "gt",
          value: 1
        },
        {
          input: { release: { channel: "beta" } },
          nodes: {}
        }
      )
    ).toThrow("matching number or string");
  });

  it("persists a separate definition and dispatches parallel branches only once", async () => {
    const root = await createInitializedProject();
    const tasks = await createGraphTasks(root);
    const definition = definitionFixture(tasks);
    const definitionPath = path.join(root, "workflow-definition.json");
    await writeJsonFileAtomic(definitionPath, definition);
    const runtime = new ProductionWorkflowRuntime(root);

    const validated = await workflowValidateCommand(root, definitionPath);
    const started = await runtime.run({ definitionPath });
    const restarted = await new ProductionWorkflowRuntime(root).recover(
      definition.workflow_id
    );
    const queue = await new WorkQueue(root).list();

    expect(validated).toContain("Kairon workflow definition is valid.");
    expect(started.artifact.nodes).toMatchObject([
      { id: "condition_release", status: "completed", condition_result: true },
      { id: "parallel_checks", status: "completed" },
      { id: "branch_a", status: "dispatched", branch_id: "checks-a" },
      { id: "branch_b", status: "dispatched", branch_id: "checks-b" },
      { id: "join_all", status: "pending", join_policy: "all" },
      { id: "finalize", status: "pending" }
    ]);
    expect(restarted.artifact.status).toBe("running");
    expect(queue).toHaveLength(2);
    expect(new Set(queue.map((item) => item.idempotency_key)).size).toBe(2);
    await expect(
      readJsonFile(workflowDefinitionArtifactPath(root, definition.workflow_id))
    ).resolves.toMatchObject({
      artifact_kind: "workflow_definition",
      workflow_id: definition.workflow_id
    });

    const workQueue = new WorkQueue(root);
    await workQueue.complete(queue[0].id, { result: "a" });
    await workQueue.complete(queue[1].id, { result: "b" });
    const joined = await runtime.recover(definition.workflow_id);
    const afterJoinQueue = await workQueue.list();
    expect(joined.artifact.nodes.find((node) => node.id === "join_all")).toMatchObject({
      status: "completed",
      join_policy: "all"
    });
    expect(afterJoinQueue).toHaveLength(3);
    expect(
      afterJoinQueue.filter(
        (item) =>
          item.metadata?.production_workflow?.node_id === "finalize"
      )
    ).toHaveLength(1);

    const stored = await readJsonFile<WorkflowRunArtifact>(
      workflowRunArtifactPath(root, definition.workflow_id)
    );
    expect(stored.definition?.artifact_path).toContain(
      ".kairon/workflows/definitions/"
    );
    expect(stored.graph).toMatchObject({
      branch_ids: ["checks-a", "checks-b"],
      join_node_ids: ["join_all"]
    });
  });

  it("waits at a manual gate and dispatches only after its approval", async () => {
    const root = await createInitializedProject();
    const task = await new TaskRunner(root).createTask({
      title: "After manual gate",
      persona: "researcher"
    });
    await new StateApplier(root).appendEvent({
      type: "approval.requested",
      actor: "workflow-definition-test",
      payload: {
        approval: {
          id: "APR-T168-MANUAL",
          type: "workflow_manual_gate",
          title: "Manual workflow gate",
          actions: ["approve", "reject"]
        }
      }
    });
    const definition: WorkflowDefinition = {
      schema_version: "0.1",
      artifact_kind: "workflow_definition",
      workflow_id: "WF-T168-MANUAL",
      objective: "Wait for a manual decision.",
      entry_node_id: "operator_gate",
      input: {},
      nodes: [
        {
          id: "operator_gate",
          type: "manual_gate",
          depends_on: [],
          approval_id: "APR-T168-MANUAL"
        },
        {
          id: "after_gate",
          type: "task",
          depends_on: ["operator_gate"],
          task_id: task.task_id,
          resource_keys: []
        }
      ]
    };
    const definitionPath = path.join(root, "manual-gate.json");
    await writeJsonFileAtomic(definitionPath, definition);
    const runtime = new ProductionWorkflowRuntime(root);

    const waiting = await runtime.run({ definitionPath });
    expect(waiting.artifact).toMatchObject({
      status: "waiting_approval",
      nodes: [
        { id: "operator_gate", kind: "manual_gate", status: "waiting_approval" },
        { id: "after_gate", status: "pending" }
      ]
    });
    await expect(new WorkQueue(root).list()).resolves.toHaveLength(0);

    await new ApprovalQueue(root).decide({
      approvalId: "APR-T168-MANUAL",
      action: "approve",
      reason: "manual gate approved"
    });
    const resumed = await runtime.recover(definition.workflow_id);
    expect(resumed.artifact.nodes).toMatchObject([
      { id: "operator_gate", status: "completed" },
      { id: "after_gate", status: "dispatched" }
    ]);
    await expect(new WorkQueue(root).list()).resolves.toHaveLength(1);
  });
});

function definitionFixture(
  tasks: {
    branchA?: string;
    branchB?: string;
    finalize?: string;
    compensationA?: string;
  } = {}
): WorkflowDefinition {
  return {
    schema_version: "0.1",
    artifact_kind: "workflow_definition",
    workflow_id: "WF-T168-BRANCH",
    objective: "Validate release checks in parallel.",
    entry_node_id: "condition_release",
    input: { release: { enabled: true, channel: "beta" } },
    nodes: [
      {
        id: "condition_release",
        type: "condition",
        depends_on: [],
        expression: {
          source: "input",
          path: "release.enabled",
          operator: "eq",
          value: true
        }
      },
      {
        id: "parallel_checks",
        type: "parallel",
        depends_on: ["condition_release"],
        when: { condition_node_id: "condition_release", equals: true },
        branches: [
          { id: "checks-a", entry_node_id: "branch_a" },
          { id: "checks-b", entry_node_id: "branch_b" }
        ]
      },
      {
        id: "branch_a",
        type: "task",
        depends_on: ["parallel_checks", "condition_release"],
        branch_id: "checks-a",
        when: { condition_node_id: "condition_release", equals: true },
        task_id: tasks.branchA ?? "TASK-BRANCH-A",
        resource_keys: ["src/branch-a.ts"],
        retry: { max_attempts: 1, backoff_seconds: 0 },
        compensation: {
          task_id: tasks.compensationA ?? "TASK-COMPENSATE-A",
          resource_keys: ["src/branch-a.ts"]
        }
      },
      {
        id: "branch_b",
        type: "task",
        depends_on: ["parallel_checks", "condition_release"],
        branch_id: "checks-b",
        when: { condition_node_id: "condition_release", equals: true },
        task_id: tasks.branchB ?? "TASK-BRANCH-B",
        resource_keys: ["src/branch-b.ts"],
        retry: { max_attempts: 1, backoff_seconds: 0 }
      },
      {
        id: "join_all",
        type: "join",
        depends_on: ["branch_a", "branch_b"],
        policy: "all"
      },
      {
        id: "finalize",
        type: "task",
        depends_on: ["join_all"],
        task_id: tasks.finalize ?? "TASK-FINALIZE",
        resource_keys: ["src/finalize.ts"]
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

async function createGraphTasks(root: string) {
  const taskRunner = new TaskRunner(root);
  const branchA = await taskRunner.createTask({
    title: "Branch A",
    persona: "researcher"
  });
  const branchB = await taskRunner.createTask({
    title: "Branch B",
    persona: "researcher"
  });
  const finalize = await taskRunner.createTask({
    title: "Finalize",
    persona: "researcher"
  });
  const compensationA = await taskRunner.createTask({
    title: "Compensate A",
    persona: "implementer"
  });
  return {
    branchA: branchA.task_id,
    branchB: branchB.task_id,
    finalize: finalize.task_id,
    compensationA: compensationA.task_id
  };
}
