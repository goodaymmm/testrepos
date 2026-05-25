import { loadConfigFile } from "../core/config/load-config.js";

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
    idempotency_ttl_minutes: config.gateway?.idempotency_ttl_minutes ?? 60
  };
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
