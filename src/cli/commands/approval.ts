import {
  ApprovalQueue,
  formatApprovalDecision,
  formatApprovalDetail,
  formatApprovalList,
  type ApprovalAction
} from "../../approvals/approval-queue.js";

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
  const result = await new ApprovalQueue(projectRoot).decide({
    approvalId,
    action,
    reason: options.reason,
    until: options.until
  });

  return formatApprovalDecision(result);
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
