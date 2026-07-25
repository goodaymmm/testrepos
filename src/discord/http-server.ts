import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  resolveSecret,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import {
  discordSecretReferences,
  type DiscordGatewayConfig,
  type PreparedDiscordGateway
} from "./gateway.js";
import {
  parseDiscordIdList,
  validateDiscordEnvValues
} from "./env-validation.js";
import {
  DiscordHttpReplayGuard,
  defaultDiscordReplayTtlSeconds,
  defaultDiscordTimestampToleranceSeconds,
  handleDiscordHttpInteraction,
  type DiscordHttpInteractionResponse
} from "./http-interactions.js";
import { discordHttpSecurityAuditPath } from "./http-security-audit.js";
import {
  prepareDiscordHttpProfile,
  validateForwardedHeaders,
  type DiscordHttpProfile
} from "./http-profile.js";
import {
  resolveDiscordHttpProfileConfig,
  type RemoteNotificationsConfig
} from "../remote/profile.js";

export type DiscordHttpServerOptions = {
  profile?: DiscordHttpProfile;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  secretResolver?: SecretResolver;
  now?: () => Date;
  maxBodyBytes?: number;
  timestampToleranceSeconds?: number;
  replayTtlSeconds?: number;
  requestTimeoutMs?: number;
};

export type DiscordHttpServerRuntimeStatus =
  | {
      schema_version: "0.1";
      status: "disabled";
      reason: string;
      missing_env: string[];
      invalid_env?: string[];
      updated_at: string;
    }
  | {
      schema_version: "0.1";
      status: "setup_required";
      mode: "http_interactions";
      profile: DiscordHttpProfile;
      reason: string;
      missing_env: string[];
      invalid_env: string[];
      updated_at: string;
    }
  | {
      schema_version: "0.1";
      status: "ready" | "stopped";
      mode: "http_interactions";
      profile: DiscordHttpProfile;
      application_id: string;
      guild_id: string;
      approval_channel_id: string;
      host: string;
      port: number;
      url: string;
      health_url: string;
      readiness_url: string;
      external_url?: string;
      external_health_url?: string;
      external_readiness_url?: string;
      trusted_proxies: string[];
      security: {
        timestamp_tolerance_seconds: number;
        replay_ttl_seconds: number;
        audit_path: string;
      };
      updated_at: string;
    };

export type DiscordHttpServerHandle = {
  schema_version: "0.1";
  status: DiscordHttpServerRuntimeStatus["status"];
  status_path: string;
  profile?: DiscordHttpProfile;
  host?: string;
  port?: number;
  url?: string;
  health_url?: string;
  readiness_url?: string;
  external_url?: string;
  reason?: string;
  missing_env?: string[];
  invalid_env?: string[];
  stop: () => Promise<void>;
  waitUntilClosed: () => Promise<void>;
};

type PreparedDiscordHttpServer =
  | {
      status: "disabled";
      reason: string;
      missing_env: string[];
      invalid_env?: string[];
    }
  | {
      status: "setup_required";
      profile: DiscordHttpProfile;
      reason: string;
      missing_env: string[];
      invalid_env: string[];
    }
  | {
      status: "ready";
      gateway: PreparedDiscordGateway & { status: "ready" };
      publicKey: string;
      profile: DiscordHttpProfile;
      externalBaseUrl?: string;
      trustedProxies: string[];
    };

const defaultPublicKeyEnv = "KAIRON_DISCORD_PUBLIC_KEY";
const defaultMaxBodyBytes = 1024 * 1024;
const defaultRequestTimeoutMs = 10_000;

export async function startDiscordHttpInteractionsServer(
  projectRoot: string,
  options: DiscordHttpServerOptions = {}
): Promise<DiscordHttpServerHandle> {
  const now = options.now ?? (() => new Date());
  const host = normalizeLoopbackHost(options.host);
  const requestedPort = options.port ?? 18777;
  assertValidPort(requestedPort);
  const timestampToleranceSeconds =
    options.timestampToleranceSeconds ?? defaultDiscordTimestampToleranceSeconds;
  const replayTtlSeconds =
    options.replayTtlSeconds ?? defaultDiscordReplayTtlSeconds;
  assertPositiveInteger(
    timestampToleranceSeconds,
    "Discord timestamp tolerance"
  );
  assertPositiveInteger(replayTtlSeconds, "Discord replay TTL");
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  assertPositiveInteger(requestTimeoutMs, "Discord HTTP request timeout");
  const statusPath = discordHttpServerStatusPath(projectRoot);
  const prepared = await prepareDiscordHttpServer(projectRoot, options);

  if (prepared.status === "disabled") {
    await writeHttpServerStatus(projectRoot, {
      schema_version: "0.1",
      status: "disabled",
      reason: prepared.reason,
      missing_env: prepared.missing_env,
      invalid_env: prepared.invalid_env,
      updated_at: now().toISOString()
    });
    return closedHandle(projectRoot, statusPath, prepared);
  }

  if (prepared.status === "setup_required") {
    await writeHttpServerStatus(projectRoot, {
      schema_version: "0.1",
      status: "setup_required",
      mode: "http_interactions",
      profile: prepared.profile,
      reason: prepared.reason,
      missing_env: prepared.missing_env,
      invalid_env: prepared.invalid_env,
      updated_at: now().toISOString()
    });
    return closedHandle(projectRoot, statusPath, prepared);
  }

  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  const replayGuard = new DiscordHttpReplayGuard(replayTtlSeconds);
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${host}`);
      if (requestUrl.pathname === "/health") {
        if ((request.method ?? "GET").toUpperCase() !== "GET") {
          send(response, 405, { "content-type": "application/json" }, {
            error: "method_not_allowed"
          });
          return;
        }

        send(response, 200, { "content-type": "application/json" }, {
          schema_version: "0.1",
          status: "ok",
          mode: "http_interactions"
        });
        return;
      }

      if (requestUrl.pathname === "/ready") {
        if ((request.method ?? "GET").toUpperCase() !== "GET") {
          send(response, 405, { "content-type": "application/json" }, {
            error: "method_not_allowed"
          });
          return;
        }

        send(response, 200, { "content-type": "application/json" }, {
          schema_version: "0.1",
          status: "ready",
          mode: "http_interactions",
          profile: prepared.profile,
          signature_verification: "ready"
        });
        return;
      }

      if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/interactions") {
        send(response, 404, { "content-type": "application/json" }, {
          error: "not_found"
        });
        return;
      }

      if (!isJsonContentType(request.headers["content-type"])) {
        send(response, 415, { "content-type": "application/json" }, {
          error: "unsupported_media_type"
        });
        return;
      }

      if (prepared.profile === "reverse-proxy") {
        const forwarded = validateForwardedHeaders({
          headers: request.headers,
          remoteAddress: request.socket.remoteAddress,
          trustedProxies: prepared.trustedProxies,
          externalBaseUrl: prepared.externalBaseUrl!
        });
        if (forwarded !== "ok") {
          send(
            response,
            forwarded === "untrusted_proxy" ? 403 : 400,
            { "content-type": "application/json" },
            { error: forwarded }
          );
          return;
        }
      }

      const body = await readRawBody(request, maxBodyBytes, requestTimeoutMs);
      const result = await handleDiscordHttpInteraction(
        {
          projectRoot,
          gateway: prepared.gateway,
          publicKey: prepared.publicKey,
          now,
          timestampToleranceSeconds,
          replayGuard
        },
        {
          method: request.method,
          headers: request.headers,
          body
        }
      );
      sendInteractionResponse(response, result);
    } catch (error) {
      const message = String(error);
      const status = message.includes("request body is too large")
        ? 413
        : message.includes("request body timed out")
          ? 408
          : 500;
      send(response, status, { "content-type": "application/json" }, {
        error:
          status === 413
            ? "request_body_too_large"
            : status === 408
              ? "request_timeout"
              : "internal_error"
      });
    }
  });

  await listen(server, requestedPort, host);
  server.ref();

  const actualPort = readActualPort(server);
  const url = `http://${host}:${actualPort}/`;
  const healthUrl = `${url}health`;
  const readinessUrl = `${url}ready`;
  const externalUrl = prepared.externalBaseUrl === undefined
    ? undefined
    : new URL("interactions", prepared.externalBaseUrl).toString();
  const externalHealthUrl = prepared.externalBaseUrl === undefined
    ? undefined
    : new URL("health", prepared.externalBaseUrl).toString();
  const externalReadinessUrl = prepared.externalBaseUrl === undefined
    ? undefined
    : new URL("ready", prepared.externalBaseUrl).toString();
  const security = {
    timestamp_tolerance_seconds: timestampToleranceSeconds,
    replay_ttl_seconds: replayTtlSeconds,
    audit_path: toProjectPath(projectRoot, discordHttpSecurityAuditPath(projectRoot))
  };
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    server.once("close", () => {
      closed = true;
      resolve();
    });
  });

  await writeHttpServerStatus(projectRoot, {
    schema_version: "0.1",
    status: "ready",
    mode: "http_interactions",
    profile: prepared.profile,
    application_id: prepared.gateway.application_id,
    guild_id: prepared.gateway.guild_id,
    approval_channel_id: prepared.gateway.approval_channel_id,
    host,
    port: actualPort,
    url,
    health_url: healthUrl,
    readiness_url: readinessUrl,
    external_url: externalUrl,
    external_health_url: externalHealthUrl,
    external_readiness_url: externalReadinessUrl,
    trusted_proxies: prepared.trustedProxies,
    security,
    updated_at: now().toISOString()
  });

  return {
    schema_version: "0.1",
    status: "ready",
    status_path: toProjectPath(projectRoot, statusPath),
    profile: prepared.profile,
    host,
    port: actualPort,
    url,
    health_url: healthUrl,
    readiness_url: readinessUrl,
    external_url: externalUrl,
    stop: async () => {
      if (closed) {
        return;
      }

      await close(server);
      await writeHttpServerStatus(projectRoot, {
        schema_version: "0.1",
        status: "stopped",
        mode: "http_interactions",
        profile: prepared.profile,
        application_id: prepared.gateway.application_id,
        guild_id: prepared.gateway.guild_id,
        approval_channel_id: prepared.gateway.approval_channel_id,
        host,
        port: actualPort,
        url,
        health_url: healthUrl,
        readiness_url: readinessUrl,
        external_url: externalUrl,
        external_health_url: externalHealthUrl,
        external_readiness_url: externalReadinessUrl,
        trusted_proxies: prepared.trustedProxies,
        security,
        updated_at: now().toISOString()
      });
    },
    waitUntilClosed: () => closedPromise
  };
}

export function formatDiscordHttpServerResult(
  result: DiscordHttpServerHandle
): string {
  if (result.status === "ready") {
    return [
      "Kairon Discord HTTP interactions server started.",
      `profile=${result.profile}`,
      `discord.http.url=${result.url}`,
      `discord.http.health_url=${result.health_url}`,
      `discord.http.readiness_url=${result.readiness_url}`,
      `discord.http.external_url=${result.external_url ?? "none"}`,
      `status_path=${result.status_path}`,
      `host=${result.host}`,
      `port=${result.port}`
    ].join("\n");
  }

  if (result.status === "setup_required") {
    return [
      "Kairon Discord HTTP interactions server setup required.",
      "status=setup_required",
      `profile=${result.profile}`,
      `status_path=${result.status_path}`,
      `reason=${result.reason}`,
      `missing_env=${(result.missing_env ?? []).join(",") || "none"}`,
      `invalid_env=${(result.invalid_env ?? []).join(",") || "none"}`
    ].join("\n");
  }

  return [
    "Kairon Discord HTTP interactions server disabled.",
    "status=disabled",
    `status_path=${result.status_path}`,
    `reason=${result.reason}`
  ].join("\n");
}

async function prepareDiscordHttpServer(
  projectRoot: string,
  options: DiscordHttpServerOptions
): Promise<PreparedDiscordHttpServer> {
  const config = await loadConfigFile<
    DiscordGatewayConfig & RemoteNotificationsConfig
  >(
    projectRoot,
    "notifications.json"
  );
  const provider = config.providers.discord;
  const httpProfile = prepareDiscordHttpProfile(
    resolveDiscordHttpProfileConfig(config),
    options.profile
  );

  if (!provider.enabled) {
    return {
      status: "disabled",
      reason: "discord provider is disabled",
      missing_env: []
    };
  }

  if (
    httpProfile.missingConfig.length > 0 ||
    httpProfile.invalidConfig.length > 0
  ) {
    return {
      status: "setup_required",
      profile: httpProfile.profile,
      reason: "discord http profile config is incomplete or invalid",
      missing_env: httpProfile.missingConfig,
      invalid_env: httpProfile.invalidConfig
    };
  }

  const env = options.env ?? process.env;
  const publicKeyEnv = provider.public_key_env ?? defaultPublicKeyEnv;
  const requiredFields: Array<{
    key: Parameters<typeof discordSecretReferences>[1];
    envName: string | undefined;
  }> = [
    { key: "public_key", envName: publicKeyEnv },
    { key: "application_id", envName: provider.application_id_env },
    { key: "guild_id", envName: provider.guild_id_env },
    { key: "approval_channel_id", envName: provider.approval_channel_id_env },
    { key: "owner_user_id", envName: provider.owner_user_id_env }
  ];
  const optionalFields: Array<{
    key: Parameters<typeof discordSecretReferences>[1];
    envName: string | undefined;
  }> = [{ key: "allowed_user_ids", envName: provider.allowed_user_ids_env }];
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  const missingEnv: string[] = [];

  for (const field of [...requiredFields, ...optionalFields]) {
    if (field.envName === undefined || field.envName.length === 0) {
      if (requiredFields.includes(field)) {
        missingEnv.push("(unset)");
      }
      continue;
    }

    const resolved = await resolveSecret({
      env,
      envName: field.envName,
      references: discordSecretReferences(provider, field.key),
      resolver: options.secretResolver
    });

    if (resolved.status === "present") {
      resolvedEnv[field.envName] = resolved.value;
    } else if (requiredFields.includes(field)) {
      missingEnv.push(field.envName);
    }
  }

  const envValidation = validateDiscordEnvValues({
    env: resolvedEnv,
    applicationIdEnv: provider.application_id_env,
    guildIdEnv: provider.guild_id_env,
    approvalChannelIdEnv: provider.approval_channel_id_env,
    ownerUserIdEnv: provider.owner_user_id_env,
    allowedUserIdsEnv: provider.allowed_user_ids_env
  });
  const invalidEnv = [...envValidation.live_invalid_env];
  const publicKey = resolvedEnv[publicKeyEnv]?.trim() ?? "";
  if (publicKey.length > 0 && !isDiscordPublicKey(publicKey)) {
    invalidEnv.push(publicKeyEnv);
  }

  if (missingEnv.length > 0 || invalidEnv.length > 0) {
    return {
      status: "setup_required",
      profile: httpProfile.profile,
      reason: "discord http interactions env is incomplete or invalid",
      missing_env: uniqueStrings(missingEnv),
      invalid_env: uniqueStrings(invalidEnv)
    };
  }

  const ownerUserId = resolvedEnv[provider.owner_user_id_env] ?? "";
  const allowedUserIds = new Set([
    ownerUserId,
    ...parseDiscordIdList(
      provider.allowed_user_ids_env === undefined
        ? undefined
        : resolvedEnv[provider.allowed_user_ids_env]
    )
  ]);

  return {
    status: "ready",
    publicKey,
    profile: httpProfile.profile,
    externalBaseUrl: httpProfile.externalBaseUrl,
    trustedProxies: httpProfile.trustedProxies,
    gateway: {
      status: "ready",
      mode: "gateway",
      bot_token: "",
      application_id: resolvedEnv[provider.application_id_env] ?? "",
      guild_id: resolvedEnv[provider.guild_id_env] ?? "",
      approval_channel_id: resolvedEnv[provider.approval_channel_id_env] ?? "",
      owner_user_id: ownerUserId,
      allowed_user_ids: [...allowedUserIds].filter(Boolean),
      register_commands_on_start: false,
      ack_timeout_ms: config.gateway?.ack_timeout_ms ?? 2500,
      idempotency_ttl_minutes: config.gateway?.idempotency_ttl_minutes ?? 60,
      reconnect: {
        enabled: config.gateway?.reconnect?.enabled ?? true,
        max_backoff_seconds:
          config.gateway?.reconnect?.max_backoff_seconds ?? 60
      }
    }
  };
}

function normalizeLoopbackHost(host: string | undefined): string {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();

  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return "127.0.0.1";
  }

  throw new Error(
    "Discord HTTP interactions server host must be loopback-only: 127.0.0.1."
  );
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid Discord HTTP interactions port: ${port}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function isDiscordPublicKey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

function readRawBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("request body timed out")));
    }, timeoutMs);
    timer.unref();

    request.on?.("data", (chunk: Buffer | Uint8Array | string) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        finish(() => reject(new Error("request body is too large")));
        return;
      }
      chunks.push(buffer);
    });
    request.on?.("error", (error) => finish(() => reject(error)));
    request.on?.("end", () => {
      finish(() => resolve(Buffer.concat(chunks)));
    });
  });
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const contentType = (Array.isArray(value) ? value[0] : value)
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "application/json";
}

function sendInteractionResponse(
  response: ServerResponse,
  result: DiscordHttpInteractionResponse
): void {
  response.writeHead(result.status, {
    ...result.headers,
    "Cache-Control": "no-store"
  });
  response.end(result.body);
}

function send(
  response: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  payload: Record<string, unknown>
): void {
  response.writeHead(status, {
    ...headers,
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readActualPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve Discord HTTP interactions server address.");
  }

  return (address as AddressInfo).port;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function closedHandle(
  projectRoot: string,
  statusPath: string,
  prepared: Extract<PreparedDiscordHttpServer, { status: "disabled" | "setup_required" }>
): DiscordHttpServerHandle {
  return {
    schema_version: "0.1",
    status: prepared.status,
    status_path: toProjectPath(projectRoot, statusPath),
    reason: prepared.reason,
    ...(prepared.status === "setup_required" ? { profile: prepared.profile } : {}),
    missing_env: prepared.missing_env,
    invalid_env: prepared.invalid_env,
    stop: async () => undefined,
    waitUntilClosed: async () => undefined
  };
}

export async function getDiscordHttpServerStatus(
  projectRoot: string
): Promise<DiscordHttpServerRuntimeStatus | undefined> {
  try {
    return await readJsonFile<DiscordHttpServerRuntimeStatus>(
      discordHttpServerStatusPath(projectRoot)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function formatDiscordHttpStatus(
  status: DiscordHttpServerRuntimeStatus | undefined
): string {
  if (status === undefined) {
    return [
      "Kairon Discord HTTP interactions server status.",
      "status=not_started"
    ].join("\n");
  }

  const lines = [
    "Kairon Discord HTTP interactions server status.",
    `status=${status.status}`
  ];
  if ("profile" in status) {
    lines.push(`profile=${status.profile}`);
  }
  if ("url" in status) {
    lines.push(
      `url=${status.url}`,
      `health_url=${status.health_url}`,
      `readiness_url=${status.readiness_url}`,
      `external_url=${status.external_url ?? "none"}`
    );
  }
  if ("reason" in status) {
    lines.push(`reason=${status.reason}`);
  }
  return lines.join("\n");
}

async function writeHttpServerStatus(
  projectRoot: string,
  status: DiscordHttpServerRuntimeStatus
): Promise<void> {
  const filePath = discordHttpServerStatusPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, status);
}

function discordHttpServerStatusPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "discord", "http-server.json");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
