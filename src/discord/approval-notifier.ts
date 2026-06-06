import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import type { ApprovalAction } from "./interactions.js";
import type { PreparedDiscordGateway } from "./gateway.js";
import {
  buildApprovalMessage,
  buildApprovalStatusMessage,
  containsUnsafeApprovalMessageData,
  type ApprovalMessageInput
} from "./approval-message.js";

export type DiscordApprovalChannel = {
  id?: string;
  send(payload: unknown): Promise<DiscordApprovalMessageHandle> | DiscordApprovalMessageHandle;
  messages?: {
    fetch(messageId: string): Promise<DiscordApprovalMessageHandle> | DiscordApprovalMessageHandle;
  };
};

export type DiscordApprovalMessageHandle = {
  id?: string;
  edit?(payload: unknown): Promise<unknown> | unknown;
};

export type DiscordApprovalNotificationResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  audit_path: string;
  failures: Array<{
    approval_id: string;
    reason: string;
  }>;
};

export type DiscordApprovalNotificationAuditRecord = {
  schema_version: "0.1";
  approval_id: string;
  status: "sent" | "skipped" | "failed";
  channel_id: string;
  message_id?: string;
  reason?: string;
  sent_at?: string;
  recorded_at: string;
};

export type DiscordApprovalMessageUpdateResult =
  | {
      status: "updated";
      approval_id: string;
      message_id: string;
    }
  | {
      status: "skipped";
      approval_id: string;
      reason: string;
    };

type ApprovalRecord = {
  id: string;
  status?: string;
  title?: string;
  type?: string;
  task_id?: string;
  branch?: string;
  commit_sha?: string;
  risk_level?: ApprovalMessageInput["risk_level"];
  risk_reason?: string;
  summary_items?: string[];
  checks?: ApprovalMessageInput["checks"];
  actions?: ApprovalAction[];
  allowed_actions?: ApprovalAction[];
  nonce?: string;
  discord_nonce?: string;
  diff?: string;
  log?: string;
  stdout?: string;
  stderr?: string;
  decision?: string;
  reason?: string;
  snooze_until?: string;
  discord?: {
    channel_id?: string;
    message_id?: string;
    nonce?: string;
    nonce_expires_at?: string;
    notified_at?: string;
    updated_at?: string;
    unsafe_fields_omitted?: boolean;
  };
  [key: string]: unknown;
};

export async function notifyPendingDiscordApprovals(
  projectRoot: string,
  gateway: PreparedDiscordGateway & { status: "ready" },
  channel: DiscordApprovalChannel,
  options: { now?: () => Date } = {}
): Promise<DiscordApprovalNotificationResult> {
  const now = options.now?.() ?? new Date();
  const approvals = await readApprovalRecords(projectRoot);
  const result: DiscordApprovalNotificationResult = {
    scanned: approvals.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    audit_path: toProjectPath(projectRoot, discordNotificationAuditPath(projectRoot)),
    failures: []
  };

  for (const approval of approvals) {
    const notificationCheck = shouldNotifyApproval(approval, gateway);
    if (!notificationCheck.ok) {
      result.skipped += 1;
      await appendDiscordNotificationAudit(projectRoot, {
        schema_version: "0.1",
        approval_id: approval.id,
        status: "skipped",
        channel_id: gateway.approval_channel_id,
        reason: notificationCheck.reason,
        recorded_at: now.toISOString()
      });
      continue;
    }

    try {
      const input = toApprovalMessageInput(approval);
      const message = buildApprovalMessage(input);
      const sent = await channel.send(message);
      const sentAt = now.toISOString();
      await updateApprovalDiscordMetadata(projectRoot, approval, {
        channel_id: gateway.approval_channel_id,
        message_id: sent.id,
        nonce: message.nonce,
        notified_at: sentAt,
        nonce_expires_at: defaultNonceExpiresAt(now),
        unsafe_fields_omitted: containsUnsafeApprovalMessageData(input)
      });
      await appendDiscordNotificationAudit(projectRoot, {
        schema_version: "0.1",
        approval_id: approval.id,
        status: "sent",
        channel_id: gateway.approval_channel_id,
        message_id: sent.id,
        sent_at: sentAt,
        recorded_at: sentAt
      });
      result.sent += 1;
    } catch (error) {
      const reason = sanitizeAuditReason(String(error));
      result.failed += 1;
      result.failures.push({
        approval_id: approval.id,
        reason
      });
      await appendDiscordNotificationAudit(projectRoot, {
        schema_version: "0.1",
        approval_id: approval.id,
        status: "failed",
        channel_id: gateway.approval_channel_id,
        reason,
        recorded_at: now.toISOString()
      });
    }
  }

  return result;
}

export async function updateDiscordApprovalMessage(
  projectRoot: string,
  approvalId: string,
  channel: DiscordApprovalChannel,
  options: { now?: () => Date } = {}
): Promise<DiscordApprovalMessageUpdateResult> {
  const approval = await readApprovalRecord(projectRoot, approvalId);
  if (approval === null) {
    return {
      status: "skipped",
      approval_id: approvalId,
      reason: "approval was not found"
    };
  }

  const messageId = approval.discord?.message_id;
  if (messageId === undefined || messageId.length === 0) {
    return {
      status: "skipped",
      approval_id: approvalId,
      reason: "discord message id is missing"
    };
  }

  const message = await channel.messages?.fetch(messageId);
  if (message?.edit === undefined) {
    return {
      status: "skipped",
      approval_id: approvalId,
      reason: "discord message edit is unavailable"
    };
  }

  await message.edit(
    buildApprovalStatusMessage({
      id: approval.id,
      title: approval.title,
      type: approval.type,
      status: approval.status ?? "unknown",
      decision: approval.decision,
      reason: approval.reason,
      snooze_until: approval.snooze_until
    })
  );
  await writeApprovalRecord(projectRoot, {
    ...approval,
    discord: {
      ...approval.discord,
      updated_at: (options.now?.() ?? new Date()).toISOString()
    }
  });

  return {
    status: "updated",
    approval_id: approvalId,
    message_id: messageId
  };
}

async function readApprovalRecords(projectRoot: string): Promise<ApprovalRecord[]> {
  const approvalsDir = getKaironPaths(projectRoot).approvalsDir;
  let entries: string[];

  try {
    entries = await readdir(approvalsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const approvals = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJsonFile<ApprovalRecord>(path.join(approvalsDir, entry)))
  );
  return approvals.filter((approval) => typeof approval.id === "string");
}

async function readApprovalRecord(
  projectRoot: string,
  approvalId: string
): Promise<ApprovalRecord | null> {
  try {
    return await readJsonFile<ApprovalRecord>(approvalPath(projectRoot, approvalId));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function shouldNotifyApproval(
  approval: ApprovalRecord,
  gateway: PreparedDiscordGateway & { status: "ready" }
): { ok: true } | { ok: false; reason: string } {
  if (approval.status !== "pending") {
    return { ok: false, reason: "not_pending" };
  }

  if (approval.discord?.message_id !== undefined) {
    return { ok: false, reason: "already_sent" };
  }

  if (approval.discord?.channel_id === gateway.approval_channel_id) {
    return { ok: false, reason: "already_sent" };
  }

  return { ok: true };
}

function toApprovalMessageInput(approval: ApprovalRecord): ApprovalMessageInput {
  return {
    id: approval.id,
    task_id: approval.task_id,
    title: approval.title ?? approval.id,
    type: approval.type ?? "approval",
    risk_level: approval.risk_level,
    risk_reason: approval.risk_reason,
    summary_items: approval.summary_items,
    checks: approval.checks,
    branch: approval.branch,
    commit_sha: approval.commit_sha,
    actions: approval.actions ?? approval.allowed_actions,
    nonce: approval.discord?.nonce ?? approval.discord_nonce ?? approval.nonce,
    diff: approval.diff,
    log: approval.log,
    stdout: approval.stdout,
    stderr: approval.stderr
  };
}

async function updateApprovalDiscordMetadata(
  projectRoot: string,
  approval: ApprovalRecord,
  discord: NonNullable<ApprovalRecord["discord"]>
): Promise<void> {
  await writeApprovalRecord(projectRoot, {
    ...approval,
    discord_nonce: discord.nonce,
    discord: {
      ...approval.discord,
      ...discord
    }
  });
}

async function writeApprovalRecord(
  projectRoot: string,
  approval: ApprovalRecord
): Promise<void> {
  await writeJsonFileAtomic(approvalPath(projectRoot, approval.id), approval);
}

function approvalPath(projectRoot: string, approvalId: string): string {
  return path.join(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`);
}

function discordNotificationAuditPath(projectRoot: string): string {
  return path.join(
    getKaironPaths(projectRoot).runtimeDir,
    "discord",
    "approval-notifications.jsonl"
  );
}

async function appendDiscordNotificationAudit(
  projectRoot: string,
  record: DiscordApprovalNotificationAuditRecord
): Promise<void> {
  await appendJsonLine(discordNotificationAuditPath(projectRoot), record);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function sanitizeAuditReason(value: string): string {
  return truncate(
    value
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[redacted-private-key]")
      .replace(/\s+/g, " ")
      .trim(),
    500
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function defaultNonceExpiresAt(now: Date): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}
