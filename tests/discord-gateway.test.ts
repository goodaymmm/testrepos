import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  prepareDiscordGateway,
  prepareDiscordGatewayFromConfig,
  type DiscordGatewayConfig
} from "../src/discord/gateway.js";
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
      idempotency_ttl_minutes: 30
    });
  });
});
