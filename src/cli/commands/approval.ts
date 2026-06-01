import {
  ApprovalActionNotAllowedError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalQueue,
  formatApprovalDecision,
  formatApprovalDetail,
  formatApprovalList,
  type ApprovalAction
} from "../../approvals/approval-queue.js";
import { StateApplier } from "../../state/state-applier.js";

export const APPROVAL_COMMAND_ERROR_EXIT_CODE = 4;

export type ApprovalListCommandOptions = {
  status?: string;
};

export type ApprovalDecideCommandOptions = {
  action?: string;
  reason?: string;
  until?: string;
};

export type ApprovalSeedCommandOptions = {
  type?: string;
  title?: string;
  actions?: string;
  taskId?: string;
  runId?: string;
  redactionFixture?: boolean;
};

const approvalActions: ApprovalAction[] = [
  "approve",
  "reject",
  "request_changes",
  "snooze"
];

export async function listApprovalsCommand(
  projectRoot: string,
  options: ApprovalListCommandOptions = {}
): Promise<string> {
  const approvals = await new ApprovalQueue(projectRoot).list({
    status: options.status
  });
  return formatApprovalList(approvals);
}

export async function showApprovalCommand(
  projectRoot: string,
  approvalId: string
): Promise<string> {
  const approval = await new ApprovalQueue(projectRoot).show(approvalId);
  return formatApprovalDetail(approval);
}

export async function decideApprovalCommand(
  projectRoot: string,
  approvalId: string,
  options: ApprovalDecideCommandOptions
): Promise<string> {
  const action = parseApprovalAction(options.action);
  let result;

  try {
    result = await new ApprovalQueue(projectRoot).decide({
      approvalId,
      action,
      reason: options.reason,
      until: options.until
    });
  } catch (error) {
    const formatted = formatApprovalCommandError(error);
    if (formatted !== null) {
      process.exitCode = APPROVAL_COMMAND_ERROR_EXIT_CODE;
      return formatted;
    }

    throw error;
  }

  return formatApprovalDecision(result);
}

export async function seedApprovalCommand(
  projectRoot: string,
  approvalId: string,
  options: ApprovalSeedCommandOptions = {}
): Promise<string> {
  const actions = parseApprovalActions(options.actions);
  const approval: Record<string, unknown> = {
    id: approvalId,
    type: options.type ?? "manual_test",
    title: options.title ?? `Manual approval ${approvalId}`,
    actions
  };

  if (options.redactionFixture === true) {
    approval.diff = "SHOULD_BE_OMITTED";
    approval.stdout = "SHOULD_BE_OMITTED";
    approval.api_token = "SHOULD_BE_REDACTED";
  }

  const event = await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    task_id: options.taskId,
    run_id: options.runId,
    actor: "local-cli",
    payload: { approval }
  });

  return [
    "Kairon approval seeded.",
    `approval_id=${approvalId}`,
    "status=pending",
    `actions=${actions.join(",")}`,
    `event_id=${event.event_id}`
  ].join("\n");
}

function formatApprovalCommandError(error: unknown): string | null {
  if (error instanceof ApprovalNotPendingError) {
    return [
      "Kairon approval decision rejected.",
      `approval_id=${error.approvalId}`,
      "reason=not_pending",
      `status=${error.status}`,
      `message=${error.message}`
    ].join("\n");
  }

  if (error instanceof ApprovalActionNotAllowedError) {
    return [
      "Kairon approval decision rejected.",
      `approval_id=${error.approvalId}`,
      "reason=action_not_allowed",
      `action=${error.action}`,
      `message=${error.message}`
    ].join("\n");
  }

  if (error instanceof ApprovalNotFoundError) {
    return [
      "Kairon approval decision rejected.",
      `approval_id=${error.approvalId}`,
      "reason=not_found",
      `message=${error.message}`
    ].join("\n");
  }

  return null;
}

function parseApprovalAction(value: string | undefined): ApprovalAction {
  if (value === undefined) {
    throw new Error("--action is required.");
  }

  if (approvalActions.includes(value as ApprovalAction)) {
    return value as ApprovalAction;
  }

  throw new Error(
    `Invalid approval action: ${value}. Expected one of: ${approvalActions.join(", ")}.`
  );
}

function parseApprovalActions(value: string | undefined): ApprovalAction[] {
  if (value === undefined || value.trim() === "") {
    return approvalActions;
  }

  const parsed = value
    .split(",")
    .map((action) => action.trim())
    .filter((action) => action.length > 0);

  if (parsed.length === 0) {
    throw new Error(
      `Invalid approval actions: ${value}. Expected comma-separated actions.`
    );
  }

  const unique = [...new Set(parsed)];
  for (const action of unique) {
    if (!approvalActions.includes(action as ApprovalAction)) {
      throw new Error(
        `Invalid approval action: ${action}. Expected one of: ${approvalActions.join(", ")}.`
      );
    }
  }

  return unique as ApprovalAction[];
}
