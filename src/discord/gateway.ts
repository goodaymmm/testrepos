import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  normalizeDiscordStatusCommand,
  parseApprovalCustomId,
  validateDiscordApprovalInteraction,
  type DiscordInteractionInput,
  type NormalizedDiscordCommand
} from "./interactions.js";
import { StateApplier, type InternalCommand } from "../state/state-applier.js";
import { formatRuntimeStatus, getRuntimeStatus } from "../runtime/status.js";
import { CommandInbox } from "../queue/command-inbox.js";
import {
  notifyPendingDiscordApprovals,
  updateDiscordApprovalMessage,
  type DiscordApprovalChannel,
  type DiscordApprovalMessageUpdateResult,
  type DiscordApprovalNotificationResult
} from "./approval-notifier.js";
import {
  parseDiscordIdList,
  validateDiscordEnvValues
} from "./env-validation.js";
import {
  auditDiscordDecisionInteraction,
  sanitizeDiscordAuditText,
  type DiscordDecisionAuditSideEffect
} from "./decision-audit.js";

export type DiscordProviderConfig = {
  enabled: boolean;
  mode: "gateway";
  bot_token_env: string;
  application_id_env: string;
  guild_id_env: string;
  approval_channel_id_env: string;
  owner_user_id_env: string;
  allowed_user_ids_env?: string;
  use_dm: boolean;
  register_commands_on_start: boolean;
};

export type DiscordGatewayConfig = {
  schema_version: string;
  primary_provider: "discord";
  providers: {
    discord: DiscordProviderConfig;
  };
  gateway?: {
    ack_timeout_ms?: number;
    idempotency_ttl_minutes?: number;
    reconnect?: {
      enabled?: boolean;
      max_backoff_seconds?: number;
    };
  };
};

export type PreparedDiscordGateway =
  | {
      status: "disabled";
      reason: string;
      missing_env: string[];
      invalid_env?: string[];
    }
  | {
      status: "ready";
      mode: "gateway";
      bot_token: string;
      application_id: string;
      guild_id: string;
      approval_channel_id: string;
      owner_user_id: string;
      allowed_user_ids: string[];
      register_commands_on_start: boolean;
      ack_timeout_ms: number;
      idempotency_ttl_minutes: number;
      reconnect: {
        enabled: boolean;
        max_backoff_seconds: number;
      };
    };

export type DiscordGatewayRuntimeStatus =
  | {
      schema_version: string;
      status: "disabled";
      reason: string;
      missing_env: string[];
      invalid_env?: string[];
      updated_at: string;
    }
  | {
      schema_version: string;
      status: "starting" | "ready" | "setup_required" | "error" | "stopped";
      mode: "gateway";
      application_id: string;
      guild_id: string;
      approval_channel_id: string;
      commands_registered: boolean;
      approval_notifications?: DiscordApprovalNotificationResult;
      client_user_id?: string;
      error?: string;
      error_code?: string;
      operation?: string;
      next_action?: string;
      discord_error_code?: string;
      http_status?: number;
      reconnect?: {
        enabled: boolean;
        max_backoff_seconds: number;
        attempts: number;
      };
      updated_at: string;
    };

export type DiscordGatewayClient = {
  once(event: string, callback: () => unknown): unknown;
  on(event: string, callback: (...args: unknown[]) => unknown): unknown;
  login(token: string): Promise<unknown> | unknown;
  destroy(): Promise<unknown> | unknown;
  channels?: {
    fetch(channelId: string): Promise<unknown> | unknown;
  };
  user?: {
    id?: string;
  } | null;
};

export type DiscordRestClient = {
  put(route: string, options: { body: unknown }): Promise<unknown> | unknown;
};

export type DiscordRestRegistration = {
  route: string;
  rest: DiscordRestClient;
};

export type DiscordGatewayInteraction = {
  id?: string;
  user?: { id?: string } | null;
  guildId?: string | null;
  channelId?: string | null;
  channel?: { id?: string } | null;
  message?: { id?: string } | null;
  commandName?: string;
  customId?: string;
  deferred?: boolean;
  replied?: boolean;
  options?: {
    getSubcommand?: (required?: boolean) => string | null;
  };
  isChatInputCommand?: () => boolean;
  deferReply?: (options: { ephemeral: boolean }) => Promise<unknown> | unknown;
  editReply?: (options: { content: string }) => Promise<unknown> | unknown;
  reply?: (options: { content: string; ephemeral: boolean }) => Promise<unknown> | unknown;
  showModal?: (modal: unknown) => Promise<unknown> | unknown;
  fields?: {
    getTextInputValue?: (customId: string) => string;
  };
};

export type DiscordGatewayHandle = {
  status: PreparedDiscordGateway["status"] | "setup_required" | "error";
  status_path: string;
  reason?: string;
  next_action?: string;
  stop(): Promise<void>;
};

export type StartDiscordGatewayOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readyTimeoutMs?: number;
  clientFactory?: (
    gateway: PreparedDiscordGateway & { status: "ready" }
  ) => Promise<DiscordGatewayClient> | DiscordGatewayClient;
  restFactory?: (
    gateway: PreparedDiscordGateway & { status: "ready" }
  ) => Promise<DiscordRestRegistration> | DiscordRestRegistration;
  approvalChannelFactory?: (
    gateway: PreparedDiscordGateway & { status: "ready" },
    client: DiscordGatewayClient
  ) => Promise<DiscordApprovalChannel | null> | DiscordApprovalChannel | null;
  approvalScanIntervalMs?: number;
};

type DiscordGatewaySetupOperation =
  | "register_commands"
  | "login"
  | "wait_for_ready"
  | "resolve_approval_channel"
  | "notify_approvals";

type ClassifiedDiscordGatewayError = {
  status: "setup_required" | "error";
  error_code: string;
  error: string;
  next_action: string;
  discord_error_code?: string;
  http_status?: number;
};

const DISCORD_CLIENT_READY_EVENT = "clientReady";

type GatewayInteractionSideEffect = DiscordDecisionAuditSideEffect & {
  content?: string;
};

export async function prepareDiscordGateway(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PreparedDiscordGateway> {
  const config = await loadConfigFile<DiscordGatewayConfig>(
    projectRoot,
    "notifications.json"
  );
  return prepareDiscordGatewayFromConfig(config, env);
}

export function prepareDiscordGatewayFromConfig(
  config: DiscordGatewayConfig,
  env: NodeJS.ProcessEnv = process.env
): PreparedDiscordGateway {
  const provider = config.providers.discord;

  if (!provider.enabled) {
    return {
      status: "disabled",
      reason: "discord provider is disabled",
      missing_env: []
    };
  }

  const requiredEnv = [
    provider.bot_token_env,
    provider.application_id_env,
    provider.guild_id_env,
    provider.approval_channel_id_env,
    provider.owner_user_id_env
  ];
  const missingEnv = requiredEnv.filter((name) => !hasEnvValue(env, name));

  if (missingEnv.length > 0) {
    return {
      status: "disabled",
      reason: "discord provider env is incomplete",
      missing_env: missingEnv
    };
  }

  const envValidation = validateDiscordEnvValues({
    env,
    applicationIdEnv: provider.application_id_env,
    guildIdEnv: provider.guild_id_env,
    approvalChannelIdEnv: provider.approval_channel_id_env,
    ownerUserIdEnv: provider.owner_user_id_env,
    allowedUserIdsEnv: provider.allowed_user_ids_env
  });

  if (envValidation.invalid_env.length > 0) {
    return {
      status: "disabled",
      reason: "discord provider env is invalid",
      missing_env: [],
      invalid_env: envValidation.invalid_env
    };
  }

  const ownerUserId = env[provider.owner_user_id_env] ?? "";
  const allowedUserIds = new Set([
    ownerUserId,
    ...parseDiscordIdList(
      provider.allowed_user_ids_env === undefined
        ? undefined
        : env[provider.allowed_user_ids_env]
    )
  ]);

  return {
    status: "ready",
    mode: "gateway",
    bot_token: env[provider.bot_token_env] ?? "",
    application_id: env[provider.application_id_env] ?? "",
    guild_id: env[provider.guild_id_env] ?? "",
    approval_channel_id: env[provider.approval_channel_id_env] ?? "",
    owner_user_id: ownerUserId,
    allowed_user_ids: [...allowedUserIds].filter(Boolean),
    register_commands_on_start: provider.register_commands_on_start,
    ack_timeout_ms: config.gateway?.ack_timeout_ms ?? 2500,
    idempotency_ttl_minutes: config.gateway?.idempotency_ttl_minutes ?? 60,
    reconnect: {
      enabled: config.gateway?.reconnect?.enabled ?? true,
      max_backoff_seconds:
        config.gateway?.reconnect?.max_backoff_seconds ?? 60
    }
  };
}

export async function startDiscordGateway(
  projectRoot: string,
  options: StartDiscordGatewayOptions = {}
): Promise<DiscordGatewayHandle> {
  const now = options.now ?? (() => new Date());
  const prepared = await prepareDiscordGateway(projectRoot, options.env ?? process.env);
  const statusPath = discordGatewayStatusPath(projectRoot);

  if (prepared.status === "disabled") {
    await writeGatewayStatus(projectRoot, {
      schema_version: "0.1",
      status: "disabled",
      reason: prepared.reason,
      missing_env: prepared.missing_env,
      invalid_env: prepared.invalid_env,
      updated_at: now().toISOString()
    });
    return {
      status: "disabled",
      status_path: toProjectPath(projectRoot, statusPath),
      stop: async () => undefined
    };
  }

  await writeGatewayStatus(projectRoot, {
    schema_version: "0.1",
    status: "starting",
    mode: "gateway",
    application_id: prepared.application_id,
    guild_id: prepared.guild_id,
    approval_channel_id: prepared.approval_channel_id,
    commands_registered: false,
    reconnect: {
      ...prepared.reconnect,
      attempts: 0
    },
    updated_at: now().toISOString()
  });

  const client = await (options.clientFactory ?? createDiscordJsClient)(prepared);
  let reconnectAttempts = 0;
  let approvalScanTimer: NodeJS.Timeout | undefined;
  let lastApprovalNotificationResult: DiscordApprovalNotificationResult | undefined;
  let approvalChannel: DiscordApprovalChannel | null = null;
  client.on("interactionCreate", (interaction) =>
    handleGatewayInteraction(
      projectRoot,
      prepared,
      interaction,
      now,
      () => approvalChannel
    ).catch((error) =>
      writeGatewayStatus(projectRoot, {
        schema_version: "0.1",
        status: "error",
        mode: "gateway",
        application_id: prepared.application_id,
        guild_id: prepared.guild_id,
        approval_channel_id: prepared.approval_channel_id,
        commands_registered: prepared.register_commands_on_start,
        approval_notifications: lastApprovalNotificationResult,
        error: String(error),
        reconnect: {
          ...prepared.reconnect,
          attempts: reconnectAttempts
        },
        updated_at: now().toISOString()
      })
    )
  );
  client.on("error", (error) => {
    reconnectAttempts += 1;
    return writeGatewayStatus(projectRoot, {
      schema_version: "0.1",
      status: "error",
      mode: "gateway",
      application_id: prepared.application_id,
      guild_id: prepared.guild_id,
      approval_channel_id: prepared.approval_channel_id,
      commands_registered: prepared.register_commands_on_start,
      error: String(error),
      reconnect: {
        ...prepared.reconnect,
        attempts: reconnectAttempts
      },
      updated_at: now().toISOString()
    });
  });

  if (prepared.register_commands_on_start) {
    const setupFailure = await handleDiscordGatewaySetupFailure(
      () =>
        registerKaironSlashCommands(
          prepared,
          options.restFactory ?? createDiscordJsRestRegistration
        ),
      {
        projectRoot,
        prepared,
        client,
        now,
        operation: "register_commands",
        commandsRegistered: false,
        reconnectAttempts,
        getApprovalNotifications: () => lastApprovalNotificationResult
      }
    );
    if (setupFailure !== null) {
      return setupFailure;
    }
  }

  const ready = waitForReady(client, options.readyTimeoutMs ?? 30_000);
  const loginFailure = await handleDiscordGatewaySetupFailure(
    async () => {
      await client.login(prepared.bot_token);
    },
    {
      projectRoot,
      prepared,
      client,
      now,
      operation: "login",
      commandsRegistered: prepared.register_commands_on_start,
      reconnectAttempts,
      getApprovalNotifications: () => lastApprovalNotificationResult
    }
  );
  if (loginFailure !== null) {
    void ready.catch(() => undefined);
    return loginFailure;
  }

  const readyFailure = await handleDiscordGatewaySetupFailure(
    async () => {
      await ready;
    },
    {
      projectRoot,
      prepared,
      client,
      now,
      operation: "wait_for_ready",
      commandsRegistered: prepared.register_commands_on_start,
      reconnectAttempts,
      getApprovalNotifications: () => lastApprovalNotificationResult
    }
  );
  if (readyFailure !== null) {
    return readyFailure;
  }

  const channelFailure = await handleDiscordGatewaySetupFailure(
    async () => {
      approvalChannel = await resolveApprovalChannel(
        prepared,
        client,
        options.approvalChannelFactory
      );
    },
    {
      projectRoot,
      prepared,
      client,
      now,
      operation: "resolve_approval_channel",
      commandsRegistered: prepared.register_commands_on_start,
      reconnectAttempts,
      getApprovalNotifications: () => lastApprovalNotificationResult
    }
  );
  if (channelFailure !== null) {
    return channelFailure;
  }

  if (approvalChannel !== null) {
    const notificationFailure = await handleDiscordGatewaySetupFailure(
      async () => {
        lastApprovalNotificationResult = await notifyPendingDiscordApprovals(
          projectRoot,
          prepared,
          approvalChannel!,
          { now }
        );
      },
      {
        projectRoot,
        prepared,
        client,
        now,
        operation: "notify_approvals",
        commandsRegistered: prepared.register_commands_on_start,
        reconnectAttempts,
        getApprovalNotifications: () => lastApprovalNotificationResult
      }
    );
    if (notificationFailure !== null) {
      return notificationFailure;
    }

    approvalScanTimer = setInterval(() => {
      void notifyPendingDiscordApprovals(projectRoot, prepared, approvalChannel!, {
        now
      })
        .then((result) => {
          lastApprovalNotificationResult = result;
        })
        .catch((error) =>
          writeGatewayStatus(projectRoot, {
            schema_version: "0.1",
            status: "error",
            mode: "gateway",
            application_id: prepared.application_id,
            guild_id: prepared.guild_id,
            approval_channel_id: prepared.approval_channel_id,
            commands_registered: prepared.register_commands_on_start,
            approval_notifications: lastApprovalNotificationResult,
            error: String(error),
            reconnect: {
              ...prepared.reconnect,
              attempts: reconnectAttempts
            },
            updated_at: now().toISOString()
          })
        );
    }, options.approvalScanIntervalMs ?? 30_000);
    approvalScanTimer.unref?.();
  }

  await writeGatewayStatus(projectRoot, {
    schema_version: "0.1",
    status: "ready",
    mode: "gateway",
    application_id: prepared.application_id,
    guild_id: prepared.guild_id,
    approval_channel_id: prepared.approval_channel_id,
    commands_registered: prepared.register_commands_on_start,
    approval_notifications: lastApprovalNotificationResult,
    client_user_id: client.user?.id,
    reconnect: {
      ...prepared.reconnect,
      attempts: reconnectAttempts
    },
    updated_at: now().toISOString()
  });

  return {
    status: "ready",
    status_path: toProjectPath(projectRoot, statusPath),
    stop: async () => {
      if (approvalScanTimer !== undefined) {
        clearInterval(approvalScanTimer);
      }
      await client.destroy();
      await writeGatewayStatus(projectRoot, {
        schema_version: "0.1",
        status: "stopped",
        mode: "gateway",
        application_id: prepared.application_id,
        guild_id: prepared.guild_id,
        approval_channel_id: prepared.approval_channel_id,
        commands_registered: prepared.register_commands_on_start,
        approval_notifications: lastApprovalNotificationResult,
        client_user_id: client.user?.id,
        reconnect: {
          ...prepared.reconnect,
          attempts: reconnectAttempts
        },
        updated_at: now().toISOString()
      });
    }
  };
}

export function buildKaironSlashCommands(): unknown[] {
  return [
    {
      name: "kairon",
      description: "Kairon runtime commands",
      type: 1,
      options: [
        {
          name: "status",
          description: "Show Kairon runtime status",
          type: 1
        },
        {
          name: "leave",
          description: "Close today's Active Work",
          type: 1
        }
      ]
    }
  ];
}

async function handleGatewayInteraction(
  projectRoot: string,
  gateway: PreparedDiscordGateway & { status: "ready" },
  rawInteraction: unknown,
  now: () => Date,
  getApprovalChannel: () => DiscordApprovalChannel | null
): Promise<void> {
  const interaction = rawInteraction as DiscordGatewayInteraction;
  const receivedAt = now();
  if (await maybeShowApprovalReasonModal(projectRoot, gateway, interaction, receivedAt)) {
    return;
  }

  await acknowledgeInteraction(interaction);

  const result = await normalizeGatewayInteraction(
    projectRoot,
    gateway,
    interaction,
    receivedAt
  );
  const sideEffect = await applyGatewayInteractionSideEffects(
    projectRoot,
    interaction,
    result,
    getApprovalChannel(),
    now
  );
  await auditDiscordDecisionInteraction(projectRoot, {
    interaction: toDiscordInteractionInput(interaction, receivedAt),
    result,
    sideEffect,
    recordedAt: now()
  });
  await respondToInteraction(interaction, result, sideEffect);
}

async function normalizeGatewayInteraction(
  projectRoot: string,
  gateway: PreparedDiscordGateway & { status: "ready" },
  interaction: DiscordGatewayInteraction,
  now: Date
): Promise<NormalizedDiscordCommand> {
  const input = toDiscordInteractionInput(interaction, now);

  if (isKaironChatCommand(interaction)) {
    const subcommand = interaction.options?.getSubcommand?.(false);
    if (subcommand === "status") {
      return normalizeDiscordStatusCommand(projectRoot, gateway, input, now);
    }

    if (subcommand === "leave") {
      return normalizeDiscordLeaveCommand(projectRoot, gateway, input, now);
    }

    return {
      accepted: false,
      duplicate: false,
      reason: "unsupported kairon subcommand"
    };
  }

  if (interaction.customId?.startsWith("kr:v1:apr:") === true) {
    return normalizeDiscordApprovalInteraction(projectRoot, gateway, input);
  }

  return {
    accepted: false,
    duplicate: false,
    reason: "unsupported discord interaction"
  };
}

function toDiscordInteractionInput(
  interaction: DiscordGatewayInteraction,
  now: Date
): DiscordInteractionInput {
  const subcommand = interaction.options?.getSubcommand?.(false);
  return {
    interaction_id: interaction.id ?? `discord-${now.getTime()}`,
    user_id: interaction.user?.id ?? "",
    guild_id: interaction.guildId ?? undefined,
    channel_id: interaction.channelId ?? interaction.channel?.id,
    message_id: interaction.message?.id,
    custom_id: interaction.customId,
    command_name:
      interaction.commandName === undefined
        ? undefined
        : [interaction.commandName, subcommand].filter(Boolean).join(" "),
    reason: readModalTextInput(interaction, "reason"),
    snooze_until: readModalTextInput(interaction, "snooze_until"),
    received_at: now.toISOString()
  };
}

async function maybeShowApprovalReasonModal(
  projectRoot: string,
  gateway: PreparedDiscordGateway & { status: "ready" },
  interaction: DiscordGatewayInteraction,
  now: Date
): Promise<boolean> {
  if (interaction.customId?.startsWith("kr:v1:apr:") !== true) {
    return false;
  }

  const parsed = parseApprovalCustomId(interaction.customId);
  if (parsed.kind !== "approval" || !parsed.modal) {
    return false;
  }

  const validation = await validateDiscordApprovalInteraction(
    projectRoot,
    gateway,
    toDiscordInteractionInput(interaction, now)
  );
  if (!validation.ok) {
    await replyToModalTrigger(interaction, `Kairon approval was rejected: ${validation.reason}`);
    return true;
  }

  if (interaction.showModal === undefined) {
    await replyToModalTrigger(
      interaction,
      "Kairon approval reason modal is unavailable."
    );
    return true;
  }

  await interaction.showModal(buildApprovalReasonModal(parsed));
  return true;
}

async function replyToModalTrigger(
  interaction: DiscordGatewayInteraction,
  content: string
): Promise<void> {
  if (interaction.reply !== undefined) {
    await interaction.reply({ content, ephemeral: true });
  }
}

async function applyGatewayInteractionSideEffects(
  projectRoot: string,
  interaction: DiscordGatewayInteraction,
  result: NormalizedDiscordCommand,
  approvalChannel: DiscordApprovalChannel | null,
  now: () => Date
): Promise<GatewayInteractionSideEffect | undefined> {
  if (!result.accepted || result.duplicate || result.command_id === undefined) {
    return undefined;
  }

  if (
    result.command.type !== "approval.decide" &&
    result.command.type !== "approval.snooze" &&
    result.command.type !== "runtime.status" &&
    result.command.type !== "schedule.close_active_work"
  ) {
    return undefined;
  }

  const inbox = new CommandInbox(projectRoot);
  try {
    if (result.command.type === "runtime.status") {
      const statusText = formatRuntimeStatus(await getRuntimeStatus(projectRoot));
      await inbox.complete(result.command_id, {
        summary: statusText.split("\n")
      });
      return {
        content: formatDiscordStatusReply(statusText),
        command_status: "completed"
      };
    }

    if (result.command.type === "schedule.close_active_work") {
      const applied = await new StateApplier(projectRoot).applyCommand(
        result.command as InternalCommand
      );
      await inbox.complete(result.command_id, {
        applied_event_ids: applied.appliedEventIds
      });
      return {
        content: "Active Work closed for today.",
        command_status: "completed",
        applied_event_ids: applied.appliedEventIds
      };
    }

    const applied = await new StateApplier(projectRoot).applyCommand(
      result.command as InternalCommand
    );
    let messageUpdate: DiscordApprovalMessageUpdateResult | undefined;
    let messageUpdateStatus: GatewayInteractionSideEffect["message_update_status"] =
      "unavailable";
    let messageUpdateReason: string | undefined =
      "approval channel is unavailable";
    let messageId: string | undefined = interaction.message?.id;

    if (approvalChannel !== null) {
      try {
        messageUpdate = await updateDiscordApprovalMessage(
          projectRoot,
          result.command.approval_id,
          approvalChannel,
          { now }
        );
        messageUpdateStatus = messageUpdate.status;
        messageUpdateReason =
          messageUpdate.status === "skipped" ? messageUpdate.reason : undefined;
        messageId =
          messageUpdate.status === "updated"
            ? messageUpdate.message_id
            : interaction.message?.id;
      } catch (error) {
        messageUpdateStatus = "failed";
        messageUpdateReason = sanitizeDiscordAuditText(String(error));
      }
    }

    const sideEffect: GatewayInteractionSideEffect = {
      content:
        result.command.type === "approval.snooze"
          ? `Kairon approval snoozed: ${result.command.approval_id}`
          : `Kairon approval decided: ${result.command.approval_id}`,
      command_status: "completed",
      applied_event_ids: applied.appliedEventIds,
      message_update_status: messageUpdateStatus,
      message_update_reason: messageUpdateReason,
      message_id: messageId
    };
    await inbox.complete(result.command_id, {
      applied_event_ids: applied.appliedEventIds,
      message_update_status: messageUpdateStatus,
      message_update_reason: messageUpdateReason
    });
    return sideEffect;
  } catch (error) {
    const sanitizedError = sanitizeDiscordAuditText(String(error)) ?? "unknown error";
    await inbox.fail(result.command_id, { message: sanitizedError });
    return {
      content: `Kairon approval command failed: ${sanitizedError}`,
      command_status: "failed",
      error: sanitizedError
    };
  }
}

async function acknowledgeInteraction(
  interaction: DiscordGatewayInteraction
): Promise<void> {
  if (interaction.deferred === true || interaction.replied === true) {
    return;
  }

  if (interaction.deferReply !== undefined) {
    await interaction.deferReply({ ephemeral: true });
    return;
  }

  if (interaction.reply !== undefined) {
    await interaction.reply({
      content: "Kairon command received.",
      ephemeral: true
    });
  }
}

async function respondToInteraction(
  interaction: DiscordGatewayInteraction,
  result: NormalizedDiscordCommand,
  sideEffect: GatewayInteractionSideEffect | undefined
): Promise<void> {
  if (interaction.editReply === undefined) {
    return;
  }

  if (sideEffect?.content !== undefined) {
    await interaction.editReply({ content: sideEffect.content });
    return;
  }

  if (!result.accepted) {
    await interaction.editReply({
      content: result.duplicate
        ? "Kairon command was already handled."
        : `Kairon command was rejected: ${result.reason}`
    });
    return;
  }

  await interaction.editReply({
    content: result.duplicate
      ? `Kairon command was already handled: ${result.command_id}`
      : `Kairon command queued: ${result.command_id}`
  });
}

function formatDiscordStatusReply(statusText: string): string {
  const content = `Kairon status:\n${statusText}`;
  return content.length <= 1900 ? content : `${content.slice(0, 1897)}...`;
}

async function resolveApprovalChannel(
  gateway: PreparedDiscordGateway & { status: "ready" },
  client: DiscordGatewayClient,
  channelFactory: StartDiscordGatewayOptions["approvalChannelFactory"]
): Promise<DiscordApprovalChannel | null> {
  if (channelFactory !== undefined) {
    return channelFactory(gateway, client);
  }

  const channel = await client.channels?.fetch(gateway.approval_channel_id);
  if (isDiscordApprovalChannel(channel)) {
    return channel;
  }

  return null;
}

function isDiscordApprovalChannel(value: unknown): value is DiscordApprovalChannel {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as DiscordApprovalChannel).send === "function"
  );
}

function readModalTextInput(
  interaction: DiscordGatewayInteraction,
  customId: string
): string | undefined {
  const value = interaction.fields?.getTextInputValue?.(customId)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function buildApprovalReasonModal(
  parsed: ReturnType<typeof parseApprovalCustomId> & { kind: "approval" }
): unknown {
  const rawAction = parsed.action === "request_changes" ? "changes" : parsed.action;
  return {
    custom_id: `kr:v1:apr:${parsed.approval_id}:${rawAction}:${parsed.nonce}`,
    title:
      parsed.action === "reject"
        ? "Reject approval"
        : "Request approval changes",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "reason",
            label: "Reason",
            style: 2,
            required: true,
            max_length: 1000
          }
        ]
      }
    ]
  };
}

async function registerKaironSlashCommands(
  gateway: PreparedDiscordGateway & { status: "ready" },
  restFactory: NonNullable<StartDiscordGatewayOptions["restFactory"]>
): Promise<void> {
  const registration = await restFactory(gateway);
  await registration.rest.put(registration.route, {
    body: buildKaironSlashCommands()
  });
}

async function handleDiscordGatewaySetupFailure(
  action: () => Promise<unknown> | unknown,
  context: {
    projectRoot: string;
    prepared: PreparedDiscordGateway & { status: "ready" };
    client: DiscordGatewayClient;
    now: () => Date;
    operation: DiscordGatewaySetupOperation;
    commandsRegistered: boolean;
    reconnectAttempts: number;
    getApprovalNotifications: () => DiscordApprovalNotificationResult | undefined;
  }
): Promise<DiscordGatewayHandle | null> {
  try {
    await action();
    return null;
  } catch (error) {
    const classified = classifyDiscordGatewayError(error, context.operation);
    await destroyDiscordClientQuietly(context.client);
    await writeGatewayStatus(context.projectRoot, {
      schema_version: "0.1",
      status: classified.status,
      mode: "gateway",
      application_id: context.prepared.application_id,
      guild_id: context.prepared.guild_id,
      approval_channel_id: context.prepared.approval_channel_id,
      commands_registered: context.commandsRegistered,
      approval_notifications: context.getApprovalNotifications(),
      error: classified.error,
      error_code: classified.error_code,
      operation: context.operation,
      next_action: classified.next_action,
      discord_error_code: classified.discord_error_code,
      http_status: classified.http_status,
      reconnect: {
        ...context.prepared.reconnect,
        attempts: context.reconnectAttempts
      },
      updated_at: context.now().toISOString()
    });

    return {
      status: classified.status,
      status_path: toProjectPath(
        context.projectRoot,
        discordGatewayStatusPath(context.projectRoot)
      ),
      reason: classified.error_code,
      next_action: classified.next_action,
      stop: async () => undefined
    };
  }
}

function classifyDiscordGatewayError(
  error: unknown,
  operation: DiscordGatewaySetupOperation
): ClassifiedDiscordGatewayError {
  const discordErrorCode = getErrorNumber(error, "code");
  const httpStatus = getErrorNumber(error, "status");
  const discord_error_code =
    discordErrorCode === undefined ? undefined : String(discordErrorCode);

  if (discordErrorCode === 50035) {
    return {
      status: "setup_required",
      error_code: "discord_invalid_form_body",
      error: "Discord API rejected gateway setup: invalid form body.",
      next_action:
        "Verify the configured Discord application, guild, and channel IDs belong together, then retry.",
      discord_error_code,
      http_status: httpStatus
    };
  }

  if (discordErrorCode === 50001 && operation === "register_commands") {
    return {
      status: "setup_required",
      error_code: "discord_missing_access_register_commands",
      error: "Discord API denied access while registering slash commands.",
      next_action:
        "Invite the bot to the configured guild with bot and applications.commands scopes, then retry.",
      discord_error_code,
      http_status: httpStatus
    };
  }

  if (discordErrorCode === 50001 && operation === "resolve_approval_channel") {
    return {
      status: "setup_required",
      error_code: "discord_missing_access_approval_channel",
      error: "Discord API denied access to the configured approval channel.",
      next_action:
        "Verify KAIRON_DISCORD_APPROVAL_CHANNEL_ID and grant the bot View Channel and Send Messages permissions.",
      discord_error_code,
      http_status: httpStatus
    };
  }

  if (operation === "wait_for_ready") {
    return {
      status: "error",
      error_code: "discord_gateway_ready_timeout",
      error: "Discord Gateway did not become ready before the timeout.",
      next_action:
        "Check the bot token, Discord gateway connectivity, and bot intents, then retry.",
      discord_error_code,
      http_status: httpStatus
    };
  }

  return {
    status: "error",
    error_code: `discord_gateway_${operation}_failed`,
    error: `Discord Gateway setup failed during ${operation}.`,
    next_action:
      "Check Discord connectivity, bot configuration, and Kairon gateway artifacts, then retry.",
    discord_error_code,
    http_status: httpStatus
  };
}

async function destroyDiscordClientQuietly(client: DiscordGatewayClient): Promise<void> {
  try {
    await client.destroy();
  } catch {
    // The original setup failure is more useful than a shutdown failure here.
  }
}

function getErrorNumber(error: unknown, key: "code" | "status"): number | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }

  return undefined;
}

async function createDiscordJsClient(): Promise<DiscordGatewayClient> {
  const { Client, GatewayIntentBits } = await import("discord.js");
  return new Client({
    intents: [GatewayIntentBits.Guilds]
  }) as unknown as DiscordGatewayClient;
}

async function createDiscordJsRestRegistration(
  gateway: PreparedDiscordGateway & { status: "ready" }
): Promise<DiscordRestRegistration> {
  const { REST, Routes } = await import("discord.js");
  return {
    rest: new REST({ version: "10" }).setToken(gateway.bot_token),
    route: Routes.applicationGuildCommands(gateway.application_id, gateway.guild_id)
  };
}

function waitForReady(
  client: DiscordGatewayClient,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("Discord Gateway ready timeout."));
    }, timeoutMs);
    timeout.unref?.();

    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    client.once(DISCORD_CLIENT_READY_EVENT, onReady);
  });
}

async function writeGatewayStatus(
  projectRoot: string,
  status: DiscordGatewayRuntimeStatus
): Promise<void> {
  const filePath = discordGatewayStatusPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, status);
}

function discordGatewayStatusPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "discord", "gateway.json");
}

function isKaironChatCommand(interaction: DiscordGatewayInteraction): boolean {
  return (
    interaction.isChatInputCommand?.() === true &&
    interaction.commandName === "kairon"
  );
}

function hasEnvValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
