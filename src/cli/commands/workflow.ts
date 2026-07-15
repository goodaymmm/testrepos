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
import {
  formatWorkflowControlResult,
  WorkflowControls
} from "../../workflow/controls.js";

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
  const runtime = new ProductionWorkflowRuntime(projectRoot);
  const [shown, events] = await Promise.all([
    runtime.show(workflowId),
    new WorkflowControls(projectRoot).events(workflowId)
  ]);
  return [
    formatProductionWorkflowResult(shown),
    `control.mode=${shown.artifact.control?.mode ?? "active"}`,
    `control.reason=${shown.artifact.control?.reason ?? "none"}`,
    `control.events=${events.length}`,
    `control.last=${formatLastControlEvent(events.at(-1))}`,
    ...events.map(
      (event) =>
        `control.event.${event.sequence}=action:${event.action};status:${event.status_after};node:${event.node_id ?? "none"};at:${event.created_at}`
    )
  ].join("\n");
}

export async function workflowListCommand(projectRoot: string): Promise<string> {
  const artifacts = await new ProductionWorkflowRuntime(projectRoot).list();
  return [
    "Kairon production workflows:",
    ...(artifacts.length === 0
      ? ["(none)"]
      : artifacts.map((artifact) => {
          const completed = artifact.nodes.filter((node) =>
            ["completed", "skipped"].includes(node.status)
          ).length;
          const blocker =
            artifact.nodes.find((node) => node.blocker !== undefined)?.blocker ??
            artifact.control?.reason;
          return [
            `workflow_id=${artifact.workflow_id}`,
            `status=${artifact.status}`,
            `progress=${completed}/${artifact.nodes.length}`,
            `blocker=${blocker ?? "none"}`,
            `retries=${artifact.nodes.reduce((sum, node) => sum + Math.max(node.attempt - 1, 0), 0)}`,
            `last_event=${artifact.control?.last_event_action ?? "none"}`
          ].join(" ");
        }))
  ].join("\n");
}

export async function workflowPauseCommand(
  projectRoot: string,
  workflowId: string,
  reason: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return formatWorkflowControlResult(
    await new WorkflowControls(projectRoot, { env }).pause(workflowId, reason)
  );
}

export async function workflowResumeCommand(
  projectRoot: string,
  workflowId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return formatWorkflowControlResult(
    await new WorkflowControls(projectRoot, { env }).resume(workflowId)
  );
}

export async function workflowCancelCommand(
  projectRoot: string,
  workflowId: string,
  options: { reason: string; approvalId?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return formatWorkflowControlResult(
    await new WorkflowControls(projectRoot, { env }).cancel(workflowId, options)
  );
}

export async function workflowRetryCommand(
  projectRoot: string,
  workflowId: string,
  options: { node: string; reason?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return formatWorkflowControlResult(
    await new WorkflowControls(projectRoot, { env }).retry(workflowId, {
      nodeId: options.node,
      reason: options.reason
    })
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

function formatLastControlEvent(
  event:
    | {
        action: string;
        event_id: string;
        status_after: string;
        node_id?: string;
      }
    | undefined
): string {
  return event === undefined
    ? "none"
    : `${event.action};id:${event.event_id};status:${event.status_after};node:${event.node_id ?? "none"}`;
}
