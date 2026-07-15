import {
  formatWorkflowRuntimeCandidate,
  formatWorkflowRuntimeCandidateRejected,
  runWorkflowRuntimeCandidate,
  WorkflowRuntimeCandidateDisabledError
} from "../../experimental/workflow-runtime.js";
import {
  formatProductionWorkflowResult,
  ProductionWorkflowRuntime,
  ProductionWorkflowRuntimeDisabledError
} from "../../workflow/runtime.js";

export type WorkflowRunCommandOptions = {
  candidate?: boolean;
  dryRun?: boolean;
  connectQueue?: boolean;
  workflowId?: string;
  taskId?: string;
  queueItemId?: string;
  approvalId?: string;
  objective?: string;
  resourceLock?: string[];
  retryMaxAttempts?: string | number;
  retryBackoffSeconds?: string | number;
};

export async function workflowRunCommand(
  projectRoot: string,
  options: WorkflowRunCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (options.candidate === true) {
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

  if (options.workflowId === undefined) {
    return formatWorkflowRuntimeCandidateRejected("workflow_id_required");
  }

  try {
    return formatProductionWorkflowResult(
      await new ProductionWorkflowRuntime(projectRoot, { env }).run({
        workflowId: options.workflowId,
        taskId: options.taskId,
        approvalId: options.approvalId,
        objective: options.objective,
        resourceKeys: options.resourceLock,
        retryMaxAttempts: parseOptionalInteger(
          options.retryMaxAttempts,
          "retry-max-attempts"
        ),
        retryBackoffSeconds: parseOptionalInteger(
          options.retryBackoffSeconds,
          "retry-backoff-seconds"
        )
      })
    );
  } catch (error) {
    if (error instanceof ProductionWorkflowRuntimeDisabledError) {
      return formatWorkflowRuntimeCandidateRejected("feature_flag_disabled");
    }
    throw error;
  }
}

export async function workflowShowCommand(
  projectRoot: string,
  workflowId: string
): Promise<string> {
  return formatProductionWorkflowResult(
    await new ProductionWorkflowRuntime(projectRoot).show(workflowId)
  );
}

export async function workflowRecoverCommand(
  projectRoot: string,
  workflowId: string,
  options: { dryRun?: boolean },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  try {
    return formatProductionWorkflowResult(
      await new ProductionWorkflowRuntime(projectRoot, { env }).recover(
        workflowId,
        options
      )
    );
  } catch (error) {
    if (error instanceof ProductionWorkflowRuntimeDisabledError) {
      return formatWorkflowRuntimeCandidateRejected("feature_flag_disabled");
    }
    throw error;
  }
}

function parseOptionalInteger(
  value: string | number | undefined,
  optionName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${optionName} must be an integer.`);
  }
  return parsed;
}
