import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  createBoardProjection,
  exportBoardProjection,
  type BoardProjectionOptions
} from "./projection.js";
import { renderBoardHtml } from "./html.js";
import {
  boardReadScope,
  issueBoardAccessToken,
  validateBoardAccessToken,
  validatePersistentBoardAccess
} from "./access-token.js";
import {
  auditBoardAccess,
  boardAccessAuditPath,
  classifyBoardAccessRoute,
  hashBoardIdentity,
  type BoardAccessAuditAuthStatus,
  type BoardAccessAuditOriginStatus,
  type BoardAccessAuditProxyStatus,
  type BoardAccessAuditRoute
} from "./access-audit.js";
import {
  prepareBoardProfile,
  validateBoardProxyRequest,
  type BoardProfile,
  type PreparedBoardProfile
} from "./profile.js";

export type BoardServerOptions = BoardProjectionOptions & {
  profile?: BoardProfile;
  host?: string;
  port?: number;
  requireToken?: boolean;
  accessTokenTtlSeconds?: number;
  randomToken?: () => string;
  externalBaseUrl?: string;
  trustedProxies?: string[];
  allowedOrigins?: string[];
  identityHeader?: string;
  rateLimitPerMinute?: number;
};

export type BoardServeResult = {
  schema_version: "0.1";
  board_url: string;
  projection_path: string;
  host: string;
  port: number;
  status_path: string;
  audit_path: string;
  profile: BoardProfile;
  external_url?: string;
  access_token?: string;
  access_token_expires_at?: string;
  access_scope?: string;
};

export type BoardServerRuntimeStatus = {
  schema_version: "0.1";
  status: "ready" | "stopped";
  mode: "loopback_read_only" | "remote_read_only";
  profile: BoardProfile;
  board_url: string;
  external_url?: string;
  projection_path: string;
  host: string;
  port: number;
  audit_path: string;
  access: {
    required: boolean;
    token_hash?: string;
    expires_at?: string;
    scope: typeof boardReadScope;
    source?: "ephemeral" | "persistent";
  };
  remote_security?: {
    trusted_proxies: string[];
    allowed_origins: string[];
    identity_header: string;
    rate_limit_per_minute: number;
  };
  updated_at: string;
};

export type BoardServerHandle = BoardServeResult & {
  stop: () => Promise<void>;
  waitUntilClosed: () => Promise<void>;
};

export async function startBoardServer(
  projectRoot: string,
  options: BoardServerOptions = {}
): Promise<BoardServerHandle> {
  const host = normalizeLoopbackHost(options.host);
  const requestedPort = options.port ?? 8787;
  assertValidPort(requestedPort);
  const now = options.now ?? (() => new Date());
  const preparedProfile = prepareServerBoardProfile(options);
  const profile = preparedProfile.profile;
  const access =
    profile === "loopback" ? createBoardAccess(options, now()) : undefined;
  const rateLimiter = new BoardRateLimiter(preparedProfile.rateLimitPerMinute);
  const server = createServer(async (request, response) => {
    const method = request.method ?? "UNKNOWN";
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    const route = classifyBoardAccessRoute(requestUrl.pathname);
    const userAgentPresent = hasUserAgent(request.headers["user-agent"]);
    let authStatus: BoardAccessAuditAuthStatus =
      profile === "loopback" && access === undefined ? "not_required" : "not_evaluated";
    let proxyStatus: BoardAccessAuditProxyStatus =
      profile === "remote-readonly" ? "not_evaluated" : "not_required";
    let originStatus: BoardAccessAuditOriginStatus =
      profile === "remote-readonly" ? "not_evaluated" : "not_required";
    let identityHash: string | undefined;
    let accessId: string | undefined;

    try {
      if (method !== "GET" && method !== "HEAD") {
        await recordBoardAccess({
          projectRoot,
          method,
          route,
          status: 405,
          outcome: "denied",
          authStatus,
          profile,
          proxyStatus,
          originStatus,
          userAgentPresent,
          now
        });
        response.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end("Method not allowed");
        return;
      }

      if (profile === "remote-readonly") {
        const forwarded = validateBoardProxyRequest({
          headers: request.headers,
          remoteAddress: request.socket.remoteAddress,
          trustedProxies: preparedProfile.trustedProxies,
          externalBaseUrl: preparedProfile.externalBaseUrl ?? ""
        });
        proxyStatus = forwarded === "ok" ? "accepted" : forwarded;
        if (forwarded !== "ok") {
          const status = forwarded === "untrusted_proxy" ? 403 : 400;
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status,
            outcome: "denied",
            authStatus,
            profile,
            proxyStatus,
            originStatus,
            userAgentPresent,
            now
          });
          sendBoardError(response, method, status, forwarded);
          return;
        }

        const origin = readSingleHeader(request.headers.origin);
        if (origin === undefined) {
          originStatus = "missing_origin";
        } else if (!preparedProfile.allowedOrigins.includes(origin)) {
          originStatus = "origin_not_allowed";
        } else {
          originStatus = "accepted";
        }
        if (originStatus !== "accepted") {
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status: 403,
            outcome: "denied",
            authStatus,
            profile,
            proxyStatus,
            originStatus,
            userAgentPresent,
            now
          });
          sendBoardError(response, method, 403, originStatus);
          return;
        }

        const identity = readVerifiedIdentity(
          request.headers[preparedProfile.identityHeader]
        );
        if (identity === undefined) {
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status: 401,
            outcome: "denied",
            authStatus,
            profile,
            proxyStatus,
            originStatus,
            userAgentPresent,
            now
          });
          sendBoardError(response, method, 401, "verified_identity_required");
          return;
        }
        identityHash = hashBoardIdentity(identity);

        const validation = await validatePersistentBoardAccess({
          projectRoot,
          token: readBearerToken(request.headers.authorization),
          now: now()
        });
        accessId = validation.access_id;
        if (!validation.accepted) {
          authStatus = validation.reason;
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status: validation.reason === "scope_mismatch" ? 403 : 401,
            outcome: "denied",
            authStatus,
            profile,
            accessId,
            identityHash,
            proxyStatus,
            originStatus,
            userAgentPresent,
            now
          });
          sendUnauthorized(response, method, validation.reason);
          return;
        }
        authStatus = "accepted";

        if (!rateLimiter.consume(identityHash, now())) {
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status: 429,
            outcome: "denied",
            authStatus,
            profile,
            accessId,
            identityHash,
            proxyStatus,
            originStatus,
            rateLimited: true,
            userAgentPresent,
            now
          });
          response.setHeader("Retry-After", "60");
          sendBoardError(response, method, 429, "rate_limited");
          return;
        }
      } else if (access !== undefined) {
        const validation = validateBoardAccessToken({
          token: readBearerToken(request.headers.authorization),
          metadata: access.metadata,
          now: now(),
          requiredScope: boardReadScope
        });
        if (!validation.accepted) {
          authStatus = validation.reason;
          await recordBoardAccess({
            projectRoot,
            method,
            route,
            status: validation.reason === "scope_mismatch" ? 403 : 401,
            outcome: "denied",
            authStatus,
            profile,
            proxyStatus,
            originStatus,
            userAgentPresent,
            now
          });
          sendUnauthorized(response, method, validation.reason);
          return;
        }
        authStatus = "accepted";
      }

      const createdProjection = await createBoardProjection(projectRoot, options);
      const projection =
        profile === "remote-readonly"
          ? sanitizeRemoteBoardProjection(createdProjection)
          : createdProjection;

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        await recordBoardAccess({
          projectRoot,
          method,
          route,
          status: 200,
          outcome: "allowed",
          authStatus,
          profile,
          accessId,
          identityHash,
          proxyStatus,
          originStatus,
          userAgentPresent,
          now
        });
        send(
          response,
          method,
          200,
          "text/html; charset=utf-8",
          renderBoardHtml(projection, { remoteReadOnly: profile === "remote-readonly" })
        );
        return;
      }

      if (requestUrl.pathname === "/projection.json") {
        await recordBoardAccess({
          projectRoot,
          method,
          route,
          status: 200,
          outcome: "allowed",
          authStatus,
          profile,
          accessId,
          identityHash,
          proxyStatus,
          originStatus,
          userAgentPresent,
          now
        });
        send(
          response,
          method,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify(projection, null, 2)}\n`
        );
        return;
      }

      await recordBoardAccess({
        projectRoot,
        method,
        route,
        status: 404,
        outcome: "denied",
        authStatus,
        profile,
        accessId,
        identityHash,
        proxyStatus,
        originStatus,
        userAgentPresent,
        now
      });
      send(response, method, 404, "text/plain; charset=utf-8", "Not found");
    } catch {
      await recordBoardAccessBestEffort({
        projectRoot,
        method,
        route,
        status: 500,
        outcome: "error",
        authStatus,
        profile,
        accessId,
        identityHash,
        proxyStatus,
        originStatus,
        userAgentPresent,
        now
      });
      send(response, method, 500, "text/plain; charset=utf-8", "Board render failed.");
    }
  });

  await listen(server, requestedPort, host);
  server.ref();

  try {
    const exportResult = await exportBoardProjection(projectRoot, options);
    const actualPort = readActualPort(server);
    const boardUrl = `http://${host}:${actualPort}/`;
    const statusPath = boardServerStatusPath(projectRoot);
    const auditPath = boardAccessAuditPath(projectRoot, profile);
    const statusBase = {
      schema_version: "0.1" as const,
      mode: profile === "remote-readonly" ? "remote_read_only" as const : "loopback_read_only" as const,
      profile,
      board_url: boardUrl,
      ...(preparedProfile.externalBaseUrl === undefined
        ? {}
        : { external_url: preparedProfile.externalBaseUrl }),
      projection_path: exportResult.projection_path,
      host,
      port: actualPort,
      audit_path: toProjectPath(projectRoot, auditPath),
      access: accessStatus(access, profile),
      ...(profile === "remote-readonly"
        ? {
            remote_security: {
              trusted_proxies: preparedProfile.trustedProxies,
              allowed_origins: preparedProfile.allowedOrigins,
              identity_header: preparedProfile.identityHeader,
              rate_limit_per_minute: preparedProfile.rateLimitPerMinute
            }
          }
        : {})
    };
    let closed = false;
    const closedPromise = new Promise<void>((resolve) => {
      server.once("close", () => {
        closed = true;
        resolve();
      });
    });

    const handle: BoardServerHandle = {
      schema_version: "0.1",
      board_url: boardUrl,
      projection_path: exportResult.projection_path,
      host,
      port: actualPort,
      status_path: toProjectPath(projectRoot, statusPath),
      audit_path: toProjectPath(projectRoot, auditPath),
      profile,
      external_url: preparedProfile.externalBaseUrl,
      access_token: access?.token,
      access_token_expires_at: access?.metadata.expires_at,
      access_scope: access?.metadata.scope,
      stop: async () => {
        if (closed) {
          return;
        }

        await close(server);
        await writeBoardServerStatus(projectRoot, {
          ...statusBase,
          status: "stopped",
          updated_at: now().toISOString()
        });
      },
      waitUntilClosed: () => closedPromise
    };

    await writeBoardServerStatus(projectRoot, {
      ...statusBase,
      status: "ready",
      updated_at: now().toISOString()
    });

    return handle;
  } catch (error) {
    await close(server);
    throw error;
  }
}

export function formatBoardServeResult(result: BoardServeResult): string {
  const lines = [
    "Kairon board server started.",
    `board.profile=${result.profile}`,
    `board.url=${result.board_url}`,
    `projection=${result.projection_path}`,
    `status_path=${result.status_path}`,
    `audit_path=${result.audit_path}`,
    `host=${result.host}`,
    `port=${result.port}`
  ];
  if (result.external_url !== undefined) {
    lines.push(`board.external_url=${result.external_url}`);
  }
  if (result.access_token !== undefined) {
    lines.push(
      `board.access_token=${result.access_token}`,
      `board.access_token_expires_at=${result.access_token_expires_at}`,
      `board.access_scope=${result.access_scope}`
    );
  }
  return lines.join("\n");
}

export function normalizeLoopbackHost(host: string | undefined): string {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();

  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return "127.0.0.1";
  }

  throw new Error("Board server host must be loopback-only: 127.0.0.1.");
}

function send(
  response: ServerResponse,
  method: string,
  status: number,
  contentType: string,
  body: string
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(body);
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid board server port: ${port}`);
  }
}

function readActualPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve board server address.");
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

function createBoardAccess(
  options: BoardServerOptions,
  now: Date
): ReturnType<typeof issueBoardAccessToken> | undefined {
  if (!options.requireToken && options.accessTokenTtlSeconds === undefined) {
    return undefined;
  }

  return issueBoardAccessToken({
    now,
    ttlSeconds: options.accessTokenTtlSeconds,
    scope: boardReadScope,
    randomToken: options.randomToken
  });
}

function accessStatus(
  access: ReturnType<typeof issueBoardAccessToken> | undefined,
  profile: BoardProfile
): BoardServerRuntimeStatus["access"] {
  if (profile === "remote-readonly") {
    return {
      required: true,
      scope: boardReadScope,
      source: "persistent"
    };
  }
  return access === undefined
    ? {
        required: false,
        scope: boardReadScope
      }
    : {
        required: true,
        token_hash: access.metadata.token_hash,
        expires_at: access.metadata.expires_at,
        scope: boardReadScope,
        source: "ephemeral"
      };
}

function readBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function sendUnauthorized(
  response: ServerResponse,
  method: string,
  reason: "missing_token" | "invalid_token" | "expired_token" | "scope_mismatch"
): void {
  const status = reason === "scope_mismatch" ? 403 : 401;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="Kairon Board"'
  });
  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(JSON.stringify({ error: "board_access_denied", reason }));
}

function sendBoardError(
  response: ServerResponse,
  method: string,
  status: number,
  reason: string
): void {
  send(
    response,
    method,
    status,
    "application/json; charset=utf-8",
    JSON.stringify({ error: "board_access_denied", reason })
  );
}

async function writeBoardServerStatus(
  projectRoot: string,
  status: BoardServerRuntimeStatus
): Promise<void> {
  const filePath = boardServerStatusPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, status);
}

export async function getBoardServerStatus(
  projectRoot: string
): Promise<BoardServerRuntimeStatus | undefined> {
  try {
    return await readJsonFile<BoardServerRuntimeStatus>(
      boardServerStatusPath(projectRoot)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function boardServerStatusPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "board", "server.json");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

type BoardAccessRecordInput = {
  projectRoot: string;
  method: string;
  route: BoardAccessAuditRoute;
  status: number;
  outcome: "allowed" | "denied" | "error";
  authStatus: BoardAccessAuditAuthStatus;
  profile: BoardProfile;
  accessId?: string;
  identityHash?: string;
  proxyStatus: BoardAccessAuditProxyStatus;
  originStatus: BoardAccessAuditOriginStatus;
  rateLimited?: boolean;
  userAgentPresent: boolean;
  now: () => Date;
};

async function recordBoardAccess(input: BoardAccessRecordInput): Promise<void> {
  await auditBoardAccess(input.projectRoot, {
    outcome: input.outcome,
    method: input.method,
    route: input.route,
    http_status: input.status,
    auth_status: input.authStatus,
    access_id: input.accessId,
    identity_hash: input.identityHash,
    proxy_status: input.proxyStatus,
    origin_status: input.originStatus,
    rate_limited: input.rateLimited,
    user_agent_present: input.userAgentPresent,
    recorded_at: input.now().toISOString()
  }, input.profile);
}

async function recordBoardAccessBestEffort(
  input: BoardAccessRecordInput
): Promise<void> {
  try {
    await recordBoardAccess(input);
  } catch {
    // The response remains generic when the audit sink itself is unavailable.
  }
}

function hasUserAgent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => item.length > 0);
  }
  return value !== undefined && value.length > 0;
}

function prepareServerBoardProfile(options: BoardServerOptions): PreparedBoardProfile {
  const prepared = prepareBoardProfile(
    {
      enabled: options.profile === "remote-readonly" ? true : undefined,
      profile: options.profile,
      external_base_url: options.externalBaseUrl,
      trusted_proxies: options.trustedProxies,
      allowed_origins: options.allowedOrigins,
      identity_header: options.identityHeader,
      rate_limit_per_minute: options.rateLimitPerMinute
    },
    options.profile
  );
  const issues = [...prepared.invalidConfig, ...prepared.missingConfig];
  if (issues.length > 0) {
    throw new Error(`Board profile setup required: ${issues.join(", ")}`);
  }
  return prepared;
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? readSingleHeader(value[0]) : undefined;
  }
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 || normalized.includes(",")
    ? undefined
    : normalized;
}

function readVerifiedIdentity(value: string | string[] | undefined): string | undefined {
  const identity = readSingleHeader(value);
  if (
    identity === undefined ||
    identity.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(identity)
  ) {
    return undefined;
  }
  return identity;
}

function sanitizeRemoteBoardProjection<T>(value: T): T {
  return removeRemoteActionHints(value) as T;
}

function removeRemoteActionHints(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeRemoteActionHints);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !remoteActionHintKeys.has(key))
        .map(([key, item]) => [key, removeRemoteActionHints(item)])
    );
  }
  return value;
}

const remoteActionHintKeys = new Set([
  "local_command_hint",
  "command_hint",
  "create_hint",
  "rollback_hint"
]);

class BoardRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit: number) {}

  consume(identityHash: string, now: Date): boolean {
    const timestamp = now.getTime();
    const current = this.windows.get(identityHash);
    if (current === undefined || timestamp - current.startedAt >= 60_000) {
      this.windows.set(identityHash, { startedAt: timestamp, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}
