import {
  isTrustedProxyAddress,
  isValidCidr,
  validateForwardedHeaders
} from "../discord/http-profile.js";

export type BoardProfile = "loopback" | "remote-readonly";

export type BoardProfileConfig = {
  enabled?: boolean;
  profile?: BoardProfile;
  external_base_url?: string | null;
  trusted_proxies?: string[];
  allowed_origins?: string[];
  identity_header?: string;
  rate_limit_per_minute?: number;
};

export type PreparedBoardProfile = {
  profile: BoardProfile;
  externalBaseUrl?: string;
  trustedProxies: string[];
  allowedOrigins: string[];
  identityHeader: string;
  rateLimitPerMinute: number;
  invalidConfig: string[];
  missingConfig: string[];
};

export type BoardProxyValidation =
  | "ok"
  | "forwarded_headers_required"
  | "untrusted_proxy"
  | "invalid_forwarded_headers";

const defaultTrustedProxies = ["127.0.0.1/32", "::1/128"];
const defaultIdentityHeader = "x-kairon-verified-identity";
const defaultRateLimitPerMinute = 60;

export function prepareBoardProfile(
  config: BoardProfileConfig | undefined,
  requestedProfile?: BoardProfile
): PreparedBoardProfile {
  const invalidConfig: string[] = [];
  const missingConfig: string[] = [];
  const configuredProfile = requestedProfile ?? config?.profile ?? "loopback";
  const profile: BoardProfile =
    configuredProfile === "loopback" || configuredProfile === "remote-readonly"
      ? configuredProfile
      : "loopback";
  if (configuredProfile !== profile) {
    invalidConfig.push("notifications.board.profile");
  }

  const trustedProxies = Array.isArray(config?.trusted_proxies)
    ? [...config.trusted_proxies]
    : config?.trusted_proxies === undefined
      ? [...defaultTrustedProxies]
      : [];
  if (config?.trusted_proxies !== undefined && !Array.isArray(config.trusted_proxies)) {
    invalidConfig.push("notifications.board.trusted_proxies");
  }
  if (trustedProxies.length === 0) {
    missingConfig.push("notifications.board.trusted_proxies");
  } else if (trustedProxies.some((value) => !isValidCidr(value))) {
    invalidConfig.push("notifications.board.trusted_proxies");
  }

  const externalBaseUrl = normalizeBoardExternalBaseUrl(config?.external_base_url);
  if (config?.external_base_url != null && externalBaseUrl === undefined) {
    invalidConfig.push("notifications.board.external_base_url");
  }

  const allowedOrigins = Array.isArray(config?.allowed_origins)
    ? config.allowed_origins
        .map(normalizeBoardOrigin)
        .filter((value): value is string => value !== undefined)
    : [];
  if (config?.allowed_origins !== undefined && !Array.isArray(config.allowed_origins)) {
    invalidConfig.push("notifications.board.allowed_origins");
  } else if (
    config?.allowed_origins?.some((value) => normalizeBoardOrigin(value) === undefined)
  ) {
    invalidConfig.push("notifications.board.allowed_origins");
  }

  const identityHeader = normalizeIdentityHeader(config?.identity_header);
  if (config?.identity_header !== undefined && identityHeader === undefined) {
    invalidConfig.push("notifications.board.identity_header");
  }
  const rateLimitPerMinute = config?.rate_limit_per_minute ?? defaultRateLimitPerMinute;
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
    invalidConfig.push("notifications.board.rate_limit_per_minute");
  }

  if (profile === "remote-readonly") {
    if (config?.enabled !== true) {
      missingConfig.push("notifications.board.enabled");
    }
    if (externalBaseUrl === undefined) {
      missingConfig.push("notifications.board.external_base_url");
    }
    if (allowedOrigins.length === 0) {
      missingConfig.push("notifications.board.allowed_origins");
    }
    if (identityHeader === undefined) {
      missingConfig.push("notifications.board.identity_header");
    }
  }

  return {
    profile,
    externalBaseUrl,
    trustedProxies,
    allowedOrigins: [...new Set(allowedOrigins)],
    identityHeader: identityHeader ?? defaultIdentityHeader,
    rateLimitPerMinute:
      Number.isInteger(rateLimitPerMinute) && rateLimitPerMinute > 0
        ? rateLimitPerMinute
        : defaultRateLimitPerMinute,
    invalidConfig: [...new Set(invalidConfig)],
    missingConfig: [...new Set(missingConfig)]
  };
}

export function validateBoardProxyRequest(input: {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  trustedProxies: string[];
  externalBaseUrl: string;
}): BoardProxyValidation {
  return validateForwardedHeaders(input);
}

export function isBoardTrustedProxy(
  address: string | undefined,
  trustedProxies: string[]
): boolean {
  return isTrustedProxyAddress(address, trustedProxies);
}

export function normalizeBoardOrigin(value: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function normalizeBoardExternalBaseUrl(
  value: string | null | undefined
): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeIdentityHeader(value: string | undefined): string | undefined {
  const normalized = (value ?? defaultIdentityHeader).trim().toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(normalized) ? normalized : undefined;
}
