import { randomBytes } from "node:crypto";

export type ApprovalCheckStatus = "passed" | "failed" | "warning" | "skipped";

export type ApprovalMessageInput = {
  id: string;
  task_id?: string;
  title: string;
  type: string;
  risk_level?: "low" | "medium" | "high" | "critical";
  risk_reason?: string;
  summary_items?: string[];
  checks?: Array<{
    name: string;
    status: ApprovalCheckStatus;
  }>;
  branch?: string;
  commit_sha?: string;
  board_url?: string;
  actions?: Array<"approve" | "reject" | "request_changes" | "snooze" | "open_board">;
  nonce?: string;
  diff?: string;
  log?: string;
  stdout?: string;
  stderr?: string;
  raw_outbox?: unknown;
};

export type DiscordApprovalMessage = {
  content: string;
  nonce: string;
  embeds: Array<{
    title: string;
    description: string;
    fields: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
  }>;
  components: Array<{
    type: "action_row";
    components: DiscordButton[];
  }>;
};

type DiscordButton = {
  type: "button";
  style: "primary" | "secondary" | "success" | "danger" | "link";
  label: string;
  custom_id?: string;
  url?: string;
};

const secretLikePattern =
  /(api[_-]?key|token|secret|password|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

export function buildApprovalMessage(
  approval: ApprovalMessageInput
): DiscordApprovalMessage {
  const nonce = approval.nonce ?? createNonce();
  const actions = approval.actions ?? [
    "approve",
    "reject",
    "request_changes",
    "snooze"
  ];
  const fields = [
    field("Approval", approval.id, true),
    field("Type", approval.type, true),
    field("Risk", approval.risk_level ?? "medium", true),
    approval.task_id === undefined ? null : field("Task", approval.task_id, true),
    approval.branch === undefined ? null : field("Branch", sanitize(approval.branch), true),
    approval.commit_sha === undefined
      ? null
      : field("Commit", sanitize(shortSha(approval.commit_sha)), true),
    approval.risk_reason === undefined
      ? null
      : field("Risk reason", sanitize(approval.risk_reason), false),
    field("Summary", formatSummaryItems(approval.summary_items ?? []), false),
    field("Checks", formatChecks(approval.checks ?? []), false)
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    content: `Approval requested: ${approval.id}`,
    nonce,
    embeds: [
      {
        title: truncate(sanitize(approval.title), 120),
        description: "Review the request and choose an action.",
        fields
      }
    ],
    components: buildComponents(approval.id, nonce, actions, approval.board_url)
  };
}

export function containsUnsafeApprovalMessageData(
  approval: ApprovalMessageInput
): boolean {
  return [approval.diff, approval.log, approval.stdout, approval.stderr]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.length > 0 || secretLikePattern.test(value));
}

function buildComponents(
  approvalId: string,
  nonce: string,
  actions: NonNullable<ApprovalMessageInput["actions"]>,
  boardUrl: string | undefined
): DiscordApprovalMessage["components"] {
  const buttons: DiscordButton[] = [];

  for (const action of actions) {
    if (action === "open_board") {
      if (boardUrl !== undefined) {
        buttons.push({
          type: "button",
          style: "link",
          label: "Open Board",
          url: boardUrl
        });
      }
      continue;
    }

    buttons.push({
      type: "button",
      style: buttonStyle(action),
      label: buttonLabel(action),
      custom_id: customId(approvalId, action, nonce)
    });
  }

  return [
    {
      type: "action_row",
      components: buttons
    }
  ];
}

function customId(
  approvalId: string,
  action: Exclude<NonNullable<ApprovalMessageInput["actions"]>[number], "open_board">,
  nonce: string
): string {
  const rawAction = action === "request_changes" ? "changes" : action;
  const value = `kr:v1:apr:${approvalId}:${rawAction}:${nonce}`;

  if (value.length > 100) {
    throw new Error(`Discord custom_id exceeds 100 characters: ${value.length}`);
  }

  return value;
}

function buttonStyle(
  action: Exclude<NonNullable<ApprovalMessageInput["actions"]>[number], "open_board">
): "primary" | "secondary" | "success" | "danger" {
  switch (action) {
    case "approve":
      return "success";
    case "reject":
      return "danger";
    case "request_changes":
      return "primary";
    case "snooze":
      return "secondary";
  }
}

function buttonLabel(
  action: Exclude<NonNullable<ApprovalMessageInput["actions"]>[number], "open_board">
): string {
  switch (action) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "request_changes":
      return "Request Changes";
    case "snooze":
      return "Snooze";
  }
}

function field(name: string, value: string, inline = false): {
  name: string;
  value: string;
  inline: boolean;
} {
  return {
    name,
    value: truncate(sanitize(value), 1024) || "-",
    inline
  };
}

function formatSummaryItems(items: string[]): string {
  if (items.length === 0) {
    return "-";
  }

  return items
    .slice(0, 4)
    .map((item) => `- ${sanitize(item)}`)
    .join("\n");
}

function formatChecks(checks: NonNullable<ApprovalMessageInput["checks"]>): string {
  if (checks.length === 0) {
    return "-";
  }

  return checks
    .slice(0, 6)
    .map((check) => `- ${sanitize(check.name)}: ${check.status}`)
    .join("\n");
}

function sanitize(value: string): string {
  return secretLikePattern.test(value) ? "[redacted]" : value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function shortSha(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function createNonce(): string {
  return `n${randomBytes(4).toString("hex")}`;
}
