import {
  formatWorkflowRuntimeCandidate,
  formatWorkflowRuntimeCandidateRejected,
  runWorkflowRuntimeCandidate,
  WorkflowRuntimeCandidateDisabledError
} from "../../experimental/workflow-runtime.js";

export type WorkflowRunCommandOptions = {
  candidate?: boolean;
  dryRun?: boolean;
  connectQueue?: boolean;
  workflowId?: string;
  taskId?: string;
  queueItemId?: string;
  approvalId?: string;
  objective?: string;
};

export async function workflowRunCommand(
  projectRoot: string,
  options: WorkflowRunCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (options.candidate !== true) {
    return formatWorkflowRuntimeCandidateRejected("candidate_required");
  }

  if (options.dryRun === false && options.connectQueue !== true) {
    return formatWorkflowRuntimeCandidateRejected("dry_run_required");
  }

  try {
    const artifact = await runWorkflowRuntimeCandidate(
      projectRoot,
      {
        candidate: true,
        dryRun: options.connectQueue !== true,
        connectQueue: options.connectQueue,
        workflowId: options.workflowId,
        taskId: options.taskId,
        queueItemId: options.queueItemId,
        approvalId: options.approvalId,
        objective: options.objective
      },
      { env }
    );
    return formatWorkflowRuntimeCandidate(artifact);
  } catch (error) {
    if (error instanceof WorkflowRuntimeCandidateDisabledError) {
      return formatWorkflowRuntimeCandidateRejected("feature_flag_disabled");
    }

    throw error;
  }
}
