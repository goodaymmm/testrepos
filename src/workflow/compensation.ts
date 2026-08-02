import { createHash } from "node:crypto";
import path from "node:path";
import { ApprovalQueue } from "../approvals/approval-queue.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { WorkQueue } from "../queue/work-queue.js";
import { TaskRunner } from "../tasks/task-runner.js";
import {
  ProductionWorkflowRuntime,
  workflowRunArtifactPath,
  type ProductionWorkflowRuntimeOptions
} from "./runtime.js";
import type {
  ProductionWorkflowCompensationQueueMetadata,
  WorkflowNodeState,
  WorkflowRunArtifact
} from "./types.js";

export type WorkflowCompensationStepStatus =
  | "pending"
  | "dispatched"
  | "completed"
  | "failed";

export type WorkflowCompensationStep = {
  step_id: string;
  order: number;
  source_node_id: string;
  branch_id?: string;
  compensation_task_id: string;
  depends_on_step_id?: string;
  status: WorkflowCompensationStepStatus;
  input_digest: string;
  source_output_digest?: string;
  idempotency_key: string;
  queue_item_id?: string;
  completed_at?: string;
  error?: string;
};

export type WorkflowCompensationPlan = {
  schema_version: "0.1";
  artifact_kind: "workflow_compensation_plan";
  plan_id: string;
  workflow_id: string;
  status: "planned" | "running" | "completed" | "failed";
  reason: "partial_failure" | "operator_request";
  source_workflow_sequence: number;
  source_workflow_digest: string;
  approval_id?: string;
  steps: WorkflowCompensationStep[];
  skipped_completed_node_ids: string[];
  created_at: string;
  updated_at: string;
};

export type WorkflowCompensationResult = {
  plan: WorkflowCompensationPlan;
  actions: string[];
  dry_run: boolean;
  plan_path: string;
};

export class WorkflowCompensationManager {
  private readonly runtime: ProductionWorkflowRuntime;

  constructor(
    private readonly projectRoot: string,
    private readonly options: ProductionWorkflowRuntimeOptions = {}
  ) {
    this.runtime = new ProductionWorkflowRuntime(projectRoot, options);
  }

  async plan(workflowId: string): Promise<WorkflowCompensationResult> {
    const artifact = (await this.runtime.show(workflowId)).artifact;
    const eligible = reverseTopologicalNodes(artifact).filter(
      (node) =>
        node.kind === "task" &&
        node.status === "completed" &&
        node.compensation !== undefined
    );
    if (eligible.length === 0) {
      throw new Error(
        `Workflow ${workflowId} has no completed compensatable nodes.`
      );
    }

    const planId = `${workflowId}-COMP-${String(artifact.sequence).padStart(6, "0")}`;
    const existing = await readOptionalPlan(
      workflowCompensationPlanPath(this.projectRoot, planId)
    );
    if (existing !== undefined) {
      return {
        plan: existing,
        actions: ["plan_reused"],
        dry_run: true,
        plan_path: toProjectPath(
          this.projectRoot,
          workflowCompensationPlanPath(this.projectRoot, planId)
        )
      };
    }

    const createdAt = this.now().toISOString();
    const steps = eligible.map<WorkflowCompensationStep>((node, index) => {
      const stepId = `${planId}-STEP-${String(index + 1).padStart(3, "0")}`;
      return {
        step_id: stepId,
        order: index + 1,
        source_node_id: node.id,
        branch_id: node.branch_id,
        compensation_task_id: node.compensation!.task_id,
        depends_on_step_id:
          index === 0
            ? undefined
            : `${planId}-STEP-${String(index).padStart(3, "0")}`,
        status: "pending",
        input_digest: digest({
          source_node_id: node.id,
          source_output_digest: node.output_digest,
          compensation_task_id: node.compensation!.task_id
        }),
        source_output_digest: node.output_digest,
        idempotency_key: `${planId}:${stepId}:1`
      };
    });
    const plan: WorkflowCompensationPlan = {
      schema_version: "0.1",
      artifact_kind: "workflow_compensation_plan",
      plan_id: planId,
      workflow_id: workflowId,
      status: "planned",
      reason: artifact.status === "failed" ? "partial_failure" : "operator_request",
      source_workflow_sequence: artifact.sequence,
      source_workflow_digest: digestWorkflowArtifact(artifact),
      steps,
      skipped_completed_node_ids: artifact.nodes
        .filter(
          (node) =>
            ["completed", "skipped"].includes(node.status) &&
            node.compensation === undefined
        )
        .map((node) => node.id),
      created_at: createdAt,
      updated_at: createdAt
    };
    await writeJsonFileAtomic(
      workflowCompensationPlanPath(this.projectRoot, planId),
      plan
    );
    return {
      plan,
      actions: [`plan_created:${planId}`],
      dry_run: true,
      plan_path: toProjectPath(
        this.projectRoot,
        workflowCompensationPlanPath(this.projectRoot, planId)
      )
    };
  }

  async execute(input: {
    workflowId: string;
    planId: string;
    approvalId: string;
    confirm: string;
  }): Promise<WorkflowCompensationResult> {
    await this.runtime.assertEnabled();
    if (input.confirm !== input.planId) {
      throw new Error(
        `Workflow compensation exact confirmation mismatch: ${input.confirm}`
      );
    }
    const approval = await new ApprovalQueue(this.projectRoot).show(
      input.approvalId
    );
    if (approval.status !== "decided" || approval.decision !== "approve") {
      throw new Error(
        `Workflow compensation approval is not approved: ${input.approvalId}`
      );
    }

    const planPath = workflowCompensationPlanPath(
      this.projectRoot,
      input.planId
    );
    const plan = await readJsonFile<WorkflowCompensationPlan>(planPath);
    if (plan.workflow_id !== input.workflowId) {
      throw new Error(
        `Workflow compensation plan belongs to ${plan.workflow_id}, not ${input.workflowId}.`
      );
    }
    const artifact = structuredClone(
      (await this.runtime.show(input.workflowId)).artifact
    );
    if (
      plan.status === "planned" &&
      (artifact.sequence !== plan.source_workflow_sequence ||
        digestWorkflowArtifact(artifact) !== plan.source_workflow_digest)
    ) {
      throw new Error(
        `Workflow compensation plan is stale: ${input.planId}`
      );
    }

    plan.approval_id = input.approvalId;
    const actions = await this.reconcile(plan, artifact);
    if (plan.status !== "failed" && plan.status !== "completed") {
      const readyStep = plan.steps.find(
        (step) =>
          step.status === "pending" &&
          (step.depends_on_step_id === undefined ||
            plan.steps.find(
              (candidate) => candidate.step_id === step.depends_on_step_id
            )?.status === "completed")
      );
      if (readyStep !== undefined) {
        const metadata: ProductionWorkflowCompensationQueueMetadata = {
          schema_version: "0.1",
          workflow_id: input.workflowId,
          plan_id: plan.plan_id,
          step_id: readyStep.step_id,
          source_node_id: readyStep.source_node_id,
          idempotency_key: readyStep.idempotency_key,
          plan_artifact_path: toProjectPath(this.projectRoot, planPath),
          approval_id: input.approvalId
        };
        const enqueue = await new TaskRunner(this.projectRoot, {
          now: this.options.now
        }).enqueueTaskWithResult({
          taskId: readyStep.compensation_task_id,
          idempotencyKey: readyStep.idempotency_key,
          metadata: { workflow_compensation: metadata },
          createdAt: this.now()
        });
        readyStep.status = "dispatched";
        readyStep.queue_item_id = enqueue.item.id;
        plan.status = "running";
        actions.push(
          `${enqueue.created ? "compensation_dispatched" : "compensation_reused"}:${readyStep.step_id}:${enqueue.item.id}`
        );
      }
    }
    if (plan.steps.every((step) => step.status === "completed")) {
      plan.status = "completed";
    }

    const updatedAt = this.now().toISOString();
    plan.updated_at = updatedAt;
    applyPlanToWorkflowArtifact(artifact, plan, updatedAt);
    await writeJsonFileAtomic(planPath, plan);
    await this.runtime.persistControlledArtifact(artifact);
    return {
      plan,
      actions,
      dry_run: false,
      plan_path: toProjectPath(this.projectRoot, planPath)
    };
  }

  async show(planId: string): Promise<WorkflowCompensationResult> {
    const planPath = workflowCompensationPlanPath(this.projectRoot, planId);
    return {
      plan: await readJsonFile<WorkflowCompensationPlan>(planPath),
      actions: [],
      dry_run: true,
      plan_path: toProjectPath(this.projectRoot, planPath)
    };
  }

  private async reconcile(
    plan: WorkflowCompensationPlan,
    artifact: WorkflowRunArtifact
  ): Promise<string[]> {
    const queueItems = await new WorkQueue(this.projectRoot).list();
    const actions: string[] = [];
    for (const step of plan.steps) {
      if (step.queue_item_id === undefined || step.status === "completed") {
        continue;
      }
      const item = queueItems.find((candidate) => candidate.id === step.queue_item_id);
      if (item?.status === "completed") {
        step.status = "completed";
        step.completed_at = item.completed_at ?? this.now().toISOString();
        actions.push(`compensation_completed:${step.step_id}:${item.id}`);
      } else if (item?.status === "failed") {
        step.status = "failed";
        step.error = item.error?.message ?? "Compensation queue item failed.";
        plan.status = "failed";
        actions.push(`compensation_failed:${step.step_id}:${item.id}`);
      }
      const sourceNode = artifact.nodes.find(
        (node) => node.id === step.source_node_id
      );
      if (sourceNode?.compensation !== undefined) {
        sourceNode.compensation.status =
          step.status === "dispatched"
            ? "dispatched"
            : step.status === "completed"
              ? "completed"
              : step.status === "failed"
                ? "failed"
                : "planned";
        sourceNode.compensation.plan_id = plan.plan_id;
        sourceNode.compensation.queue_item_id = step.queue_item_id;
        sourceNode.compensation.error = step.error;
      }
    }
    return actions;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function formatWorkflowCompensationResult(
  result: WorkflowCompensationResult
): string {
  return [
    result.dry_run
      ? "Kairon workflow compensation plan inspected."
      : "Kairon workflow compensation updated.",
    `workflow_id=${result.plan.workflow_id}`,
    `plan_id=${result.plan.plan_id}`,
    `status=${result.plan.status}`,
    `dry_run=${result.dry_run}`,
    `approval_id=${result.plan.approval_id ?? "none"}`,
    `steps=${result.plan.steps.length}`,
    `completed_steps=${result.plan.steps.filter((step) => step.status === "completed").length}`,
    `plan_path=${result.plan_path}`,
    `actions=${result.actions.length === 0 ? "none" : result.actions.join(",")}`,
    ...result.plan.steps.map(
      (step) =>
        `step.${step.order}=id:${step.step_id};source:${step.source_node_id};task:${step.compensation_task_id};status:${step.status};queue:${step.queue_item_id ?? "none"}`
    )
  ].join("\n");
}

export function workflowCompensationPlanPath(
  projectRoot: string,
  planId: string
): string {
  if (!/^WF-[A-Za-z0-9_-]+-COMP-\d{6}$/.test(planId)) {
    throw new Error(`Invalid workflow compensation plan id: ${planId}`);
  }
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "compensations",
    `${planId}.json`
  );
}

function applyPlanToWorkflowArtifact(
  artifact: WorkflowRunArtifact,
  plan: WorkflowCompensationPlan,
  updatedAt: string
): void {
  for (const step of plan.steps) {
    const node = artifact.nodes.find((candidate) => candidate.id === step.source_node_id);
    if (node?.compensation === undefined) {
      continue;
    }
    node.compensation.status =
      step.status === "pending"
        ? "planned"
        : step.status;
    node.compensation.plan_id = plan.plan_id;
    node.compensation.queue_item_id = step.queue_item_id;
    node.compensation.error = step.error;
  }
  artifact.compensation = {
    plan_id: plan.plan_id,
    status: plan.status,
    approval_id: plan.approval_id,
    pending_steps: plan.steps.filter((step) =>
      ["pending", "dispatched"].includes(step.status)
    ).length,
    updated_at: updatedAt
  };
}

async function readOptionalPlan(
  planPath: string
): Promise<WorkflowCompensationPlan | undefined> {
  try {
    return await readJsonFile<WorkflowCompensationPlan>(planPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function digestWorkflowArtifact(artifact: WorkflowRunArtifact): string {
  return digest({
    workflow_id: artifact.workflow_id,
    sequence: artifact.sequence,
    status: artifact.status,
    nodes: artifact.nodes.map((node) => ({
      id: node.id,
      status: node.status,
      attempt: node.attempt,
      output_digest: node.output_digest
    }))
  });
}

function reverseTopologicalNodes(
  artifact: WorkflowRunArtifact
): WorkflowNodeState[] {
  const nodesById = new Map(artifact.nodes.map((node) => [node.id, node]));
  const remainingDependencies = new Map(
    artifact.nodes.map((node) => [node.id, new Set(node.dependencies)])
  );
  const ordered: WorkflowNodeState[] = [];
  const queued = new Set<string>();
  const ready = artifact.nodes
    .filter((node) => node.dependencies.length === 0)
    .map((node) => node.id);
  ready.forEach((nodeId) => queued.add(nodeId));
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    const node = nodesById.get(nodeId);
    if (node === undefined || ordered.some((candidate) => candidate.id === nodeId)) {
      continue;
    }
    ordered.push(node);
    for (const candidate of artifact.nodes) {
      const dependencies = remainingDependencies.get(candidate.id)!;
      dependencies.delete(nodeId);
      if (
        dependencies.size === 0 &&
        !queued.has(candidate.id) &&
        !ordered.some((value) => value.id === candidate.id)
      ) {
        ready.push(candidate.id);
        queued.add(candidate.id);
      }
    }
  }
  if (ordered.length !== artifact.nodes.length) {
    throw new Error(
      `Cannot create compensation order for cyclic workflow ${artifact.workflow_id}.`
    );
  }
  return ordered.reverse();
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
