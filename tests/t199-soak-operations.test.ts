import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("T199 soak operations", () => {
  it("keeps soak times explicit and outside source code", async () => {
    const tasks = await readFile(
      path.resolve("docs", "t199-soak-tasks.ps1"),
      "utf8"
    );
    const control = await readFile(
      path.resolve("docs", "t199-soak-control.ps1"),
      "utf8"
    );

    expect(tasks).toContain("-StartWindowFrom");
    expect(tasks).toContain("-StartWindowTo");
    expect(tasks).toContain("-DailyWorkloadAt");
    expect(tasks).toContain("-DiscordOwnerUserId");
    expect(tasks).toContain("-DiscordAllowedUserIds");
    expect(tasks).toContain("t199-soak-schedule.json");
    expect(control).toContain("Read-T199Schedule");
    expect(control).toContain("daily_workload_at");
    expect(control).toContain("ConvertTo-T199DateTimeOffset");
    expect(control).not.toContain("[DateTimeOffset]::Parse($event.created_at)");
    expect(control).not.toContain("[DateTimeOffset]::Parse($Status.updated_at)");
    expect(tasks).not.toContain('New-ScheduledTaskTrigger -Daily -At "01:10"');
    expect(control).not.toContain("Start T199 between 00:55 and 01:05");
  });

  it("defines graceful and explicit legacy cleanup for long-running services", async () => {
    const tasks = await readFile(
      path.resolve("docs", "t199-soak-tasks.ps1"),
      "utf8"
    );
    const supervisor = await readFile(
      path.resolve("docs", "t199-remote-supervisor.mjs"),
      "utf8"
    );
    const launcher = await readFile(
      path.resolve("docs", "t199-kairon-with-secrets.mjs"),
      "utf8"
    );

    expect(tasks).toContain("Stop-KaironRuntime");
    expect(tasks).toContain("Stop-KaironRemoteServices");
    expect(tasks).toContain("Assert-NoResidualServices");
    expect(tasks).toContain("-AllowLegacyCleanup");
    expect(tasks).toContain("taskkill.exe");
    expect(supervisor).toContain('arguments_.includes("--request-stop")');
    expect(supervisor).toContain("supervisor_pid: process.pid");
    expect(supervisor).toContain("t199-remote-supervisor.stop.json");
    expect(supervisor).toContain("heartbeatTimer = setInterval");
    expect(launcher).toContain('cliArguments[0] !== "stop"');
  });

  runIfPowerShell("parses both PowerShell control scripts", () => {
    for (const name of ["t199-soak-tasks.ps1", "t199-soak-control.ps1"]) {
      const scriptPath = path.resolve("docs", name);
      const result = spawnSync(
        powershell!,
        [
          "-NoProfile",
          "-Command",
          `[scriptblock]::Create((Get-Content -LiteralPath '${scriptPath.replaceAll("'", "''")}' -Raw)) | Out-Null`
        ],
        { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
      );
      expect(result.status, result.stderr).toBe(0);
    }
  });

  runIfPowerShell("preserves UTC when ConvertFrom-Json returns DateTime", () => {
    const scriptPath = path.resolve("docs", "t199-soak-control.ps1");
    const escapedPath = scriptPath.replaceAll("'", "''");
    const command = [
      `$source = Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-T199DateTimeOffset' }, $true)",
      ". ([scriptblock]::Create($function.Extent.Text))",
      "$value = '{\"updated_at\":\"2026-08-02T18:06:29.581Z\"}' | ConvertFrom-Json",
      "(ConvertTo-T199DateTimeOffset $value.updated_at).ToString('o')"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("2026-08-02T18:06:29.5810000+00:00");
  });

  runIfPowerShell("requests runtime stop from the configured project root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-t199-stop-root-"));
    const capturePath = path.join(root, "captured-cwd.txt");
    const wrapperPath = path.join(root, "fake-kairon.cmd");
    await writeFile(
      wrapperPath,
      `@echo off\r\ncd > "${capturePath}"\r\nexit /b 0\r\n`,
      "utf8"
    );
    const scriptPath = path.resolve("docs", "t199-soak-tasks.ps1");
    const escaped = (value: string) => value.replaceAll("'", "''");
    const command = [
      `$source = Get-Content -LiteralPath '${escaped(scriptPath)}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-KaironRuntime' }, $true)",
      ". ([scriptblock]::Create($function.Extent.Text))",
      `$ProjectRoot = '${escaped(root)}'`,
      `$KaironWrapper = '${escaped(wrapperPath)}'`,
      `$RuntimeLockPath = '${escaped(path.join(root, ".kairon", "runtime", "lock.json"))}'`,
      "$AllowLegacyCleanup = $false",
      "Stop-KaironRuntime"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    const observedRoot = await realpath((await readFile(capturePath, "utf8")).trim());
    const expectedRoot = await realpath(root);
    expect(normalizePathForComparison(observedRoot)).toBe(
      normalizePathForComparison(expectedRoot)
    );
  });

  it("treats a missing or stopped remote supervisor as an idempotent stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-t199-stop-"));
    const script = path.resolve("docs", "t199-remote-supervisor.mjs");
    const missing = spawnSync(
      process.execPath,
      [script, "--project-root", root, "--request-stop", "--timeout-ms", "1000"],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 5_000 }
    );
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stdout).toContain("remote_supervisor.status=not_running");

    const runtimeRoot = path.join(root, ".kairon", "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "t199-remote-supervisor.json"),
      JSON.stringify({ schema_version: "0.1", status: "stopped" }),
      "utf8"
    );
    const stopped = spawnSync(
      process.execPath,
      [script, "--project-root", root, "--request-stop", "--timeout-ms", "1000"],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 5_000 }
    );
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("remote_supervisor.status=stopped");
  });

  it("reports a legacy supervisor status without emitting a stack trace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-t199-legacy-stop-"));
    const runtimeRoot = path.join(root, ".kairon", "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "t199-remote-supervisor.json"),
      JSON.stringify({ schema_version: "0.1", status: "running" }),
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("docs", "t199-remote-supervisor.mjs"),
        "--project-root",
        root,
        "--request-stop",
        "--timeout-ms",
        "1000"
      ],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 5_000 }
    );

    expect(result.status).toBe(4);
    expect(result.stderr).toContain(
      "remote_supervisor.stop_status=legacy_cleanup_required"
    );
    expect(result.stderr).not.toContain("at requestSupervisorStop");
  });

  it("stops the runtime without requiring Discord setup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-t199-runtime-stop-"));
    const environment = { ...process.env };
    for (const name of [
      "KAIRON_DISCORD_APPLICATION_ID",
      "KAIRON_DISCORD_GUILD_ID",
      "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
      "KAIRON_DISCORD_OWNER_USER_ID",
      "KAIRON_DISCORD_ALLOWED_USER_IDS",
      "KAIRON_DISCORD_BOT_TOKEN"
    ]) {
      delete environment[name];
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve("docs", "t199-kairon-with-secrets.mjs"), "stop"],
      {
        cwd: root,
        env: environment,
        encoding: "utf8",
        timeout: 10_000
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Kairon runtime stopped.");
  });
});

function findPowerShell(): string | undefined {
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
      encoding: "utf8",
      timeout: 5_000
    });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

function normalizePathForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
