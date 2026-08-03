import { describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
import {
  DiscordHttpReplayGuard,
  handleDiscordHttpInteraction,
  verifyDiscordHttpInteractionSignature,
  type DiscordHttpInteractionRequest
} from "../src/discord/http-interactions.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { RuntimeLoop } from "../src/runtime/runtime-loop.js";
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

const fixedNow = new Date("2026-06-01T00:00:00.000Z");

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
          publicKey: keys.publicKeyHex,
          now: () => fixedNow
        },
        {
          method: "POST",
          headers: {
            "x-signature-ed25519": "00".repeat(64),
            "x-signature-timestamp": discordTimestamp(fixedNow)
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
        publicKey: keys.publicKeyHex,
        now: () => fixedNow
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
    const payload = approvalInteractionPayload("interaction-http-1");
    const request = signDiscordRequest(payload, keys);

    const response = await handleDiscordHttpInteraction(
      {
        projectRoot: root,
        gateway,
        publicKey: keys.publicKeyHex,
        now: () => fixedNow
      },
      request
    );
    const body = JSON.parse(response.body) as {
      type: number;
      data: { components: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      type: 7,
      data: {
        components: []
      }
    });
    await expect(new CommandInbox(root).list()).resolves.toMatchObject([
      {
        command: {
          type: "approval.decide",
          approval_id: "APR-HTTP",
          decision: "approve",
          discord: {
            transport: "http_interactions",
            guild_id: "guild",
            channel_id: "channel",
            message_id: "message-1",
            interaction_id: "interaction-http-1",
            custom_id: "kr:v1:apr:APR-HTTP:approve:n42"
          }
        }
      }
    ]);

    const duplicateResponse = await handleDiscordHttpInteraction(
      {
        projectRoot: root,
        gateway,
        publicKey: keys.publicKeyHex,
        now: () => fixedNow
      },
      signDiscordRequest(approvalInteractionPayload("interaction-http-2"), keys)
    );
    expect(JSON.parse(duplicateResponse.body)).toEqual({
      type: 4,
      data: {
        content: "Kairon command was already handled.",
        flags: 64
      }
    });
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(1);

    await expect(
      new RuntimeLoop(root, { now: () => fixedNow }).runTick()
    ).resolves.toMatchObject({ action: "processed-command" });
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-HTTP.json"))
    ).resolves.toMatchObject({ status: "decided", decision: "approve" });
    await expect(
      readJsonLines(
        path.join(root, ".kairon", "runtime", "discord", "decision-interactions.jsonl")
      )
    ).resolves.toEqual([
      expect.objectContaining({
        interaction_id: "interaction-http-1",
        transport: "http_interactions",
        approval_id: "APR-HTTP",
        decision: "approve",
        status: "applied",
        duplicate: false,
        command_status: "completed",
        message_update_status: "unavailable",
        reply_status: "skipped"
      })
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

  it("rejects signatures outside the timestamp tolerance and audits a safe reason", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const keys = createDiscordSigningKeys();
    const marker = "SHOULD_NOT_LEAK_HTTP_BODY";
    const request = signDiscordRequest(
      { type: 1, marker },
      keys,
      new Date(fixedNow.getTime() - 301_000)
    );

    const response = await handleDiscordHttpInteraction(
      {
        projectRoot: root,
        gateway,
        publicKey: keys.publicKeyHex,
        now: () => fixedNow,
        timestampToleranceSeconds: 300
      },
      request
    );

    expect(response).toMatchObject({
      status: 401,
      body: JSON.stringify({ error: "signature_timestamp_out_of_range" })
    });

    const audit = await readJsonLines(
      path.join(root, ".kairon", "runtime", "discord", "http-security.jsonl")
    );
    expect(audit).toMatchObject([
      {
        status: "rejected",
        reason: "signature_timestamp_out_of_range",
        method: "POST"
      }
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(keys.publicKeyHex);
    expect(serialized).not.toContain(
      request.headers["x-signature-ed25519"] as string
    );
  });

  it("rejects a replayed signed request within the configured cache TTL", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const keys = createDiscordSigningKeys();
    const request = signDiscordRequest({ type: 1 }, keys);
    const replayGuard = new DiscordHttpReplayGuard(300);
    const options = {
      projectRoot: root,
      gateway,
      publicKey: keys.publicKeyHex,
      now: () => fixedNow,
      replayGuard
    };

    await expect(handleDiscordHttpInteraction(options, request)).resolves.toMatchObject({
      status: 200
    });
    await expect(handleDiscordHttpInteraction(options, request)).resolves.toMatchObject({
      status: 409,
      body: JSON.stringify({ error: "replayed_request" })
    });

    await expect(
      readJsonLines(
        path.join(root, ".kairon", "runtime", "discord", "http-security.jsonl")
      )
    ).resolves.toMatchObject([{ reason: "replayed_request" }]);
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
  keys: ReturnType<typeof createDiscordSigningKeys>,
  timestampDate = fixedNow
): DiscordHttpInteractionRequest {
  const body = JSON.stringify(payload);
  const timestamp = discordTimestamp(timestampDate);
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

function discordTimestamp(date: Date): string {
  return Math.floor(date.getTime() / 1000).toString();
}

function approvalInteractionPayload(interactionId: string): Record<string, unknown> {
  return {
    id: interactionId,
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
  };
}
