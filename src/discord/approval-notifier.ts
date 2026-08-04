import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJsonFile } from "../core/fs/json-file.js";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  ResourceLockAlreadyExistsError,
  type ResourceLockHandle,
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import {
  ensureApprovalCorrelation,
  trackCorrelationMember
} from "../correlation/store.js";
import type { ApprovalAction } from "./interactions.js";
import type { PreparedDiscordGateway } from "./gateway.js";
import { sanitizeDiscordAuditText } from "./decision-audit.js";
import {
  buildApprovalMessage,
  buildApprovalStatusMessage,
  containsUnsafeApprovalMessageData,
  type ApprovalMessageInput
} from "./approval-message.js";
import {
  prepareStableRemoteProfile,
  resolveBoardProfileConfig,
  type RemoteNotificationsConfig
} from "../remote/profile.js";
import { prepareBoardProfile } from "../board/profile.js";
import { recordNotificationResult } from "../observability/runtime-metrics.js";

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
  resent: number;
  updated: number;
  skipped: number;
  failed: number;
  audit_path: string;
  failures: Array<{
    approval_id: string;
    reason: string;
  }>;
};

export type DiscordApprovalNotificationOptions = {
  now?: () => Date;
  maxMessageVerifications?: number;
  messageVerificationIntervalMs?: number;
};

const approvalMetadataLockRetryDelaysMs = [25, 50, 100, 200, 400, 800] as const;

export type DiscordApprovalNotificationAuditRecord = {
  schema_version: "0.1";
  correlation_id?: string;
  approval_id: string;
  status: "sent" | "resent" | "updated" | "skipped" | "failed";
  channel_id: string;
  message_id?: string;
  replaces_message_id?: string;
  board_url?: string;
  board_anchor?: string;
  reason?: string;
  sent_at?: string;
  updated_at?: string;
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
  correlation_id?: string;
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
    message_verification_checked_at?: string;
    board_url?: string;
    board_anchor?: string;
    unsafe_fields_omitted?: boolean;
  };
  [key: string]: unknown;
};

type NotificationsBoardConfig = RemoteNotificationsConfig;

export async function notifyPendingDiscordApprovals(
  projectRoot: string,
  gateway: PreparedDiscordGateway & { status: "ready" },
  channel: DiscordApprovalChannel,
  options: DiscordApprovalNotificationOptions = {}
): Promise<DiscordApprovalNotificationResult> {
  const now = options.now?.() ?? new Date();
  const approvals = (await readApprovalRecords(projectRoot)).sort(
    compareApprovalNotificationPriority
  );
  const result: DiscordApprovalNotificationResult = {
    scanned: approvals.length,
    sent: 0,
    resent: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    audit_path: toProjectPath(projectRoot, discordNotificationAuditPath(projectRoot)),
    failures: []
  };
  const boardBaseUrl = await readConfiguredBoardBaseUrl(projectRoot);
  let remainingMessageVerifications = normalizeVerificationLimit(
    options.maxMessageVerifications
  );
  const messageVerificationIntervalMs =
    options.messageVerificationIntervalMs ?? 15 * 60 * 1_000;

  for (const approval of approvals) {
    const board = boardTrackingMetadata(boardBaseUrl, approval.id);
    if (shouldRetryApprovalStatusUpdate(approval)) {
      try {
        const update = await updateDiscordApprovalMessage(projectRoot, approval.id, channel, options);
        if (update.status === "updated") {
          result.updated += 1;
          await appendDiscordNotificationAudit(projectRoot, {
            schema_version: "0.1",
            approval_id: approval.id,
            status: "updated",
            channel_id: gateway.approval_channel_id,
            message_id: update.message_id,
            board_url: approval.discord?.board_url ?? board.board_url,
            board_anchor: approval.discord?.board_anchor ?? board.board_anchor,
            reason: "status_reconciled",
            updated_at: now.toISOString(),
            recorded_at: now.toISOString()
          });
        } else {
          result.skipped += 1;
        }
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
          message_id: approval.discord?.message_id,
          board_url: approval.discord?.board_url ?? board.board_url,
          board_anchor: approval.discord?.board_anchor ?? board.board_anchor,
          reason,
          recorded_at: now.toISOString()
        });
      }
      continue;
    }

    if (!isOpenApprovalStatus(approval.status)) {
      result.skipped += 1;
      continue;
    }

    if (isDiscordSnowflake(approval.discord?.message_id)) {
      if (
        remainingMessageVerifications <= 0 ||
        !isMessageVerificationDue(
          approval,
          now,
          messageVerificationIntervalMs
        )
      ) {
        result.skipped += 1;
        continue;
      }
      remainingMessageVerifications -= 1;
      const verification = await verifyDiscordApprovalMessage(channel, approval.discord.message_id);
      await updateApprovalDiscordMetadata(projectRoot, approval, {
        message_verification_checked_at: now.toISOString()
      });
      if (verification.status === "found") {
        result.skipped += 1;
        continue;
      }

      if (verification.status === "failed") {
        result.failed += 1;
        result.failures.push({
          approval_id: approval.id,
          reason: verification.reason
        });
        await appendDiscordNotificationAudit(projectRoot, {
          schema_version: "0.1",
          approval_id: approval.id,
          status: "failed",
          channel_id: gateway.approval_channel_id,
          message_id: approval.discord.message_id,
          board_url: approval.discord?.board_url ?? board.board_url,
          board_anchor: approval.discord?.board_anchor ?? board.board_anchor,
          reason: verification.reason,
          recorded_at: now.toISOString()
        });
        continue;
      }
    }

    try {
      const input = toApprovalMessageInput(approval, boardBaseUrl);
      const message = buildApprovalMessage(input);
      const sent = await channel.send(message);
      const sentAt = now.toISOString();
      const resent = approval.discord?.message_id !== undefined;
      await updateApprovalDiscordMetadata(projectRoot, approval, {
        channel_id: gateway.approval_channel_id,
        message_id: sent.id,
        nonce: message.nonce,
        notified_at: sentAt,
        message_verification_checked_at: sentAt,
        nonce_expires_at: defaultNonceExpiresAt(now),
        board_url: input.board_url,
        board_anchor: input.board_url === undefined ? undefined : approvalBoardAnchor(approval.id),
        unsafe_fields_omitted: containsUnsafeApprovalMessageData(input)
      });
      await appendDiscordNotificationAudit(projectRoot, {
        schema_version: "0.1",
        approval_id: approval.id,
        status: resent ? "resent" : "sent",
        channel_id: gateway.approval_channel_id,
        message_id: sent.id,
        replaces_message_id: resent ? approval.discord?.message_id : undefined,
        board_url: input.board_url,
        board_anchor: input.board_url === undefined ? undefined : approvalBoardAnchor(approval.id),
        reason: resent ? "message_missing_reposted" : undefined,
        sent_at: sentAt,
        recorded_at: sentAt
      });
      if (resent) {
        result.resent += 1;
      } else {
        result.sent += 1;
      }
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
        board_url: board.board_url,
        board_anchor: board.board_anchor,
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
      snooze_until: approval.snooze_until,
      board_url: approval.discord?.board_url
    })
  );
  await updateApprovalDiscordMetadata(projectRoot, approval, {
    updated_at: (options.now?.() ?? new Date()).toISOString()
  });
  const correlation = await ensureApprovalCorrelation(projectRoot, approval, {
    migrated: approval.correlation_id === undefined
  });
  await trackCorrelationMember(projectRoot, {
    correlationId: correlation.correlation_id,
    approvalId,
    kind: "discord_message",
    id: messageId,
    status: approval.status ?? "updated",
    artifactPath: toProjectPath(projectRoot, discordNotificationAuditPath(projectRoot)),
    createdAt: (options.now?.() ?? new Date()).toISOString()
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

type DiscordApprovalMessageVerification =
  | { status: "found" }
  | { status: "missing"; reason: string }
  | { status: "failed"; reason: string };

async function verifyDiscordApprovalMessage(
  channel: DiscordApprovalChannel,
  messageId: string
): Promise<DiscordApprovalMessageVerification> {
  if (channel.messages?.fetch === undefined) {
    return { status: "found" };
  }

  try {
    await channel.messages.fetch(messageId);
    return { status: "found" };
  } catch (error) {
    if (isDiscordUnknownMessageError(error)) {
      return { status: "missing", reason: "message_missing_reposted" };
    }

    return { status: "failed", reason: sanitizeAuditReason(String(error)) };
  }
}

function isOpenApprovalStatus(status: unknown): boolean {
  return status === "pending" || status === "snoozed";
}

function compareApprovalNotificationPriority(
  left: ApprovalRecord,
  right: ApprovalRecord
): number {
  return notificationPriority(left) - notificationPriority(right);
}

function notificationPriority(approval: ApprovalRecord): number {
  if (isOpenApprovalStatus(approval.status) && approval.discord?.message_id === undefined) {
    return 0;
  }
  if (shouldRetryApprovalStatusUpdate(approval)) {
    return 1;
  }
  if (isOpenApprovalStatus(approval.status)) {
    return 2;
  }
  return 3;
}

function normalizeVerificationLimit(value: number | undefined): number {
  if (value === undefined) {
    return 5;
  }
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isMessageVerificationDue(
  approval: ApprovalRecord,
  now: Date,
  intervalMs: number
): boolean {
  const checkedAt = approval.discord?.message_verification_checked_at;
  if (checkedAt === undefined) {
    return true;
  }
  const checkedAtMs = Date.parse(checkedAt);
  return !Number.isFinite(checkedAtMs) || checkedAtMs + intervalMs <= now.getTime();
}

function shouldRetryApprovalStatusUpdate(approval: ApprovalRecord): boolean {
  return (
    approval.discord?.message_id !== undefined &&
    approval.discord.updated_at === undefined &&
    (approval.status === "decided" || approval.status === "snoozed")
  );
}

function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/u.test(value);
}

function isDiscordUnknownMessageError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 10008 || code === "10008") {
      return true;
    }
  }

  return /unknown message|message not found/i.test(String(error));
}

function toApprovalMessageInput(
  approval: ApprovalRecord,
  boardBaseUrl: string | undefined
): ApprovalMessageInput {
  const actions = approval.actions ?? approval.allowed_actions;
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
    board_url: boardBaseUrl === undefined ? undefined : approvalBoardUrl(boardBaseUrl, approval.id),
    actions: boardBaseUrl === undefined ? actions : appendOpenBoardAction(actions),
    nonce: approval.discord?.nonce ?? approval.discord_nonce ?? approval.nonce,
    diff: approval.diff,
    log: approval.log,
    stdout: approval.stdout,
    stderr: approval.stderr
  };
}

async function readConfiguredBoardBaseUrl(projectRoot: string): Promise<string | undefined> {
  const configPath = path.join(getKaironPaths(projectRoot).configDir, "notifications.json");
  let config: NotificationsBoardConfig;

  try {
    config = await readJsonFile<NotificationsBoardConfig>(configPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }

  const stableRemote = prepareStableRemoteProfile(config.remote);
  const boardConfig = resolveBoardProfileConfig(config);
  if (boardConfig.enabled !== true) {
    return undefined;
  }

  if (stableRemote.configured) {
    const preparedBoard = prepareBoardProfile(boardConfig);
    return preparedBoard.invalidConfig.length === 0 &&
      preparedBoard.missingConfig.length === 0
      ? preparedBoard.externalBaseUrl?.replace(/\/$/, "")
      : undefined;
  }

  return normalizeBoardBaseUrl(boardConfig.base_url ?? "http://127.0.0.1:8787");
}

function normalizeBoardBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) {
      return undefined;
    }

    url.hostname = "127.0.0.1";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function approvalBoardUrl(boardBaseUrl: string, approvalId: string): string {
  return `${boardBaseUrl}/${approvalBoardAnchor(approvalId)}`;
}

function approvalBoardAnchor(approvalId: string): string {
  return `#approval-${approvalId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function boardTrackingMetadata(
  boardBaseUrl: string | undefined,
  approvalId: string
): { board_url?: string; board_anchor?: string } {
  if (boardBaseUrl === undefined) {
    return {};
  }

  return {
    board_url: approvalBoardUrl(boardBaseUrl, approvalId),
    board_anchor: approvalBoardAnchor(approvalId)
  };
}

function appendOpenBoardAction(
  actions: ApprovalAction[] | undefined
): NonNullable<ApprovalMessageInput["actions"]> {
  const baseActions = actions ?? [
    "approve",
    "reject",
    "request_changes",
    "snooze"
  ];
  return [...baseActions, "open_board"];
}

async function updateApprovalDiscordMetadata(
  projectRoot: string,
  approval: ApprovalRecord,
  discord: NonNullable<ApprovalRecord["discord"]>
): Promise<void> {
  const filePath = approvalPath(projectRoot, approval.id);
  await withApprovalMetadataLock(projectRoot, filePath, async (lock) => {
    const current = (await readApprovalRecord(projectRoot, approval.id)) ?? approval;
    await writeJsonFileFenced(lock, filePath, {
      ...current,
      discord_nonce: discord.nonce ?? current.discord_nonce,
      discord: {
        ...current.discord,
        ...discord
      }
    });
  });
}

async function withApprovalMetadataLock<T>(
  projectRoot: string,
  filePath: string,
  run: (handle: ResourceLockHandle) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withResourceLock(
        projectRoot,
        filePath,
        { owner: "discord-approval-metadata", ttlMs: 30_000 },
        run
      );
    } catch (error) {
      if (
        !(error instanceof ResourceLockAlreadyExistsError) ||
        attempt >= approvalMetadataLockRetryDelaysMs.length
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, approvalMetadataLockRetryDelaysMs[attempt])
      );
    }
  }
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
  const approval = await readApprovalRecord(projectRoot, record.approval_id);
  const correlation =
    approval === null
      ? undefined
      : await ensureApprovalCorrelation(projectRoot, approval, {
          migrated: approval.correlation_id === undefined
        });
  await appendJsonLine(discordNotificationAuditPath(projectRoot), {
    ...record,
    correlation_id: correlation?.correlation_id ?? record.correlation_id
  });
  if (record.status === "failed") {
    await recordNotificationResult(projectRoot, {
      provider: "discord",
      result: "failed",
      recordedAt: new Date(record.recorded_at)
    }).catch(() => undefined);
  } else if (
    record.status === "sent" ||
    record.status === "resent" ||
    record.status === "updated"
  ) {
    await recordNotificationResult(projectRoot, {
      provider: "discord",
      result: "success",
      recordedAt: new Date(record.recorded_at)
    }).catch(() => undefined);
  }
  if (correlation !== undefined && record.message_id !== undefined) {
    await trackCorrelationMember(projectRoot, {
      correlationId: correlation.correlation_id,
      approvalId: record.approval_id,
      kind: "discord_message",
      id: record.message_id,
      status:
        approval?.status !== undefined &&
        ["decided", "completed", "rejected", "cancelled"].includes(approval.status)
          ? approval.status
          : record.status === "failed"
            ? "failed"
            : "sent",
      artifactPath: toProjectPath(projectRoot, discordNotificationAuditPath(projectRoot)),
      createdAt: record.recorded_at,
      replacesId: record.replaces_message_id
    });
  }
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function sanitizeAuditReason(value: string): string {
  const sanitized = sanitizeDiscordAuditText(value) ?? "unknown discord approval notification error";
  return truncate(
    sanitized
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
