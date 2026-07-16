import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ApprovalQueue, type ApprovalRecord } from "../approvals/approval-queue.js";
import { ensureWorkflowCorrelation } from "../correlation/store.js";
import {
  acquireResourceLock,
  assertResourceLockFencingToken,
  releaseResourceLock,
  ResourceLockAlreadyExistsError,
  type ResourceLockData,
  type ResourceLockHandle
} from "../core/fs/resource-lock.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { experimentalWorkflowArtifactPath } from "../experimental/workflow-runtime.js";
import { WorkQueue, type QueueItem } from "../queue/work-queue.js";
import { TaskRunner, type TaskRecord } from "../tasks/task-runner.js";
import {
  deriveControlledWorkflowStatus,
  transitionWorkflowNode,
  type ProductionWorkflowQueueMetadata,
  type WorkflowControlState,
  type WorkflowNodeState,
  type WorkflowResourceLock,
  type WorkflowRunArtifact
} from "./types.js";

export type RunProductionWorkflowRequest = {
  workflowId: string;
  correlationId?: string;
  taskId?: string;
  approvalId?: string;
  objective?: string;
  resourceKeys?: string[];
  retryMaxAttempts?: number;
  retryBackoffSeconds?: number;
};

export type RecoverProductionWorkflowOptions = {
  dryRun?: boolean;
};

export type WorkflowRuntimeResult = {
  artifact: WorkflowRunArtifact;
  actions: string[];
  dry_run: boolean;
  checkpoint_path?: string;
};

export type ProductionWorkflowRuntimeOptions = {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  resourceLockTtlMs?: number;
};

export type WorkflowExecutionContext = {
  workflow_id: string;
  node_id: string;
  cancellation_token: string;
  isCancellationRequested: () => Promise<boolean>;
};

export class ProductionWorkflowRuntimeDisabledError extends Error {
  constructor() {
    super("Production workflow runtime requires KAIRON_WORKFLOW_RUNTIME=1.");
    this.name = "ProductionWorkflowRuntimeDisabledError";
  }
}

export class ProductionWorkflowRuntime {
  constructor(
    private readonly projectRoot: string,
    private readonly options: ProductionWorkflowRuntimeOptions = {}
  ) {}

  async run(request: RunProductionWorkflowRequest): Promise<WorkflowRuntimeResult> {
    this.assertEnabled();
    assertWorkflowId(request.workflowId);
    const actions: string[] = [];
    const loaded = await this.loadOrCreate(request);
    const artifact = loaded.artifact;
    if (request.correlationId !== undefined) {
      artifact.correlation_id = request.correlationId;
    }

    if (request.approvalId !== undefined) {
      const approvalNode = artifact.nodes.find((node) => node.kind === "approval_gate");
      if (approvalNode !== undefined && approvalNode.status !== "completed") {
        approvalNode.approval_id = request.approvalId;
        artifact.approval_id = request.approvalId;
      }
    }
    await this.ensureCorrelation(artifact);

    await this.reconcile(artifact, actions);
    await this.advance(artifact, actions);
    const checkpointPath = await this.persist(
      artifact,
      loaded.created ? "created" : "run"
    );

    return {
      artifact,
      actions,
      dry_run: false,
      checkpoint_path: checkpointPath
    };
  }

  async show(workflowId: string): Promise<WorkflowRuntimeResult> {
    assertWorkflowId(workflowId);
    const artifact = await this.loadArtifact(workflowId);
    await this.ensureCorrelation(artifact);
    return { artifact, actions: [], dry_run: true };
  }

  async list(): Promise<WorkflowRunArtifact[]> {
    let entries: string[];
    try {
      entries = await readdir(workflowRunsDirectory(this.projectRoot));
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return [];
      }
      throw error;
    }

    const artifacts = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const artifact = await this.loadArtifact(name.slice(0, -5));
          await this.ensureCorrelation(artifact);
          return artifact;
        })
    );
    return artifacts.sort(
      (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
    );
  }

  async persistControlledArtifact(artifact: WorkflowRunArtifact): Promise<string> {
    return this.persist(artifact, "control");
  }

  async releaseWorkflowResourceLocks(
    artifact: WorkflowRunArtifact
  ): Promise<WorkflowResourceLock[]> {
    const locks = artifact.nodes.flatMap((node) => node.resource_locks);
    await this.releaseResourceLocks(locks);
    for (const node of artifact.nodes) {
      node.resource_locks = [];
      delete node.fencing_token;
    }
    return locks;
  }

  async recover(
    workflowId: string,
    options: RecoverProductionWorkflowOptions = {}
  ): Promise<WorkflowRuntimeResult> {
    assertWorkflowId(workflowId);
    if (options.dryRun !== true) {
      this.assertEnabled();
    }

    const artifact = structuredClone(await this.loadArtifact(workflowId));
    const actions: string[] = [];
    await this.reconcile(artifact, actions);

    if (options.dryRun === true) {
      artifact.status = deriveControlledWorkflowStatus(
        artifact.nodes,
        artifact.control
      );
      return { artifact, actions, dry_run: true };
    }

    await this.advance(artifact, actions);
    const checkpointPath = await this.persist(artifact, "recover");
    return {
      artifact,
      actions,
      dry_run: false,
      checkpoint_path: checkpointPath
    };
  }

  async recoverActive(): Promise<WorkflowRuntimeResult[]> {
    if (!isProductionWorkflowRuntimeEnabled(this.options.env ?? process.env)) {
      return [];
    }

    let entries: string[];
    try {
      entries = await readdir(workflowRunsDirectory(this.projectRoot));
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return [];
      }
      throw error;
    }

    const results: WorkflowRuntimeResult[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const workflowId = entry.slice(0, -5);
      const artifact = await this.loadArtifact(workflowId);
      if (["completed", "failed", "cancelled"].includes(artifact.status)) {
        continue;
      }
      results.push(await this.recover(workflowId));
    }
    return results;
  }

  async executeQueueItem(
    item: QueueItem,
    execute: (context?: WorkflowExecutionContext) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const metadata = item.metadata?.production_workflow;
    if (metadata === undefined) {
      return execute();
    }

    this.assertEnabled();
    const artifact = await this.loadArtifact(metadata.workflow_id);
    const nodeIndex = artifact.nodes.findIndex((node) => node.id === metadata.node_id);
    if (nodeIndex < 0) {
      throw new Error(
        `Workflow node not found: ${metadata.workflow_id}/${metadata.node_id}`
      );
    }

    let node = artifact.nodes[nodeIndex];
    if (node.status === "completed") {
      return {
        workflow_id: metadata.workflow_id,
        node_id: metadata.node_id,
        idempotent: true
      };
    }

    if (isCancellationRequested(artifact)) {
      if (!isTerminalNodeStatus(node.status)) {
        artifact.nodes[nodeIndex] = transitionWorkflowNode(node, {
          type: "cancel",
          at: this.now().toISOString()
        });
      }
      artifact.control!.mode = "cancelled";
      await this.releaseWorkflowResourceLocks(artifact);
      await this.persist(artifact, "control");
      return cancellationResult(metadata);
    }

    if (node.status === "pending") {
      node = transitionWorkflowNode(node, {
        type: "dispatch",
        at: this.now().toISOString(),
        attempt: Math.max(node.attempt, 1),
        queueItemId: item.id,
        idempotencyKey: metadata.idempotency_key,
        fencingToken: metadata.fencing_token,
        resourceLocks: metadata.resource_locks
      });
    }

    await this.assertResourceLocks(metadata);
    node = transitionWorkflowNode(node, {
      type: "start",
      at: this.now().toISOString()
    });
    artifact.nodes[nodeIndex] = node;
    await this.persist(artifact, "queue_started");

    try {
      const result = await execute({
        workflow_id: metadata.workflow_id,
        node_id: metadata.node_id,
        cancellation_token:
          metadata.cancellation_token ?? artifact.control!.cancellation_token,
        isCancellationRequested: () =>
          this.isWorkflowCancellationRequested(metadata.workflow_id)
      });
      const latest = await this.loadArtifact(metadata.workflow_id);
      const latestNodeIndex = latest.nodes.findIndex(
        (candidate) => candidate.id === metadata.node_id
      );
      const latestNode = latest.nodes[latestNodeIndex];
      if (isCancellationRequested(latest)) {
        if (
          latestNode !== undefined &&
          !isTerminalNodeStatus(latestNode.status)
        ) {
          latest.nodes[latestNodeIndex] = transitionWorkflowNode(latestNode, {
            type: "cancel",
            at: this.now().toISOString()
          });
        }
        latest.control!.mode = "cancelled";
        await this.persist(latest, "control");
        return cancellationResult(metadata);
      }
      const completedAt = this.now().toISOString();
      latest.nodes[latestNodeIndex] = transitionWorkflowNode(
        latestNode ?? node,
        {
          type: "complete",
          at: completedAt,
          outputDigest: digest(result),
          runId: readString(result.run_id)
        }
      );
      await this.persist(latest, "queue_completed");
      return result;
    } catch (error) {
      const latest = await this.loadArtifact(metadata.workflow_id);
      const latestNodeIndex = latest.nodes.findIndex(
        (candidate) => candidate.id === metadata.node_id
      );
      const latestNode = latest.nodes[latestNodeIndex] ?? node;
      if (isCancellationRequested(latest)) {
        if (!isTerminalNodeStatus(latestNode.status)) {
          latest.nodes[latestNodeIndex] = transitionWorkflowNode(latestNode, {
            type: "cancel",
            at: this.now().toISOString()
          });
        }
        latest.control!.mode = "cancelled";
        await this.persist(latest, "control");
        return cancellationResult(metadata);
      }
      latest.nodes[latestNodeIndex] = transitionWorkflowNode(latestNode, {
        type: "fail",
        at: this.now().toISOString(),
        error: String(error)
      });
      await this.persist(latest, "queue_failed");
      throw error;
    } finally {
      await this.releaseResourceLocks(metadata.resource_locks);
    }
  }

  private async isWorkflowCancellationRequested(
    workflowId: string
  ): Promise<boolean> {
    return isCancellationRequested(await this.loadArtifact(workflowId));
  }

  private async loadOrCreate(
    request: RunProductionWorkflowRequest
  ): Promise<{ artifact: WorkflowRunArtifact; created: boolean }> {
    try {
      return { artifact: await this.loadArtifact(request.workflowId), created: false };
    } catch (error) {
      if (!isMissingJsonFile(error)) {
        throw error;
      }
    }

    if (request.taskId === undefined) {
      throw new Error(
        `Workflow ${request.workflowId} does not exist; --task-id is required.`
      );
    }

    return {
      artifact: await this.createArtifact({
        workflowId: request.workflowId,
        correlationId: request.correlationId,
        taskId: request.taskId,
        approvalId: request.approvalId,
        objective: request.objective,
        resourceKeys: request.resourceKeys,
        retryMaxAttempts: request.retryMaxAttempts,
        retryBackoffSeconds: request.retryBackoffSeconds,
        source: { kind: "new" }
      }),
      created: true
    };
  }

  private async loadArtifact(workflowId: string): Promise<WorkflowRunArtifact> {
    try {
      return normalizeWorkflowArtifact(
        await readJsonFile<WorkflowRunArtifact>(
          workflowRunArtifactPath(this.projectRoot, workflowId)
        )
      );
    } catch (error) {
      if (!isMissingJsonFile(error)) {
        throw error;
      }
    }

    const legacyPath = experimentalWorkflowArtifactPath(this.projectRoot, workflowId);
    const legacy = await readJsonFile<Record<string, unknown>>(legacyPath);
    return this.translateLegacyArtifact(workflowId, legacy, legacyPath);
  }

  private async translateLegacyArtifact(
    workflowId: string,
    legacy: Record<string, unknown>,
    legacyPath: string
  ): Promise<WorkflowRunArtifact> {
    const artifactKind = readString(legacy.artifact_kind);
    if (
      artifactKind !== "workflow_runtime_candidate" &&
      artifactKind !== "experimental_workflow_runtime_spike"
    ) {
      throw new Error(`Unsupported legacy workflow artifact: ${artifactKind ?? "unknown"}`);
    }

    const taskId = readString(legacy.task_id);
    if (taskId === undefined) {
      throw new Error(`Legacy workflow ${workflowId} is missing task_id.`);
    }

    const approvalId = readString(legacy.approval_id);
    const executionPolicy = readRecord(legacy.execution_policy);
    const approvalPolicy = readRecord(executionPolicy?.approval_gate);
    const resourcePolicy = readRecord(executionPolicy?.resource_locks);
    const retryPolicy = readRecord(executionPolicy?.retry_policy);
    const legacyNodes = Array.isArray(legacy.nodes) ? legacy.nodes : [];
    const approvalRequired =
      approvalId !== undefined ||
      approvalPolicy?.required === true ||
      legacyNodes.some((value) => {
        const node = readRecord(value);
        return node?.kind === "approval_gate" && node.status === "waiting";
      });
    const artifact = await this.createArtifact({
      workflowId,
      taskId,
      approvalId,
      objective: readString(legacy.objective) ?? `Promoted legacy workflow ${workflowId}.`,
      resourceKeys: readStringArray(resourcePolicy?.keys),
      retryMaxAttempts: readInteger(retryPolicy?.max_attempts),
      retryBackoffSeconds: readInteger(retryPolicy?.backoff_seconds),
      approvalRequired,
      source: {
        kind: artifactKind,
        artifact_path: toProjectPath(this.projectRoot, legacyPath)
      }
    });

    const legacyApprovalGate = readRecord(legacy.approval_gate);
    const legacyApprovalDecision = readString(legacyApprovalGate?.decision);
    const legacyApprovalStatus = readString(legacyApprovalGate?.status);
    const approvalNodeIndex = artifact.nodes.findIndex(
      (node) => node.kind === "approval_gate"
    );
    const approvalNode = artifact.nodes[approvalNodeIndex];
    if (
      approvalNode !== undefined &&
      legacyApprovalStatus === "decided" &&
      legacyApprovalDecision === "approve"
    ) {
      artifact.nodes[approvalNodeIndex] = transitionWorkflowNode(approvalNode, {
        type: "complete",
        at: this.now().toISOString(),
        outputDigest: digest({
          approval_id: approvalId,
          decision: legacyApprovalDecision
        })
      });
    } else if (
      approvalNode !== undefined &&
      approvalNode.status === "pending" &&
      legacyApprovalStatus !== undefined
    ) {
      artifact.nodes[approvalNodeIndex] = transitionWorkflowNode(approvalNode, {
        type: "wait_approval",
        at: this.now().toISOString(),
        blocker: "approval_pending"
      });
    }

    const queueItemId = readString(legacy.queue_item_id);
    if (queueItemId !== undefined) {
      const taskNodeIndex = artifact.nodes.findIndex((node) => node.kind === "task");
      const queueItem = (await new WorkQueue(this.projectRoot).list()).find(
        (item) => item.id === queueItemId
      );
      const taskNode = artifact.nodes[taskNodeIndex];
      artifact.nodes[taskNodeIndex] = {
        ...taskNode,
        status:
          queueItem?.status === "completed"
            ? "completed"
            : queueItem?.status === "failed"
              ? "failed"
              : queueItem?.status === "claimed"
                ? "running"
                : "dispatched",
        attempt: Math.max(queueItem?.attempts ?? 1, 1),
        queue_item_id: queueItemId,
        run_id: readString(queueItem?.result?.run_id),
        idempotency_key: queueItem?.idempotency_key,
        output_digest:
          queueItem?.result === undefined ? undefined : digest(queueItem.result),
        updated_at: this.now().toISOString()
      };
    }

    artifact.status = deriveControlledWorkflowStatus(
      artifact.nodes,
      artifact.control
    );
    return artifact;
  }

  private async createArtifact(input: {
    workflowId: string;
    correlationId?: string;
    taskId: string;
    approvalId?: string;
    objective?: string;
    resourceKeys?: string[];
    retryMaxAttempts?: number;
    retryBackoffSeconds?: number;
    approvalRequired?: boolean;
    source: WorkflowRunArtifact["source"];
  }): Promise<WorkflowRunArtifact> {
    let task: TaskRecord | undefined;
    try {
      task = await readJsonFile<TaskRecord>(
        resolveInside(
          getKaironPaths(this.projectRoot).tasksDir,
          input.taskId,
          "task.json"
        )
      );
    } catch (error) {
      if (input.source.kind === "new" || !isMissingJsonFile(error)) {
        throw error;
      }
    }
    const now = this.now().toISOString();
    const approvalRequired =
      input.approvalRequired ??
      (task?.approval_required === true || input.approvalId !== undefined);
    const maxAttempts = input.retryMaxAttempts ?? 1;
    assertRetryPolicy(maxAttempts, input.retryBackoffSeconds ?? 0);
    const resourceKeys = uniqueStrings(
      input.resourceKeys ?? [`.kairon/tasks/${input.taskId}`]
    );
    const approvalNode: WorkflowNodeState = {
      id: "approval_gate",
      kind: "approval_gate",
      status: approvalRequired ? "pending" : "skipped",
      dependencies: [],
      attempt: 0,
      max_attempts: 1,
      input_digest: digest({
        approval_id: input.approvalId,
        required: approvalRequired
      }),
      approval_id: input.approvalId,
      resource_locks: [],
      blocker:
        approvalRequired && input.approvalId === undefined
          ? "approval_id_missing"
          : undefined,
      updated_at: now,
      completed_at: approvalRequired ? undefined : now
    };
    const taskNode: WorkflowNodeState = {
      id: `task_${input.taskId}`,
      kind: "task",
      status: "pending",
      dependencies: [approvalNode.id],
      attempt: 0,
      max_attempts: maxAttempts,
      input_digest: digest({ task_id: input.taskId, resource_keys: resourceKeys }),
      task_id: input.taskId,
      resource_locks: [],
      updated_at: now
    };

    return {
      schema_version: "0.1",
      artifact_kind: "workflow_run",
      runtime: "kairon_workflow_runtime",
      workflow_id: input.workflowId,
      correlation_id: input.correlationId,
      status: "ready",
      sequence: 0,
      objective: input.objective ?? task?.title ?? `Legacy workflow ${input.workflowId}`,
      task_id: input.taskId,
      approval_id: input.approvalId,
      resource_keys: resourceKeys,
      retry_policy: {
        max_attempts: maxAttempts,
        backoff_seconds: input.retryBackoffSeconds ?? 0
      },
      nodes: [approvalNode, taskNode],
      edges: [{ from: approvalNode.id, to: taskNode.id }],
      source: input.source,
      recovery: {
        last_action: "created",
        reconciled_queue_item_ids: []
      },
      control: createWorkflowControlState(),
      created_at: now,
      updated_at: now
    };
  }

  private async reconcile(
    artifact: WorkflowRunArtifact,
    actions: string[]
  ): Promise<void> {
    const now = this.now().toISOString();
    const approvals = await new ApprovalQueue(this.projectRoot).list({ status: "all" });
    const queueItems = await new WorkQueue(this.projectRoot).list();
    const reconciled = new Set(artifact.recovery.reconciled_queue_item_ids);

    for (let index = 0; index < artifact.nodes.length; index += 1) {
      let node = artifact.nodes[index];
      if (
        node.kind === "approval_gate" &&
        !["completed", "skipped", "failed", "cancelled"].includes(node.status)
      ) {
        node = this.reconcileApprovalNode(node, approvals, now, actions);
        artifact.nodes[index] = node;
        continue;
      }

      if (node.kind !== "task" || node.queue_item_id === undefined || node.status === "completed") {
        continue;
      }

      const queueItem = queueItems.find((item) => item.id === node.queue_item_id);
      if (queueItem === undefined) {
        continue;
      }
      reconciled.add(queueItem.id);

      if (queueItem.status === "ready") {
        node.status = "dispatched";
        node.updated_at = now;
      } else if (queueItem.status === "claimed") {
        if (node.status === "dispatched") {
          node = transitionWorkflowNode(node, { type: "start", at: now });
        }
      } else if (queueItem.status === "completed") {
        if (!["completed", "skipped", "cancelled"].includes(node.status)) {
          node = transitionWorkflowNode(node, {
            type: "complete",
            at: queueItem.completed_at ?? now,
            outputDigest: digest(queueItem.result ?? {}),
            runId: readString(queueItem.result?.run_id)
          });
          await this.releaseResourceLocks(node.resource_locks);
          actions.push(`completed:${node.id}:${queueItem.id}`);
        }
      } else if (queueItem.status === "failed") {
        await this.releaseResourceLocks(node.resource_locks);
        if (node.status !== "failed") {
          node = transitionWorkflowNode(node, {
            type: "fail",
            at: queueItem.failed_at ?? now,
            error: queueItem.error?.message ?? "Queue item failed."
          });
        }
        if (node.attempt < node.max_attempts) {
          node = transitionWorkflowNode(node, { type: "retry", at: now });
          actions.push(`retry_ready:${node.id}:${queueItem.id}`);
        }
      }
      artifact.nodes[index] = node;
    }

    artifact.recovery.reconciled_queue_item_ids = [...reconciled].sort();
    artifact.status = deriveControlledWorkflowStatus(
      artifact.nodes,
      artifact.control
    );
  }

  private reconcileApprovalNode(
    node: WorkflowNodeState,
    approvals: ApprovalRecord[],
    now: string,
    actions: string[]
  ): WorkflowNodeState {
    if (node.approval_id === undefined) {
      return transitionWorkflowNode(node, {
        type: "wait_approval",
        at: now,
        blocker: "approval_id_missing"
      });
    }

    const approval = approvals.find((candidate) => candidate.id === node.approval_id);
    if (approval === undefined) {
      return transitionWorkflowNode(node, {
        type: "wait_approval",
        at: now,
        blocker: "approval_not_found"
      });
    }

    if (approval.status !== "decided") {
      return transitionWorkflowNode(node, {
        type: "wait_approval",
        at: now,
        blocker: "approval_pending"
      });
    }

    const decision = readString(approval.decision);
    if (decision === "approve") {
      actions.push(`approval_completed:${node.id}:${approval.id}`);
      return transitionWorkflowNode(node, {
        type: "complete",
        at: now,
        outputDigest: digest({ approval_id: approval.id, decision })
      });
    }

    actions.push(`approval_failed:${node.id}:${approval.id}`);
    return transitionWorkflowNode(node, {
      type: "fail",
      at: now,
      error: `Approval decision is not approve: ${decision ?? "unknown"}`
    });
  }

  private async advance(
    artifact: WorkflowRunArtifact,
    actions: string[]
  ): Promise<void> {
    if (artifact.control?.mode !== "active") {
      artifact.status = deriveControlledWorkflowStatus(
        artifact.nodes,
        artifact.control
      );
      return;
    }
    for (let index = 0; index < artifact.nodes.length; index += 1) {
      const node = artifact.nodes[index];
      if (node.status !== "pending") {
        continue;
      }
      if (!dependenciesCompleted(node, artifact.nodes)) {
        continue;
      }

      if (node.kind === "approval_gate") {
        artifact.nodes[index] = transitionWorkflowNode(node, {
          type: "wait_approval",
          at: this.now().toISOString(),
          blocker: node.approval_id === undefined ? "approval_id_missing" : "approval_pending"
        });
        continue;
      }

      const dispatch = await this.dispatchTaskNode(artifact, node);
      artifact.nodes[index] = dispatch.node;
      actions.push(dispatch.action);
      break;
    }

    artifact.status = deriveControlledWorkflowStatus(
      artifact.nodes,
      artifact.control
    );
  }

  private async dispatchTaskNode(
    artifact: WorkflowRunArtifact,
    node: WorkflowNodeState
  ): Promise<{ node: WorkflowNodeState; action: string }> {
    if (node.task_id === undefined) {
      return {
        node: transitionWorkflowNode(node, {
          type: "fail",
          at: this.now().toISOString(),
          error: "Workflow task node is missing task_id."
        }),
        action: `failed:${node.id}:task_id_missing`
      };
    }

    const attempt = node.attempt + 1;
    const idempotencyKey = `${artifact.workflow_id}:${node.id}:${attempt}`;
    const existing = (await new WorkQueue(this.projectRoot).list()).find(
      (item) => item.idempotency_key === idempotencyKey
    );
    if (existing !== undefined) {
      const existingMetadata = existing.metadata?.production_workflow;
      if (
        existingMetadata === undefined ||
        existingMetadata.workflow_id !== artifact.workflow_id ||
        existingMetadata.node_id !== node.id
      ) {
        throw new Error(
          `Workflow idempotency key is owned by incompatible queue metadata: ${idempotencyKey}`
        );
      }
      return {
        node: transitionWorkflowNode(node, {
          type: "dispatch",
          at: this.now().toISOString(),
          attempt,
          queueItemId: existing.id,
          idempotencyKey,
          fencingToken: existingMetadata.fencing_token,
          resourceLocks: existingMetadata.resource_locks
        }),
        action: `dispatch_reused:${node.id}:${existing.id}`
      };
    }

    const fencingToken = randomUUID();
    const lockResult = await this.acquireResourceLocks(
      artifact,
      node,
      fencingToken
    );
    if (!lockResult.acquired) {
      return {
        node: {
          ...node,
          blocker: "resource_lock_conflict",
          updated_at: this.now().toISOString()
        },
        action: `paused:${node.id}:resource_lock_conflict`
      };
    }

    const metadata: ProductionWorkflowQueueMetadata = {
      schema_version: "0.1",
      workflow_id: artifact.workflow_id,
      node_id: node.id,
      idempotency_key: idempotencyKey,
      fencing_token: fencingToken,
      resource_locks: lockResult.locks,
      run_artifact_path: toProjectPath(
        this.projectRoot,
        workflowRunArtifactPath(this.projectRoot, artifact.workflow_id)
      ),
      feature_flag: "KAIRON_WORKFLOW_RUNTIME",
      cancellation_token: artifact.control?.cancellation_token,
      control_generation: artifact.control?.generation
    };
    const enqueueResult = await new TaskRunner(this.projectRoot, {
      now: this.options.now
    }).enqueueTaskWithResult({
      taskId: node.task_id,
      metadata: { production_workflow: metadata },
      idempotencyKey,
      createdAt: this.now()
    });

    if (!enqueueResult.created) {
      await this.releaseResourceLocks(lockResult.locks);
      const existingMetadata = enqueueResult.item.metadata?.production_workflow;
      if (existingMetadata === undefined) {
        throw new Error(
          `Idempotent workflow queue item is missing metadata: ${enqueueResult.item.id}`
        );
      }
      metadata.fencing_token = existingMetadata.fencing_token;
      metadata.resource_locks = existingMetadata.resource_locks;
    }

    return {
      node: transitionWorkflowNode(node, {
        type: "dispatch",
        at: this.now().toISOString(),
        attempt,
        queueItemId: enqueueResult.item.id,
        idempotencyKey,
        fencingToken: metadata.fencing_token,
        resourceLocks: metadata.resource_locks
      }),
      action: `${enqueueResult.created ? "dispatched" : "dispatch_reused"}:${node.id}:${enqueueResult.item.id}`
    };
  }

  private async acquireResourceLocks(
    artifact: WorkflowRunArtifact,
    node: WorkflowNodeState,
    fencingToken: string
  ): Promise<{ acquired: true; locks: WorkflowResourceLock[] } | { acquired: false }> {
    const handles: ResourceLockHandle[] = [];
    try {
      for (const resource of artifact.resource_keys) {
        handles.push(
          await acquireResourceLock(this.projectRoot, resource, {
            owner: `workflow:${artifact.workflow_id}:${node.id}`,
            fencingToken,
            now: this.now(),
            ttlMs: this.options.resourceLockTtlMs ?? 86_400_000
          })
        );
      }
    } catch (error) {
      await Promise.all(handles.map((handle) => releaseResourceLock(handle)));
      if (error instanceof ResourceLockAlreadyExistsError) {
        return { acquired: false };
      }
      throw error;
    }

    return {
      acquired: true,
      locks: handles.map((handle) => ({
        resource: handle.data.resource,
        lock_path: toProjectPath(this.projectRoot, handle.path),
        fencing_token: handle.data.fencing_token
      }))
    };
  }

  private async assertResourceLocks(
    metadata: ProductionWorkflowQueueMetadata
  ): Promise<void> {
    if (metadata.resource_locks.some((lock) => lock.fencing_token !== metadata.fencing_token)) {
      throw new Error(
        `Workflow resource lock fencing token mismatch: ${metadata.workflow_id}/${metadata.node_id}`
      );
    }

    for (const lock of metadata.resource_locks) {
      const lockPath = resolveInside(this.projectRoot, lock.lock_path);
      const data = await readJsonFile<ResourceLockData>(lockPath);
      await assertResourceLockFencingToken(
        { path: lockPath, data: { ...data, fencing_token: lock.fencing_token } },
        { now: this.now() }
      );
    }
  }

  private async releaseResourceLocks(
    locks: WorkflowResourceLock[]
  ): Promise<void> {
    for (const lock of locks) {
      const lockPath = resolveInside(this.projectRoot, lock.lock_path);
      try {
        const data = await readJsonFile<ResourceLockData>(lockPath);
        await releaseResourceLock({
          path: lockPath,
          data: { ...data, fencing_token: lock.fencing_token }
        });
      } catch (error) {
        if (!isMissingJsonFile(error)) {
          throw error;
        }
      }
    }
  }

  private async persist(
    artifact: WorkflowRunArtifact,
    action: WorkflowRunArtifact["recovery"]["last_action"]
  ): Promise<string> {
    const now = this.now().toISOString();
    artifact.sequence += 1;
    artifact.updated_at = now;
    artifact.status = deriveControlledWorkflowStatus(
      artifact.nodes,
      artifact.control
    );
    artifact.recovery.last_action = action;
    const checkpointPath = workflowCheckpointPath(
      this.projectRoot,
      artifact.workflow_id,
      artifact.sequence
    );
    artifact.recovery.last_checkpoint_path = toProjectPath(
      this.projectRoot,
      checkpointPath
    );
    await this.ensureCorrelation(artifact);
    await writeJsonFileAtomic(checkpointPath, artifact);
    await writeJsonFileAtomic(
      workflowRunArtifactPath(this.projectRoot, artifact.workflow_id),
      artifact
    );
    return artifact.recovery.last_checkpoint_path;
  }

  private async ensureCorrelation(artifact: WorkflowRunArtifact): Promise<void> {
    const previousCorrelationId = artifact.correlation_id;
    const correlation = await ensureWorkflowCorrelation(this.projectRoot, {
      workflowId: artifact.workflow_id,
      status: artifact.status,
      artifactPath:
        artifact.source.kind === "new" || artifact.source.artifact_path === undefined
          ? toProjectPath(
              this.projectRoot,
              workflowRunArtifactPath(this.projectRoot, artifact.workflow_id)
            )
          : artifact.source.artifact_path,
      correlationId: artifact.correlation_id,
      approvalId: artifact.approval_id,
      createdAt: artifact.updated_at
    });
    artifact.correlation_id = correlation.correlation_id;
    if (previousCorrelationId === undefined && artifact.source.kind === "new") {
      await writeJsonFileAtomic(
        workflowRunArtifactPath(this.projectRoot, artifact.workflow_id),
        artifact
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private assertEnabled(): void {
    if (!isProductionWorkflowRuntimeEnabled(this.options.env ?? process.env)) {
      throw new ProductionWorkflowRuntimeDisabledError();
    }
  }
}

function createWorkflowControlState(): WorkflowControlState {
  return {
    mode: "active",
    generation: 0,
    cancellation_token: randomUUID()
  };
}

function normalizeWorkflowArtifact(
  artifact: WorkflowRunArtifact
): WorkflowRunArtifact {
  artifact.control ??= createWorkflowControlState();
  artifact.status = deriveControlledWorkflowStatus(
    artifact.nodes,
    artifact.control
  );
  return artifact;
}

function isCancellationRequested(artifact: WorkflowRunArtifact): boolean {
  return (
    artifact.control?.mode === "cancellation_requested" ||
    artifact.control?.mode === "cancelled"
  );
}

function isTerminalNodeStatus(status: WorkflowNodeState["status"]): boolean {
  return ["completed", "skipped", "cancelled"].includes(status);
}

function cancellationResult(
  metadata: ProductionWorkflowQueueMetadata
): Record<string, unknown> {
  return {
    workflow_id: metadata.workflow_id,
    node_id: metadata.node_id,
    status: "cancelled",
    cooperative_cancellation: true
  };
}

export function workflowRunArtifactPath(
  projectRoot: string,
  workflowId: string
): string {
  return resolveInside(workflowRunsDirectory(projectRoot), `${workflowId}.json`);
}

export function workflowCheckpointPath(
  projectRoot: string,
  workflowId: string,
  sequence: number
): string {
  return resolveInside(
    workflowCheckpointsDirectory(projectRoot),
    `${workflowId}-${String(sequence).padStart(6, "0")}.json`
  );
}

export function isProductionWorkflowRuntimeEnabled(
  env: NodeJS.ProcessEnv
): boolean {
  const value = env.KAIRON_WORKFLOW_RUNTIME;
  return value === "1" || value?.toLowerCase() === "true";
}

export function formatProductionWorkflowResult(
  result: WorkflowRuntimeResult
): string {
  const artifact = result.artifact;
  return [
    result.dry_run
      ? "Kairon production workflow inspected."
      : "Kairon production workflow updated.",
    `workflow_id=${artifact.workflow_id}`,
    `status=${artifact.status}`,
    `sequence=${artifact.sequence}`,
    `task_id=${artifact.task_id}`,
    `checkpoint=${result.checkpoint_path ?? artifact.recovery.last_checkpoint_path ?? "none"}`,
    `source=${artifact.source.kind}`,
    `actions=${result.actions.length === 0 ? "none" : result.actions.join(",")}`,
    ...artifact.nodes.map(
      (node) =>
        `node.${node.id}=status:${node.status};attempt:${node.attempt};queue:${node.queue_item_id ?? "none"};run:${node.run_id ?? "none"};blocker:${node.blocker ?? "none"}`
    )
  ].join("\n");
}

function workflowRunsDirectory(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "workflows", "runs");
}

function workflowCheckpointsDirectory(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "checkpoints"
  );
}

function dependenciesCompleted(
  node: WorkflowNodeState,
  nodes: WorkflowNodeState[]
): boolean {
  return node.dependencies.every((dependencyId) => {
    const dependency = nodes.find((candidate) => candidate.id === dependencyId);
    return dependency !== undefined && ["completed", "skipped"].includes(dependency.status);
  });
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function assertWorkflowId(workflowId: string): void {
  if (!/^(?:WF|EXP-WF)-[A-Za-z0-9_-]+$/.test(workflowId)) {
    throw new Error("Invalid workflow id. Expected WF- or EXP-WF- prefix.");
  }
}

function assertRetryPolicy(maxAttempts: number, backoffSeconds: number): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Workflow retry max attempts must be between 1 and 10.");
  }
  if (!Number.isInteger(backoffSeconds) || backoffSeconds < 0 || backoffSeconds > 3600) {
    throw new Error("Workflow retry backoff seconds must be between 0 and 3600.");
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isMissingJsonFile(error: unknown): boolean {
  return String(error).includes("ENOENT");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
