import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { ApprovalQueue, type ApprovalRecord } from "../approvals/approval-queue.js";
import {
  WorkQueue,
  type QueueItem,
  type WorkflowRuntimeQueueMetadata
} from "../queue/work-queue.js";
import { TaskRunner, type TaskRecord } from "../tasks/task-runner.js";

export type ExperimentalWorkflowNodeStatus =
  | "completed"
  | "skipped"
  | "waiting"
  | "failed";

export type ExperimentalWorkflowNode = {
  id: string;
  kind:
    | "task_intake"
    | "agent_run"
    | "approval_gate"
    | "queue_intake"
    | "task_placeholder"
    | "production_handoff";
  status: ExperimentalWorkflowNodeStatus;
  summary: string;
  output: Record<string, unknown>;
};

export type ExperimentalWorkflowEdge = {
  from: string;
  to: string;
};

export type ExperimentalWorkflowRuntimeRequest = {
  experimental?: boolean;
  workflowId: string;
  taskId: string;
  objective: string;
  agent?: string;
  agentOutcome?: "completed" | "setup_required" | "failed";
  approvalRequired?: boolean;
};

export type ExperimentalWorkflowArtifact = {
  schema_version: string;
  artifact_kind: "experimental_workflow_runtime_spike";
  runtime: "langgraph_runtime_spike";
  experimental: true;
  workflow_id: string;
  task_id: string;
  status: "completed" | "waiting_for_approval" | "failed";
  nodes: ExperimentalWorkflowNode[];
  edges: ExperimentalWorkflowEdge[];
  state_boundary: {
    production_runtime_touched: false;
    queue_touched: false;
    task_runner_touched: false;
    review_loop_touched: false;
    state_applier_touched: false;
    artifact_path: string;
  };
  dependency_assessment: {
    langgraph_dependency_added: false;
    recommendation: "defer_dependency_until_value_is_proven";
    reasons: string[];
  };
  created_at: string;
};

export type RunExperimentalWorkflowOptions = {
  now?: () => Date;
  writeArtifact?: boolean;
};

export type WorkflowRuntimeCandidateRequest = {
  candidate?: boolean;
  dryRun?: boolean;
  connectQueue?: boolean;
  workflowId?: string;
  taskId?: string;
  queueItemId?: string;
  approvalId?: string;
  objective?: string;
  resourceLocks?: string[];
  retryMaxAttempts?: number;
  retryBackoffSeconds?: number;
};

export type WorkflowRuntimeCandidateStatus =
  | "candidate_ready"
  | "waiting_for_approval"
  | "blocked";

export type WorkflowRuntimeCandidateArtifact = {
  schema_version: "0.1";
  artifact_kind: "workflow_runtime_candidate";
  runtime: "kairon_workflow_runtime_candidate";
  experimental: true;
  candidate: true;
  dry_run: boolean;
  workflow_id: string;
  status: WorkflowRuntimeCandidateStatus;
  task_id?: string;
  queue_item_id?: string;
  approval_id?: string;
  objective: string;
  nodes: ExperimentalWorkflowNode[];
  edges: ExperimentalWorkflowEdge[];
  queue_intake: WorkflowRuntimeQueueIntake;
  task_placeholder: WorkflowRuntimeTaskPlaceholder;
  approval_gate: WorkflowRuntimeApprovalGate;
  queue_connection: WorkflowRuntimeQueueConnection;
  execution_policy: WorkflowRuntimeExecutionPolicy;
  recovery: WorkflowRuntimeRecoveryReference;
  production_boundary: {
    feature_flag: "KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME";
    flag_enabled: true;
    production_runtime_touched: boolean;
    queue_read: boolean;
    queue_enqueued: boolean;
    queue_claimed: false;
    queue_completed: false;
    approval_read: boolean;
    approval_created: false;
    task_read: boolean;
    task_runner_touched: boolean;
    state_applier_touched: false;
    artifact_path: string;
  };
  recommendation: {
    ready_for_runtime_integration: boolean;
    blockers: string[];
    next_steps: string[];
  };
  created_at: string;
};

export type WorkflowRuntimeRecoveryArtifact = {
  schema_version: "0.1";
  artifact_kind: "workflow_runtime_queue_recovery";
  workflow_id: string;
  task_id: string;
  queue_item_id: string;
  status: "queued";
  retry_policy: WorkflowRuntimeExecutionPolicy["retry_policy"];
  resource_locks: WorkflowRuntimeExecutionPolicy["resource_locks"];
  recovery: {
    expired_claim: "work_queue_requeues_after_claim_ttl";
    dispatch_failure: "queue_worker_marks_item_failed";
  };
  rollback: {
    automatic: false;
    strategy: "fail_queue_item_before_claim";
    operator_steps: string[];
  };
  artifact_path: string;
  created_at: string;
};

export type RunWorkflowRuntimeCandidateOptions = {
  now?: () => Date;
  writeArtifact?: boolean;
  env?: NodeJS.ProcessEnv;
};

type WorkflowRuntimeQueueIntake = {
  requested: boolean;
  found: boolean;
  item_id?: string;
  item_type?: QueueItem["type"];
  item_status?: QueueItem["status"];
  task_id?: string;
  schedule_mode?: QueueItem["schedule_mode"];
};

type WorkflowRuntimeTaskPlaceholder = {
  requested: boolean;
  found: boolean;
  task_id?: string;
  status?: string;
  persona?: string;
  approval_required?: boolean;
  code_producing?: boolean;
};

type WorkflowRuntimeApprovalGate = {
  requested: boolean;
  found: boolean;
  approval_id?: string;
  status?: string;
  type?: string;
  decision?: string;
};

type WorkflowRuntimeQueueConnection = {
  requested: boolean;
  status: "not_requested" | "blocked" | "connected";
  queue_item_id?: string;
  queue_item_type?: QueueItem["type"];
  reason?: string;
};

type WorkflowRuntimeExecutionPolicy = {
  approval_gate: {
    required: boolean;
    approval_id?: string;
    status: string;
  };
  resource_locks: WorkflowRuntimeQueueMetadata["resource_locks"];
  retry_policy: WorkflowRuntimeQueueMetadata["retry_policy"];
};

type WorkflowRuntimeRecoveryReference = {
  required: boolean;
  artifact_path: string;
  written: boolean;
  rollback_strategy: WorkflowRuntimeQueueMetadata["rollback"]["strategy"];
};

export class WorkflowRuntimeCandidateDisabledError extends Error {
  constructor() {
    super(
      "Workflow runtime candidate requires KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME=1."
    );
    this.name = "WorkflowRuntimeCandidateDisabledError";
  }
}

export async function runExperimentalWorkflowRuntimeSpike(
  projectRoot: string,
  request: ExperimentalWorkflowRuntimeRequest,
  options: RunExperimentalWorkflowOptions = {}
): Promise<ExperimentalWorkflowArtifact> {
  const artifact = evaluateExperimentalWorkflowRuntime(projectRoot, request, {
    now: options.now
  });

  if (options.writeArtifact !== false) {
    await writeJsonFileAtomic(
      experimentalWorkflowArtifactPath(projectRoot, request.workflowId),
      artifact
    );
  }

  return artifact;
}

export async function runWorkflowRuntimeCandidate(
  projectRoot: string,
  request: WorkflowRuntimeCandidateRequest,
  options: RunWorkflowRuntimeCandidateOptions = {}
): Promise<WorkflowRuntimeCandidateArtifact> {
  assertWorkflowCandidateRequest(request);

  if (!isWorkflowRuntimeCandidateEnabled(options.env ?? process.env)) {
    throw new WorkflowRuntimeCandidateDisabledError();
  }

  if (request.connectQueue === true && options.writeArtifact === false) {
    throw new Error(
      "Workflow runtime queue connection requires candidate and recovery artifacts."
    );
  }

  const artifact = await evaluateWorkflowRuntimeCandidate(projectRoot, request, {
    now: options.now
  });

  if (request.connectQueue === true) {
    await connectWorkflowRuntimeCandidate(projectRoot, artifact, options);
  }

  if (options.writeArtifact !== false) {
    try {
      await writeJsonFileAtomic(
        experimentalWorkflowArtifactPath(projectRoot, artifact.workflow_id),
        artifact
      );
    } catch (error) {
      if (
        artifact.queue_connection.status === "connected" &&
        artifact.queue_item_id !== undefined
      ) {
        await new WorkQueue(projectRoot).fail(artifact.queue_item_id, {
          message: "Workflow candidate artifact write failed after enqueue.",
          code: "workflow_candidate_artifact_write_failed"
        });
      }
      throw error;
    }
  }

  return artifact;
}

export function evaluateExperimentalWorkflowRuntime(
  projectRoot: string,
  request: ExperimentalWorkflowRuntimeRequest,
  options: Pick<RunExperimentalWorkflowOptions, "now"> = {}
): ExperimentalWorkflowArtifact {
  assertExperimentalRequest(request);

  const agentOutcome = request.agentOutcome ?? "completed";
  const approvalRequired = request.approvalRequired ?? false;
  const nodes = buildNodes(request, agentOutcome, approvalRequired);
  const status = deriveWorkflowStatus(agentOutcome, approvalRequired);
  const artifactPath = experimentalWorkflowArtifactPath(
    projectRoot,
    request.workflowId
  );

  return {
    schema_version: "0.1",
    artifact_kind: "experimental_workflow_runtime_spike",
    runtime: "langgraph_runtime_spike",
    experimental: true,
    workflow_id: request.workflowId,
    task_id: request.taskId,
    status,
    nodes,
    edges: [
      { from: "task_intake", to: "agent_run_placeholder" },
      { from: "agent_run_placeholder", to: "approval_gate_placeholder" }
    ],
    state_boundary: {
      production_runtime_touched: false,
      queue_touched: false,
      task_runner_touched: false,
      review_loop_touched: false,
      state_applier_touched: false,
      artifact_path: toProjectPath(projectRoot, artifactPath)
    },
    dependency_assessment: {
      langgraph_dependency_added: false,
      recommendation: "defer_dependency_until_value_is_proven",
      reasons: [
        "The spike must not alter the production file-based runtime path.",
        "A dependency should be added only after a graph runtime proves operational value.",
        "The artifact shape can be evaluated without changing queue, task, review, or state contracts."
      ]
    },
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
}

export async function evaluateWorkflowRuntimeCandidate(
  projectRoot: string,
  request: WorkflowRuntimeCandidateRequest,
  options: Pick<RunWorkflowRuntimeCandidateOptions, "now"> = {}
): Promise<WorkflowRuntimeCandidateArtifact> {
  assertWorkflowCandidateRequest(request);

  const workflowId = request.workflowId ?? defaultCandidateWorkflowId(options.now?.() ?? new Date());
  const queueItem = await readQueueItem(projectRoot, request.queueItemId);
  const effectiveTaskId = request.taskId ?? queueItem?.task_id;
  const task = await readTask(projectRoot, effectiveTaskId);
  const approval = await readApproval(projectRoot, request.approvalId);
  const queueIntake = buildQueueIntake(request.queueItemId, queueItem);
  const taskPlaceholder = buildTaskPlaceholder(effectiveTaskId, task);
  const approvalGate = buildApprovalGate(request.approvalId, approval);
  const blockers = [
    ...queueBlockers(queueIntake),
    ...taskBlockers(taskPlaceholder),
    ...approvalBlockers(approvalGate),
    ...queueConnectionBlockers(
      request,
      effectiveTaskId,
      taskPlaceholder,
      approvalGate
    )
  ];
  const status = deriveCandidateStatus(blockers, approvalGate);
  const artifactPath = experimentalWorkflowArtifactPath(projectRoot, workflowId);
  const recoveryPath = workflowRuntimeRecoveryArtifactPath(projectRoot, workflowId);
  const executionPolicy = buildExecutionPolicy(
    request,
    effectiveTaskId,
    taskPlaceholder,
    approvalGate
  );

  return {
    schema_version: "0.1",
    artifact_kind: "workflow_runtime_candidate",
    runtime: "kairon_workflow_runtime_candidate",
    experimental: true,
    candidate: true,
    dry_run: request.connectQueue !== true,
    workflow_id: workflowId,
    status,
    task_id: effectiveTaskId,
    queue_item_id: request.queueItemId,
    approval_id: request.approvalId,
    objective: request.objective ?? "Evaluate workflow runtime production candidate.",
    nodes: buildCandidateNodes(queueIntake, taskPlaceholder, approvalGate, blockers),
    edges: [
      { from: "queue_intake", to: "task_placeholder" },
      { from: "task_placeholder", to: "approval_gate" },
      { from: "approval_gate", to: "production_handoff" }
    ],
    queue_intake: queueIntake,
    task_placeholder: taskPlaceholder,
    approval_gate: approvalGate,
    queue_connection: {
      requested: request.connectQueue === true,
      status: request.connectQueue === true ? "blocked" : "not_requested",
      reason:
        request.connectQueue === true
          ? queueConnectionReason(status, blockers)
          : undefined
    },
    execution_policy: executionPolicy,
    recovery: {
      required: request.connectQueue === true,
      artifact_path: toProjectPath(projectRoot, recoveryPath),
      written: false,
      rollback_strategy: "fail_queue_item_before_claim"
    },
    production_boundary: {
      feature_flag: "KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME",
      flag_enabled: true,
      production_runtime_touched: false,
      queue_read: request.queueItemId !== undefined,
      queue_enqueued: false,
      queue_claimed: false,
      queue_completed: false,
      approval_read: request.approvalId !== undefined,
      approval_created: false,
      task_read: effectiveTaskId !== undefined,
      task_runner_touched: false,
      state_applier_touched: false,
      artifact_path: toProjectPath(projectRoot, artifactPath)
    },
    recommendation: {
      ready_for_runtime_integration:
        blockers.length === 0 && approvalGateReadyForIntegration(approvalGate),
      blockers,
      next_steps: candidateNextSteps(blockers, approvalGate)
    },
    created_at: (options.now?.() ?? new Date()).toISOString()
  };
}

export function formatWorkflowRuntimeCandidate(
  artifact: WorkflowRuntimeCandidateArtifact
): string {
  return [
    "Kairon workflow runtime candidate generated.",
    `workflow_id=${artifact.workflow_id}`,
    `status=${artifact.status}`,
    "candidate=true",
    `dry_run=${artifact.dry_run}`,
    `execution_allowed=${artifact.queue_connection.status === "connected"}`,
    `artifact=${artifact.production_boundary.artifact_path}`,
    `queue_item=${artifact.queue_intake.item_id ?? "not_requested"}`,
    `queue_intake=${nodeStatus(artifact.nodes, "queue_intake")}`,
    `queue_connection=${artifact.queue_connection.status}`,
    `recovery_artifact=${artifact.recovery.artifact_path}`,
    `task=${artifact.task_placeholder.task_id ?? "not_requested"}`,
    `task_placeholder=${nodeStatus(artifact.nodes, "task_placeholder")}`,
    `approval=${artifact.approval_gate.approval_id ?? "not_requested"}`,
    `approval_gate=${nodeStatus(artifact.nodes, "approval_gate")}`,
    `ready_for_runtime_integration=${artifact.recommendation.ready_for_runtime_integration}`,
    `blockers=${artifact.recommendation.blockers.length === 0 ? "none" : artifact.recommendation.blockers.join(";")}`,
    ...artifact.recommendation.next_steps.map((step) => `next_step=${step}`)
  ].join("\n");
}

export function formatWorkflowRuntimeCandidateRejected(
  reason: string
): string {
  return [
    "Kairon workflow runtime candidate rejected.",
    "candidate=true",
    "dry_run=true",
    "execution_allowed=false",
    `reason=${reason}`
  ].join("\n");
}

export function experimentalWorkflowArtifactPath(
  projectRoot: string,
  workflowId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "experimental",
    "workflows",
    `${workflowId}.json`
  );
}

export function workflowRuntimeRecoveryArtifactPath(
  projectRoot: string,
  workflowId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "experimental",
    "workflows",
    `${workflowId}-recovery.json`
  );
}

export function isWorkflowRuntimeCandidateEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME;
  return value === "1" || value?.toLowerCase() === "true";
}

function assertExperimentalRequest(
  request: ExperimentalWorkflowRuntimeRequest
): void {
  if (request.experimental !== true) {
    throw new Error(
      "Experimental workflow runtime requires experimental=true."
    );
  }

  if (!/^EXP-WF-[A-Za-z0-9_-]+$/.test(request.workflowId)) {
    throw new Error("Invalid workflow id. Expected prefix EXP-WF-.");
  }

  if (request.taskId.trim().length === 0) {
    throw new Error("Experimental workflow runtime requires taskId.");
  }

  if (request.objective.trim().length === 0) {
    throw new Error("Experimental workflow runtime requires objective.");
  }
}

function assertWorkflowCandidateRequest(
  request: WorkflowRuntimeCandidateRequest
): void {
  if (request.candidate !== true) {
    throw new Error("Workflow runtime candidate requires candidate=true.");
  }

  if (request.dryRun === false && request.connectQueue !== true) {
    throw new Error("Workflow runtime candidate only supports dry_run=true.");
  }

  if (request.connectQueue === true && request.queueItemId !== undefined) {
    throw new Error(
      "Workflow runtime queue connection cannot reuse an existing queue item."
    );
  }

  if (
    request.workflowId !== undefined &&
    !/^EXP-WF-[A-Za-z0-9_-]+$/.test(request.workflowId)
  ) {
    throw new Error("Invalid workflow id. Expected prefix EXP-WF-.");
  }

  if (request.taskId !== undefined && request.taskId.trim().length === 0) {
    throw new Error("Workflow runtime candidate taskId must not be empty.");
  }

  if (request.objective !== undefined && request.objective.trim().length === 0) {
    throw new Error("Workflow runtime candidate objective must not be empty.");
  }

  if (
    request.retryMaxAttempts !== undefined &&
    (!Number.isInteger(request.retryMaxAttempts) ||
      request.retryMaxAttempts < 1 ||
      request.retryMaxAttempts > 10)
  ) {
    throw new Error("Workflow runtime retryMaxAttempts must be between 1 and 10.");
  }

  if (
    request.retryBackoffSeconds !== undefined &&
    (!Number.isInteger(request.retryBackoffSeconds) ||
      request.retryBackoffSeconds < 0 ||
      request.retryBackoffSeconds > 3600)
  ) {
    throw new Error(
      "Workflow runtime retryBackoffSeconds must be between 0 and 3600."
    );
  }
}

function buildNodes(
  request: ExperimentalWorkflowRuntimeRequest,
  agentOutcome: NonNullable<ExperimentalWorkflowRuntimeRequest["agentOutcome"]>,
  approvalRequired: boolean
): ExperimentalWorkflowNode[] {
  return [
    {
      id: "task_intake",
      kind: "task_intake",
      status: "completed",
      summary: "Accepted an experimental task input without touching WorkQueue.",
      output: {
        task_id: request.taskId,
        objective: request.objective
      }
    },
    {
      id: "agent_run_placeholder",
      kind: "agent_run",
      status: agentOutcome === "setup_required" ? "waiting" : agentOutcome,
      summary: "Represented an agent run as a placeholder node only.",
      output: {
        agent: request.agent ?? "unassigned",
        outcome: agentOutcome
      }
    },
    {
      id: "approval_gate_placeholder",
      kind: "approval_gate",
      status:
        agentOutcome === "failed"
          ? "skipped"
          : approvalRequired
            ? "waiting"
            : "skipped",
      summary: "Represented approval gating without creating an approval.",
      output: {
        approval_required: approvalRequired
      }
    }
  ];
}

function deriveWorkflowStatus(
  agentOutcome: NonNullable<ExperimentalWorkflowRuntimeRequest["agentOutcome"]>,
  approvalRequired: boolean
): ExperimentalWorkflowArtifact["status"] {
  if (agentOutcome === "failed") {
    return "failed";
  }

  return approvalRequired || agentOutcome === "setup_required"
    ? "waiting_for_approval"
    : "completed";
}

async function connectWorkflowRuntimeCandidate(
  projectRoot: string,
  artifact: WorkflowRuntimeCandidateArtifact,
  options: RunWorkflowRuntimeCandidateOptions
): Promise<void> {
  if (artifact.status !== "candidate_ready" || artifact.task_id === undefined) {
    artifact.queue_connection = {
      requested: true,
      status: "blocked",
      reason: queueConnectionReason(
        artifact.status,
        artifact.recommendation.blockers
      )
    };
    return;
  }

  const metadata = buildWorkflowQueueMetadata(artifact);
  const queueItem = await new TaskRunner(projectRoot, {
    now: options.now
  }).enqueueTask({
    taskId: artifact.task_id,
    metadata: { workflow_runtime: metadata },
    createdAt: options.now?.()
  });
  const queueIntake = buildQueueIntake(queueItem.id, queueItem);

  artifact.queue_item_id = queueItem.id;
  artifact.queue_intake = queueIntake;
  artifact.queue_connection = {
    requested: true,
    status: "connected",
    queue_item_id: queueItem.id,
    queue_item_type: queueItem.type
  };
  artifact.production_boundary.queue_enqueued = true;
  artifact.production_boundary.task_runner_touched = true;
  artifact.nodes = buildCandidateNodes(
    queueIntake,
    artifact.task_placeholder,
    artifact.approval_gate,
    []
  );

  const handoff = artifact.nodes.find((node) => node.id === "production_handoff");
  if (handoff !== undefined) {
    handoff.status = "completed";
    handoff.summary = "Candidate was queued; RuntimeLoop dispatch remains feature-flagged.";
    handoff.output = {
      production_runtime_touched: false,
      queue_item_id: queueItem.id,
      blockers: []
    };
  }

  const recoveryArtifact = buildRecoveryArtifact(
    projectRoot,
    artifact,
    queueItem,
    options.now?.() ?? new Date()
  );
  try {
    await writeJsonFileAtomic(
      workflowRuntimeRecoveryArtifactPath(projectRoot, artifact.workflow_id),
      recoveryArtifact
    );
  } catch (error) {
    await new WorkQueue(projectRoot).fail(queueItem.id, {
      message: "Workflow recovery artifact write failed after enqueue.",
      code: "workflow_recovery_artifact_write_failed"
    });
    throw error;
  }
  artifact.recovery.written = true;
  artifact.recommendation.next_steps = [
    "Run RuntimeLoop with the workflow feature flag enabled to dispatch the queued candidate."
  ];
}

function buildWorkflowQueueMetadata(
  artifact: WorkflowRuntimeCandidateArtifact
): WorkflowRuntimeQueueMetadata {
  return {
    schema_version: "0.1",
    workflow_id: artifact.workflow_id,
    candidate_artifact_path: artifact.production_boundary.artifact_path,
    feature_flag: "KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME",
    approval_gate: artifact.execution_policy.approval_gate,
    resource_locks: artifact.execution_policy.resource_locks,
    retry_policy: artifact.execution_policy.retry_policy,
    recovery_artifact_path: artifact.recovery.artifact_path,
    rollback: {
      strategy: artifact.recovery.rollback_strategy,
      automatic: false
    }
  };
}

function buildRecoveryArtifact(
  projectRoot: string,
  artifact: WorkflowRuntimeCandidateArtifact,
  queueItem: QueueItem,
  now: Date
): WorkflowRuntimeRecoveryArtifact {
  if (artifact.task_id === undefined) {
    throw new Error("Connected workflow candidate is missing task_id.");
  }

  return {
    schema_version: "0.1",
    artifact_kind: "workflow_runtime_queue_recovery",
    workflow_id: artifact.workflow_id,
    task_id: artifact.task_id,
    queue_item_id: queueItem.id,
    status: "queued",
    retry_policy: artifact.execution_policy.retry_policy,
    resource_locks: artifact.execution_policy.resource_locks,
    recovery: {
      expired_claim: "work_queue_requeues_after_claim_ttl",
      dispatch_failure: "queue_worker_marks_item_failed"
    },
    rollback: {
      automatic: false,
      strategy: "fail_queue_item_before_claim",
      operator_steps: [
        `Inspect queue item ${queueItem.id} before RuntimeLoop dispatch.`,
        "Disable KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME to keep the item unclaimed.",
        "Mark or isolate the queue item through the normal recovery workflow."
      ]
    },
    artifact_path: toProjectPath(
      projectRoot,
      workflowRuntimeRecoveryArtifactPath(projectRoot, artifact.workflow_id)
    ),
    created_at: now.toISOString()
  };
}

function buildExecutionPolicy(
  request: WorkflowRuntimeCandidateRequest,
  taskId: string | undefined,
  task: WorkflowRuntimeTaskPlaceholder,
  approvalGate: WorkflowRuntimeApprovalGate
): WorkflowRuntimeExecutionPolicy {
  const approvalRequired =
    approvalGate.requested || task.approval_required === true;
  const requestedLocks = (request.resourceLocks ?? [])
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const lockKeys = Array.from(
    new Set(
      requestedLocks.length > 0
        ? requestedLocks
        : taskId === undefined
          ? []
          : [`task:${taskId}`]
    )
  );

  return {
    approval_gate: {
      required: approvalRequired,
      approval_id: approvalGate.approval_id,
      status:
        approvalGate.status ??
        (approvalRequired ? "missing" : "not_required")
    },
    resource_locks: {
      mode: "exclusive",
      keys: lockKeys,
      release_on: ["completed", "failed"]
    },
    retry_policy: {
      max_attempts: request.retryMaxAttempts ?? 1,
      backoff_seconds: request.retryBackoffSeconds ?? 0
    }
  };
}

function queueConnectionBlockers(
  request: WorkflowRuntimeCandidateRequest,
  taskId: string | undefined,
  task: WorkflowRuntimeTaskPlaceholder,
  approvalGate: WorkflowRuntimeApprovalGate
): string[] {
  if (request.connectQueue === true && taskId === undefined) {
    return ["task id is required for queue connection"];
  }

  if (
    request.connectQueue === true &&
    task.approval_required === true &&
    !approvalGate.requested
  ) {
    return ["approval id is required for an approval-gated task"];
  }

  return [];
}

function queueConnectionReason(
  status: WorkflowRuntimeCandidateStatus,
  blockers: string[]
): string {
  if (blockers.length > 0) {
    return blockers.join(";");
  }

  return status === "waiting_for_approval"
    ? "approval decision is required before queue connection"
    : "ready_to_connect";
}

async function readQueueItem(
  projectRoot: string,
  queueItemId: string | undefined
): Promise<QueueItem | undefined> {
  if (queueItemId === undefined) {
    return undefined;
  }

  return (await new WorkQueue(projectRoot).list()).find(
    (item) => item.id === queueItemId
  );
}

async function readTask(
  projectRoot: string,
  taskId: string | undefined
): Promise<TaskRecord | undefined> {
  if (taskId === undefined) {
    return undefined;
  }

  try {
    return await readJsonFile<TaskRecord>(
      resolveInside(getKaironPaths(projectRoot).tasksDir, taskId, "task.json")
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function readApproval(
  projectRoot: string,
  approvalId: string | undefined
): Promise<ApprovalRecord | undefined> {
  if (approvalId === undefined) {
    return undefined;
  }

  return (await new ApprovalQueue(projectRoot).list({ status: "all" })).find(
    (approval) => approval.id === approvalId
  );
}

function buildQueueIntake(
  queueItemId: string | undefined,
  item: QueueItem | undefined
): WorkflowRuntimeQueueIntake {
  return {
    requested: queueItemId !== undefined,
    found: item !== undefined,
    item_id: queueItemId,
    item_type: item?.type,
    item_status: item?.status,
    task_id: item?.task_id,
    schedule_mode: item?.schedule_mode
  };
}

function buildTaskPlaceholder(
  taskId: string | undefined,
  task: TaskRecord | undefined
): WorkflowRuntimeTaskPlaceholder {
  return {
    requested: taskId !== undefined,
    found: task !== undefined,
    task_id: taskId,
    status: task?.status,
    persona: task?.persona,
    approval_required: task?.approval_required,
    code_producing: task?.code_producing
  };
}

function buildApprovalGate(
  approvalId: string | undefined,
  approval: ApprovalRecord | undefined
): WorkflowRuntimeApprovalGate {
  return {
    requested: approvalId !== undefined,
    found: approval !== undefined,
    approval_id: approvalId,
    status: approval?.status,
    type: approval?.type,
    decision: readString(approval?.decision)
  };
}

function buildCandidateNodes(
  queueIntake: WorkflowRuntimeQueueIntake,
  taskPlaceholder: WorkflowRuntimeTaskPlaceholder,
  approvalGate: WorkflowRuntimeApprovalGate,
  blockers: string[]
): ExperimentalWorkflowNode[] {
  return [
    {
      id: "queue_intake",
      kind: "queue_intake",
      status: requestedNodeStatus(queueIntake.requested, queueIntake.found),
      summary: queueIntake.requested
        ? "Read a queue item as candidate input without claiming it."
        : "No queue item was requested for this candidate.",
      output: { ...queueIntake }
    },
    {
      id: "task_placeholder",
      kind: "task_placeholder",
      status: requestedNodeStatus(taskPlaceholder.requested, taskPlaceholder.found),
      summary: taskPlaceholder.requested
        ? "Read task metadata as a placeholder without invoking TaskRunner."
        : "No task placeholder was requested for this candidate.",
      output: { ...taskPlaceholder }
    },
    {
      id: "approval_gate",
      kind: "approval_gate",
      status: approvalGateStatus(approvalGate),
      summary: approvalGate.requested
        ? "Read approval state as a gate without creating or deciding approvals."
        : "No approval gate was requested for this candidate.",
      output: { ...approvalGate }
    },
    {
      id: "production_handoff",
      kind: "production_handoff",
      status: blockers.length === 0 ? "waiting" : "failed",
      summary: "Candidate only; RuntimeLoop remains untouched.",
      output: {
        production_runtime_touched: false,
        blockers
      }
    }
  ];
}

function queueBlockers(queueIntake: WorkflowRuntimeQueueIntake): string[] {
  if (queueIntake.requested && !queueIntake.found) {
    return [`queue item not found: ${queueIntake.item_id}`];
  }

  if (queueIntake.item_status !== undefined && queueIntake.item_status !== "ready") {
    return [`queue item is not ready: ${queueIntake.item_status}`];
  }

  return [];
}

function taskBlockers(taskPlaceholder: WorkflowRuntimeTaskPlaceholder): string[] {
  if (taskPlaceholder.requested && !taskPlaceholder.found) {
    return [`task not found: ${taskPlaceholder.task_id}`];
  }

  return [];
}

function approvalBlockers(approvalGate: WorkflowRuntimeApprovalGate): string[] {
  if (approvalGate.requested && !approvalGate.found) {
    return [`approval not found: ${approvalGate.approval_id}`];
  }

  if (
    approvalGate.status === "decided" &&
    approvalGate.decision !== undefined &&
    approvalGate.decision !== "approve"
  ) {
    return [`approval decision is not approve: ${approvalGate.decision}`];
  }

  return [];
}

function deriveCandidateStatus(
  blockers: string[],
  approvalGate: WorkflowRuntimeApprovalGate
): WorkflowRuntimeCandidateStatus {
  if (blockers.length > 0) {
    return "blocked";
  }

  if (
    approvalGate.requested &&
    approvalGate.status !== "decided"
  ) {
    return "waiting_for_approval";
  }

  return "candidate_ready";
}

function candidateNextSteps(
  blockers: string[],
  approvalGate: WorkflowRuntimeApprovalGate
): string[] {
  if (blockers.length > 0) {
    return [
      "Resolve blocked queue, task, or approval inputs before connecting to production runtime."
    ];
  }

  if (approvalGate.requested && approvalGate.status !== "decided") {
    return ["Collect the required approval decision, then rerun candidate dry-run."];
  }

  return [
    "Keep RuntimeLoop unchanged.",
    "Use this artifact to decide whether a production workflow adapter is justified."
  ];
}

function approvalGateReadyForIntegration(
  approvalGate: WorkflowRuntimeApprovalGate
): boolean {
  if (!approvalGate.requested) {
    return true;
  }

  return approvalGate.status === "decided" && approvalGate.decision === "approve";
}

function requestedNodeStatus(
  requested: boolean,
  found: boolean
): ExperimentalWorkflowNodeStatus {
  if (!requested) {
    return "skipped";
  }

  return found ? "completed" : "failed";
}

function approvalGateStatus(
  approvalGate: WorkflowRuntimeApprovalGate
): ExperimentalWorkflowNodeStatus {
  if (!approvalGate.requested) {
    return "skipped";
  }

  if (!approvalGate.found) {
    return "failed";
  }

  if (approvalGate.status === "decided") {
    return approvalGate.decision === "approve" ? "completed" : "failed";
  }

  return "waiting";
}

function defaultCandidateWorkflowId(now: Date): string {
  return `EXP-WF-CANDIDATE-${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
}

function nodeStatus(
  artifactNodes: ExperimentalWorkflowNode[],
  nodeId: string
): ExperimentalWorkflowNodeStatus | "missing" {
  return artifactNodes.find((node) => node.id === nodeId)?.status ?? "missing";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
