import { ApprovalQueue } from "../approvals/approval-queue.js";
import type { CommandEnvelope } from "../queue/command-inbox.js";
import {
  updateDiscordApprovalMessage,
  type DiscordApprovalChannel
} from "./approval-notifier.js";
import {
  prepareDiscordGateway,
  type PreparedDiscordGateway
} from "./gateway.js";
import { sanitizeDiscordAuditText } from "./decision-audit.js";

export type DiscordApprovalResultReplyStatus = "sent" | "skipped" | "failed";

export type DiscordApprovalResultReply = {
  status: DiscordApprovalResultReplyStatus;
  approval_id: string;
  action: string;
  result: "completed" | "failed";
  source_message_id?: string;
  reply_message_id?: string;
  message_update_status?: "updated" | "skipped" | "failed" | "unavailable";
  reason?: string;
};

export type DiscordApprovalResultReplyOptions = {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  prepareGateway?: () => Promise<PreparedDiscordGateway>;
  channelFactory?: (
    gateway: PreparedDiscordGateway & { status: "ready" },
    channelId: string
  ) => Promise<DiscordApprovalChannel> | DiscordApprovalChannel;
};

export async function replyToDiscordApprovalResult(
  projectRoot: string,
  input: {
    envelope: CommandEnvelope;
    commandStatus: "completed" | "failed";
    error?: unknown;
  },
  options: DiscordApprovalResultReplyOptions = {}
): Promise<DiscordApprovalResultReply> {
  const command = input.envelope.command;
  if (
    command.source !== "discord" ||
    command.discord?.transport !== "http_interactions" ||
    (command.type !== "approval.confirmation.request" &&
      command.type !== "approval.decide" &&
      command.type !== "approval.snooze")
  ) {
    return {
      status: "skipped",
      approval_id: "approval_id" in command ? command.approval_id : "unknown",
      action: approvalAction(command),
      result: input.commandStatus,
      message_update_status: "unavailable",
      reason: "command is not a Discord HTTP approval action"
    };
  }

  const base = {
    approval_id: command.approval_id,
    action: approvalAction(command),
    result: input.commandStatus
  } as const;

  try {
    const approval = await new ApprovalQueue(projectRoot).show(command.approval_id);
    const sourceMessageId = readDiscordMessageId(approval.discord);
    if (sourceMessageId === undefined) {
      return {
        ...base,
        status: "skipped",
        message_update_status: "unavailable",
        reason: "discord approval message id is missing"
      };
    }
    if (
      input.commandStatus === "failed" &&
      approval.status !== "pending" &&
      approval.status !== "snoozed"
    ) {
      return {
        ...base,
        status: "skipped",
        source_message_id: sourceMessageId,
        message_update_status: "unavailable",
        reason: `approval is already ${approval.status}`
      };
    }

    const gateway = await (options.prepareGateway?.() ??
      prepareDiscordGateway(projectRoot, options.env ?? process.env));
    if (gateway.status !== "ready") {
      return {
        ...base,
        status: "skipped",
        source_message_id: sourceMessageId,
        message_update_status: "unavailable",
        reason: gateway.reason
      };
    }

    const channelId = command.discord.channel_id ?? gateway.approval_channel_id;
    const channel = await (options.channelFactory?.(gateway, channelId) ??
      createDiscordRestApprovalChannel(gateway, channelId));

    let messageUpdateStatus: DiscordApprovalResultReply["message_update_status"] =
      "unavailable";
    if (input.commandStatus === "completed") {
      const update = await updateDiscordApprovalMessage(
        projectRoot,
        command.approval_id,
        channel,
        { now: options.now }
      );
      messageUpdateStatus = update.status;
      if (update.status !== "updated") {
        return {
          ...base,
          status: "skipped",
          source_message_id: sourceMessageId,
          message_update_status: update.status,
          reason: update.reason
        };
      }
    }

    const reply = await channel.send({
      content: formatDiscordApprovalResultReply({
        action: base.action,
        commandStatus: input.commandStatus,
        commandId: input.envelope.command_id,
        error: input.error
      }),
      message_reference: {
        type: 0,
        message_id: sourceMessageId,
        channel_id: channelId,
        guild_id: command.discord.guild_id ?? gateway.guild_id,
        fail_if_not_exists: true
      },
      allowed_mentions: {
        replied_user: false
      }
    });
    if (reply.id === undefined || reply.id.length === 0) {
      return {
        ...base,
        status: "failed",
        source_message_id: sourceMessageId,
        message_update_status: messageUpdateStatus,
        reason: "Discord result reply did not return a message id"
      };
    }

    return {
      ...base,
      status: "sent",
      source_message_id: sourceMessageId,
      reply_message_id: reply.id,
      message_update_status: messageUpdateStatus
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      message_update_status: "failed",
      reason:
        sanitizeDiscordAuditText(String(error)) ??
        "unknown Discord approval result reply error"
    };
  }
}

export function formatDiscordApprovalResultReply(input: {
  action: string;
  commandStatus: "completed" | "failed";
  commandId: string;
  error?: unknown;
}): string {
  const lines = [
    `Action: ${input.action}`,
    `Result: ${input.commandStatus}`,
    `Command: ${input.commandId}`
  ];
  if (input.commandStatus === "failed") {
    lines.push(
      `Reason: ${sanitizeDiscordAuditText(String(input.error ?? "command failed")) ?? "command failed"}`
    );
  }
  return lines.join("\n");
}

function approvalAction(command: CommandEnvelope["command"]): string {
  if (command.type === "approval.decide") {
    return command.decision;
  }
  if (command.type === "approval.snooze") {
    return "snooze";
  }
  if (command.type === "approval.confirmation.request") {
    return command.action;
  }
  return command.type;
}

function readDiscordMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("message_id" in value)) {
    return undefined;
  }
  const messageId = (value as { message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0
    ? messageId
    : undefined;
}

async function createDiscordRestApprovalChannel(
  gateway: PreparedDiscordGateway & { status: "ready" },
  channelId: string
): Promise<DiscordApprovalChannel> {
  const { REST, Routes } = await import("discord.js");
  const rest = new REST({ version: "10" }).setToken(gateway.bot_token);

  return {
    id: channelId,
    send: async (payload) => {
      const response = (await rest.post(Routes.channelMessages(channelId), {
        body: payload
      })) as { id?: unknown };
      return {
        id: typeof response.id === "string" ? response.id : undefined
      };
    },
    messages: {
      fetch: (messageId) => ({
        id: messageId,
        edit: (payload) =>
          rest.patch(Routes.channelMessage(channelId, messageId), {
            body: payload
          })
      })
    }
  };
}
