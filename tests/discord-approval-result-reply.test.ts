import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  formatDiscordApprovalResultReply,
  replyToDiscordApprovalResult
} from "../src/discord/approval-result-reply.js";
import type {
  DiscordApprovalChannel,
  DiscordApprovalMessageHandle
} from "../src/discord/approval-notifier.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
import type { CommandEnvelope } from "../src/queue/command-inbox.js";
import { createTempProject } from "./test-utils.js";

const gateway: PreparedDiscordGateway & { status: "ready" } = {
  status: "ready",
  mode: "gateway",
  bot_token: "token",
  application_id: "1512769191617237002",
  guild_id: "1512769541216931901",
  approval_channel_id: "1512774533143335034",
  owner_user_id: "471954474567598080",
  allowed_user_ids: ["471954474567598080"],
  register_commands_on_start: false,
  ack_timeout_ms: 2500,
  idempotency_ttl_minutes: 60,
  reconnect: {
    enabled: true,
    max_backoff_seconds: 60
  }
};

describe("Discord approval result replies", () => {
  it("updates the Approval message and posts a paired action result reply", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-HTTP-RESULT.json"),
      {
        schema_version: "0.1",
        id: "APR-HTTP-RESULT",
        status: "decided",
        decision: "approve",
        title: "HTTP result reply",
        type: "manual_test",
        discord: {
          channel_id: gateway.approval_channel_id,
          message_id: "1528430700733403337",
          nonce: "n42"
        }
      }
    );
    const sourceMessage: DiscordApprovalMessageHandle & { edited?: unknown } = {
      id: "1528430700733403337",
      edit(payload) {
        sourceMessage.edited = payload;
      }
    };
    const sent: unknown[] = [];
    const channel: DiscordApprovalChannel = {
      id: gateway.approval_channel_id,
      messages: {
        fetch: () => sourceMessage
      },
      send(payload) {
        sent.push(payload);
        return { id: "1528430737731096637" };
      }
    };
    const envelope = approvalEnvelope();

    await expect(
      replyToDiscordApprovalResult(
        root,
        { envelope, commandStatus: "completed" },
        {
          now: () => new Date("2026-07-19T15:58:08.867Z"),
          prepareGateway: async () => gateway,
          channelFactory: () => channel
        }
      )
    ).resolves.toEqual({
      status: "sent",
      approval_id: "APR-HTTP-RESULT",
      action: "approve",
      result: "completed",
      source_message_id: "1528430700733403337",
      reply_message_id: "1528430737731096637",
      message_update_status: "updated"
    });
    expect(sourceMessage.edited).toMatchObject({
      content: "Approval decided: APR-HTTP-RESULT",
      components: []
    });
    expect(sent).toEqual([
      {
        content: [
          "Action: approve",
          "Result: completed",
          "Command: CMD-0001"
        ].join("\n"),
        message_reference: {
          type: 0,
          message_id: "1528430700733403337",
          channel_id: "1512774533143335034",
          guild_id: "1512769541216931901",
          fail_if_not_exists: true
        },
        allowed_mentions: {
          replied_user: false
        }
      }
    ]);
  });

  it("includes a sanitized failure result in the reply body", () => {
    expect(
      formatDiscordApprovalResultReply({
        action: "reject",
        commandStatus: "failed",
        commandId: "CMD-0002",
        error: "policy denied\nwith detail"
      })
    ).toBe(
      [
        "Action: reject",
        "Result: failed",
        "Command: CMD-0002",
        "Reason: policy denied with detail"
      ].join("\n")
    );
  });

  it("does not post a failure reply for a stale command against a closed approval", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-HTTP-RESULT.json"),
      {
        schema_version: "0.1",
        id: "APR-HTTP-RESULT",
        status: "decided",
        decision: "reject",
        discord: {
          message_id: "1528430700733403337"
        }
      }
    );
    let channelCreated = false;

    await expect(
      replyToDiscordApprovalResult(
        root,
        {
          envelope: approvalEnvelope(),
          commandStatus: "failed",
          error: "approval is already decided"
        },
        {
          prepareGateway: async () => gateway,
          channelFactory: () => {
            channelCreated = true;
            throw new Error("channel should not be created");
          }
        }
      )
    ).resolves.toMatchObject({
      status: "skipped",
      approval_id: "APR-HTTP-RESULT",
      result: "failed",
      source_message_id: "1528430700733403337",
      reason: "approval is already decided"
    });
    expect(channelCreated).toBe(false);
  });
});

function approvalEnvelope(): CommandEnvelope {
  return {
    command_id: "CMD-0001",
    status: "claimed",
    command: {
      type: "approval.decide",
      source: "discord",
      approval_id: "APR-HTTP-RESULT",
      decision: "approve",
      received_at: "2026-07-19T15:58:04.742Z",
      discord: {
        transport: "http_interactions",
        guild_id: gateway.guild_id,
        channel_id: gateway.approval_channel_id,
        message_id: "1528430700733403337",
        interaction_id: "1528430737731096637",
        custom_id: "kr:v1:apr:APR-HTTP-RESULT:approve:n42"
      }
    },
    idempotency_key: "discord:interaction:1528430737731096637",
    created_at: "2026-07-19T15:58:04.753Z",
    updated_at: "2026-07-19T15:58:08.739Z"
  };
}
