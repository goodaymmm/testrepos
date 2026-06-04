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
