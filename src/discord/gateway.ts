import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  normalizeDiscordStatusCommand,
  type DiscordInteractionInput,
  type NormalizedDiscordCommand
} from "./interactions.js";

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
      updated_at: string;
    }
  | {
      schema_version: string;
      status: "starting" | "ready" | "error" | "stopped";
      mode: "gateway";
      application_id: string;
      guild_id: string;
      approval_channel_id: string;
      commands_registered: boolean;
      client_user_id?: string;
      error?: string;
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
};

export type DiscordGatewayHandle = {
  status: PreparedDiscordGateway["status"];
  status_path: string;
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

  const ownerUserId = env[provider.owner_user_id_env] ?? "";
  const allowedUserIds = new Set([
    ownerUserId,
    ...parseUserIdList(
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
  client.on("interactionCreate", (interaction) =>
    handleGatewayInteraction(projectRoot, prepared, interaction, now).catch((error) =>
      writeGatewayStatus(projectRoot, {
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

  const ready = waitForReady(client, options.readyTimeoutMs ?? 30_000);

  if (prepared.register_commands_on_start) {
    await registerKaironSlashCommands(
      prepared,
      options.restFactory ?? createDiscordJsRestRegistration
    );
  }

  await client.login(prepared.bot_token);
  await ready;
  await writeGatewayStatus(projectRoot, {
    schema_version: "0.1",
    status: "ready",
    mode: "gateway",
    application_id: prepared.application_id,
    guild_id: prepared.guild_id,
    approval_channel_id: prepared.approval_channel_id,
    commands_registered: prepared.register_commands_on_start,
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
      await client.destroy();
      await writeGatewayStatus(projectRoot, {
        schema_version: "0.1",
        status: "stopped",
        mode: "gateway",
        application_id: prepared.application_id,
        guild_id: prepared.guild_id,
        approval_channel_id: prepared.approval_channel_id,
        commands_registered: prepared.register_commands_on_start,
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
  now: () => Date
): Promise<void> {
  const interaction = rawInteraction as DiscordGatewayInteraction;
  await acknowledgeInteraction(interaction);

  const result = await normalizeGatewayInteraction(
    projectRoot,
    gateway,
    interaction,
    now()
  );
  await respondToInteraction(interaction, result);
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
    received_at: now.toISOString()
  };
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
  result: NormalizedDiscordCommand
): Promise<void> {
  if (interaction.editReply === undefined) {
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
      ? `Kairon command is already queued: ${result.command_id}`
      : `Kairon command queued: ${result.command_id}`
  });
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

    const onReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    client.once("clientReady", onReady);
    client.once("ready", onReady);
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

function parseUserIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
