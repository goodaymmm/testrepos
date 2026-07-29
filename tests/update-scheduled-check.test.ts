import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import type { PreparedDiscordGateway } from "../src/discord/gateway.js";
import { defaultAlertPolicy } from "../src/notifications/alert-policy.js";
import { setUpdateChannel } from "../src/update/channel.js";
import type { UpdateCheckResult } from "../src/update/downloader.js";
import {
  getScheduledUpdateStatus,
  installScheduledUpdateCheck,
  readLatestScheduledUpdateCheck,
  runScheduledUpdateCheck,
  scheduledUpdatePaths,
  uninstallScheduledUpdateCheck,
  verifyScheduledUpdateTask
} from "../src/update/scheduled-check.js";
import { createTempProject } from "./test-utils.js";

describe("scheduled update check", () => {
  it("installs and removes only the exact managed Windows task without secrets", async () => {
    const root = await createTempProject();
    const invocations: CliInvocation[] = [];
    const commandRunner = async (
      invocation: CliInvocation
    ): Promise<CommandRunResult> => {
      invocations.push(invocation);
      const action = invocation.args[
        invocation.args.indexOf("-Action") + 1
      ];
      return commandResult(invocation, {
        stdout:
          action === "Unregister"
            ? "task.exists=false\ntask.managed=false\n"
            : "task.exists=true\ntask.managed=true\ntask.state=Ready\n"
      });
    };

    const installed = await installScheduledUpdateCheck(root, {
      platform: "win32",
      taskName: "Kairon T197 Test",
      intervalHours: 12,
      timeoutMs: 30_000,
      cooldownHours: 6,
      tokenEnv: "GH_TOKEN",
      kaironCommand: "C:\\Kairon\\kairon.cmd",
      helperPath: "C:\\Kairon\\kairon-update-check-task.ps1",
      commandRunner,
      now: () => new Date("2026-07-29T00:00:00.000Z")
    });
    expect(installed).toContain("task_status=registered");

    const verified = await verifyScheduledUpdateTask(root, {
      platform: "win32",
      helperPath: "C:\\Kairon\\kairon-update-check-task.ps1",
      commandRunner
    });
    expect(verified).toContain("task_managed=true");

    const removed = await uninstallScheduledUpdateCheck(root, {
      platform: "win32",
      helperPath: "C:\\Kairon\\kairon-update-check-task.ps1",
      commandRunner
    });
    expect(removed).toContain("task_status=missing");

    const view = await getScheduledUpdateStatus(root);
    expect(view.enabled).toBe(false);
    expect(invocations).toHaveLength(3);
    expect(invocations[0]?.args).toEqual(expect.arrayContaining([
      "-Action",
      "Register",
      "-ProjectRoot",
      root,
      "-IntervalHours",
      "12"
    ]));
    expect(JSON.stringify(invocations)).not.toContain("github_pat_");
    expect(JSON.stringify(invocations)).not.toContain("secret-value");
  });

  it("classifies current without notification and preserves protected state", async () => {
    const root = await preparedProject();
    const send = vi.fn();
    const result = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: updateResult("current", "0.3.0"),
      send
    }));

    expect(result).toMatchObject({
      status: "completed",
      classification: "current",
      notification: { status: "not_required" },
      manual_download_command: null,
      read_only_guard: { mutation_detected: false },
      automatic_download: false,
      automatic_apply: false,
      automatic_restart: false
    });
    expect(send).not.toHaveBeenCalled();
    await expect(readLatestScheduledUpdateCheck(root)).resolves.toMatchObject({
      check_id: result.check_id,
      classification: "current"
    });
  });

  it("notifies a new release once and deduplicates the same release", async () => {
    const root = await preparedProject();
    const send = vi.fn().mockResolvedValue({ id: "discord-message-1" });
    const first = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: updateResult("update_available", "0.3.1"),
      send
    }));
    const second = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: updateResult("update_available", "0.3.1"),
      send,
      now: new Date("2026-07-29T01:00:00.000Z")
    }));

    expect(first).toMatchObject({
      classification: "new_release",
      selected_release_id: 197,
      notification: {
        status: "sent",
        message_id: "discord-message-1"
      },
      manual_download_command: "kairon update download 0.3.1"
    });
    expect(second.notification).toMatchObject({
      status: "deduplicated",
      policy_reason: "release_already_notified"
    });
    expect(send).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("github-token-value");
    expect(serialized).not.toContain("discord-token-value");
  });

  it("applies quiet hours before attempting Discord delivery", async () => {
    const root = await preparedProject();
    const send = vi.fn();
    const result = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: updateResult("update_available", "0.3.1"),
      send,
      policy: {
        ...defaultAlertPolicy,
        timezone: "UTC",
        quiet_hours: [{ start: "00:00", end: "02:00" }]
      },
      now: new Date("2026-07-29T01:00:00.000Z")
    }));

    expect(result.notification).toMatchObject({
      status: "deferred",
      policy_decision: "defer",
      policy_reason: "quiet_hours"
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed without sending when notification audit is invalid", async () => {
    const root = await preparedProject();
    const send = vi.fn();
    await writeFile(
      scheduledUpdatePaths(root).notificationAudit,
      "{not-json}\n",
      "utf8"
    );

    const result = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: updateResult("update_available", "0.3.1"),
      send
    }));

    expect(result.notification).toMatchObject({
      status: "failed",
      policy_reason: "notification_audit_invalid"
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves the update result when Discord setup fails", async () => {
    const root = await preparedProject();
    const result = await runScheduledUpdateCheck(root, "0.3.0", {
      ...dependencies({
        update: updateResult("update_available", "0.3.1"),
        send: vi.fn()
      }),
      prepareDiscord: async () => {
        throw new Error("discord setup exploded with token=secret-value");
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      classification: "new_release",
      notification: {
        status: "failed",
        policy_reason: "discord_setup_failed"
      },
      read_only_guard: {
        mutation_detected: false
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("returns setup_required without a GitHub token and does not touch the cache", async () => {
    const root = await preparedProject();
    const paths = scheduledUpdatePaths(root);
    const result = await runScheduledUpdateCheck(root, "0.3.0", {
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      resolveGitHubToken: async () => ({
        status: "missing",
        provider: "windows_credential",
        source: "Kairon/GH_TOKEN",
        reason: "not found"
      })
    });

    expect(result).toMatchObject({
      status: "setup_required",
      classification: "remote_unavailable",
      credential: {
        status: "missing",
        provider: "windows_credential",
        source: "Kairon/GH_TOKEN"
      },
      notification: { status: "not_required" },
      reason: "github_token_missing",
      read_only_guard: { mutation_detected: false }
    });
    expect(result.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(paths.latest).toContain(path.join(".kairon", "update", "schedule"));
  });

  it("records setup_required when the update channel is not configured", async () => {
    const root = await createTempProject();
    await installProfile(root);

    const result = await runScheduledUpdateCheck(root, "0.3.0");

    expect(result).toMatchObject({
      status: "setup_required",
      classification: "remote_unavailable",
      repository: null,
      channel: null,
      reason: "update_channel_missing",
      read_only_guard: {
        mutation_detected: false
      }
    });
    await expect(readLatestScheduledUpdateCheck(root)).resolves.toMatchObject({
      check_id: result.check_id
    });
  });

  it("classifies a pinned mismatch and keeps download manual", async () => {
    const root = await createTempProject();
    await setUpdateChannel(root, {
      channel: "pinned",
      repository: "goodaymmm/Kairon",
      version: "0.2.9",
      write: true,
      confirm: "pinned@0.2.9"
    });
    await installProfile(root);
    const result = await runScheduledUpdateCheck(root, "0.3.0", dependencies({
      update: {
        ...updateResult("downgrade_available", "0.2.9"),
        channel: "pinned"
      },
      send: vi.fn().mockResolvedValue({ id: "pinned-message" })
    }));

    expect(result).toMatchObject({
      classification: "pinned_mismatch",
      manual_download_command: "kairon update download 0.2.9",
      automatic_apply: false
    });
  });

  it("refuses to remove a foreign task and records the safety boundary", async () => {
    const root = await preparedProject();
    const invocation: CliInvocation = {
      command: "powershell.exe",
      args: [],
      cwd: root,
      timeoutMs: 120_000
    };
    const output = await uninstallScheduledUpdateCheck(root, {
      platform: "win32",
      commandRunner: async () => commandResult(invocation, {
        exitCode: 1,
        stdout: [
          "task.exists=true",
          "task.managed=false",
          "Refusing to remove a task that is not managed by Kairon."
        ].join("\n")
      })
    });

    expect(output).toContain("task_status=foreign");
    expect(output).toContain("task_is_not_managed_by_kairon");
    await expect(getScheduledUpdateStatus(root)).resolves.toMatchObject({
      enabled: true,
      task: {
        status: "foreign",
        managed: false
      }
    });
  });

  it("returns setup_required outside Windows without creating a profile", async () => {
    const root = await createTempProject();
    const output = await installScheduledUpdateCheck(root, {
      platform: "linux"
    });
    expect(output).toContain("status=setup_required");
    expect(output).toContain("windows_task_scheduler_required");
    await expect(getScheduledUpdateStatus(root)).resolves.toMatchObject({
      enabled: false,
      profile: null
    });
  });
});

async function preparedProject(): Promise<string> {
  const root = await createTempProject();
  await setUpdateChannel(root, {
    channel: "stable",
    repository: "goodaymmm/Kairon",
    write: true,
    confirm: "stable"
  });
  await installProfile(root);
  return root;
}

async function installProfile(root: string): Promise<void> {
  await installScheduledUpdateCheck(root, {
    platform: "win32",
    taskName: "Kairon T197 Test",
    commandRunner: async (invocation) => commandResult(invocation, {
      stdout: "task.exists=true\ntask.managed=true\ntask.state=Ready\n"
    }),
    now: () => new Date("2026-07-29T00:00:00.000Z")
  });
}

function dependencies(input: {
  update: UpdateCheckResult;
  send: ReturnType<typeof vi.fn>;
  policy?: typeof defaultAlertPolicy;
  now?: Date;
}) {
  const gateway: PreparedDiscordGateway & { status: "ready" } = {
    status: "ready",
    mode: "gateway",
    bot_token: "discord-token-value",
    application_id: "1",
    guild_id: "2",
    approval_channel_id: "3",
    owner_user_id: "4",
    allowed_user_ids: ["4"],
    register_commands_on_start: false,
    ack_timeout_ms: 2500,
    idempotency_ttl_minutes: 60,
    reconnect: {
      enabled: true,
      max_backoff_seconds: 60
    }
  };
  return {
    now: () => input.now ?? new Date("2026-07-29T00:00:00.000Z"),
    resolveGitHubToken: async () => ({
      status: "present" as const,
      value: "github-token-value",
      provider: "env" as const,
      source: "GH_TOKEN"
    }),
    updateCheck: async () => input.update,
    resolvePolicy: async () => ({
      policy: input.policy ?? structuredClone(defaultAlertPolicy),
      issues: []
    }),
    prepareDiscord: async () => gateway,
    channelFactory: async () => ({
      id: "3",
      send: input.send
    }),
    readWatchdogAudit: async () => []
  };
}

function updateResult(
  status: UpdateCheckResult["status"],
  selectedVersion: string
): UpdateCheckResult {
  return {
    schema_version: "0.1",
    status,
    channel: "stable",
    repository: "goodaymmm/Kairon",
    current_version: "0.3.0",
    selected_release_id: 197,
    selected_version: selectedVersion,
    selected_tag: `v${selectedVersion}`,
    selected_source_commit: "a".repeat(40),
    prerelease: false,
    filesystem_changed: false,
    automatic_updates: false
  };
}

function commandResult(
  invocation: CliInvocation,
  overrides: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:00:01.000Z",
    timedOut: false,
    ...overrides
  };
}
