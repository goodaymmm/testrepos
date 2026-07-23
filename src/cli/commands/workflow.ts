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
import {
  resolveWorkflowRuntimeConfig
} from "../../workflow/config.js";
import {
  createWorkflowConfigProposal,
  formatWorkflowConfigProposalCreateResult
} from "../../core/config/config-proposals.js";

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

export type WorkflowConfigProposeCommandOptions = {
  enable?: boolean;
  disable?: boolean;
};

export async function workflowConfigShowCommand(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const resolution = await resolveWorkflowRuntimeConfig(projectRoot, env);
  return [
    "Kairon workflow runtime config.",
    `enabled=${resolution.config.enabled}`,
    `effective_enabled=${resolution.effective_enabled}`,
    `effective_source=${resolution.effective_source}`,
    `environment_name=${resolution.environment_name}`,
    `environment_value=${resolution.environment_value ?? "unset"}`,
    `explicit_enabled=${resolution.explicit_enabled}`,
    `legacy_enabled_env=${resolution.legacy_enabled_env}`,
    `conflict=${resolution.conflict}`,
    `mode=${resolution.config.mode}`,
    `checkpoint_store=${resolution.config.checkpoint_store}`,
    `checkpoint_on_transition=${resolution.config.checkpoint_on_transition}`,
    `resource_lock_ttl_seconds=${resolution.config.resource_lock_ttl_seconds}`,
    `retry.max_attempts=${resolution.config.retry.max_attempts}`,
    `retry.backoff_seconds=${resolution.config.retry.backoff_seconds}`,
    ...resolution.warnings.map((warning) => `warning=${warning}`)
  ].join("\n");
}

export async function workflowConfigProposeCommand(
  projectRoot: string,
  options: WorkflowConfigProposeCommandOptions
): Promise<string> {
  if (options.enable === options.disable) {
    throw new Error(
      "Specify exactly one of --enable or --disable for workflow config propose."
    );
  }
  return formatWorkflowConfigProposalCreateResult(
    await createWorkflowConfigProposal({
      projectRoot,
      enabled: options.enable === true
    })
  );
}

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
      return formatProductionWorkflowDisabled();
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
      return formatProductionWorkflowDisabled();
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

function formatProductionWorkflowDisabled(): string {
  return [
    "Kairon production workflow is disabled.",
    "status=setup_required",
    "reason=workflow_config_disabled",
    "next_action=kairon workflow config propose --enable"
  ].join("\n");
}
