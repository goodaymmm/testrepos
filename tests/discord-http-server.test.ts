import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { startDiscordHttpInteractionsServer } from "../src/discord/http-server.js";
import { createTempProject } from "./test-utils.js";

const discordIds = {
  application: "1512769191617237002",
  guild: "1512769541216931901",
  channel: "1512774533143335034",
  owner: "1512769542366036072"
};

describe("Discord HTTP interactions server", () => {
  it("serves signed Discord ping interactions over loopback with raw body preservation", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscord(root);
    const keys = createDiscordSigningKeys();
    const server = await startDiscordHttpInteractionsServer(root, {
      port: 0,
      env: discordHttpEnv(keys.publicKeyHex)
    });

    try {
      expect(server).toMatchObject({
        status: "ready",
        host: "127.0.0.1"
      });

      const body = '{ "type" : 1 }';
      const signed = signDiscordBody(body, keys);
      const response = await postJson(server.url!, body, signed.headers);

      expect(response).toEqual({
        status: 200,
        body: JSON.stringify({ type: 1 })
      });

      await expect(
        readJsonFile(path.join(root, ".kairon", "runtime", "discord", "http-server.json"))
      ).resolves.toMatchObject({
        status: "ready",
        mode: "http_interactions",
        host: "127.0.0.1"
      });
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
      env: discordHttpEnv(keys.publicKeyHex)
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
});

async function enableDiscord(root: string): Promise<void> {
  const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
  const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
  const providers = notifications.providers as Record<string, unknown>;
  const discord = providers.discord as Record<string, unknown>;
  discord.enabled = true;
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
  const timestamp = "2026-06-01T00:00:00.000Z";
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
