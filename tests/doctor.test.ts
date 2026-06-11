import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { formatDoctorResult, runDoctor } from "../src/diagnostics/doctor.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

const discordIds = {
  application: "111111111111111111",
  guild: "222222222222222222",
  channel: "333333333333333333",
  owner: "444444444444444444",
  teammate: "555555555555555555"
};

describe("runDoctor", () => {
  it("passes a healthy initialized project", async () => {
    const root = await createInitializedGitProject();
    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ error: 0, warning: 0 });
    expect(statusById(result, "git.repository")).toBe("pass");
    expect(statusById(result, "git.gitignore")).toBe("pass");
    expect(statusById(result, "cli.availability")).toBe("pass");
    expect(statusById(result, "env.api_keys")).toBe("pass");
    expect(statusById(result, "discord.config")).toBe("pass");
    expect(statusById(result, "runtime.recovery")).toBe("pass");
    expect(checkById(result, "discord.config")?.details).toContain(
      "live_status=setup_required"
    );
    expect(checkById(result, "config.agents")?.details).toContain(
      "antigravity(gemini): adapter=antigravity_cli, command=agy"
    );
    expect(checkById(result, "cli.availability")?.details).toContain(
      "antigravity(gemini): agy available=true"
    );
  });

  it("warns when migration or subscription-only environment cleanup is needed", async () => {
    const root = await createInitializedGitProject({ gitignore: false });
    await writeLegacyAgentsConfig(root);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { OPENAI_API_KEY: "redacted" }
    });

    expect(result.ok).toBe(true);
    expect(statusById(result, "git.gitignore")).toBe("warning");
    expect(statusById(result, "config.agents")).toBe("warning");
    expect(statusById(result, "env.api_keys")).toBe("warning");
    expect(checkById(result, "config.agents")?.nextAction).toBe("Run kairon migrate.");
  });

  it("errors when required CLIs or enabled Discord env vars are missing", async () => {
    const root = await createInitializedGitProject();
    const notifications = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "config", "notifications.json")
    );
    const providers = notifications.providers as Record<string, unknown>;
    const discord = providers.discord as Record<string, unknown>;
    discord.enabled = true;
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "config", "notifications.json"),
      notifications
    );

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async (command) => command !== "agy",
      env: {}
    });

    expect(result.ok).toBe(false);
    expect(statusById(result, "cli.availability")).toBe("error");
    expect(statusById(result, "discord.config")).toBe("error");
    expect(checkById(result, "discord.config")?.details).toContain(
      "live_status=setup_required"
    );
    expect(checkById(result, "cli.availability")?.nextAction).toContain(
      "antigravity(gemini):agy"
    );
  });

  it("reports Discord live readiness without leaking env values", async () => {
    const root = await createInitializedGitProject();
    await enableDiscordProvider(root);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {
        KAIRON_DISCORD_BOT_TOKEN: "secret-bot-token",
        KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
        KAIRON_DISCORD_GUILD_ID: discordIds.guild,
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
        KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
        KAIRON_DISCORD_ALLOWED_USER_IDS: `${discordIds.owner},${discordIds.teammate}`
      }
    });
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(true);
    expect(statusById(result, "discord.config")).toBe("pass");
    expect(checkById(result, "discord.config")?.details).toEqual(
      expect.arrayContaining([
        "gateway_status=ready",
        "live_status=ready",
        "live_missing_env=none",
        "gateway_invalid_env=none",
        "live_invalid_env=none",
        "KAIRON_DISCORD_BOT_TOKEN=present",
        "KAIRON_DISCORD_ALLOWED_USER_IDS=present"
      ])
    );
    expect(text).not.toContain("secret-bot-token");
    expect(text).not.toContain(discordIds.channel);
    expect(text).not.toContain(`${discordIds.owner},${discordIds.teammate}`);
  });

  it("warns when Discord gateway env is ready but live approval env is incomplete", async () => {
    const root = await createInitializedGitProject();
    await enableDiscordProvider(root);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {
        KAIRON_DISCORD_BOT_TOKEN: "secret-bot-token",
        KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
        KAIRON_DISCORD_GUILD_ID: discordIds.guild,
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
        KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner
      }
    });

    expect(result.ok).toBe(true);
    expect(statusById(result, "discord.config")).toBe("warning");
    expect(checkById(result, "discord.config")?.details).toContain(
      "gateway_status=ready"
    );
    expect(checkById(result, "discord.config")?.details).toContain(
      "live_status=setup_required"
    );
    expect(checkById(result, "discord.config")?.details).toContain(
      "live_missing_env=KAIRON_DISCORD_ALLOWED_USER_IDS"
    );
  });

  it("reports invalid Discord id env without leaking values", async () => {
    const root = await createInitializedGitProject();
    await enableDiscordProvider(root);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {
        KAIRON_DISCORD_BOT_TOKEN: "secret-bot-token",
        KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
        KAIRON_DISCORD_GUILD_ID: "not-a-snowflake",
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
        KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
        KAIRON_DISCORD_ALLOWED_USER_IDS: `${discordIds.owner},invalid-user`
      }
    });
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(false);
    expect(statusById(result, "discord.config")).toBe("error");
    expect(checkById(result, "discord.config")?.details).toEqual(
      expect.arrayContaining([
        "gateway_status=setup_required",
        "live_status=setup_required",
        "gateway_invalid_env=KAIRON_DISCORD_GUILD_ID",
        "live_invalid_env=KAIRON_DISCORD_GUILD_ID,KAIRON_DISCORD_ALLOWED_USER_IDS"
      ])
    );
    expect(checkById(result, "discord.config")?.nextAction).toBe(
      "Fix invalid Discord gateway env vars: KAIRON_DISCORD_GUILD_ID."
    );
    expect(text).not.toContain("not-a-snowflake");
    expect(text).not.toContain("invalid-user");
    expect(text).not.toContain("secret-bot-token");
  });

  it("warns but does not fail when GitHub branch protection cannot be verified or config backups exist", async () => {
    const root = await createInitializedGitProject();
    await writeFile(
      path.join(root, ".git", "config"),
      [
        '[remote "origin"]',
        "  url = https://github.com/goodaymmm/Kairon.git",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, ".kairon", "config", "project.json.bak-20260601010101"),
      "{}\n",
      "utf8"
    );

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });

    expect(result.ok).toBe(true);
    expect(statusById(result, "git.branch_protection")).toBe("warning");
    expect(statusById(result, "config.backups")).toBe("warning");
    expect(checkById(result, "git.branch_protection")?.details).toContain(
      "auth=missing"
    );
    expect(checkById(result, "config.backups")?.details).toContain(
      "backup=.kairon/config/project.json.bak-20260601010101"
    );
  });

  it("warns when runtime recovery targets are present", async () => {
    const root = await createInitializedGitProject();
    await writeJsonFileAtomic(path.join(root, ".kairon", "runtime", "lock.json"), {
      owner: "kairon-runtime",
      pid: -1,
      created_at: "2026-06-01T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      mode: "daemon",
      heartbeat_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z"
    });

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });

    expect(result.ok).toBe(true);
    expect(statusById(result, "runtime.recovery")).toBe("warning");
    expect(checkById(result, "runtime.recovery")?.details).toContain("targets=1");
    expect(checkById(result, "runtime.recovery")?.details).toContain("stale_locks=1");
    expect(checkById(result, "runtime.recovery")?.nextAction).toBe(
      "Run kairon recovery run and review any generated approval requests."
    );
  });

  it("formats doctor output with summary, checks, and next actions", async () => {
    const root = await createInitializedGitProject({ gitignore: false });
    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const text = formatDoctorResult(result);

    expect(text).toContain("doctor.ok=true");
    expect(text).toContain("WARNING git.gitignore .gitignore");
    expect(text).toContain("next=Create .gitignore and add .kairon/.");
  });
});

type DoctorResult = Awaited<ReturnType<typeof runDoctor>>;

async function createInitializedGitProject(
  options: { gitignore?: boolean } = {}
): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await mkdir(path.join(root, ".git"));

  if (options.gitignore !== false) {
    await writeFile(path.join(root, ".gitignore"), ".kairon/\n", "utf8");
  }

  return root;
}

async function writeLegacyAgentsConfig(root: string): Promise<void> {
  const agentsPath = path.join(root, ".kairon", "config", "agents.json");
  const agents = await readJsonFile<Record<string, unknown>>(agentsPath);
  const agentMap = agents.agents as Record<string, unknown>;
  const gemini = agentMap.gemini as Record<string, unknown>;
  gemini.adapter = "gemini_cli";
  gemini.command = "gemini";
  await writeJsonFileAtomic(agentsPath, agents);
}

async function enableDiscordProvider(root: string): Promise<void> {
  const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
  const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
  const providers = notifications.providers as Record<string, unknown>;
  const discord = providers.discord as Record<string, unknown>;
  discord.enabled = true;
  await writeJsonFileAtomic(notificationsPath, notifications);
}

function checkById(result: DoctorResult, id: string) {
  return result.checks.find((check) => check.id === id);
}

function statusById(result: DoctorResult, id: string) {
  return checkById(result, id)?.status;
}
