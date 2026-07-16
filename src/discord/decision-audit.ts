import { createHash } from "node:crypto";
import path from "node:path";
import { ApprovalQueue, ApprovalNotFoundError } from "../approvals/approval-queue.js";
import {
  ensureApprovalCorrelation,
  trackCorrelationMember
} from "../correlation/store.js";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import {
  parseApprovalCustomId,
  type DiscordInteractionInput,
  type NormalizedDiscordCommand
} from "./interactions.js";

export type DiscordDecisionAuditStatus =
  | "applied"
  | "rejected"
  | "skipped"
  | "failed";

export type DiscordDecisionMessageUpdateStatus =
  | "updated"
  | "skipped"
  | "failed"
  | "unavailable";

export type DiscordDecisionAuditSideEffect = {
  command_status?: "completed" | "failed";
  applied_event_ids?: string[];
  message_update_status?: DiscordDecisionMessageUpdateStatus;
  message_update_reason?: string;
  message_id?: string;
  error?: string;
};

export type DiscordDecisionAuditRecord = {
  schema_version: "0.1";
  correlation_id?: string;
  interaction_id: string;
  approval_id: string;
  decision: string;
  status: DiscordDecisionAuditStatus;
  duplicate: boolean;
  actor_hash: string;
  message_id?: string;
  command_id?: string;
  command_status?: "completed" | "failed";
  idempotency_key?: string;
  reason?: string;
  decision_reason?: string;
  applied_event_ids?: string[];
  message_update_status?: DiscordDecisionMessageUpdateStatus;
  message_update_reason?: string;
  received_at?: string;
  recorded_at: string;
};

export async function auditDiscordDecisionInteraction(
  projectRoot: string,
  input: {
    interaction: DiscordInteractionInput;
    result: NormalizedDiscordCommand;
    sideEffect?: DiscordDecisionAuditSideEffect;
    recordedAt: Date;
  }
): Promise<void> {
  const parsed =
    input.interaction.custom_id === undefined
      ? { kind: "unknown" as const }
      : parseApprovalCustomId(input.interaction.custom_id);

  if (parsed.kind !== "approval" || parsed.modal) {
    return;
  }

  const command =
    input.result.accepted &&
    (input.result.command.type === "approval.decide" ||
      input.result.command.type === "approval.snooze" ||
      input.result.command.type === "approval.confirmation.request")
      ? input.result.command
      : undefined;
  const reason =
    input.sideEffect?.error ??
    (input.result.accepted ? undefined : input.result.reason);
  const status = resolveAuditStatus(input.result, input.sideEffect);
  const messageId = input.sideEffect?.message_id ?? input.interaction.message_id;
  let correlationId: string | undefined;
  let approvalStatus: string | undefined;
  try {
    const approval = await new ApprovalQueue(projectRoot).show(parsed.approval_id);
    approvalStatus = approval.status;
    correlationId = (
      await ensureApprovalCorrelation(projectRoot, approval, {
        migrated: approval.correlation_id === undefined
      })
    ).correlation_id;
  } catch (error) {
    if (!(error instanceof ApprovalNotFoundError)) {
      throw error;
    }
  }

  await appendJsonLine(discordDecisionAuditPath(projectRoot), {
    schema_version: "0.1",
    correlation_id: correlationId,
    interaction_id: input.interaction.interaction_id,
    approval_id: parsed.approval_id,
    decision: parsed.action,
    status,
    duplicate: input.result.duplicate,
    actor_hash: hashActor(input.interaction.user_id),
    message_id: messageId,
    command_id: input.result.accepted ? input.result.command_id : undefined,
    command_status: input.sideEffect?.command_status,
    idempotency_key: input.result.accepted ? input.result.idempotency_key : undefined,
    reason:
      input.result.duplicate && !input.result.accepted
        ? "duplicate_interaction"
        : sanitizeDiscordAuditText(reason),
    decision_reason: sanitizeDiscordAuditText(
      command !== undefined && "reason" in command ? command.reason : undefined
    ),
    applied_event_ids: input.sideEffect?.applied_event_ids,
    message_update_status: input.sideEffect?.message_update_status,
    message_update_reason: sanitizeDiscordAuditText(
      input.sideEffect?.message_update_reason
    ),
    received_at: input.interaction.received_at,
    recorded_at: input.recordedAt.toISOString()
  } satisfies DiscordDecisionAuditRecord);
  if (correlationId !== undefined) {
    const auditPath = toProjectPath(projectRoot, discordDecisionAuditPath(projectRoot));
    await trackCorrelationMember(projectRoot, {
      correlationId,
      approvalId: parsed.approval_id,
      kind: "discord_interaction",
      id: input.interaction.interaction_id,
      status,
      artifactPath: auditPath,
      createdAt: input.recordedAt.toISOString()
    });
    if (messageId !== undefined) {
      await trackCorrelationMember(projectRoot, {
        correlationId,
        approvalId: parsed.approval_id,
        kind: "discord_message",
        id: messageId,
        status: approvalStatus ?? input.sideEffect?.message_update_status ?? status,
        artifactPath: auditPath,
        createdAt: input.recordedAt.toISOString()
      });
    }
  }
}

export function discordDecisionAuditPath(projectRoot: string): string {
  return path.join(
    getKaironPaths(projectRoot).runtimeDir,
    "discord",
    "decision-interactions.jsonl"
  );
}

function resolveAuditStatus(
  result: NormalizedDiscordCommand,
  sideEffect: DiscordDecisionAuditSideEffect | undefined
): DiscordDecisionAuditStatus {
  if (!result.accepted) {
    return result.duplicate ? "skipped" : "rejected";
  }

  if (result.duplicate) {
    return "skipped";
  }

  return sideEffect?.command_status === "failed" ? "failed" : "applied";
}

function hashActor(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

export function sanitizeDiscordAuditText(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return truncate(
    value
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(
        /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
        "[redacted-private-key]"
      )
      .replace(/\s+/g, " ")
      .trim(),
    500
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
