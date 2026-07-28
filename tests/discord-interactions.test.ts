import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  normalizeDiscordApprovalInteraction,
  normalizeDiscordLeaveCommand,
  normalizeDiscordStatusCommand,
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
  idempotency_ttl_minutes: 60,
  reconnect: {
    enabled: true,
    max_backoff_seconds: 60
  }
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
    expect(parseApprovalCustomId("kr:v1:apr:APR-0001:reject_modal:n42")).toMatchObject({
      action: "reject",
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
    await writeApproval(root, {
      id: "APR-0002",
      status: "pending",
      discord_nonce: "expired",
      actions: ["approve"],
      discord: {
        nonce_expires_at: "2026-05-24T00:00:00.000Z"
      }
    });
    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-0002:approve:expired",
        received_at: "2026-05-25T00:00:00.000Z"
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "approval nonce expired"
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

  it("blocks Discord approve for high-risk approvals while allowing reject and changes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-HIGH",
      status: "pending",
      type: "deploy",
      discord_nonce: "n42",
      actions: ["approve", "reject", "request_changes"]
    });

    await expect(
      validateDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i-high-approve-validate",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        custom_id: "kr:v1:apr:APR-HIGH:approve:n42"
      })
    ).resolves.toMatchObject({
      ok: true,
      confirmation: {
        required_by: "board",
        reason: "board_confirmation_required"
      }
    });
    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i-high-approve",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        message_id: "m1",
        custom_id: "kr:v1:apr:APR-HIGH:approve:n42"
      })
    ).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      command: {
        type: "approval.confirmation.request",
        approval_id: "APR-HIGH",
        action: "approve",
        confirmation: "board",
        reason: "board_confirmation_required"
      }
    });
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(1);

    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i-high-reject",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        message_id: "m1",
        custom_id: "kr:v1:apr:APR-HIGH:reject:n42",
        reason: "Do not deploy yet."
      })
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "approval.decide",
        decision: "reject",
        reason: "Do not deploy yet."
      }
    });
    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i-high-changes",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        message_id: "m1",
        custom_id: "kr:v1:apr:APR-HIGH:changes:n42",
        reason: "Attach rollout evidence."
      })
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "approval.decide",
        decision: "request_changes",
        reason: "Attach rollout evidence."
      }
    });
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(3);
  });

  it("allows low-risk Discord approve interactions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-LOW",
      status: "pending",
      type: "manual_test",
      risk_level: "low",
      discord_nonce: "n42",
      actions: ["approve"]
    });

    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i-low-approve",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        message_id: "m1",
        custom_id: "kr:v1:apr:APR-LOW:approve:n42"
      })
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "approval.decide",
        approval_id: "APR-LOW",
        decision: "approve"
      }
    });
  });

  it("normalizes reject modal submissions with a reason", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      discord_nonce: "n42",
      actions: ["reject"]
    });

    await expect(
      normalizeDiscordApprovalInteraction(root, gateway, {
        interaction_id: "i1",
        user_id: "owner",
        guild_id: "guild",
        channel_id: "channel",
        message_id: "m1",
        custom_id: "kr:v1:apr:APR-0001:reject:n42",
        reason: "Blocked by policy.",
        received_at: "2026-05-25T00:00:00.000Z"
      })
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "approval.decide",
        decision: "reject",
        reason: "Blocked by policy."
      }
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

  it("normalizes /kairon status into a runtime status command", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      normalizeDiscordStatusCommand(
        root,
        gateway,
        {
          interaction_id: "status-1",
          user_id: "owner",
          guild_id: "guild",
          channel_id: "channel",
          command_name: "kairon status"
        },
        new Date("2026-05-25T08:00:00.000Z")
      )
    ).resolves.toMatchObject({
      accepted: true,
      command: {
        type: "runtime.status",
        reason: "discord_kairon_status"
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
