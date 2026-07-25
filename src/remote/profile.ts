import {
  normalizeBoardExternalBaseUrl,
  normalizeBoardOrigin,
  type BoardProfileConfig
} from "../board/profile.js";
import {
  isValidCidr,
  isValidDiscordExternalBaseUrl,
  type DiscordHttpProfileConfig
} from "../discord/http-profile.js";

export const stableRemoteProfileName = "stable-remote-readonly" as const;

export type StableRemoteProfileName =
  | "disabled"
  | typeof stableRemoteProfileName;

export type StableRemoteProfileConfig = {
  profile?: StableRemoteProfileName;
  discord_interactions_base_url?: string | null;
  board_base_url?: string | null;
  trusted_proxies?: string[];
  allowed_origins?: string[];
  identity_header?: string;
};

export type RemoteNotificationsConfig = {
  remote?: StableRemoteProfileConfig;
  http?: DiscordHttpProfileConfig;
  board?: BoardProfileConfig & {
    base_url?: string;
  };
};

export type PreparedStableRemoteProfile = {
  profile: StableRemoteProfileName;
  configured: boolean;
  discordInteractionsBaseUrl?: string;
  boardBaseUrl?: string;
  trustedProxies: string[];
  allowedOrigins: string[];
  identityHeader: string;
  invalidConfig: string[];
  missingConfig: string[];
};

export type StableRemoteMigrationProposal = {
  proposal_kind: "stable_remote_profile";
  source: "notifications.http+notifications.board";
  target: StableRemoteProfileConfig;
};

const defaultIdentityHeader = "x-kairon-verified-identity";

export function prepareStableRemoteProfile(
  config: StableRemoteProfileConfig | undefined
): PreparedStableRemoteProfile {
  const invalidConfig: string[] = [];
  const missingConfig: string[] = [];
  const configuredProfile = config?.profile ?? "disabled";
  const profile: StableRemoteProfileName =
    configuredProfile === stableRemoteProfileName || configuredProfile === "disabled"
      ? configuredProfile
      : "disabled";
  if (configuredProfile !== profile) {
    invalidConfig.push("notifications.remote.profile");
  }

  const discordInteractionsBaseUrl = normalizeStableBaseUrl(
    config?.discord_interactions_base_url,
    isValidDiscordExternalBaseUrl
  );
  if (
    config?.discord_interactions_base_url != null &&
    discordInteractionsBaseUrl === undefined
  ) {
    invalidConfig.push("notifications.remote.discord_interactions_base_url");
  }

  const boardBaseUrl = normalizeStableBaseUrl(
    config?.board_base_url,
    (value) => normalizeBoardExternalBaseUrl(value) !== undefined
  );
  if (config?.board_base_url != null && boardBaseUrl === undefined) {
    invalidConfig.push("notifications.remote.board_base_url");
  }

  const trustedProxies = Array.isArray(config?.trusted_proxies)
    ? [...config.trusted_proxies]
    : [];
  if (config?.trusted_proxies !== undefined && !Array.isArray(config.trusted_proxies)) {
    invalidConfig.push("notifications.remote.trusted_proxies");
  } else if (trustedProxies.some((value) => !isValidCidr(value))) {
    invalidConfig.push("notifications.remote.trusted_proxies");
  }

  const configuredOrigins = Array.isArray(config?.allowed_origins)
    ? config.allowed_origins
    : [];
  const allowedOrigins = configuredOrigins
    .map(normalizeBoardOrigin)
    .filter((value): value is string => value !== undefined);
  if (config?.allowed_origins !== undefined && !Array.isArray(config.allowed_origins)) {
    invalidConfig.push("notifications.remote.allowed_origins");
  } else if (allowedOrigins.length !== configuredOrigins.length) {
    invalidConfig.push("notifications.remote.allowed_origins");
  }

  const identityHeader = normalizeIdentityHeader(config?.identity_header);
  if (config?.identity_header !== undefined && identityHeader === undefined) {
    invalidConfig.push("notifications.remote.identity_header");
  }

  if (profile === stableRemoteProfileName) {
    if (discordInteractionsBaseUrl === undefined) {
      missingConfig.push("notifications.remote.discord_interactions_base_url");
    }
    if (boardBaseUrl === undefined) {
      missingConfig.push("notifications.remote.board_base_url");
    }
    if (trustedProxies.length === 0) {
      missingConfig.push("notifications.remote.trusted_proxies");
    }
    if (allowedOrigins.length === 0) {
      missingConfig.push("notifications.remote.allowed_origins");
    }
    if (identityHeader === undefined) {
      missingConfig.push("notifications.remote.identity_header");
    }

    const boardOrigin =
      boardBaseUrl === undefined ? undefined : new URL(boardBaseUrl).origin;
    if (
      boardOrigin !== undefined &&
      allowedOrigins.length > 0 &&
      !allowedOrigins.includes(boardOrigin)
    ) {
      invalidConfig.push("notifications.remote.allowed_origins");
    }
  }

  return {
    profile,
    configured: profile === stableRemoteProfileName,
    discordInteractionsBaseUrl,
    boardBaseUrl,
    trustedProxies: [...new Set(trustedProxies)],
    allowedOrigins: [...new Set(allowedOrigins)],
    identityHeader: identityHeader ?? defaultIdentityHeader,
    invalidConfig: [...new Set(invalidConfig)],
    missingConfig: [...new Set(missingConfig)]
  };
}

export function resolveDiscordHttpProfileConfig(
  notifications: RemoteNotificationsConfig
): DiscordHttpProfileConfig | undefined {
  const prepared = prepareStableRemoteProfile(notifications.remote);
  if (!prepared.configured) {
    return notifications.http;
  }
  return {
    profile: "reverse-proxy",
    external_base_url: prepared.discordInteractionsBaseUrl,
    trusted_proxies: prepared.trustedProxies
  };
}

export function resolveBoardProfileConfig(
  notifications: RemoteNotificationsConfig
): BoardProfileConfig & { base_url?: string } {
  const prepared = prepareStableRemoteProfile(notifications.remote);
  if (!prepared.configured) {
    return notifications.board ?? {};
  }
  return {
    ...notifications.board,
    enabled: true,
    profile: "remote-readonly",
    external_base_url: prepared.boardBaseUrl,
    trusted_proxies: prepared.trustedProxies,
    allowed_origins: prepared.allowedOrigins,
    identity_header: prepared.identityHeader
  };
}

export function proposeStableRemoteMigration(
  notifications: RemoteNotificationsConfig
): StableRemoteMigrationProposal | undefined {
  if (prepareStableRemoteProfile(notifications.remote).configured) {
    return undefined;
  }
  if (
    notifications.http?.profile !== "reverse-proxy" ||
    notifications.board?.profile !== "remote-readonly"
  ) {
    return undefined;
  }

  const discordBaseUrl = normalizeStableBaseUrl(
    notifications.http.external_base_url,
    isValidDiscordExternalBaseUrl
  );
  const boardBaseUrl = normalizeStableBaseUrl(
    notifications.board.external_base_url,
    (value) => normalizeBoardExternalBaseUrl(value) !== undefined
  );
  const trustedProxies = notifications.http.trusted_proxies ?? [];
  const boardTrustedProxies = notifications.board.trusted_proxies ?? [];
  const allowedOrigins = notifications.board.allowed_origins ?? [];
  if (
    discordBaseUrl === undefined ||
    boardBaseUrl === undefined ||
    trustedProxies.length === 0 ||
    trustedProxies.some((value) => !boardTrustedProxies.includes(value))
  ) {
    return undefined;
  }

  const target: StableRemoteProfileConfig = {
    profile: stableRemoteProfileName,
    discord_interactions_base_url: discordBaseUrl,
    board_base_url: boardBaseUrl,
    trusted_proxies: [...trustedProxies],
    allowed_origins: [...allowedOrigins],
    identity_header:
      notifications.board.identity_header ?? defaultIdentityHeader
  };
  const prepared = prepareStableRemoteProfile(target);
  if (prepared.missingConfig.length > 0 || prepared.invalidConfig.length > 0) {
    return undefined;
  }

  return {
    proposal_kind: "stable_remote_profile",
    source: "notifications.http+notifications.board",
    target
  };
}

function normalizeStableBaseUrl(
  value: string | null | undefined,
  validator: (candidate: string) => boolean
): string | undefined {
  if (value == null || typeof value !== "string" || !validator(value)) {
    return undefined;
  }
  const url = new URL(value.trim());
  if (
    url.hostname.toLowerCase().endsWith(".trycloudflare.com") ||
    url.hostname.toLowerCase() === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  ) {
    return undefined;
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url.toString();
}

function normalizeIdentityHeader(value: string | undefined): string | undefined {
  const normalized = (value ?? defaultIdentityHeader).trim().toLowerCase();
  return /^[a-z0-9-]{1,64}$/u.test(normalized) ? normalized : undefined;
}
