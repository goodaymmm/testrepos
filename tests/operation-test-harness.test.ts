import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTempProject } from "./test-utils.js";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("kairon-operation-test.ps1", () => {
  it("runs TaskRun with interactive-only agents disabled", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-operation-test.ps1"),
      "utf8"
    );

    expect(script).toContain(
      "kairon task run $taskId --timeout-ms $TimeoutMs --no-interactive-agents"
    );
  });

  it("includes a targeted RuntimeReview operation test", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-operation-test.ps1"),
      "utf8"
    );

    expect(script).toContain("RuntimeReview");
    expect(script).toContain("Add-KaironReviewQueueItem");
    expect(script).toContain("tick\\.item_type=review\\.run");
    expect(script).toContain("runtime processed $actualItemId instead of expected $expectedItemId");
  });

  it("includes Discord live/setup and audit-focused operation profiles", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-operation-test.ps1"),
      "utf8"
    );

    expect(script).toContain("DiscordLiveReady");
    expect(script).toContain("DiscordInvalidEnv");
    expect(script).toContain("DiscordSetupError");
    expect(script).toContain("ApprovalNotificationAudit");
    expect(script).toContain("RuntimeRecovery");
    expect(script).toContain("SETUP_REQUIRED");
    expect(script).toContain("OPTIONAL");
    expect(script).toContain("Assert-NoSecretLeak");
    expect(script).toContain("approval-notifications.jsonl");
    expect(script).toContain("decision-interactions.jsonl");
    expect(script).toContain("kairon recovery run");
    expect(script).toContain("failed_ids");
    expect(script).toContain("artifact_paths");
  });

  it("guards DiscordSetupError evidence from raw Discord errors and raw ids", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-operation-test.ps1"),
      "utf8"
    );

    expect(script).toContain("DiscordAPIError\\[");
    expect(script).toContain("node_modules\\\\@discordjs");
    expect(script).toContain("discord\\.gateway\\.status=setup_required");
    expect(script).toContain("discord\\.gateway\\.next_action=");
    expect(script).toContain("$DiscordSetupErrorGuildId");
    expect(script).toContain("$DiscordSetupErrorApprovalChannelId");
  });

  runIfPowerShell("runs external commands without recursive scriptblock capture", async () => {
    const root = await createTempProject();
    const kaironRoot = path.join(root, "kairon");
    const targetRoot = path.join(root, "target");
    const outputRoot = path.join(root, "results");
    const binRoot = path.join(root, "bin");
    await mkdir(kaironRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await writeFakeKairon(binRoot);

    const result = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts", "kairon-operation-test.ps1"),
        "-KaironRoot",
        kaironRoot,
        "-TargetRoot",
        targetRoot,
        "-OutputRoot",
        outputRoot,
        "-Test",
        "Doctor"
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`
        },
        timeout: 10_000
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[DOCTOR] PASS");
    expect(result.stderr).not.toContain("recursion");
    expect(result.stderr).not.toContain("オーバーフロー");

    const summaryPath = result.stdout.match(/summary\.json=(.+)/)?.[1]?.trim();
    expect(summaryPath).toBeTruthy();
    const summary = JSON.parse(await readFile(summaryPath!, "utf8"));
    expect(summary.summary).toEqual({
      pass: 1,
      fail: 0,
      setup_required: 0,
      optional: 0,
      total: 1
    });
    expect(summary.failed_ids).toEqual([]);
    expect(summary.artifact_paths).toEqual(
      expect.arrayContaining([expect.stringContaining("summary.json")])
    );
    expect(summary.results[0]).toMatchObject({
      id: "DOCTOR",
      status: "PASS"
    });
  });

  runIfPowerShell("passes DiscordLiveReady when all Discord env names are present", async () => {
    const root = await createTempProject();
    const kaironRoot = path.join(root, "kairon");
    const targetRoot = path.join(root, "target");
    const outputRoot = path.join(root, "results");
    const binRoot = path.join(root, "bin");
    await mkdir(kaironRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await mkdir(binRoot, { recursive: true });
    await writeFakeKairon(binRoot);
    await writeMinimalNotifications(targetRoot);

    const result = runHarness(kaironRoot, targetRoot, outputRoot, "DiscordLiveReady", {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
      KAIRON_DISCORD_BOT_TOKEN: "secret-token-for-test",
      KAIRON_DISCORD_APPLICATION_ID: "111111111111111111",
      KAIRON_DISCORD_GUILD_ID: "222222222222222222",
      KAIRON_DISCORD_APPROVAL_CHANNEL_ID: "333333333333333333",
      KAIRON_DISCORD_OWNER_USER_ID: "444444444444444444",
      KAIRON_DISCORD_ALLOWED_USER_IDS: "444444444444444444"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[DISCORD_LIVE_READY] PASS");
    expect(result.stdout).not.toContain("secret-token-for-test");
    const summary = await readSummaryFromStdout(result.stdout);
    expect(summary.results[0]).toMatchObject({
      id: "DISCORD_LIVE_READY",
      status: "PASS"
    });
    expect(JSON.stringify(summary)).not.toContain("secret-token-for-test");
  });

  runIfPowerShell("marks DiscordSetupError setup_required when one required env is missing", async () => {
    const root = await createTempProject();
    const kaironRoot = path.join(root, "kairon");
    const targetRoot = path.join(root, "target");
    const outputRoot = path.join(root, "results");
    await mkdir(kaironRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });

    const result = runHarness(kaironRoot, targetRoot, outputRoot, "DiscordSetupError", {
      ...process.env,
      KAIRON_DISCORD_BOT_TOKEN: "secret-token-for-test",
      KAIRON_DISCORD_APPLICATION_ID: "111111111111111111",
      KAIRON_DISCORD_OWNER_USER_ID: ""
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[DISCORD_SETUP_ERROR] SETUP_REQUIRED");
    const summary = await readSummaryFromStdout(result.stdout);
    expect(summary.summary).toMatchObject({
      fail: 0,
      setup_required: 1
    });
    expect(summary.results[0]).toMatchObject({
      id: "DISCORD_SETUP_ERROR",
      status: "SETUP_REQUIRED"
    });
  });

  runIfPowerShell("passes ApprovalNotificationAudit when only one audit file exists", async () => {
    const root = await createTempProject();
    const kaironRoot = path.join(root, "kairon");
    const targetRoot = path.join(root, "target");
    const outputRoot = path.join(root, "results");
    await mkdir(kaironRoot, { recursive: true });
    await mkdir(
      path.join(targetRoot, ".kairon", "runtime", "discord"),
      { recursive: true }
    );
    await writeFile(
      path.join(
        targetRoot,
        ".kairon",
        "runtime",
        "discord",
        "approval-notifications.jsonl"
      ),
      `${JSON.stringify({
        schema_version: "0.1",
        approval_id: "APR-TEST",
        status: "sent"
      })}\n`,
      "utf8"
    );

    const result = runHarness(kaironRoot, targetRoot, outputRoot, "ApprovalNotificationAudit", {
      ...process.env
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[APPROVAL_NOTIFICATION_AUDIT] PASS");
    const summary = await readSummaryFromStdout(result.stdout);
    expect(summary.results[0]).toMatchObject({
      id: "APPROVAL_NOTIFICATION_AUDIT",
      status: "PASS"
    });
  });
});

function findPowerShell(): string | undefined {
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"], {
      encoding: "utf8"
    });
    if (result.status === 0) {
      return command;
    }
  }
  return undefined;
}

function runHarness(
  kaironRoot: string,
  targetRoot: string,
  outputRoot: string,
  testName: string,
  env: NodeJS.ProcessEnv
) {
  return spawnSync(
    powershell!,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts", "kairon-operation-test.ps1"),
      "-KaironRoot",
      kaironRoot,
      "-TargetRoot",
      targetRoot,
      "-OutputRoot",
      outputRoot,
      "-Test",
      testName
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env,
      timeout: 10_000
    }
  );
}

async function readSummaryFromStdout(stdout: string) {
  const summaryPath = stdout.match(/summary\.json=(.+)/)?.[1]?.trim();
  expect(summaryPath).toBeTruthy();
  return JSON.parse(await readFile(summaryPath!, "utf8"));
}

async function writeMinimalNotifications(targetRoot: string): Promise<void> {
  await mkdir(path.join(targetRoot, ".kairon", "config"), { recursive: true });
  await writeFile(
    path.join(targetRoot, ".kairon", "config", "notifications.json"),
    `${JSON.stringify(
      {
        schema_version: "0.1",
        providers: {
          discord: {
            enabled: false,
            env: {
              bot_token: "KAIRON_DISCORD_BOT_TOKEN",
              application_id: "KAIRON_DISCORD_APPLICATION_ID",
              guild_id: "KAIRON_DISCORD_GUILD_ID",
              approval_channel_id: "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
              owner_user_id: "KAIRON_DISCORD_OWNER_USER_ID",
              allowed_user_ids: "KAIRON_DISCORD_ALLOWED_USER_IDS"
            }
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeFakeKairon(binRoot: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(
      path.join(binRoot, "kairon.cmd"),
      [
        "@echo off",
        "if \"%1\"==\"doctor\" (",
        "  echo doctor.ok=true",
        "  echo PASS discord.config Discord notification config",
        "  echo   - gateway_status=ready",
        "  echo   - live_status=ready",
        "  exit /b 0",
        ")",
        "echo unexpected kairon args: %*",
        "exit /b 2",
        ""
      ].join("\r\n"),
      "utf8"
    );
    return;
  }

  const executable = path.join(binRoot, "kairon");
  await writeFile(
    executable,
    [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"doctor\" ]; then",
      "  echo doctor.ok=true",
      "  echo \"PASS discord.config Discord notification config\"",
      "  echo \"  - gateway_status=ready\"",
      "  echo \"  - live_status=ready\"",
      "  exit 0",
      "fi",
      "echo \"unexpected kairon args: $*\"",
      "exit 2",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(executable, 0o755);
}
