import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type ExperimentalWorkflowNodeStatus =
  | "completed"
  | "skipped"
  | "waiting"
  | "failed";

export type ExperimentalWorkflowNode = {
  id: string;
  kind: "task_intake" | "agent_run" | "approval_gate";
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

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
