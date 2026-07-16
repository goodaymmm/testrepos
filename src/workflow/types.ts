export type WorkflowStatus =
  | "ready"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "dispatched"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type WorkflowNodeKind = "approval_gate" | "task";

export type WorkflowResourceLock = {
  resource: string;
  lock_path: string;
  fencing_token: string;
};

export type WorkflowControlMode =
  | "active"
  | "paused"
  | "cancellation_requested"
  | "cancelled";

export type WorkflowControlState = {
  mode: WorkflowControlMode;
  generation: number;
  cancellation_token: string;
  reason?: string;
  approval_id?: string;
  requested_at?: string;
  last_event_id?: string;
  last_event_sequence?: number;
  last_event_action?: WorkflowControlAction;
};

export type WorkflowControlAction = "pause" | "resume" | "cancel" | "retry";

export type WorkflowControlEvent = {
  schema_version: "0.1";
  event_id: string;
  workflow_id: string;
  sequence: number;
  action: WorkflowControlAction;
  status_before: WorkflowStatus;
  status_after: WorkflowStatus;
  reason?: string;
  approval_id?: string;
  node_id?: string;
  attempt?: number;
  compensation_path?: string;
  created_at: string;
};

export type WorkflowNodeState = {
  id: string;
  kind: WorkflowNodeKind;
  status: WorkflowNodeStatus;
  dependencies: string[];
  attempt: number;
  max_attempts: number;
  input_digest: string;
  output_digest?: string;
  task_id?: string;
  approval_id?: string;
  queue_item_id?: string;
  run_id?: string;
  idempotency_key?: string;
  fencing_token?: string;
  resource_locks: WorkflowResourceLock[];
  blocker?: string;
  error?: string;
  dispatched_at?: string;
  started_at?: string;
  completed_at?: string;
  updated_at: string;
};

export type WorkflowEdge = {
  from: string;
  to: string;
};

export type WorkflowRunArtifact = {
  schema_version: "0.1";
  artifact_kind: "workflow_run";
  runtime: "kairon_workflow_runtime";
  workflow_id: string;
  correlation_id?: string;
  status: WorkflowStatus;
  sequence: number;
  objective: string;
  task_id: string;
  approval_id?: string;
  resource_keys: string[];
  retry_policy: {
    max_attempts: number;
    backoff_seconds: number;
  };
  nodes: WorkflowNodeState[];
  edges: WorkflowEdge[];
  source: {
    kind: "new" | "experimental_workflow_runtime_spike" | "workflow_runtime_candidate";
    artifact_path?: string;
  };
  recovery: {
    last_action:
      | "created"
      | "run"
      | "recover"
      | "queue_started"
      | "queue_completed"
      | "queue_failed"
      | "control";
    last_checkpoint_path?: string;
    reconciled_queue_item_ids: string[];
  };
  control?: WorkflowControlState;
  created_at: string;
  updated_at: string;
};

export type ProductionWorkflowQueueMetadata = {
  schema_version: "0.1";
  workflow_id: string;
  node_id: string;
  idempotency_key: string;
  fencing_token: string;
  resource_locks: WorkflowResourceLock[];
  run_artifact_path: string;
  feature_flag: "KAIRON_WORKFLOW_RUNTIME";
  cancellation_token?: string;
  control_generation?: number;
};

export type WorkflowNodeTransition =
  | { type: "dispatch"; at: string; attempt: number; queueItemId: string; idempotencyKey: string; fencingToken: string; resourceLocks: WorkflowResourceLock[] }
  | { type: "start"; at: string; runId?: string }
  | { type: "wait_approval"; at: string; blocker?: string }
  | { type: "complete"; at: string; outputDigest?: string; runId?: string }
  | { type: "fail"; at: string; error: string }
  | { type: "retry"; at: string }
  | { type: "skip"; at: string }
  | { type: "cancel"; at: string };

const terminalNodeStatuses = new Set<WorkflowNodeStatus>([
  "completed",
  "skipped",
  "cancelled"
]);

export function transitionWorkflowNode(
  node: WorkflowNodeState,
  transition: WorkflowNodeTransition
): WorkflowNodeState {
  const next: WorkflowNodeState = {
    ...node,
    resource_locks: node.resource_locks.map((lock) => ({ ...lock })),
    updated_at: transition.at
  };

  if (terminalNodeStatuses.has(node.status)) {
    throw new Error(`Workflow node ${node.id} is already terminal: ${node.status}`);
  }

  switch (transition.type) {
    case "dispatch":
      assertNodeStatus(node, ["pending"]);
      next.status = "dispatched";
      next.attempt = transition.attempt;
      next.queue_item_id = transition.queueItemId;
      next.idempotency_key = transition.idempotencyKey;
      next.fencing_token = transition.fencingToken;
      next.resource_locks = transition.resourceLocks.map((lock) => ({ ...lock }));
      next.dispatched_at = transition.at;
      delete next.blocker;
      delete next.error;
      return next;
    case "start":
      assertNodeStatus(node, ["dispatched", "running"]);
      next.status = "running";
      next.started_at = next.started_at ?? transition.at;
      next.run_id = transition.runId ?? next.run_id;
      return next;
    case "wait_approval":
      assertNodeStatus(node, ["pending", "waiting_approval"]);
      next.status = "waiting_approval";
      next.blocker = transition.blocker ?? "approval_pending";
      return next;
    case "complete":
      assertNodeStatus(node, ["pending", "dispatched", "running", "waiting_approval"]);
      next.status = "completed";
      next.output_digest = transition.outputDigest ?? next.output_digest;
      next.run_id = transition.runId ?? next.run_id;
      next.completed_at = transition.at;
      delete next.blocker;
      delete next.error;
      return next;
    case "fail":
      assertNodeStatus(node, ["pending", "dispatched", "running", "waiting_approval", "failed"]);
      next.status = "failed";
      next.error = transition.error;
      next.completed_at = transition.at;
      delete next.blocker;
      return next;
    case "retry":
      assertNodeStatus(node, ["failed"]);
      next.status = "pending";
      next.resource_locks = [];
      delete next.queue_item_id;
      delete next.run_id;
      delete next.idempotency_key;
      delete next.fencing_token;
      delete next.dispatched_at;
      delete next.started_at;
      delete next.completed_at;
      delete next.blocker;
      delete next.error;
      return next;
    case "skip":
      assertNodeStatus(node, ["pending", "waiting_approval"]);
      next.status = "skipped";
      next.completed_at = transition.at;
      delete next.blocker;
      return next;
    case "cancel":
      next.status = "cancelled";
      next.completed_at = transition.at;
      delete next.blocker;
      return next;
  }
}

export function deriveWorkflowStatus(nodes: WorkflowNodeState[]): WorkflowStatus {
  if (
    nodes.some(
      (node) =>
        node.status === "failed" &&
        (node.kind === "approval_gate" || node.attempt >= node.max_attempts)
    )
  ) {
    return "failed";
  }
  if (nodes.some((node) => node.status === "waiting_approval")) {
    return "waiting_approval";
  }
  if (nodes.some((node) => node.blocker === "resource_lock_conflict")) {
    return "paused";
  }
  if (nodes.every((node) => terminalNodeStatuses.has(node.status))) {
    return nodes.every((node) => node.status === "cancelled") ? "cancelled" : "completed";
  }
  if (nodes.some((node) => node.status === "dispatched" || node.status === "running")) {
    return "running";
  }
  return "ready";
}

export function deriveControlledWorkflowStatus(
  nodes: WorkflowNodeState[],
  control: WorkflowControlState | undefined
): WorkflowStatus {
  if (control?.mode === "paused") {
    return "paused";
  }
  if (
    control?.mode === "cancellation_requested" ||
    control?.mode === "cancelled"
  ) {
    return "cancelled";
  }
  return deriveWorkflowStatus(nodes);
}

function assertNodeStatus(
  node: WorkflowNodeState,
  allowed: WorkflowNodeStatus[]
): void {
  if (!allowed.includes(node.status)) {
    throw new Error(
      `Invalid workflow node transition for ${node.id}: ${node.status}`
    );
  }
}
