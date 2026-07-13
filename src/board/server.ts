import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
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
  validateBoardAccessToken
} from "./access-token.js";

export type BoardServerOptions = BoardProjectionOptions & {
  host?: string;
  port?: number;
  requireToken?: boolean;
  accessTokenTtlSeconds?: number;
  randomToken?: () => string;
};

export type BoardServeResult = {
  schema_version: "0.1";
  board_url: string;
  projection_path: string;
  host: string;
  port: number;
  status_path: string;
  access_token?: string;
  access_token_expires_at?: string;
  access_scope?: string;
};

export type BoardServerRuntimeStatus = {
  schema_version: "0.1";
  status: "ready" | "stopped";
  mode: "loopback_read_only";
  board_url: string;
  projection_path: string;
  host: string;
  port: number;
  access: {
    required: boolean;
    token_hash?: string;
    expires_at?: string;
    scope: typeof boardReadScope;
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
  const access = createBoardAccess(options, now());
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        });
        response.end("Method not allowed");
        return;
      }

      const requestUrl = new URL(request.url ?? "/", `http://${host}`);
      if (access !== undefined) {
        const validation = validateBoardAccessToken({
          token: readBearerToken(request.headers.authorization),
          metadata: access.metadata,
          now: now(),
          requiredScope: boardReadScope
        });
        if (!validation.accepted) {
          sendUnauthorized(response, request.method, validation.reason);
          return;
        }
      }

      const projection = await createBoardProjection(projectRoot, options);

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        send(response, request.method, 200, "text/html; charset=utf-8", renderBoardHtml(projection));
        return;
      }

      if (requestUrl.pathname === "/projection.json") {
        send(
          response,
          request.method,
          200,
          "application/json; charset=utf-8",
          `${JSON.stringify(projection, null, 2)}\n`
        );
        return;
      }

      send(response, request.method, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      send(
        response,
        request.method ?? "GET",
        500,
        "text/plain; charset=utf-8",
        `Board render failed: ${String(error)}`
      );
    }
  });

  await listen(server, requestedPort, host);
  server.ref();

  try {
    const exportResult = await exportBoardProjection(projectRoot, options);
    const actualPort = readActualPort(server);
    const boardUrl = `http://${host}:${actualPort}/`;
    const statusPath = boardServerStatusPath(projectRoot);
    const statusBase = {
      schema_version: "0.1" as const,
      mode: "loopback_read_only" as const,
      board_url: boardUrl,
      projection_path: exportResult.projection_path,
      host,
      port: actualPort,
      access: accessStatus(access)
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
    `board.url=${result.board_url}`,
    `projection=${result.projection_path}`,
    `status_path=${result.status_path}`,
    `host=${result.host}`,
    `port=${result.port}`
  ];
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
  access: ReturnType<typeof issueBoardAccessToken> | undefined
): BoardServerRuntimeStatus["access"] {
  return access === undefined
    ? {
        required: false,
        scope: boardReadScope
      }
    : {
        required: true,
        token_hash: access.metadata.token_hash,
        expires_at: access.metadata.expires_at,
        scope: boardReadScope
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

async function writeBoardServerStatus(
  projectRoot: string,
  status: BoardServerRuntimeStatus
): Promise<void> {
  const filePath = boardServerStatusPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFileAtomic(filePath, status);
}

function boardServerStatusPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "board", "server.json");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
