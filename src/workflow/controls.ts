import path from "node:path";
import { ApprovalQueue } from "../approvals/approval-queue.js";
import { appendJsonLine, readJsonLines } from "../core/fs/jsonl-file.js";
import { withResourceLock } from "../core/fs/resource-lock.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  ProductionWorkflowRuntime,
  type ProductionWorkflowRuntimeOptions,
  type WorkflowRuntimeResult
} from "./runtime.js";
import {
  deriveControlledWorkflowStatus,
  transitionWorkflowNode,
  type WorkflowControlAction,
  type WorkflowControlEvent,
  type WorkflowNodeState,
  type WorkflowResourceLock,
  type WorkflowRunArtifact,
  type WorkflowStatus
} from "./types.js";

export type WorkflowControlResult = WorkflowRuntimeResult & {
  event: WorkflowControlEvent;
  compensation_path?: string;
};

export type WorkflowCancelRequest = {
  reason: string;
  approvalId?: string;
};

export type WorkflowRetryRequest = {
  nodeId: string;
  reason?: string;
};

type WorkflowCompensationPlan = {
  schema_version: "0.1";
  kind: "workflow_compensation_plan";
  workflow_id: string;
  event_id: string;
  status: "pending";
  reason: string;
  approval_id: string;
  completed_nodes: string[];
  cancelled_nodes: string[];
  running_nodes: string[];
  released_resource_locks: WorkflowResourceLock[];
  rollback_steps: string[];
  created_at: string;
};

export class WorkflowControls {
  private readonly runtime: ProductionWorkflowRuntime;

  constructor(
    private readonly projectRoot: string,
    private readonly options: ProductionWorkflowRuntimeOptions = {}
  ) {
    this.runtime = new ProductionWorkflowRuntime(projectRoot, options);
  }

  async pause(workflowId: string, reason: string): Promise<WorkflowControlResult> {
    assertReason(reason, "pause");
    return this.mutate(workflowId, "pause", async (artifact, eventInput) => {
      assertWorkflowStatus(artifact.status, ["ready", "running", "waiting_approval"]);
      artifact.control!.mode = "paused";
      artifact.control!.reason = reason;
      artifact.control!.requested_at = eventInput.createdAt;
      return { reason };
    });
  }

  async resume(workflowId: string): Promise<WorkflowControlResult> {
    const controlled = await this.mutate(
      workflowId,
      "resume",
      async (artifact) => {
        assertWorkflowStatus(artifact.status, ["paused"]);
        artifact.control!.mode = "active";
        delete artifact.control!.reason;
        delete artifact.control!.requested_at;
        delete artifact.control!.approval_id;
        return {};
      }
    );
    const recovered = await this.runtime.recover(workflowId);
    return { ...controlled, ...recovered, event: controlled.event };
  }

  async cancel(
    workflowId: string,
    request: WorkflowCancelRequest
  ): Promise<WorkflowControlResult> {
    assertReason(request.reason, "cancel");
    return this.mutate(workflowId, "cancel", async (artifact, eventInput) => {
      assertWorkflowStatus(artifact.status, [
        "ready",
        "running",
        "waiting_approval",
        "paused",
        "failed"
      ]);
      const approvalId = request.approvalId ?? artifact.approval_id;
      if (approvalId === undefined) {
        throw new Error("Workflow cancel requires an approved --approval-id.");
      }
      await this.assertApproved(approvalId);

      let releasedLocks: WorkflowResourceLock[] = [];
      try {
        artifact.control!.mode = artifact.nodes.some(
          (node) => node.status === "running"
        )
          ? "cancellation_requested"
          : "cancelled";
        artifact.control!.reason = request.reason;
        artifact.control!.approval_id = approvalId;
        artifact.control!.requested_at = eventInput.createdAt;

        for (let index = 0; index < artifact.nodes.length; index += 1) {
          const node = artifact.nodes[index];
          if (node.status === "running" || isTerminal(node)) {
            continue;
          }
          artifact.nodes[index] = transitionWorkflowNode(node, {
            type: "cancel",
            at: eventInput.createdAt
          });
        }
      } finally {
        // The running process observes its token at the execution boundary.
        releasedLocks = await this.runtime.releaseWorkflowResourceLocks(artifact);
      }

      const compensationPath = workflowCompensationPath(
        this.projectRoot,
        workflowId,
        eventInput.eventSequence
      );
      const compensation: WorkflowCompensationPlan = {
        schema_version: "0.1",
        kind: "workflow_compensation_plan",
        workflow_id: workflowId,
        event_id: eventInput.eventId,
        status: "pending",
        reason: request.reason,
        approval_id: approvalId,
        completed_nodes: nodeIds(artifact.nodes, ["completed", "skipped"]),
        cancelled_nodes: nodeIds(artifact.nodes, ["cancelled"]),
        running_nodes: nodeIds(artifact.nodes, ["running"]),
        released_resource_locks: releasedLocks,
        rollback_steps: [
          "Inspect completed node outputs before applying compensation.",
          "Apply a reviewed rollback for externally visible side effects.",
          "Close this plan only after locks and related approvals are reconciled."
        ],
        created_at: eventInput.createdAt
      };
      await writeJsonFileAtomic(compensationPath, compensation);
      return {
        reason: request.reason,
        approvalId,
        compensationPath: toProjectPath(this.projectRoot, compensationPath)
      };
    });
  }

  async retry(
    workflowId: string,
    request: WorkflowRetryRequest
  ): Promise<WorkflowControlResult> {
    const controlled = await this.mutate(
      workflowId,
      "retry",
      async (artifact, eventInput) => {
        const nodeIndex = artifact.nodes.findIndex(
          (node) => node.id === request.nodeId
        );
        if (nodeIndex < 0) {
          throw new Error(`Workflow node not found: ${request.nodeId}`);
        }
        const node = artifact.nodes[nodeIndex];
        if (node.status !== "failed") {
          throw new Error(
            `Workflow retry requires a failed node: ${request.nodeId} is ${node.status}`
          );
        }

        const nextMaxAttempts = Math.max(node.max_attempts, node.attempt + 1);
        const retried = transitionWorkflowNode(node, {
          type: "retry",
          at: eventInput.createdAt
        });
        retried.max_attempts = nextMaxAttempts;
        artifact.nodes[nodeIndex] = retried;
        artifact.retry_policy.max_attempts = Math.max(
          artifact.retry_policy.max_attempts,
          nextMaxAttempts
        );
        artifact.control!.mode = "active";
        delete artifact.control!.reason;
        delete artifact.control!.requested_at;
        return {
          reason: request.reason,
          nodeId: request.nodeId,
          attempt: node.attempt + 1
        };
      }
    );
    const recovered = await this.runtime.recover(workflowId);
    return { ...controlled, ...recovered, event: controlled.event };
  }

  async events(workflowId: string): Promise<WorkflowControlEvent[]> {
    try {
      return await readJsonLines<WorkflowControlEvent>(
        workflowControlEventsPath(this.projectRoot, workflowId)
      );
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  private async mutate(
    workflowId: string,
    action: WorkflowControlAction,
    change: (
      artifact: WorkflowRunArtifact,
      event: { eventId: string; eventSequence: number; createdAt: string }
    ) => Promise<{
      reason?: string;
      approvalId?: string;
      nodeId?: string;
      attempt?: number;
      compensationPath?: string;
    }>
  ): Promise<WorkflowControlResult> {
    let result: WorkflowControlResult | undefined;
    await withResourceLock(
      this.projectRoot,
      `.kairon/workflows/runs/${workflowId}.json.control`,
      {
        owner: `workflow-control:${workflowId}:${action}`,
        now: this.now(),
        ttlMs: 30_000
      },
      async () => {
        const artifact = structuredClone((await this.runtime.show(workflowId)).artifact);
        const events = await this.events(workflowId);
        const eventSequence =
          Math.max(
            events.at(-1)?.sequence ?? 0,
            artifact.control?.last_event_sequence ?? 0
          ) + 1;
        const eventId = `${workflowId}-CTL-${String(eventSequence).padStart(6, "0")}`;
        const createdAt = this.now().toISOString();
        const statusBefore = artifact.status;
        const changeResult = await change(artifact, {
          eventId,
          eventSequence,
          createdAt
        });

        artifact.control!.generation += 1;
        artifact.control!.last_event_id = eventId;
        artifact.control!.last_event_sequence = eventSequence;
        artifact.control!.last_event_action = action;
        artifact.status = deriveControlledWorkflowStatus(
          artifact.nodes,
          artifact.control
        );
        const event: WorkflowControlEvent = {
          schema_version: "0.1",
          event_id: eventId,
          workflow_id: workflowId,
          sequence: eventSequence,
          action,
          status_before: statusBefore,
          status_after: artifact.status,
          reason: changeResult.reason,
          approval_id: changeResult.approvalId,
          node_id: changeResult.nodeId,
          attempt: changeResult.attempt,
          compensation_path: changeResult.compensationPath,
          created_at: createdAt
        };
        const checkpointPath = await this.runtime.persistControlledArtifact(artifact);
        await appendJsonLine(
          workflowControlEventsPath(this.projectRoot, workflowId),
          event
        );
        result = {
          artifact,
          actions: [`control:${action}:${eventId}`],
          dry_run: false,
          checkpoint_path: checkpointPath,
          event,
          compensation_path: changeResult.compensationPath
        };
      }
    );

    return result!;
  }

  private async assertApproved(approvalId: string): Promise<void> {
    const approval = await new ApprovalQueue(this.projectRoot).show(approvalId);
    if (approval.status !== "decided" || approval.decision !== "approve") {
      throw new Error(`Workflow control approval is not approved: ${approvalId}`);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function formatWorkflowControlResult(result: WorkflowControlResult): string {
  return [
    "Kairon workflow control applied.",
    `workflow_id=${result.artifact.workflow_id}`,
    `action=${result.event.action}`,
    `status=${result.artifact.status}`,
    `event_id=${result.event.event_id}`,
    `event_sequence=${result.event.sequence}`,
    `node_id=${result.event.node_id ?? "none"}`,
    `checkpoint=${result.checkpoint_path ?? "none"}`,
    `compensation=${result.compensation_path ?? "none"}`
  ].join("\n");
}

export function workflowControlEventsPath(
  projectRoot: string,
  workflowId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "events",
    `${workflowId}.jsonl`
  );
}

export function workflowCompensationPath(
  projectRoot: string,
  workflowId: string,
  sequence: number
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "compensations",
    `${workflowId}-${String(sequence).padStart(6, "0")}.json`
  );
}

function assertWorkflowStatus(
  actual: WorkflowStatus,
  allowed: WorkflowStatus[]
): void {
  if (!allowed.includes(actual)) {
    throw new Error(
      `Workflow control is not allowed from ${actual}; expected ${allowed.join(", ")}.`
    );
  }
}

function assertReason(reason: string, action: string): void {
  if (reason.trim().length === 0) {
    throw new Error(`Workflow ${action} requires a non-empty reason.`);
  }
}

function isTerminal(node: WorkflowNodeState): boolean {
  return ["completed", "skipped", "cancelled"].includes(node.status);
}

function nodeIds(
  nodes: WorkflowNodeState[],
  statuses: WorkflowNodeState["status"][]
): string[] {
  return nodes
    .filter((node) => statuses.includes(node.status))
    .map((node) => node.id);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
