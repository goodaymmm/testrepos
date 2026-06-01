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

export const APPROVAL_COMMAND_ERROR_EXIT_CODE = 4;

export type ApprovalListCommandOptions = {
  status?: string;
};

export type ApprovalDecideCommandOptions = {
  action?: string;
  reason?: string;
  until?: string;
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
