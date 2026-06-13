import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createBoardProjection,
  exportBoardProjection,
  type BoardProjectionOptions
} from "./projection.js";
import { renderBoardHtml } from "./html.js";

export type BoardServerOptions = BoardProjectionOptions & {
  host?: string;
  port?: number;
};

export type BoardServeResult = {
  schema_version: "0.1";
  board_url: string;
  projection_path: string;
  host: string;
  port: number;
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
    let closed = false;
    const closedPromise = new Promise<void>((resolve) => {
      server.once("close", () => {
        closed = true;
        resolve();
      });
    });

    return {
      schema_version: "0.1",
      board_url: boardUrl,
      projection_path: exportResult.projection_path,
      host,
      port: actualPort,
      stop: async () => {
        if (closed) {
          return;
        }

        await close(server);
      },
      waitUntilClosed: () => closedPromise
    };
  } catch (error) {
    await close(server);
    throw error;
  }
}

export function formatBoardServeResult(result: BoardServeResult): string {
  return [
    "Kairon board server started.",
    `board.url=${result.board_url}`,
    `projection=${result.projection_path}`,
    `host=${result.host}`,
    `port=${result.port}`
  ].join("\n");
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
