import { describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
import {
  handleDiscordHttpInteraction,
  verifyDiscordHttpInteractionSignature,
  type DiscordHttpInteractionRequest
} from "../src/discord/http-interactions.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { createTempProject } from "./test-utils.js";

const gateway: PreparedDiscordGateway = {
  status: "ready",
  mode: "gateway",
  bot_token: "token",
  application_id: "app",
  guild_id: "guild",
  approval_channel_id: "channel",
  owner_user_id: "owner",
  allowed_user_ids: ["owner"],
  register_commands_on_start: true,
  ack_timeout_ms: 2500,
  idempotency_ttl_minutes: 60,
  reconnect: {
    enabled: true,
    max_backoff_seconds: 60
  }
};

describe("Discord HTTP interactions", () => {
  it("rejects invalid request signatures", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const keys = createDiscordSigningKeys();
    const body = JSON.stringify({ type: 1 });

    await expect(
      handleDiscordHttpInteraction(
        {
          projectRoot: root,
          gateway,
          publicKey: keys.publicKeyHex
        },
        {
          method: "POST",
          headers: {
            "x-signature-ed25519": "00".repeat(64),
            "x-signature-timestamp": "2026-06-01T00:00:00.000Z"
          },
          body
        }
      )
    ).resolves.toMatchObject({
      status: 401,
      body: JSON.stringify({ error: "invalid_request_signature" })
    });
  });

  it("responds to Discord ping interactions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const keys = createDiscordSigningKeys();
    const request = signDiscordRequest({ type: 1 }, keys);

    const response = await handleDiscordHttpInteraction(
      {
        projectRoot: root,
        gateway,
        publicKey: keys.publicKeyHex
      },
      request
    );

    expect(response).toMatchObject({
      status: 200,
      body: JSON.stringify({ type: 1 })
    });
  });

  it("normalizes approval button decisions through the shared Discord path", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-HTTP",
      status: "pending",
      type: "manual_test",
      risk_level: "low",
      discord_nonce: "n42",
      actions: ["approve"]
    });
    const keys = createDiscordSigningKeys();
    const request = signDiscordRequest(
      {
        id: "interaction-http-1",
        type: 3,
        guild_id: "guild",
        channel_id: "channel",
        member: {
          user: {
            id: "owner"
          }
        },
        message: {
          id: "message-1"
        },
        data: {
          custom_id: "kr:v1:apr:APR-HTTP:approve:n42"
        }
      },
      keys
    );

    const response = await handleDiscordHttpInteraction(
      {
        projectRoot: root,
        gateway,
        publicKey: keys.publicKeyHex,
        now: () => new Date("2026-06-01T00:00:00.000Z")
      },
      request
    );
    const body = JSON.parse(response.body) as {
      type: number;
      data: { content: string; flags: number };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      type: 4,
      data: {
        flags: 64
      }
    });
    expect(body.data.content).toMatch(/^Kairon command queued: CMD-/);
    await expect(new CommandInbox(root).list()).resolves.toMatchObject([
      {
        command: {
          type: "approval.decide",
          approval_id: "APR-HTTP",
          decision: "approve",
          discord: {
            guild_id: "guild",
            channel_id: "channel",
            message_id: "message-1",
            interaction_id: "interaction-http-1",
            custom_id: "kr:v1:apr:APR-HTTP:approve:n42"
          }
        }
      }
    ]);
  });

  it("verifies valid Ed25519 signatures over timestamp and raw body", () => {
    const keys = createDiscordSigningKeys();
    const request = signDiscordRequest({ type: 1 }, keys);

    expect(
      verifyDiscordHttpInteractionSignature({
        publicKey: keys.publicKeyHex,
        signature: request.headers["x-signature-ed25519"] as string,
        timestamp: request.headers["x-signature-timestamp"] as string,
        body: request.body
      })
    ).toBe(true);
  });
});

async function writeApproval(
  root: string,
  approval: Record<string, unknown>
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "approvals", `${approval.id}.json`),
    {
      schema_version: "0.1",
      ...approval
    }
  );
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

function signDiscordRequest(
  payload: Record<string, unknown>,
  keys: ReturnType<typeof createDiscordSigningKeys>
): DiscordHttpInteractionRequest {
  const body = JSON.stringify(payload);
  const timestamp = "2026-06-01T00:00:00.000Z";
  const message = Buffer.concat([
    Buffer.from(timestamp, "utf8"),
    Buffer.from(body, "utf8")
  ]);
  return {
    method: "POST",
    headers: {
      "x-signature-ed25519": sign(null, message, keys.privateKey).toString("hex"),
      "x-signature-timestamp": timestamp
    },
    body
  };
}
