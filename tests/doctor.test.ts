import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  formatDoctorResult,
  runDoctor,
  type GitHubBranchProtectionClient
} from "../src/diagnostics/doctor.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createDefaultSecretResolver } from "../src/core/secrets/secret-resolver.js";
import { exportBoardProjection } from "../src/board/projection.js";
import { issuePersistentBoardAccess } from "../src/board/access-token.js";
import { trackCorrelationMember } from "../src/correlation/store.js";
import { buildRagIndex, type RagIndex } from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";
import { suspendProvider } from "../src/agents/provider-policy.js";
import { runWatchdogCheck } from "../src/runtime/watchdog.js";

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
    expect(statusById(result, "agent.provider_policy")).toBe("pass");
    expect(statusById(result, "env.api_keys")).toBe("pass");
    expect(statusById(result, "discord.config")).toBe("pass");
    expect(statusById(result, "workflow.config")).toBe("pass");
    expect(statusById(result, "board.secret_scan")).toBe("pass");
    expect(statusById(result, "runtime.recovery")).toBe("pass");
    expect(statusById(result, "watchdog.alerts")).toBe("pass");
    expect(checkById(result, "discord.config")?.details).toContain(
      "live_status=not_configured"
    );
    expect(checkById(result, "config.agents")?.details).toContain(
      "antigravity(gemini): adapter=antigravity_cli, command=agy"
    );
    expect(checkById(result, "cli.availability")?.details).toContain(
      "antigravity(gemini): agy available=true"
    );
  });

  it("warns when a provider is suspended without exposing sensitive values", async () => {
    const root = await createInitializedGitProject();
    await suspendProvider(root, {
      agent: "codex",
      reason: "authentication token=SHOULD_NOT_LEAK",
      now: new Date("2026-07-16T07:00:00.000Z")
    });
    await runWatchdogCheck(root, {
      now: new Date("2026-07-16T07:00:01.000Z")
    });

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const text = formatDoctorResult(result);

    expect(statusById(result, "agent.provider_policy")).toBe("warning");
    expect(statusById(result, "watchdog.alerts")).toBe("warning");
    expect(text).toContain("status=suspended");
    expect(text).not.toContain("SHOULD_NOT_LEAK");
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
    expect(checkById(result, "config.agents")?.next_action).toBe("Run kairon migrate.");
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
    expect(checkById(result, "cli.availability")?.next_action).toContain(
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

  it("reports Discord readiness from configured Windows credentials without leaking values", async () => {
    const root = await createInitializedGitProject();
    await enableDiscordProvider(root);
    const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
    const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
    const providers = notifications.providers as Record<string, unknown>;
    const discord = providers.discord as Record<string, unknown>;
    discord.secrets = {
      bot_token: {
        provider: "windows_credential",
        target: "Kairon/Discord/BotToken"
      }
    };
    await writeJsonFileAtomic(notificationsPath, notifications);
    const env = {
      KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
      KAIRON_DISCORD_GUILD_ID: discordIds.guild,
      KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
      KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
      KAIRON_DISCORD_ALLOWED_USER_IDS: discordIds.teammate
    };
    const secretResolver = createDefaultSecretResolver({
      env,
      platform: "win32",
      windowsCredentialReader: async (target) =>
        target === "Kairon/Discord/BotToken" ? "secret-bot-token" : undefined
    });

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env,
      secretResolver
    });
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(true);
    expect(statusById(result, "discord.config")).toBe("pass");
    expect(checkById(result, "discord.config")?.details).toEqual(
      expect.arrayContaining([
        "KAIRON_DISCORD_BOT_TOKEN=present",
        "KAIRON_DISCORD_BOT_TOKEN_provider=windows_credential",
        "KAIRON_DISCORD_APPLICATION_ID_provider=env"
      ])
    );
    expect(text).not.toContain("secret-bot-token");
    expect(text).not.toContain(discordIds.channel);
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

  it("reports reverse-proxy HTTP setup requirements without exposing the public key", async () => {
    const root = await createInitializedGitProject();
    await enableDiscordProvider(root);
    const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
    const notifications = await readJsonFile<Record<string, unknown>>(notificationsPath);
    notifications.http = {
      profile: "reverse-proxy",
      external_base_url: "https://discord.example.test/",
      trusted_proxies: ["127.0.0.1/32"]
    };
    await writeJsonFileAtomic(notificationsPath, notifications);
    const env = {
      KAIRON_DISCORD_BOT_TOKEN: "secret-bot-token",
      KAIRON_DISCORD_APPLICATION_ID: discordIds.application,
      KAIRON_DISCORD_GUILD_ID: discordIds.guild,
      KAIRON_DISCORD_APPROVAL_CHANNEL_ID: discordIds.channel,
      KAIRON_DISCORD_OWNER_USER_ID: discordIds.owner,
      KAIRON_DISCORD_ALLOWED_USER_IDS: discordIds.teammate
    };

    const missing = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env
    });
    expect(statusById(missing, "discord.config")).toBe("warning");
    expect(checkById(missing, "discord.config")?.details).toEqual(
      expect.arrayContaining([
        "http_profile=reverse-proxy",
        "http_status=setup_required",
        "http_missing=KAIRON_DISCORD_PUBLIC_KEY"
      ])
    );

    const ready = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {
        ...env,
        KAIRON_DISCORD_PUBLIC_KEY: "a".repeat(64)
      }
    });
    const text = formatDoctorResult(ready);
    expect(statusById(ready, "discord.config")).toBe("pass");
    expect(checkById(ready, "discord.config")?.details).toEqual(
      expect.arrayContaining([
        "http_profile=reverse-proxy",
        "http_status=ready",
        "http_missing=none",
        "http_invalid=none"
      ])
    );
    expect(text).not.toContain("a".repeat(64));
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
    expect(checkById(result, "discord.config")?.next_action).toBe(
      "Fix invalid Discord gateway env vars: KAIRON_DISCORD_GUILD_ID. Then run kairon doctor. Guide: docs/discord-approval-v0.md."
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

  it("passes GitHub branch protection when authenticated API verification finds required gates", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "git@github.com:goodaymmm/Kairon.git");
    const requests: Parameters<GitHubBranchProtectionClient>[0][] = [];
    const githubBranchProtectionClient: GitHubBranchProtectionClient = async (request) => {
      requests.push(request);
      return {
        kind: "protected",
        requiredPullRequestReviews: true,
        requiredStatusChecks: true,
        enforceAdmins: true
      };
    };

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GH_TOKEN: "secret-token" },
      githubBranchProtectionClient
    });
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(true);
    expect(statusById(result, "git.branch_protection")).toBe("pass");
    expect(requests).toEqual([
      {
        owner: "goodaymmm",
        repo: "Kairon",
        branch: "main",
        token: "secret-token"
      }
    ]);
    expect(checkById(result, "git.branch_protection")?.details).toEqual(
      expect.arrayContaining([
        "remote=origin",
        "repository=goodaymmm/Kairon",
        "branch=main",
        "auth=present",
        "network_check=completed",
        "api_status=ok",
        "branch_protection=enabled",
        "required_pull_request_reviews=present",
        "required_status_checks=present",
        "enforce_admins=true"
      ])
    );
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("git@github.com");
  });

  it("passes GitHub branch protection when expected required status checks are present", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "https://github.com/goodaymmm/Kairon.git");

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {
        GH_TOKEN: "secret-token",
        KAIRON_GITHUB_EXPECTED_STATUS_CHECKS: "build,ci/test"
      },
      githubBranchProtectionClient: async () => ({
        kind: "protected",
        requiredPullRequestReviews: true,
        requiredStatusChecks: true,
        requiredStatusCheckContexts: ["build", "ci/test"],
        enforceAdmins: true
      })
    });
    const check = checkById(result, "git.branch_protection");
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(true);
    expect(check?.status).toBe("pass");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "required_status_check_contexts=build,ci/test",
        "expected_status_checks=build,ci/test",
        "missing_expected_status_checks=none"
      ])
    );
    expect(text).not.toContain("secret-token");
  });

  it("warns when an expected required status check is missing", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "https://github.com/goodaymmm/Kairon.git");
    const policiesPath = path.join(root, ".kairon", "config", "policies.json");
    const policies = await readJsonFile<Record<string, any>>(policiesPath);
    policies.git.branch_protection = {
      expected_status_checks: ["build", "ci/test"]
    };
    await writeJsonFileAtomic(policiesPath, policies);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GH_TOKEN: "secret-token" },
      githubBranchProtectionClient: async () => ({
        kind: "protected",
        requiredPullRequestReviews: true,
        requiredStatusChecks: true,
        requiredStatusCheckContexts: ["build"],
        enforceAdmins: true
      })
    });
    const check = checkById(result, "git.branch_protection");

    expect(result.ok).toBe(true);
    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "required_status_check_contexts=build",
        "expected_status_checks=build,ci/test",
        "missing_expected_status_checks=ci/test"
      ])
    );
    expect(check?.next_action).toBe(
      "Add expected required status checks: ci/test. Then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );
  });

  it("extracts GitHub required status check contexts from the live API payload shape", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "https://github.com/goodaymmm/Kairon.git");
    const previousFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          required_pull_request_reviews: {},
          required_status_checks: {
            contexts: ["build"],
            checks: [{ context: "ci/test" }, { context: "build" }]
          },
          enforce_admins: { enabled: false }
        }),
        { status: 200 }
      );

    try {
      const result = await runDoctor({
        projectRoot: root,
        commandAvailability: async () => true,
        env: {
          GH_TOKEN: "secret-token",
          KAIRON_GITHUB_EXPECTED_STATUS_CHECKS: "build,ci/test"
        }
      });
      const check = checkById(result, "git.branch_protection");

      expect(result.ok).toBe(true);
      expect(check?.status).toBe("pass");
      expect(check?.details).toEqual(
        expect.arrayContaining([
          "required_status_check_contexts=build,ci/test",
          "missing_expected_status_checks=none"
        ])
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("can verify GitHub branch protection using a configured Windows credential target", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "git@github.com:goodaymmm/Kairon.git");
    const env = {
      KAIRON_GH_TOKEN_CREDENTIAL_TARGET: "Kairon/GH_TOKEN"
    };
    const secretResolver = createDefaultSecretResolver({
      env,
      platform: "win32",
      windowsCredentialReader: async (target) =>
        target === "Kairon/GH_TOKEN" ? "secret-token" : undefined
    });
    const requests: Parameters<GitHubBranchProtectionClient>[0][] = [];

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env,
      secretResolver,
      githubBranchProtectionClient: async (request) => {
        requests.push(request);
        return {
          kind: "protected",
          requiredPullRequestReviews: true,
          requiredStatusChecks: true,
          enforceAdmins: true
        };
      }
    });
    const text = formatDoctorResult(result);

    expect(result.ok).toBe(true);
    expect(statusById(result, "git.branch_protection")).toBe("pass");
    expect(requests[0]?.token).toBe("secret-token");
    expect(checkById(result, "git.branch_protection")?.details).toEqual(
      expect.arrayContaining([
        "auth=present",
        "auth_provider=windows_credential",
        "auth_source=Kairon/GH_TOKEN",
        "api_status=ok"
      ])
    );
    expect(text).not.toContain("secret-token");
  });

  it("warns when authenticated GitHub branch protection is missing required gates", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "https://github.com/goodaymmm/Kairon.git");

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GITHUB_TOKEN: "secret-token" },
      githubBranchProtectionClient: async () => ({
        kind: "protected",
        requiredPullRequestReviews: false,
        requiredStatusChecks: true,
        enforceAdmins: "unknown"
      })
    });
    const check = checkById(result, "git.branch_protection");

    expect(result.ok).toBe(true);
    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "auth=present",
        "network_check=completed",
        "api_status=ok",
        "required_pull_request_reviews=missing",
        "required_status_checks=present"
      ])
    );
    expect(check?.next_action).toBe(
      "Enable GitHub branch protection gates: required_pull_request_reviews. Then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );
  });

  it("normalizes GitHub branch protection auth, permission, and not found failures into warnings", async () => {
    const root = await createInitializedGitProject();
    await writeGitHubRemote(root, "https://github.com/goodaymmm/Kairon");

    const authError = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GH_TOKEN: "secret-token" },
      githubBranchProtectionClient: async () => ({
        kind: "auth_error",
        httpStatus: 401
      })
    });
    const authCheck = checkById(authError, "git.branch_protection");

    expect(authError.ok).toBe(true);
    expect(authCheck?.status).toBe("warning");
    expect(authCheck?.details).toEqual(
      expect.arrayContaining(["api_status=auth_error", "http_status=401"])
    );
    expect(authCheck?.next_action).toBe(
      "Check GH_TOKEN or GITHUB_TOKEN authentication, then run kairon doctor. Guide: docs/github-branch-protection-sandbox-v0.md."
    );

    const permissionError = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GH_TOKEN: "secret-token" },
      githubBranchProtectionClient: async () => ({
        kind: "plan_or_permission_error",
        httpStatus: 403
      })
    });
    const permissionCheck = checkById(permissionError, "git.branch_protection");

    expect(permissionError.ok).toBe(true);
    expect(permissionCheck?.status).toBe("warning");
    expect(permissionCheck?.details).toEqual(
      expect.arrayContaining(["api_status=plan_or_permission_error", "http_status=403"])
    );
    expect(permissionCheck?.next_action).toContain(
      "Check token repository access and Administration read permission"
    );
    expect(permissionCheck?.next_action).toContain(
      "public sandbox check"
    );

    const notFound = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { GH_TOKEN: "secret-token" },
      githubBranchProtectionClient: async () => ({
        kind: "not_found",
        httpStatus: 404
      })
    });

    expect(notFound.ok).toBe(true);
    expect(statusById(notFound, "git.branch_protection")).toBe("warning");
    expect(checkById(notFound, "git.branch_protection")?.details).toEqual(
      expect.arrayContaining(["api_status=not_found_or_unprotected", "http_status=404"])
    );
    expect(checkById(notFound, "git.branch_protection")?.next_action).toContain(
      "public sandbox check"
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
    expect(checkById(result, "runtime.recovery")?.details).toContain("resolved_targets=0");
    expect(checkById(result, "runtime.recovery")?.next_action).toBe(
      "Run kairon recovery run and review any generated approval requests."
    );
  });

  it("warns for an exposed Board secret and passes after sanitized export", async () => {
    const root = await createInitializedGitProject();
    const projectionPath = path.join(root, ".kairon", "board", "projection.json");
    await writeJsonFileAtomic(projectionPath, {
      schema_version: "0.1",
      kind: "board_projection",
      generated_at: "2026-06-01T00:00:00.000Z",
      meta: {
        secret_scan: {
          status: "passed",
          scanned_fields: 1,
          scanned_strings: 1,
          redacted_fields: 0,
          redacted_values: 0,
          unresolved_findings: 0
        }
      },
      unsafe_message: `Authorization: Bearer ${"A".repeat(32)}`
    });

    const unsafeResult = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    expect(statusById(unsafeResult, "board.secret_scan")).toBe("warning");
    expect(checkById(unsafeResult, "board.secret_scan")?.details).toContain(
      "exposed_findings=1"
    );
    expect(formatDoctorResult(unsafeResult)).not.toContain("A".repeat(32));

    await exportBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z")
    });
    const safeResult = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    expect(statusById(safeResult, "board.secret_scan")).toBe("pass");
    expect(checkById(safeResult, "board.secret_scan")?.details).toContain(
      "exposed_findings=0"
    );
  });

  it("warns with a Board remediation when Board is enabled without a projection", async () => {
    const root = await createInitializedGitProject();
    const notificationsPath = path.join(root, ".kairon", "config", "notifications.json");
    const notifications = await readJsonFile<Record<string, any>>(notificationsPath);
    notifications.board.enabled = true;
    await writeJsonFileAtomic(notificationsPath, notifications);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(result, "board.secret_scan");

    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining(["enabled=true", "status=setup_required"])
    );
    expect(check?.next_action).toContain("kairon board export");
    expect(check?.next_action).toContain("docs/board-public-safety-v0.md");
  });

  it("warns with a RAG remediation when an enabled index is missing", async () => {
    const root = await createInitializedGitProject();
    const ragPath = path.join(root, ".kairon", "config", "rag.json");
    const rag = await readJsonFile<Record<string, unknown>>(ragPath);
    rag.enabled = true;
    await writeJsonFileAtomic(ragPath, rag);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(result, "rag.status");

    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "enabled=true",
        "status=setup_required",
        "index_validation=missing"
      ])
    );
    expect(check?.next_action).toContain("kairon rag refresh");
    expect(check?.next_action).toContain("docs/rag-memory-v0.md");
  });

  it("warns when the enabled RAG index checksum no longer matches", async () => {
    const root = await createInitializedGitProject();
    const ragPath = path.join(root, ".kairon", "config", "rag.json");
    const rag = await readJsonFile<Record<string, unknown>>(ragPath);
    rag.enabled = true;
    await writeJsonFileAtomic(ragPath, rag);
    await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const index = await readJsonFile<RagIndex>(indexPath);
    index.chunks[0] = { ...index.chunks[0]!, text: "tampered RAG chunk" };
    await writeJsonFileAtomic(indexPath, index);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(result, "rag.status");

    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "enabled=true",
        "status=unpassed",
        "index_validation=unpassed",
        expect.stringContaining("issue=index_checksum_mismatch")
      ])
    );
    expect(check?.next_action).toContain("kairon rag verify");
    expect(check?.next_action).toContain("kairon rag rebuild --dry-run --compare");
  });

  it("warns with daemon report and recovery commands after a fatal daemon event", async () => {
    const root = await createInitializedGitProject();
    await writeFile(
      path.join(root, ".kairon", "runtime", "daemon", "2026-07-14.jsonl"),
      `${JSON.stringify({
        event: "fatal_error",
        created_at: "2026-07-14T00:00:00.000Z",
        error: {
          code: "DAEMON_FATAL",
          message: "token=must-not-leak"
        }
      })}\n`,
      "utf8"
    );

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(result, "daemon.health");
    const text = formatDoctorResult(result);

    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "status=fatal_error",
        "remediation_status=setup_required",
        "last_error_code=DAEMON_FATAL"
      ])
    );
    expect(check?.next_action).toContain("kairon daemon report");
    expect(check?.next_action).toContain("kairon recovery run");
    expect(text).not.toContain("must-not-leak");
  });

  it("formats JSON with snake-case remediation fields and no secret values", async () => {
    const root = await createInitializedGitProject({ gitignore: false });
    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { OPENAI_API_KEY: "secret-api-key-value" }
    });
    const output = formatDoctorResult(result, { format: "json" });
    const parsed = JSON.parse(output) as DoctorResult;
    const check = checkById(parsed, "git.gitignore");

    expect(check?.next_action).toBe("Create .gitignore and add .kairon/.");
    expect(output).toContain('"next_action"');
    expect(output).not.toContain('"nextAction"');
    expect(output).not.toContain("secret-api-key-value");
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
    expect(text).toContain("next_action=Create .gitignore and add .kairon/.");
  });

  it("reports an existing invalid Beta readiness manifest as a warning", async () => {
    const root = await createInitializedGitProject();
    const readinessDir = path.join(root, ".kairon", "readiness");
    await mkdir(readinessDir, { recursive: true });
    await writeFile(path.join(readinessDir, "evidence-manifest.json"), "{ invalid", "utf8");

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });

    expect(statusById(result, "readiness.status")).toBe("warning");
    expect(checkById(result, "readiness.status")?.details).toEqual(
      expect.arrayContaining(["status=UNKNOWN", "ready=false", "manifest_status=invalid"])
    );
  });

  it("reports remote Board readiness without exposing access tokens", async () => {
    const root = await createInitializedGitProject();
    const notificationsPath = path.join(
      root,
      ".kairon",
      "config",
      "notifications.json"
    );
    const notifications = await readJsonFile<Record<string, any>>(notificationsPath);
    notifications.board = {
      ...notifications.board,
      enabled: true,
      profile: "remote-readonly",
      external_base_url: "https://board.example.test/",
      trusted_proxies: ["127.0.0.1/32"],
      allowed_origins: ["https://board.example.test"],
      identity_header: "x-kairon-verified-identity",
      rate_limit_per_minute: 30
    };
    await writeJsonFileAtomic(notificationsPath, notifications);

    const setupRequired = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    expect(statusById(setupRequired, "board.remote_profile")).toBe("warning");
    expect(checkById(setupRequired, "board.remote_profile")?.details).toContain(
      "active_access=0"
    );

    const token = "doctor-board-token-abcdefghijklmnopqrstuvwxyz0123456789";
    await issuePersistentBoardAccess(root, {
      ttlMinutes: 15,
      randomToken: () => token,
      accessId: "BOARD-ACCESS-T154-DOCTOR"
    });
    const ready = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(ready, "board.remote_profile");
    expect(check?.status).toBe("pass");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "profile=remote-readonly",
        "external_base_url=configured",
        "active_access=1",
        "status=ready"
      ])
    );
    expect(formatDoctorResult(ready)).not.toContain(token);
  });

  it("warns when a correlation member points to a missing artifact", async () => {
    const root = await createInitializedGitProject();
    await trackCorrelationMember(root, {
      kind: "workflow",
      id: "WF-T155-MISSING",
      status: "running",
      artifactPath: ".kairon/workflows/production/WF-T155-MISSING.json",
      createdAt: "2026-07-16T02:00:00.000Z"
    });

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const check = checkById(result, "correlation.integrity");

    expect(result.ok).toBe(true);
    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "missing_artifacts=1",
        "stale_messages=0",
        "orphan_follow_ups=0"
      ])
    );
    expect(check?.next_action).toContain(".kairon/correlations");
  });

  it("warns when workflow config conflicts with its legacy environment fallback", async () => {
    const root = await createInitializedGitProject();
    const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    const workflow = runtime.workflow as Record<string, unknown>;
    workflow.enabled = false;
    workflow.enabled_env = "KAIRON_WORKFLOW_RUNTIME";
    await writeJsonFileAtomic(runtimePath, runtime);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { KAIRON_WORKFLOW_RUNTIME: "1" }
    });
    const check = checkById(result, "workflow.config");

    expect(result.ok).toBe(true);
    expect(check?.status).toBe("warning");
    expect(check?.details).toEqual(
      expect.arrayContaining([
        "effective_source=config",
        "conflict=true",
        "legacy_enabled_env=true"
      ])
    );
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

async function writeGitHubRemote(root: string, remoteUrl: string): Promise<void> {
  await writeFile(
    path.join(root, ".git", "config"),
    ['[remote "origin"]', `  url = ${remoteUrl}`, ""].join("\n"),
    "utf8"
  );
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
