import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server
} from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  formatDiscordHttpStatus,
  getDiscordHttpServerStatus,
  startDiscordHttpInteractionsServer
} from "../src/discord/http-server.js";
import { createTempProject } from "./test-utils.js";

const discordIds = {
  application: "1512769191617237002",
  guild: "1512769541216931901",
  channel: "1512774533143335034",
  owner: "1512769542366036072"
};

const fixedNow = new Date("2026-06-01T00:00:00.000Z");

describe("Discord HTTP interactions server", () => {
  it("serves signed Discord ping interactions over loopback with raw body preservation", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      now: () => fixedNow
    });

    try {
      expect(server).toMatchObject({
        status: "ready",
        profile: "loopback",
        host: "127.0.0.1",
        health_url: expect.stringContaining("/health"),
        readiness_url: expect.stringContaining("/ready")
      });

      await expect(getJson(server.readiness_url!)).resolves.toEqual({
        status: 200,
        body: JSON.stringify({
          schema_version: "0.1",
          status: "ready",
          mode: "http_interactions",
          profile: "loopback",
          signature_verification: "ready"
        })
      });

      await expect(getJson(server.health_url!)).resolves.toEqual({
        status: 200,
        body: JSON.stringify({
          schema_version: "0.1",
          status: "ok",
          mode: "http_interactions"
        })
      });

      const body = '{ "type" : 1 }';
      const signed = signDiscordBody(body, keys);
      const response = await postJson(server.url!, body, signed.headers);

      expect(response).toEqual({
        status: 200,
        body: JSON.stringify({ type: 1 })
      });
      await expect(postJson(server.url!, body, signed.headers)).resolves.toEqual({
        status: 409,
        body: JSON.stringify({ error: "replayed_request" })
      });

      await expect(
        readJsonFile(path.join(root, ".kairon", "runtime", "discord", "http-server.json"))
      ).resolves.toMatchObject({
        status: "ready",
        mode: "http_interactions",
        profile: "loopback",
        host: "127.0.0.1",
        health_url: server.health_url,
        readiness_url: server.readiness_url,
        trusted_proxies: ["127.0.0.1/32", "::1/128"],
        security: {
          timestamp_tolerance_seconds: 300,
          replay_ttl_seconds: 300,
          audit_path: ".kairon/runtime/discord/http-security.jsonl"
        }
      });
      await expect(getDiscordHttpServerStatus(root)).resolves.toMatchObject({
        status: "ready",
        profile: "loopback"
      });
      expect(formatDiscordHttpStatus(await getDiscordHttpServerStatus(root))).toContain(
        "readiness_url=http://127.0.0.1:"
      );
    } finally {
      await server.stop();
    }

    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "http-server.json"))
    ).resolves.toMatchObject({
      status: "stopped",
      mode: "http_interactions"
    });
  });

  it("rejects signatures when the raw request body changes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      now: () => fixedNow
    });

    try {
      const signed = signDiscordBody('{ "type" : 1 }', keys);
      const response = await postJson(server.url!, JSON.stringify({ type: 1 }), signed.headers);

      expect(response).toEqual({
        status: 401,
        body: JSON.stringify({ error: "invalid_request_signature" })
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects non-loopback hosts before binding", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      startDiscordHttpInteractionsServer(root, {
        host: "0.0.0.0",
        port: 0,
        env: discordHttpEnv("a".repeat(64))
      })
    ).rejects.toThrow("loopback-only");
  });

  it("records setup_required without exposing secret values when public key is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(undefined)
    });

    expect(server).toMatchObject({
      status: "setup_required",
      missing_env: ["KAIRON_DISCORD_PUBLIC_KEY"]
    });

    const status = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "http-server.json")
    );
    expect(status).toMatchObject({
      status: "setup_required",
      mode: "http_interactions",
      missing_env: ["KAIRON_DISCORD_PUBLIC_KEY"]
    });
    expect(JSON.stringify(status)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("requires HTTPS profile config and a public key before reverse-proxy readiness", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);

    const missingConfig = await startDiscordHttpInteractionsServer(root, {
      profile: "reverse-proxy",
      port: 0,
      env: discordHttpEnv("a".repeat(64))
    });
    expect(missingConfig).toMatchObject({
      status: "setup_required",
      profile: "reverse-proxy",
      missing_env: ["notifications.http.external_base_url"]
    });

    await configureHttpProfile(root, {
      profile: "reverse-proxy",
      external_base_url: "http://discord.example.test/",
      trusted_proxies: ["not-a-cidr"]
    });
    const invalidConfig = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv("a".repeat(64))
    });
    expect(invalidConfig).toMatchObject({
      status: "setup_required",
      profile: "reverse-proxy",
      invalid_env: expect.arrayContaining([
        "notifications.http.external_base_url",
        "notifications.http.trusted_proxies"
      ])
    });

    await configureHttpProfile(root, {
      profile: "reverse-proxy",
      external_base_url: "https://discord.example.test/kairon/",
      trusted_proxies: ["127.0.0.1/32"]
    });
    const missingKey = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(undefined)
    });
    expect(missingKey).toMatchObject({
      status: "setup_required",
      profile: "reverse-proxy",
      missing_env: ["KAIRON_DISCORD_PUBLIC_KEY"]
    });
  });

  it("rejects forwarded headers from an untrusted proxy address", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    await configureHttpProfile(root, {
      profile: "reverse-proxy",
      external_base_url: "https://discord.example.test/",
      trusted_proxies: ["10.0.0.0/8"]
    });
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      now: () => fixedNow
    });

    try {
      const body = JSON.stringify({ type: 1 });
      const signed = signDiscordBody(body, keys);
      await expect(
        postJson(server.url!, body, {
          ...signed.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "discord.example.test"
        })
      ).resolves.toEqual({
        status: 403,
        body: JSON.stringify({ error: "untrusted_proxy" })
      });
    } finally {
      await server.stop();
    }
  });

  it("accepts a signed interaction through a trusted reverse proxy and keeps replay protection", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    await configureHttpProfile(root, {
      profile: "reverse-proxy",
      external_base_url: "https://discord.example.test/kairon/",
      trusted_proxies: ["127.0.0.1/32"]
    });
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      now: () => fixedNow
    });
    const proxy = await startReverseProxy(server.url!, "discord.example.test");

    try {
      expect(server).toMatchObject({
        status: "ready",
        profile: "reverse-proxy",
        host: "127.0.0.1",
        external_url: "https://discord.example.test/kairon/interactions"
      });
      const body = '{ "type" : 1 }';
      const signed = signDiscordBody(body, keys);
      await expect(postJson(proxy.url, body, signed.headers)).resolves.toEqual({
        status: 200,
        body: JSON.stringify({ type: 1 })
      });
      await expect(postJson(proxy.url, body, signed.headers)).resolves.toEqual({
        status: 409,
        body: JSON.stringify({ error: "replayed_request" })
      });
    } finally {
      await proxy.stop();
      await server.stop();
    }
  });

  it("rejects non-JSON and oversized interaction requests before parsing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      now: () => fixedNow,
      maxBodyBytes: 8
    });

    try {
      const body = JSON.stringify({ type: 1 });
      const signed = signDiscordBody(body, keys);
      const { "content-type": _contentType, ...withoutContentType } = signed.headers;
      await expect(postJson(server.url!, body, withoutContentType)).resolves.toEqual({
        status: 415,
        body: JSON.stringify({ error: "unsupported_media_type" })
      });
      await expect(postJson(server.url!, body, signed.headers)).resolves.toEqual({
        status: 413,
        body: JSON.stringify({ error: "request_body_too_large" })
      });
    } finally {
      await server.stop();
    }
  });

  it("terminates an incomplete interaction body at the configured request timeout", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex),
      requestTimeoutMs: 25
    });

    try {
      await expect(postIncompleteJson(server.url!)).resolves.toEqual({
        status: 408,
        body: JSON.stringify({ error: "request_timeout" })
      });
    } finally {
      await server.stop();
    }
  });
});

async function enableDiscord(root: string): Promise<void> {
  const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
  const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
  const providers = notifications.providers as Record<string, unknown>;
  const discord = providers.discord as Record<string, unknown>;
  discord.enabled = true;
  await writeJsonFileAtomic(notificationsPath, notifications);
}

async function configureHttpProfile(
  root: string,
  http: Record<string, unknown>
): Promise<void> {
  const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
  const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
  notifications.http = http;
  await writeJsonFileAtomic(notificationsPath, notifications);
}

function discordHttpEnv(publicKey: string | undefined): NodeJS.ProcessEnv {
  return {
    KAIRON_DISCORD_PUBLIC_KEY: publicKey,
    KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
    KAIRON_DISCORD_GUILD_ID: discordIds.guild,
    KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
    KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
    KAIRON_DISCORD_ALLOWED_USER_IDS: discordIds.owner
  };
}

function createDiscordSigningKeys(): {
  privateKey: KeyObject;
  publicKeyHex: string;
} {
  const keyPair = generateKeyPairSync("ed25519");
  const spki = keyPair.publicKey.export({
    format: "der",
    type: "spki"
  }) as Buffer;
  return {
    privateKey: keyPair.privateKey,
    publicKeyHex: spki.subarray(-32).toString("hex")
  };
}

function signDiscordBody(
  body: string,
  keys: ReturnType<typeof createDiscordSigningKeys>
): { headers: Record<string, string> } {
  const timestamp = Math.floor(fixedNow.getTime() / 1000).toString();
  const message = Buffer.concat([
    Buffer.from(timestamp, "utf8"),
    Buffer.from(body, "utf8")
  ]);
  return {
    headers: {
      "x-signature-ed25519": sign(null, message, keys.privateKey).toString("hex"),
      "x-signature-timestamp": timestamp,
      "content-type": "application/json"
    }
  };
}

function getJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function postJson(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function postIncompleteJson(
  url: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          request.destroy();
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.flushHeaders();
  });
}

async function startReverseProxy(
  upstreamUrl: string,
  forwardedHost: string
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    const upstream = httpRequest(
      upstreamUrl,
      {
        method: request.method,
        headers: {
          ...request.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-host": forwardedHost
        }
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    stop: () => closeServer(server)
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
