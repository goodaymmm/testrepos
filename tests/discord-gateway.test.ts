import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
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

const discordIds = {
  application: "111111111111111111",
  guild: "222222222222222222",
  channel: "333333333333333333",
  owner: "444444444444444444",
  teammate: "555555555555555555"
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
        APP: discordIds.application,
        GUILD: discordIds.guild,
        CHANNEL: discordIds.channel,
        OWNER: discordIds.owner,
        ALLOWED: `${discordIds.owner},${discordIds.teammate}`
      })
    ).toMatchObject({
      status: "ready",
      mode: "gateway",
      allowed_user_ids: [discordIds.owner, discordIds.teammate],
      idempotency_ttl_minutes: 30,
      reconnect: {
        enabled: true,
        max_backoff_seconds: 60
      }
    });
  });

  it("starts disabled when enabled provider has invalid Discord id env", () => {
    expect(
      prepareDiscordGatewayFromConfig(enabledConfig, {
        BOT: "token",
        APP: discordIds.application,
        GUILD: "not-a-snowflake",
        CHANNEL: discordIds.channel,
        OWNER: discordIds.owner,
        ALLOWED: `${discordIds.owner},not-a-snowflake`
      })
    ).toMatchObject({
      status: "disabled",
      reason: "discord provider env is invalid",
      missing_env: [],
      invalid_env: ["GUILD", "ALLOWED"]
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

  it("writes a disabled runtime artifact and does not create a client when env is invalid", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    let clientCreated = false;

    const handle = await startDiscordGateway(root, {
      env: {
        KAIRON_DISCORD_BOT_TOKEN: "token",
        KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
        KAIRON_DISCORD_GUILD_ID: "not-a-snowflake",
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
        KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
        KAIRON_DISCORD_ALLOWED_USER_IDS: discordIds.owner
      },
      clientFactory: () => {
        clientCreated = true;
        return new FakeDiscordClient("bot-user");
      }
    });

    expect(handle.status).toBe("disabled");
    expect(clientCreated).toBe(false);
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      status: "disabled",
      reason: "discord provider env is invalid",
      invalid_env: ["KAIRON_DISCORD_GUILD_ID"]
    });
  });

  it("records setup guidance when slash command registration is missing access", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    const client = new FakeDiscordClient("bot-user");
    const error = fakeDiscordApiError({
      code: 50001,
      status: 403,
      message: "Missing Access"
    });

    const handle = await startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => failingRestRegistration(error),
      readyTimeoutMs: 50
    });

    expect(handle).toMatchObject({
      status: "setup_required",
      reason: "discord_missing_access_register_commands"
    });
    expect(client.destroyed).toBe(true);
    const gateway = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "gateway.json")
    );
    expect(gateway).toMatchObject({
      status: "setup_required",
      error_code: "discord_missing_access_register_commands",
      operation: "register_commands",
      commands_registered: false,
      discord_error_code: "50001",
      http_status: 403
    });
    expect(String(gateway.error)).toContain("registering slash commands");
    expect(JSON.stringify(gateway)).not.toContain("DiscordAPIError");
  });

  it("records setup guidance when Discord rejects command registration form", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    const client = new FakeDiscordClient("bot-user");

    const handle = await startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () =>
        failingRestRegistration(
          fakeDiscordApiError({
            code: 50035,
            status: 400,
            message: "Invalid Form Body"
          })
        ),
      readyTimeoutMs: 50
    });

    expect(handle).toMatchObject({
      status: "setup_required",
      reason: "discord_invalid_form_body"
    });
    const gateway = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "gateway.json")
    );
    expect(gateway).toMatchObject({
      status: "setup_required",
      error_code: "discord_invalid_form_body",
      operation: "register_commands",
      commands_registered: false,
      discord_error_code: "50035",
      http_status: 400
    });
  });

  it("records setup guidance when approval channel access is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const handlePromise = startDiscordGateway(root, {
      env: readyEnv(),
      clientFactory: () => client,
      restFactory: () => rest,
      approvalChannelFactory: () => {
        throw fakeDiscordApiError({
          code: 50001,
          status: 403,
          message: "Missing Access"
        });
      },
      readyTimeoutMs: 50
    });
    await client.waitForLogin();
    expect(client.onceEventNames()).toContain("clientReady");
    expect(client.onceEventNames()).not.toContain("ready");
    client.emitReady();
    const handle = await handlePromise;

    expect(handle).toMatchObject({
      status: "setup_required",
      reason: "discord_missing_access_approval_channel"
    });
    expect(client.destroyed).toBe(true);
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      status: "setup_required",
      error_code: "discord_missing_access_approval_channel",
      operation: "resolve_approval_channel",
      commands_registered: true,
      discord_error_code: "50001",
      http_status: 403
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
      route: rest.route,
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
        channel_id: discordIds.channel,
        message_id: "message-1",
        unsafe_fields_omitted: true
      }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      approval_notifications: {
        sent: 1,
        failed: 0,
        audit_path: ".kairon/runtime/discord/approval-notifications.jsonl"
      }
    });
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        approval_id: "APR-0001",
        status: "sent",
        channel_id: discordIds.channel,
        message_id: "message-1",
        sent_at: "2026-05-25T08:00:00.000Z"
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain("diff --git");

    await handle.stop();
  });

  it("reposts pending approval messages when the stored Discord message is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-REPOST",
      status: "pending",
      title: "Repost approval",
      type: "manual_test",
      actions: ["approve", "reject"],
      discord: {
        channel_id: discordIds.channel,
        message_id: "message-missing",
        nonce: "n-old"
      }
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
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-REPOST.json"))
    ).resolves.toMatchObject({
      discord: {
        channel_id: discordIds.channel,
        message_id: "message-1"
      }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      approval_notifications: {
        sent: 0,
        resent: 1,
        failed: 0
      }
    });
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        approval_id: "APR-REPOST",
        status: "resent",
        message_id: "message-1",
        reason: "message_missing_reposted"
      })
    ]);

    await handle.stop();
  });

  it("retries status updates for decided approval messages during notification scans", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-DECIDED",
      status: "decided",
      decision: "approve",
      title: "Decided approval",
      type: "manual_test",
      discord: {
        channel_id: discordIds.channel,
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

    expect(channel.sent).toHaveLength(0);
    expect(channel.messagesById.get("message-1")?.editedPayload).toMatchObject({
      content: "Approval decided: APR-DECIDED",
      components: []
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-DECIDED.json"))
    ).resolves.toMatchObject({
      discord: {
        updated_at: "2026-05-25T08:00:00.000Z"
      }
    });
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        approval_id: "APR-DECIDED",
        status: "updated",
        message_id: "message-1",
        reason: "status_reconciled"
      })
    ]);

    await handle.stop();
  });

  it("audits failed status reconcile attempts without unsafe fields", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-RECONCILE-FAIL",
      status: "decided",
      decision: "reject",
      title: "token=SHOULD_NOT_LEAK",
      type: "manual_test",
      discord: {
        channel_id: discordIds.channel,
        message_id: "message-1",
        nonce: "n42"
      }
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FailingFetchApprovalChannel(
      "channel",
      "Missing Access token=SHOULD_NOT_LEAK"
    );

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

    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      approval_notifications: {
        failed: 1,
        failures: [
          {
            approval_id: "APR-RECONCILE-FAIL",
            reason: "Error: Missing Access token=[redacted]"
          }
        ]
      }
    });
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        approval_id: "APR-RECONCILE-FAIL",
        status: "failed",
        message_id: "message-1",
        reason: "Error: Missing Access token=[redacted]"
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain("SHOULD_NOT_LEAK");

    await handle.stop();
  });

  it("audits skipped and failed approval notifications without unsafe fields", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-SKIP-DONE",
      status: "decided",
      decision: "approve"
    });
    await writeApproval(root, {
      id: "APR-SKIP-SENT",
      status: "pending",
      discord: {
        channel_id: discordIds.channel,
        message_id: "message-existing"
      }
    });
    await writeApproval(root, {
      id: "APR-FAIL",
      status: "pending",
      title: "API_TOKEN=SHOULD_NOT_LEAK",
      diff: "diff --git should not be audited",
      stdout: "password=SHOULD_NOT_LEAK"
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FailingApprovalChannel("send failed: token=SHOULD_NOT_LEAK");

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

    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "discord", "gateway.json"))
    ).resolves.toMatchObject({
      approval_notifications: {
        scanned: 3,
        sent: 0,
        skipped: 2,
        failed: 1,
        audit_path: ".kairon/runtime/discord/approval-notifications.jsonl",
        failures: [
          {
            approval_id: "APR-FAIL",
            reason: "Error: send failed: token=[redacted]"
          }
        ]
      }
    });
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl")
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approval_id: "APR-SKIP-DONE",
          status: "skipped",
          reason: "not_pending"
        }),
        expect.objectContaining({
          approval_id: "APR-SKIP-SENT",
          status: "skipped",
          reason: "already_sent"
        }),
        expect.objectContaining({
          approval_id: "APR-FAIL",
          status: "failed",
          reason: "Error: send failed: token=[redacted]"
        })
      ])
    );
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain("SHOULD_NOT_LEAK");
    expect(auditText).not.toContain("diff --git");
    expect(auditText).not.toContain("password=");

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
        channel_id: discordIds.channel,
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
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "decision-interactions.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        interaction_id: "reject-submit-1",
        approval_id: "APR-0001",
        decision: "reject",
        status: "applied",
        duplicate: false,
        command_status: "completed",
        message_update_status: "updated",
        message_id: "message-1",
        decision_reason: "Blocked by operation policy."
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain(discordIds.owner);

    await handle.stop();
  });

  it("audits duplicate approval interactions without applying twice", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      title: "Push approval",
      type: "git_push",
      discord_nonce: "n42",
      actions: ["approve"],
      discord: {
        channel_id: discordIds.channel,
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
    const interaction = new FakeButtonInteraction(
      "approve-button-1",
      "kr:v1:apr:APR-0001:approve:n42"
    );

    await client.emitInteraction(interaction);
    await client.emitInteraction(interaction);

    await expect(new CommandInbox(root).list("completed")).resolves.toHaveLength(1);
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "decision-interactions.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        interaction_id: "approve-button-1",
        approval_id: "APR-0001",
        decision: "approve",
        status: "applied",
        duplicate: false,
        command_status: "completed",
        message_update_status: "updated"
      }),
      expect.objectContaining({
        interaction_id: "approve-button-1",
        approval_id: "APR-0001",
        decision: "approve",
        status: "skipped",
        duplicate: true,
        reason: "duplicate_interaction"
      })
    ]);

    await handle.stop();
  });

  it("audits message update failures without failing the canonical decision", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableDiscordProvider(root);
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      title: "Push approval",
      type: "git_push",
      discord_nonce: "n42",
      actions: ["request_changes"],
      discord: {
        channel_id: discordIds.channel,
        message_id: "message-1",
        nonce: "n42"
      }
    });
    const client = new FakeDiscordClient("bot-user");
    const rest = new FakeDiscordRestRegistration();
    const channel = new FakeApprovalChannel("channel");
    channel.addMessage("message-1", "edit failed: token=SHOULD_NOT_LEAK");

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
      "changes-submit-1",
      "kr:v1:apr:APR-0001:changes:n42",
      "Add tests before merge. token=SHOULD_NOT_LEAK"
    );

    await client.emitInteraction(interaction);

    expect(interaction.editedReply).toBe("Kairon approval decided: APR-0001");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "decided",
      decision: "request_changes"
    });
    await expect(new CommandInbox(root).list("completed")).resolves.toHaveLength(1);
    await expect(new CommandInbox(root).list("failed")).resolves.toHaveLength(0);
    const audit = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "discord", "decision-interactions.jsonl")
    );
    expect(audit).toEqual([
      expect.objectContaining({
        interaction_id: "changes-submit-1",
        approval_id: "APR-0001",
        decision: "request_changes",
        status: "applied",
        command_status: "completed",
        message_update_status: "failed",
        decision_reason: "Add tests before merge. token=[redacted]"
      })
    ]);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain("SHOULD_NOT_LEAK");
    expect(auditText).not.toContain(discordIds.owner);

    await handle.stop();
  });
});

function readyEnv(): NodeJS.ProcessEnv {
  return {
    KAIRON_DISCORD_BOT_TOKEN: "token",
    KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
    KAIRON_DISCORD_GUILD_ID: discordIds.guild,
    KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
    KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
    KAIRON_DISCORD_ALLOWED_USER_IDS: discordIds.owner
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
    const handlers = [...(this.onceHandlers.get("clientReady") ?? [])];
    this.onceHandlers.delete("clientReady");
    for (const handler of handlers) {
      handler();
    }
  }

  onceEventNames(): string[] {
    return [...this.onceHandlers.keys()];
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
  route = `/applications/${discordIds.application}/guilds/${discordIds.guild}/commands`;
  rest = {
    put: async (route: string, options: { body: unknown }) => {
      this.puts.push({ route, body: options.body });
    }
  };
  puts: Array<{ route: string; body: unknown }> = [];
}

function failingRestRegistration(error: unknown): DiscordRestRegistration {
  return {
    route: `/applications/${discordIds.application}/guilds/${discordIds.guild}/commands`,
    rest: {
      put: async () => {
        throw error;
      }
    }
  };
}

function fakeDiscordApiError(input: {
  code: number;
  status: number;
  message: string;
}): Error & { code: number; status: number; rawError: { message: string } } {
  const error = new Error(input.message) as Error & {
    code: number;
    status: number;
    rawError: { message: string };
  };
  error.name = "DiscordAPIError";
  error.code = input.code;
  error.status = input.status;
  error.rawError = { message: input.message };
  return error;
}

class FakeSlashInteraction implements DiscordGatewayInteraction {
  user = { id: discordIds.owner };
  guildId = discordIds.guild;
  channelId = discordIds.channel;
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
  user = { id: discordIds.owner };
  guildId = discordIds.guild;
  channelId = discordIds.channel;
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
  user = { id: discordIds.owner };
  guildId = discordIds.guild;
  channelId = discordIds.channel;
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

  addMessage(id: string, editError?: string): FakeApprovalMessage {
    const message = new FakeApprovalMessage(id, editError);
    this.messagesById.set(id, message);
    return message;
  }
}

class FailingApprovalChannel implements DiscordApprovalChannel {
  constructor(readonly reason: string) {}

  async send(): Promise<FakeApprovalMessage> {
    throw new Error(this.reason);
  }
}

class FailingFetchApprovalChannel implements DiscordApprovalChannel {
  sent: Array<{ id: string; payload: unknown }> = [];
  messages = {
    fetch: async () => {
      throw new Error(this.reason);
    }
  };

  constructor(
    readonly id: string,
    readonly reason: string
  ) {}

  async send(payload: unknown): Promise<FakeApprovalMessage> {
    const id = `message-${this.sent.length + 1}`;
    this.sent.push({ id, payload });
    return new FakeApprovalMessage(id);
  }
}

class FakeApprovalMessage {
  editedPayload: unknown;

  constructor(
    readonly id: string,
    readonly editError?: string
  ) {}

  async edit(payload: unknown): Promise<void> {
    if (this.editError !== undefined) {
      throw new Error(this.editError);
    }

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
