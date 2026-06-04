import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  buildKaironSlashCommands,
  prepareDiscordGateway,
  prepareDiscordGatewayFromConfig,
  startDiscordGateway,
  type DiscordGatewayClient,
  type DiscordGatewayConfig,
  type DiscordGatewayInteraction,
  type DiscordRestRegistration
} from "../src/discord/gateway.js";
import type { DiscordApprovalChannel } from "../src/discord/approval-notifier.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { createTempProject } from "./test-utils.js";

const enabledConfig: DiscordGatewayConfig = {
  schema_version: "0.1",
  primary_provider: "discord",
  providers: {
    discord: {
      enabled: true,
      mode: "gateway",
      bot_token_env: "BOT",
      application_id_env: "APP",
      guild_id_env: "GUILD",
      approval_channel_id_env: "CHANNEL",
      owner_user_id_env: "OWNER",
      allowed_user_ids_env: "ALLOWED",
      use_dm: false,
      register_commands_on_start: true
    }
  },
  gateway: {
    ack_timeout_ms: 2500,
    idempotency_ttl_minutes: 30
  }
};

describe("prepareDiscordGateway", () => {
  it("starts disabled when provider is disabled", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(prepareDiscordGateway(root, {})).resolves.toMatchObject({
      status: "disabled",
      reason: "discord provider is disabled"
    });
  });

  it("starts disabled when enabled provider has missing env", () => {
    expect(prepareDiscordGatewayFromConfig(enabledConfig, { BOT: "x" })).toMatchObject({
      status: "disabled",
      missing_env: ["APP", "GUILD", "CHANNEL", "OWNER"]
    });
  });

  it("is ready when enabled provider has required env", () => {
    expect(
      prepareDiscordGatewayFromConfig(enabledConfig, {
        BOT: "token",
        APP: "app",
        GUILD: "guild",
        CHANNEL: "channel",
        OWNER: "owner",
        ALLOWED: "owner,teammate"
      })
    ).toMatchObject({
      status: "ready",
      mode: "gateway",
      allowed_user_ids: ["owner", "teammate"],
      idempotency_ttl_minutes: 30,
      reconnect: {
        enabled: true,
        max_backoff_seconds: 60
      }
    });
  });

  it("writes a disabled runtime artifact when env is incomplete", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
    const notifications = await readJsonFile<DiscordGatewayConfig>(notificationsPath);
    notifications.providers.discord.enabled = true;
    await writeJsonFileAtomic(notificationsPath, notifications);

    const handle = await startDiscordGateway(root, {
      env: { KAIRON_DISCORD_BOT_TOKEN: "token" }
    });

    expect(handle.status).toBe("disabled");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      status: "disabled",
      reason: "discord provider env is incomplete"
    });
  });

  it("registers slash commands, records ready, and supports shutdown", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();

    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      readyTimeoutMs: 50
    });
    await client.waitForLogin();
    client.emitReady();
    const handle = await handlePromise;

    expect(handle.status).toBe("ready");
    expect(rest.puts[0]).toMatchObject({
      route: "/applications/app/guilds/guild/commands",
      body: buildKaironSlashCommands()
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      status: "ready",
      client_user_id: "bot-user",
      commands_registered: true
    });

    await handle.stop();
    expect(client.destroyed).toBe(true);
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      status: "stopped"
    });
  });

  it("defers slash command interactions and enqueues them through Command Inbox", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();

    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      readyTimeoutMs: 50,
      now: () => new Date("2026-05-25T08:00:00.000Z")
    });
    await client.waitForLogin();
    client.emitReady();
    const handle = await handlePromise;
    const interaction = new FakeSlashInteraction("status-1", "status");

    await client.emitInteraction(interaction);

    expect(interaction.deferredOptions).toEqual({ ephemeral: true });
    expect(interaction.editedReply).toContain("Kairon command queued");
    await expect(new CommandInbox(root).list("queued")).resolves.toMatchObject([
      {
        command: {
          type: "runtime.status",
          source: "discord"
        }
      }
    ]);
    await handle.stop();
  });

  it("sends pending approval messages and stores discord metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      title: "Push approval",
      type: "git_push",
      actions: ["approve", "reject", "request_changes", "snooze"],
      diff: "diff --git should not be sent"
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FakeApprovalChannel("channel");

    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      approvalChannelFactory: () => channel,
      readyTimeoutMs: 50,
      now: () => new Date("2026-05-25T08:00:00.000Z")
    });
    await client.waitForLogin();
    client.emitReady();
    const handle = await handlePromise;

    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(channel.sent[0]?.payload)).not.toContain("diff --git");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      discord_nonce: expect.stringMatching(/^n/),
      discord: {
        channel_id: "channel",
        message_id: "message-1",
        unsafe_fields_omitted: true
      }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      approval_notifications: {
        sent: 1,
        failed: 0
      }
    });

    await handle.stop();
  });

  it("opens reason modals for reject and request_changes buttons", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      discord_nonce: "n42",
      actions: ["reject"]
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FakeApprovalChannel("channel");

    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      approvalChannelFactory: () => channel,
      readyTimeoutMs: 50
    });
    await client.waitForLogin();
    client.emitReady();
    const handle = await handlePromise;
    const interaction = new FakeButtonInteraction(
      "reject-button-1",
      "kr:v1:apr:APR-0001:reject_modal:n42"
    );

    await client.emitInteraction(interaction);

    expect(interaction.deferredOptions).toBeUndefined();
    expect(interaction.modal).toMatchObject({
      custom_id: "kr:v1:apr:APR-0001:reject:n42",
      title: "Reject approval"
    });
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(0);

    await handle.stop();
  });

  it("applies approval modal decisions and updates the discord message", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      title: "Push approval",
      type: "git_push",
      discord_nonce: "n42",
      actions: ["reject"],
      discord: {
        channel_id: "channel",
        message_id: "message-1",
        nonce: "n42"
      }
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FakeApprovalChannel("channel");
    channel.addMessage("message-1");

    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      approvalChannelFactory: () => channel,
      readyTimeoutMs: 50,
      now: () => new Date("2026-05-25T08:00:00.000Z")
    });
    await client.waitForLogin();
    client.emitReady();
    const handle = await handlePromise;
    const interaction = new FakeModalSubmitInteraction(
      "reject-submit-1",
      "kr:v1:apr:APR-0001:reject:n42",
      "Blocked by operation policy."
    );

    await client.emitInteraction(interaction);

    expect(interaction.deferredOptions).toEqual({ ephemeral: true });
    expect(interaction.editedReply).toBe("Kairon approval decided: APR-0001");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "decided",
      decision: "reject",
      reason: "Blocked by operation policy."
    });
    await expect(new CommandInbox(root).list("completed")).resolves.toMatchObject([
      {
        command: {
          type: "approval.decide",
          approval_id: "APR-0001",
          decision: "reject"
        }
      }
    ]);
    expect(channel.messagesById.get("message-1")?.editedPayload).toMatchObject({
      content: "Approval decided: APR-0001"
    });

    await handle.stop();
  });
});

function readyEnv(): NodeJS.ProcessEnv {
  return {
    KAIRON_DISCORD_BOT_TOKEN: "token",
    KAIRON_DISCORD_APPLICATION_ID: "app",
    KAIRON_DISCORD_GUILD_ID: "guild",
    KAIRON_DISCORD_APPROVAL_CHANNEL_ID: "channel",
    KAIRON_DISCORD_OWNER_USER_ID: "owner",
    KAIRON_DISCORD_ALLOWED_USER_IDS: "owner"
  };
}

async function enableDiscordProvider(root: string): Promise<void> {
  const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
  const notifications = await readJsonFile<DiscordGatewayConfig>(notificationsPath);
  notifications.providers.discord.enabled = true;
  await writeJsonFileAtomic(notificationsPath, notifications);
}

class FakeDiscordClient implements DiscordGatewayClient {
  user: { id: string };
  destroyed = false;
  private readonly onceHandlers = new Map<string, Array<() => unknown>>();
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  private loginResolver: (() => void) | undefined;
  private readonly loginStarted: Promise<void>;

  constructor(userId: string) {
    this.user = { id: userId };
    this.loginStarted = new Promise((resolve) => {
      this.loginResolver = resolve;
    });
  }

  once(event: string, callback: () => unknown): unknown {
    const handlers = this.onceHandlers.get(event) ?? [];
    handlers.push(callback);
    this.onceHandlers.set(event, handlers);
    return undefined;
  }

  on(event: string, callback: (...args: unknown[]) => unknown): unknown {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(callback);
    this.handlers.set(event, handlers);
    return undefined;
  }

  async login(): Promise<void> {
    this.loginResolver?.();
  }

  async waitForLogin(): Promise<void> {
    await this.loginStarted;
  }

  emitReady(): void {
    const handlers = [
      ...(this.onceHandlers.get("clientReady") ?? []),
      ...(this.onceHandlers.get("ready") ?? [])
    ];
    this.onceHandlers.delete("clientReady");
    this.onceHandlers.delete("ready");
    for (const handler of handlers) {
      handler();
    }
  }

  async emitInteraction(interaction: DiscordGatewayInteraction): Promise<void> {
    const handlers = this.handlers.get("interactionCreate") ?? [];
    await Promise.all(handlers.map((handler) => handler(interaction)));
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class FakeDiscordRestRegistration implements DiscordRestRegistration {
  route = "/applications/app/guilds/guild/commands";
  rest = {
    put: async (route: string, options: { body: unknown }) => {
      this.puts.push({ route, body: options.body });
    }
  };
  puts: Array<{ route: string; body: unknown }> = [];
}

class FakeSlashInteraction implements DiscordGatewayInteraction {
  user = { id: "owner" };
  guildId = "guild";
  channelId = "channel";
  commandName = "kairon";
  deferredOptions: { ephemeral: boolean } | undefined;
  editedReply: string | undefined;
  options: DiscordGatewayInteraction["options"];

  constructor(
    readonly id: string,
    subcommand: string
  ) {
    this.options = {
      getSubcommand: () => subcommand
    };
  }

  isChatInputCommand(): boolean {
    return true;
  }

  async deferReply(options: { ephemeral: boolean }): Promise<void> {
    this.deferredOptions = options;
  }

  async editReply(options: { content: string }): Promise<void> {
    this.editedReply = options.content;
  }
}

class FakeButtonInteraction implements DiscordGatewayInteraction {
  user = { id: "owner" };
  guildId = "guild";
  channelId = "channel";
  message = { id: "message-1" };
  deferredOptions: { ephemeral: boolean } | undefined;
  modal: unknown;
  replyContent: string | undefined;

  constructor(
    readonly id: string,
    readonly customId: string
  ) {}

  async deferReply(options: { ephemeral: boolean }): Promise<void> {
    this.deferredOptions = options;
  }

  async showModal(modal: unknown): Promise<void> {
    this.modal = modal;
  }

  async reply(options: { content: string; ephemeral: boolean }): Promise<void> {
    this.replyContent = options.content;
  }
}

class FakeModalSubmitInteraction implements DiscordGatewayInteraction {
  user = { id: "owner" };
  guildId = "guild";
  channelId = "channel";
  message = { id: "message-1" };
  deferredOptions: { ephemeral: boolean } | undefined;
  editedReply: string | undefined;
  fields: DiscordGatewayInteraction["fields"];

  constructor(
    readonly id: string,
    readonly customId: string,
    reason: string
  ) {
    this.fields = {
      getTextInputValue: (customId) => (customId === "reason" ? reason : "")
    };
  }

  async deferReply(options: { ephemeral: boolean }): Promise<void> {
    this.deferredOptions = options;
  }

  async editReply(options: { content: string }): Promise<void> {
    this.editedReply = options.content;
  }
}

class FakeApprovalChannel implements DiscordApprovalChannel {
  sent: Array<{ id: string; payload: unknown }> = [];
  messagesById = new Map<string, FakeApprovalMessage>();
  messages = {
    fetch: async (messageId: string) => {
      const message = this.messagesById.get(messageId);
      if (message === undefined) {
        throw new Error(`Message not found: ${messageId}`);
      }

      return message;
    }
  };

  constructor(readonly id: string) {}

  async send(payload: unknown): Promise<FakeApprovalMessage> {
    const id = `message-${this.sent.length + 1}`;
    this.sent.push({ id, payload });
    return this.addMessage(id);
  }

  addMessage(id: string): FakeApprovalMessage {
    const message = new FakeApprovalMessage(id);
    this.messagesById.set(id, message);
    return message;
  }
}

class FakeApprovalMessage {
  editedPayload: unknown;

  constructor(readonly id: string) {}

  async edit(payload: unknown): Promise<void> {
    this.editedPayload = payload;
  }
}

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
