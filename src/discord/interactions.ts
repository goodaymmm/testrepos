import path from "node:path";
import { loadConfigFile, type ConfigFileName } from "../core/config/load-config.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import { CommandInbox, type KaironCommand } from "../queue/command-inbox.js";
import { getLocalDateKey, type ScheduleConfig } from "../runtime/schedule-engine.js";
import type { PreparedDiscordGateway } from "./gateway.js";
import {
  DiscordIdempotencyStore,
  discordApprovalActionKey,
  discordInteractionKey
} from "./idempotency.js";

export type ApprovalAction =
  | "approve"
  | "reject"
  | "request_changes"
  | "snooze";

export type ParsedCustomId =
  | {
      kind: "approval";
      version: "v1";
      approval_id: string;
      action: ApprovalAction;
      nonce: string;
      modal: boolean;
    }
  | {
      kind: "unknown";
      reason: string;
    };

export type DiscordInteractionInput = {
  interaction_id: string;
  user_id: string;
  guild_id?: string;
  channel_id?: string;
  message_id?: string;
  custom_id?: string;
  command_name?: string;
  reason?: string;
  snooze_until?: string;
  received_at?: string;
};

export type DiscordValidationResult =
  | {
      ok: true;
      parsed?: ParsedCustomId & { kind: "approval" };
      confirmation?: DiscordApprovalConfirmationRequirement;
    }
  | {
      ok: false;
      reason: string;
    };

export type DiscordApprovalConfirmationRequirement = {
  required_by: "board" | "local";
  reason: "board_confirmation_required" | "local_confirmation_required";
};

export type NormalizedDiscordCommand =
  | {
      accepted: true;
      duplicate: boolean;
      command: KaironCommand;
      command_id?: string;
      idempotency_key: string;
    }
  | {
      accepted: false;
      duplicate: boolean;
      reason: string;
    };

type ApprovalRecord = {
  id: string;
  status?: string;
  type?: string;
  risk_level?: string;
  nonce?: string;
  discord_nonce?: string;
  actions?: string[];
  discord?: {
    nonce?: string;
    nonce_expires_at?: string;
  };
};

type NotificationsPolicyConfig = {
  approval_policy?: {
    require_board_reauth_for?: string[];
    require_board_confirmation_for?: string[];
    require_local_confirmation_for?: string[];
  };
};

type PoliciesConfig = {
  git?: {
    require_approval_for?: string[];
  };
};

const defaultHighRiskApprovalTypes = [
  "deploy",
  "secret_change",
  "billing_change",
  "merge",
  "protected_branch_push",
  "git_protected_branch_push",
  "force_push",
  "branch_delete"
];

const defaultBoardConfirmationApprovalTypes = [
  "deploy",
  "secret_change",
  "billing_change",
  "protected_branch_push",
  "git_protected_branch_push",
  "force_push",
  "branch_delete"
];

const defaultLocalConfirmationApprovalTypes = [
  "merge",
  "protected_branch_push",
  "git_protected_branch_push",
  "force_push",
  "branch_delete"
];

export function parseApprovalCustomId(customId: string): ParsedCustomId {
  const parts = customId.split(":");

  if (parts.length !== 6 || parts[0] !== "kr" || parts[1] !== "v1") {
    return { kind: "unknown", reason: "unsupported custom_id format" };
  }

  const [, version, resource, approvalId, rawAction, nonce] = parts;
  if (version !== "v1" || resource !== "apr") {
    return { kind: "unknown", reason: "unsupported custom_id resource" };
  }

  const action = parseAction(rawAction);
  if (action === null) {
    return { kind: "unknown", reason: "unsupported approval action" };
  }

  return {
    kind: "approval",
    version,
    approval_id: approvalId,
    action: action.action,
    nonce,
    modal: action.modal
  };
}

export async function validateDiscordApprovalInteraction(
  projectRoot: string,
  gateway: PreparedDiscordGateway,
  interaction: DiscordInteractionInput
): Promise<DiscordValidationResult> {
  if (gateway.status !== "ready") {
    return { ok: false, reason: "discord gateway is not ready" };
  }

  if (!gateway.allowed_user_ids.includes(interaction.user_id)) {
    return { ok: false, reason: "discord actor is not allowed" };
  }

  if (interaction.guild_id !== gateway.guild_id) {
    return { ok: false, reason: "discord guild is not allowed" };
  }

  if (interaction.channel_id !== gateway.approval_channel_id) {
    return { ok: false, reason: "discord channel is not allowed" };
  }

  const customId = interaction.custom_id;
  if (customId === undefined) {
    return { ok: false, reason: "custom_id is required" };
  }

  const parsed = parseApprovalCustomId(customId);
  if (parsed.kind !== "approval") {
    return { ok: false, reason: parsed.reason };
  }

  const approval = await readApproval(projectRoot, parsed.approval_id);
  if (approval === null) {
    return { ok: false, reason: "approval was not found" };
  }
  if (!["pending", "snoozed"].includes(approval.status ?? "")) {
    return { ok: false, reason: "approval is not pending" };
  }

  if (resolveApprovalNonce(approval) !== parsed.nonce) {
    return { ok: false, reason: "approval nonce does not match" };
  }

  if (isApprovalNonceExpired(approval, interaction.received_at)) {
    return { ok: false, reason: "approval nonce expired" };
  }

  if (!resolveApprovalActions(approval).includes(parsed.action)) {
    return { ok: false, reason: "approval action is not allowed" };
  }

  const confirmation = await resolveDiscordApprovalConfirmationRequirement(
    projectRoot,
    approval,
    parsed.action
  );

  return confirmation === null ? { ok: true, parsed } : { ok: true, parsed, confirmation };
}

export async function normalizeDiscordApprovalInteraction(
  projectRoot: string,
  gateway: PreparedDiscordGateway,
  interaction: DiscordInteractionInput
): Promise<NormalizedDiscordCommand> {
  const interactionKey = discordInteractionKey(interaction.interaction_id);
  const validation = await validateDiscordApprovalInteraction(
    projectRoot,
    gateway,
    interaction
  );
  const idempotency = new DiscordIdempotencyStore(projectRoot);

  if (!validation.ok) {
    const result = await idempotency.reject(interactionKey, validation.reason, {
      ttlMinutes: gateway.status === "ready" ? gateway.idempotency_ttl_minutes : 60
    });
    return {
      accepted: false,
      duplicate: result.duplicate,
      reason: validation.reason
    };
  }

  if (gateway.status !== "ready") {
    return {
      accepted: false,
      duplicate: false,
      reason: "discord gateway is not ready"
    };
  }

  const parsed = validation.parsed;
  if (parsed === undefined) {
    return {
      accepted: false,
      duplicate: false,
      reason: "approval custom_id parse failed"
    };
  }

  const actionKey = discordApprovalActionKey({
    approvalId: parsed.approval_id,
    action: parsed.action,
    nonce: parsed.nonce
  });

  const actionResult = await idempotency.accept(actionKey, {
    ttlMinutes: gateway.idempotency_ttl_minutes
  });
  if (actionResult.duplicate) {
    return {
      accepted: false,
      duplicate: true,
      reason: "duplicate approval action"
    };
  }

  const command =
    validation.confirmation === undefined
      ? buildApprovalCommand(parsed, interaction)
      : buildApprovalConfirmationCommand(parsed, validation.confirmation, interaction);
  const inboxResult = await new CommandInbox(projectRoot).enqueue(command, {
    idempotencyKey: interactionKey
  });

  await idempotency.accept(interactionKey, {
    commandId: inboxResult.envelope.command_id,
    ttlMinutes: gateway.idempotency_ttl_minutes
  });

  return {
    accepted: true,
    duplicate: inboxResult.duplicate,
    command,
    command_id: inboxResult.envelope.command_id,
    idempotency_key: interactionKey
  };
}

export async function normalizeDiscordLeaveCommand(
  projectRoot: string,
  gateway: PreparedDiscordGateway,
  interaction: DiscordInteractionInput,
  now = new Date()
): Promise<NormalizedDiscordCommand> {
  const validation = validateGatewayActorAndChannel(gateway, interaction);
  const key = discordInteractionKey(interaction.interaction_id);
  const idempotency = new DiscordIdempotencyStore(projectRoot);

  if (!validation.ok) {
    const result = await idempotency.reject(key, validation.reason, {
      ttlMinutes: gateway.status === "ready" ? gateway.idempotency_ttl_minutes : 60
    });
    return { accepted: false, duplicate: result.duplicate, reason: validation.reason };
  }

  const schedule = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  const command = {
    type: "schedule.close_active_work" as const,
    source: "discord" as const,
    date: getLocalDateKey(now, schedule.timezone),
    reason: "discord_kairon_leave",
    actor: {
      discord_user_id: interaction.user_id,
      mapped_user_id: "user:owner"
    },
    discord: buildDiscordMetadata(interaction),
    received_at: interaction.received_at ?? now.toISOString()
  };
  const inboxResult = await new CommandInbox(projectRoot).enqueue(command, {
    idempotencyKey: key
  });
  const result = await idempotency.accept(key, {
    commandId: inboxResult.envelope.command_id,
    ttlMinutes: validation.gateway.idempotency_ttl_minutes,
    now
  });

  return {
    accepted: true,
    duplicate: inboxResult.duplicate || result.duplicate,
    command,
    command_id: inboxResult.envelope.command_id,
    idempotency_key: key
  };
}

export async function normalizeDiscordStatusCommand(
  projectRoot: string,
  gateway: PreparedDiscordGateway,
  interaction: DiscordInteractionInput,
  now = new Date()
): Promise<NormalizedDiscordCommand> {
  const validation = validateGatewayActorAndChannel(gateway, interaction);
  const key = discordInteractionKey(interaction.interaction_id);
  const idempotency = new DiscordIdempotencyStore(projectRoot);

  if (!validation.ok) {
    const result = await idempotency.reject(key, validation.reason, {
      ttlMinutes: gateway.status === "ready" ? gateway.idempotency_ttl_minutes : 60,
      now
    });
    return { accepted: false, duplicate: result.duplicate, reason: validation.reason };
  }

  const command = {
    type: "runtime.status" as const,
    source: "discord" as const,
    reason: "discord_kairon_status",
    actor: {
      discord_user_id: interaction.user_id,
      mapped_user_id: "user:owner"
    },
    discord: buildDiscordMetadata(interaction),
    received_at: interaction.received_at ?? now.toISOString()
  };
  const inboxResult = await new CommandInbox(projectRoot).enqueue(command, {
    idempotencyKey: key
  });
  const result = await idempotency.accept(key, {
    commandId: inboxResult.envelope.command_id,
    ttlMinutes: validation.gateway.idempotency_ttl_minutes,
    now
  });

  return {
    accepted: true,
    duplicate: inboxResult.duplicate || result.duplicate,
    command,
    command_id: inboxResult.envelope.command_id,
    idempotency_key: key
  };
}

function buildApprovalConfirmationCommand(
  parsed: ParsedCustomId & { kind: "approval" },
  confirmation: DiscordApprovalConfirmationRequirement,
  interaction: DiscordInteractionInput
): KaironCommand {
  return {
    type: "approval.confirmation.request",
    source: "discord",
    approval_id: parsed.approval_id,
    action: "approve",
    confirmation: confirmation.required_by,
    reason: confirmation.reason,
    actor: buildActor(interaction),
    discord: buildDiscordMetadata(interaction),
    nonce: parsed.nonce,
    received_at: interaction.received_at ?? new Date().toISOString()
  };
}

function buildApprovalCommand(
  parsed: ParsedCustomId & { kind: "approval" },
  interaction: DiscordInteractionInput
): KaironCommand {
  if (parsed.action === "snooze") {
    return {
      type: "approval.snooze",
      source: "discord",
      approval_id: parsed.approval_id,
      until: interaction.snooze_until ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      actor: buildActor(interaction),
      discord: buildDiscordMetadata(interaction),
      nonce: parsed.nonce,
      received_at: interaction.received_at ?? new Date().toISOString()
    };
  }

  return {
    type: "approval.decide",
    source: "discord",
    approval_id: parsed.approval_id,
    decision: parsed.action,
    reason:
      parsed.action === "reject" || parsed.action === "request_changes"
        ? interaction.reason
        : undefined,
    actor: buildActor(interaction),
    discord: buildDiscordMetadata(interaction),
    nonce: parsed.nonce,
    received_at: interaction.received_at ?? new Date().toISOString()
  };
}

function validateGatewayActorAndChannel(
  gateway: PreparedDiscordGateway,
  interaction: DiscordInteractionInput
):
  | { ok: true; gateway: PreparedDiscordGateway & { status: "ready" } }
  | { ok: false; reason: string } {
  if (gateway.status !== "ready") {
    return { ok: false, reason: "discord gateway is not ready" };
  }

  if (!gateway.allowed_user_ids.includes(interaction.user_id)) {
    return { ok: false, reason: "discord actor is not allowed" };
  }

  if (interaction.guild_id !== gateway.guild_id) {
    return { ok: false, reason: "discord guild is not allowed" };
  }

  if (interaction.channel_id !== gateway.approval_channel_id) {
    return { ok: false, reason: "discord channel is not allowed" };
  }

  return { ok: true, gateway };
}

async function readApproval(
  projectRoot: string,
  approvalId: string
): Promise<ApprovalRecord | null> {
  try {
    return await readJsonFile<ApprovalRecord>(
      path.join(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function parseAction(
  rawAction: string
): { action: ApprovalAction; modal: boolean } | null {
  if (rawAction === "approve" || rawAction === "reject" || rawAction === "snooze") {
    return { action: rawAction, modal: false };
  }

  if (rawAction === "reject_modal") {
    return { action: "reject", modal: true };
  }

  if (rawAction === "changes" || rawAction === "request_changes") {
    return { action: "request_changes", modal: false };
  }

  if (rawAction === "changes_modal") {
    return { action: "request_changes", modal: true };
  }

  return null;
}

function resolveApprovalNonce(approval: ApprovalRecord): string | undefined {
  return approval.discord_nonce ?? approval.nonce ?? approval.discord?.nonce;
}

function isApprovalNonceExpired(
  approval: ApprovalRecord,
  receivedAt: string | undefined
): boolean {
  const expiresAt = approval.discord?.nonce_expires_at;
  if (expiresAt === undefined) {
    return false;
  }

  const expiresAtTime = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtTime)) {
    return false;
  }

  const receivedAtTime = Date.parse(receivedAt ?? new Date().toISOString());
  return Number.isFinite(receivedAtTime) && receivedAtTime > expiresAtTime;
}

function resolveApprovalActions(approval: ApprovalRecord): ApprovalAction[] {
  const actions = approval.actions ?? ["approve", "reject", "request_changes", "snooze"];
  return actions.flatMap((action) => {
    const parsed = parseAction(action);
    return parsed === null ? [] : [parsed.action];
  });
}

async function resolveDiscordApprovalConfirmationRequirement(
  projectRoot: string,
  approval: ApprovalRecord,
  action: ApprovalAction
): Promise<DiscordApprovalConfirmationRequirement | null> {
  if (action !== "approve") {
    return null;
  }

  const approvalType = approval.type;
  const policies = await readApprovalConfirmationPolicies(projectRoot);

  if (approvalType !== undefined) {
    if (policies.board.has(approvalType)) {
      return {
        required_by: "board",
        reason: "board_confirmation_required"
      };
    }

    if (policies.local.has(approvalType)) {
      return {
        required_by: "local",
        reason: "local_confirmation_required"
      };
    }
  }

  if (approval.risk_level === "high" || approval.risk_level === "critical") {
    return {
      required_by: "board",
      reason: "board_confirmation_required"
    };
  }

  return null;
}

async function readApprovalConfirmationPolicies(projectRoot: string): Promise<{
  board: Set<string>;
  local: Set<string>;
}> {
  const [notifications, policies] = await Promise.all([
    readOptionalConfig<NotificationsPolicyConfig>(projectRoot, "notifications.json"),
    readOptionalConfig<PoliciesConfig>(projectRoot, "policies.json")
  ]);
  const configuredBoardConfirmation =
    notifications?.approval_policy?.require_board_confirmation_for ?? [];
  const configuredBoardReauth =
    notifications?.approval_policy?.require_board_reauth_for ?? [];
  const configuredLocalConfirmation =
    notifications?.approval_policy?.require_local_confirmation_for ?? [];
  const configuredApprovalRequired = policies?.git?.require_approval_for ?? [];

  return {
    board: new Set([
      ...defaultBoardConfirmationApprovalTypes,
      ...configuredBoardReauth,
      ...configuredBoardConfirmation
    ]),
    local: new Set([
      ...defaultLocalConfirmationApprovalTypes,
      ...configuredApprovalRequired,
      ...configuredLocalConfirmation
    ])
  };
}

export async function readHighRiskApprovalTypes(
  projectRoot: string
): Promise<Set<string>> {
  const policies = await readApprovalConfirmationPolicies(projectRoot);
  return new Set([
    ...defaultHighRiskApprovalTypes,
    ...policies.board,
    ...policies.local
  ]);
}

async function readOptionalConfig<T>(
  projectRoot: string,
  fileName: ConfigFileName
): Promise<T | null> {
  try {
    return await loadConfigFile<T>(projectRoot, fileName);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function buildActor(interaction: DiscordInteractionInput): Record<string, string> {
  return {
    discord_user_id: interaction.user_id,
    mapped_user_id: "user:owner"
  };
}

function buildDiscordMetadata(
  interaction: DiscordInteractionInput
): NonNullable<KaironCommand["discord"]> {
  return {
    guild_id: interaction.guild_id,
    channel_id: interaction.channel_id,
    message_id: interaction.message_id,
    interaction_id: interaction.interaction_id,
    custom_id: interaction.custom_id
  };
}
