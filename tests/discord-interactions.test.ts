import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  parseApprovalCustomId,
  validateDiscordApprovalInteraction
} from "../src/discord/interactions.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
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
  idempotency_ttl_minutes: 60
};

describe("Discord interactions", () => {
  it("parses approval custom ids", () => {
    expect(parseApprovalCustomId("kr:v1:apr:APR-0001:approve:n42")).toMatchObject({
      kind: "approval",
      approval_id: "APR-0001",
      action: "approve",
      nonce: "n42"
    });
    expect(parseApprovalCustomId("kr:v1:apr:APR-0001:changes_modal:n42")).toMatchObject({
      action: "request_changes",
      modal: true
    });
    expect(parseApprovalCustomId("invalid")).toMatchObject({
      kind: "unknown"
    });
  });

  it("validates actor, channel, nonce, status, and allowed action", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      discord_nonce: "n42",
      actions: ["approve"]
    });

    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-0001:approve:n42"
      })
    ).resolves.toMatchObject({
      ok: true
    });
    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "intruder",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-0001:approve:n42"
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "discord actor is not allowed"
    });
    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-0001:reject:n42"
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "approval action is not allowed"
    });
    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-9999:approve:n42"
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "approval was not found"
    });
  });

  it("normalizes approval decision interactions into Command Inbox", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      discord_nonce: "n42",
      actions: ["request_changes"]
    });

    const result = await normalizeDiscordApprovalInteraction(root, gateway, {
      interaction_id: "i1",
      user_id: "owner",
      guild_id: "guild",
      channel_id: "channel",
      message_id: "m1",
      custom_id: "kr:v1:apr:APR-0001:changes:n42",
      reason: "Add regression tests.",
      received_at: "2026-05-25T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      command: {
        type: "approval.decide",
        approval_id: "APR-0001",
        decision: "request_changes",
        reason: "Add regression tests."
      }
    });
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(1);
    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-0001:changes:n42",
        reason: "Add regression tests."
      })
    ).resolves.toMatchObject({
      accepted: false,
      duplicate: true
    });
  });

  it("normalizes /kairon leave into a schedule command", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      normalizeDiscordLeaveCommand(
        root,
        gateway,
        {
          interaction_id: "leave-1",
          user_id: "owner",
          guild_id: "guild",
          channel_id: "channel",
          command_name: "kairon leave"
        },
        new Date("2026-05-25T08:00:00.000Z")
      )
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "schedule.close_active_work",
        reason: "discord_kairon_leave"
      }
    });
  });
});

async function writeApproval(root: string, approval: Record<string, unknown>): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "approvals", `${approval.id}.json`),
    {
      schema_version: "0.1",
      ...approval
    }
  );
  await expect(
    readJsonFile(path.join(root, ".kairon", "approvals", `${approval.id}.json`))
  ).resolves.toMatchObject({ id: approval.id });
}
