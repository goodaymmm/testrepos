import { isIP } from "node:net";

export type DiscordHttpProfile = "loopback" | "reverse-proxy";

export type DiscordHttpProfileConfig = {
  profile?: DiscordHttpProfile;
  external_base_url?: string | null;
  trusted_proxies?: string[];
};

export type PreparedDiscordHttpProfile = {
  profile: DiscordHttpProfile;
  externalBaseUrl?: string;
  trustedProxies: string[];
  invalidConfig: string[];
  missingConfig: string[];
};

const defaultTrustedProxies = ["127.0.0.1/32", "::1/128"];

export function prepareDiscordHttpProfile(
  config: DiscordHttpProfileConfig | undefined,
  requestedProfile?: DiscordHttpProfile
): PreparedDiscordHttpProfile {
  const invalidConfig: string[] = [];
  const missingConfig: string[] = [];
  const configuredProfile = requestedProfile ?? config?.profile ?? "loopback";
  const profile: DiscordHttpProfile =
    configuredProfile === "loopback" || configuredProfile === "reverse-proxy"
      ? configuredProfile
      : "loopback";
  if (configuredProfile !== profile) {
    invalidConfig.push("notifications.http.profile");
  }
  const configuredTrustedProxies = config?.trusted_proxies;
  const trustedProxies = configuredTrustedProxies === undefined
    ? defaultTrustedProxies
    : Array.isArray(configuredTrustedProxies)
      ? configuredTrustedProxies
      : [];
  if (configuredTrustedProxies !== undefined && !Array.isArray(configuredTrustedProxies)) {
    invalidConfig.push("notifications.http.trusted_proxies");
  }
  const externalBaseUrl = normalizeExternalBaseUrl(config?.external_base_url);

  if (config?.external_base_url != null && externalBaseUrl === undefined) {
    invalidConfig.push("notifications.http.external_base_url");
  }

  if (!Array.isArray(trustedProxies) || trustedProxies.length === 0) {
    missingConfig.push("notifications.http.trusted_proxies");
  } else if (trustedProxies.some((value) => !isValidCidr(value))) {
    invalidConfig.push("notifications.http.trusted_proxies");
  }

  if (profile === "reverse-proxy" && externalBaseUrl === undefined) {
    missingConfig.push("notifications.http.external_base_url");
  }

  return {
    profile,
    externalBaseUrl,
    trustedProxies: [...trustedProxies],
    invalidConfig: uniqueStrings(invalidConfig),
    missingConfig: uniqueStrings(missingConfig)
  };
}

export function isTrustedProxyAddress(
  address: string | undefined,
  trustedProxies: string[]
): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === undefined) {
    return false;
  }

  return trustedProxies.some((cidr) => addressMatchesCidr(normalized, cidr));
}

export function validateForwardedHeaders(input: {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  trustedProxies: string[];
  externalBaseUrl: string;
}): "ok" | "forwarded_headers_required" | "untrusted_proxy" | "invalid_forwarded_headers" {
  const proto = firstForwardedValue(readHeader(input.headers, "x-forwarded-proto"));
  const host = firstForwardedValue(readHeader(input.headers, "x-forwarded-host"));

  if (proto === undefined || host === undefined) {
    return "forwarded_headers_required";
  }

  if (!isTrustedProxyAddress(input.remoteAddress, input.trustedProxies)) {
    return "untrusted_proxy";
  }

  const expected = new URL(input.externalBaseUrl);
  if (proto.toLowerCase() !== "https" || host.toLowerCase() !== expected.host.toLowerCase()) {
    return "invalid_forwarded_headers";
  }

  return "ok";
}

export function isValidCidr(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const [address, prefixText, ...rest] = value.trim().split("/");
  if (rest.length > 0 || address.length === 0 || prefixText === undefined) {
    return false;
  }

  const version = isIP(address);
  if (version === 6 && address.includes(".")) {
    return false;
  }
  const prefix = Number(prefixText);
  const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix;
}

export function isValidDiscordExternalBaseUrl(value: string): boolean {
  return normalizeExternalBaseUrl(value) !== undefined;
}

function normalizeExternalBaseUrl(value: string | null | undefined): string | undefined {
  if (value != null && typeof value !== "string") {
    return undefined;
  }
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
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

function addressMatchesCidr(address: string, cidr: string): boolean {
  if (!isValidCidr(cidr)) {
    return false;
  }

  const [networkAddress, prefixText] = cidr.trim().split("/");
  const addressBytes = parseAddressBytes(address);
  const networkBytes = parseAddressBytes(networkAddress);
  if (
    addressBytes === undefined ||
    networkBytes === undefined ||
    addressBytes.length !== networkBytes.length
  ) {
    return false;
  }

  let bits = Number(prefixText);
  for (let index = 0; index < addressBytes.length; index += 1) {
    if (bits <= 0) {
      return true;
    }

    const comparedBits = Math.min(bits, 8);
    const mask = (0xff << (8 - comparedBits)) & 0xff;
    if ((addressBytes[index] & mask) !== (networkBytes[index] & mask)) {
      return false;
    }
    bits -= comparedBits;
  }

  return true;
}

function parseAddressBytes(address: string): number[] | undefined {
  const normalized = normalizeAddress(address);
  if (normalized === undefined) {
    return undefined;
  }

  if (isIP(normalized) === 4) {
    return normalized.split(".").map(Number);
  }

  if (isIP(normalized) !== 6) {
    return undefined;
  }

  const [leftText, rightText] = normalized.split("::");
  const left = parseIpv6Parts(leftText);
  const right = parseIpv6Parts(rightText);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (missing === 0 && normalized.includes("::"))) {
    return undefined;
  }
  const parts = normalized.includes("::")
    ? [...left, ...Array<number>(missing).fill(0), ...right]
    : left;
  if (parts.length !== 8) {
    return undefined;
  }

  return parts.flatMap((part) => [(part >> 8) & 0xff, part & 0xff]);
}

function parseIpv6Parts(value: string | undefined): number[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value.split(":").map((part) => Number.parseInt(part, 16));
}

function normalizeAddress(address: string | undefined): string | undefined {
  const normalized = address?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function firstForwardedValue(value: string | undefined): string | undefined {
  const first = value?.split(",", 1)[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
