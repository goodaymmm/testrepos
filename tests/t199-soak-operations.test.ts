import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("T199 soak operations", () => {
  it("uses bounded runtime health queue samples instead of external agents", async () => {
    const workload = await readFile(
      path.resolve("docs", "t199-daily-workload.mjs"),
      "utf8"
    );

    expect(workload).toContain('type: "health.check"');
    expect(workload).toContain(":runtime-health:");
    expect(workload).toContain("await writeStatus();");
    expect(workload).toContain("Runtime health queue failed");
    expect(workload).not.toContain('type: "agent.run"');
    expect(workload).not.toContain("createTaskCommand");
    expect(workload).not.toContain("timeout_ms: 120000");
    expect(workload).toContain("cleanupPendingApprovals");
    expect(workload).toContain(
      "T199 daily notification sample cleanup after workload failure"
    );
  });

  it("uses the full soak execution key for retry-safe approval ids", async () => {
    const identifiers = await import(
      pathToFileURL(path.resolve("docs", "t199-soak-identifiers.mjs")).href
    );
    const first = identifiers.createT199ApprovalId(
      "SSK-20260803110634-3584ff08ca9c",
      "2026-08-03",
      1
    );
    const retry = identifiers.createT199ApprovalId(
      "SSK-20260803134641-3584ff08ca9c",
      "2026-08-03",
      1
    );

    expect(first).not.toBe(retry);
    expect(first).toContain("20260803110634-3584ff08ca9c");
    expect(retry).toContain("20260803134641-3584ff08ca9c");
  });

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
    expect(supervisor).toContain("statusWriteQueue");
    expect(supervisor).toContain("renameStatusFile");
    expect(supervisor).toContain('["EACCES", "EBUSY", "EPERM"]');
    expect(supervisor).toContain("status_error=");
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

  runIfPowerShell("accepts a T199 start window that crosses midnight", () => {
    const tasksPath = path.resolve("docs", "t199-soak-tasks.ps1");
    const controlPath = path.resolve("docs", "t199-soak-control.ps1");
    const escaped = (value: string) => value.replaceAll("'", "''");
    const command = [
      `$tasks = Get-Content -LiteralPath '${escaped(tasksPath)}' -Raw -Encoding UTF8`,
      `$control = Get-Content -LiteralPath '${escaped(controlPath)}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$tasksAst = [Management.Automation.Language.Parser]::ParseInput($tasks, [ref]$tokens, [ref]$errors)",
      "$taskNames = @('ConvertTo-KaironTimeOfDay','Assert-KaironSchedule')",
      "$tasksAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $taskNames -contains $node.Name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }",
      "$schedule = [pscustomobject]@{ start_window_from='23:45'; start_window_to='00:00'; daily_workload_at='00:10'; discord_owner_user_id='12345678901234567'; discord_allowed_user_ids='12345678901234567' }",
      "Assert-KaironSchedule $schedule",
      "$tokens = $null",
      "$errors = $null",
      "$controlAst = [Management.Automation.Language.Parser]::ParseInput($control, [ref]$tokens, [ref]$errors)",
      "$controlNames = @('Test-T199TimeWithinWindow')",
      "$controlAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $controlNames -contains $node.Name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }",
      "$from = [TimeSpan]::Parse('23:45')",
      "$to = [TimeSpan]::Parse('00:00')",
      "@((Test-T199TimeWithinWindow ([TimeSpan]::Parse('23:50')) $from $to), (Test-T199TimeWithinWindow ([TimeSpan]::Parse('00:00')) $from $to), (Test-T199TimeWithinWindow ([TimeSpan]::Parse('00:01')) $from $to)) -join ','"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("True,True,False");
  });

  runIfPowerShell("requires confirmed remote failure at a soak checkpoint", () => {
    const scriptPath = path.resolve("docs", "t199-soak-control.ps1");
    const escapedPath = scriptPath.replaceAll("'", "''");
    const base = {
      profile: "stable-remote-readonly",
      status: "degraded",
      config: { status: "ready" },
      discord: {
        local_status: "ready",
        url_drift: false,
        external_readiness: "ready",
        consecutive_failures: 0
      },
      board: {
        local_status: "ready",
        url_drift: false,
        external_readiness: "unreachable",
        consecutive_failures: 2
      },
      identity: { status: "not_checked" },
      tunnel: { status: "not_checked", consecutive_failures: 0 }
    };
    const confirmed = structuredClone(base);
    confirmed.board.consecutive_failures = 3;
    const bypass = structuredClone(base);
    bypass.board.external_readiness = "identity_bypass_detected";
    bypass.identity.status = "bypass_detected";
    const command = [
      `$source = Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$names = @('Test-T199RemoteFailureConfirmed')",
      "$ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }",
      `$transient = '${JSON.stringify(base)}' | ConvertFrom-Json`,
      `$confirmed = '${JSON.stringify(confirmed)}' | ConvertFrom-Json`,
      `$bypass = '${JSON.stringify(bypass)}' | ConvertFrom-Json`,
      "@((Test-T199RemoteFailureConfirmed $transient 3), (Test-T199RemoteFailureConfirmed $confirmed 3), (Test-T199RemoteFailureConfirmed $bypass 3)) -join ','"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("False,True,True");
  });

  runIfPowerShell("defaults the remote failure threshold when config is sparse", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-t199-threshold-"));
    const configRoot = path.join(root, ".kairon", "config");
    await mkdir(configRoot, { recursive: true });
    await writeFile(path.join(configRoot, "runtime.json"), "{}\n", "utf8");

    const scriptPath = path.resolve("docs", "t199-soak-control.ps1");
    const escapedPath = scriptPath.replaceAll("'", "''");
    const escapedRoot = root.replaceAll("'", "''");
    const command = [
      "Set-StrictMode -Version Latest",
      `$source = Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$name = 'Get-T199RemoteFailureThreshold'",
      "$ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }",
      `$ProjectRoot = '${escapedRoot}'`,
      "Get-T199RemoteFailureThreshold"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("3");
  });

  runIfPowerShell("retries a transient checkpoint probe until it recovers", () => {
    const scriptPath = path.resolve("docs", "t199-soak-control.ps1");
    const escapedPath = scriptPath.replaceAll("'", "''");
    const transient = remoteStatus("degraded", "unreachable", 1);
    const ready = remoteStatus("ready", "identity_enforced", 0);
    const command = [
      `$source = Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8`,
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
      "$names = @('Test-T199RemoteCheckpointReady','Test-T199RemoteFailureConfirmed','Invoke-T199RemoteCheckpointProbe')",
      "$ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }",
      "function Get-T199RemoteFailureThreshold { return 3 }",
      "function Start-Sleep { param([int]$Seconds) }",
      `$script:responses = @('${JSON.stringify(transient)}','${JSON.stringify(ready)}')`,
      "$script:index = 0",
      "function Invoke-KaironJson { param([string[]]$Arguments) $value = $script:responses[$script:index]; $script:index += 1; return $value | ConvertFrom-Json }",
      "$result = Invoke-T199RemoteCheckpointProbe",
      "@($result.attempts, $result.failure_threshold, $result.status.status) -join ','"
    ].join("; ");
    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-Command", command],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("2,3,ready");
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

function remoteStatus(
  status: "ready" | "degraded",
  boardReadiness: "identity_enforced" | "unreachable",
  boardFailures: number
) {
  return {
    profile: "stable-remote-readonly",
    status,
    config: { status: "ready" },
    discord: {
      local_status: "ready",
      url_drift: false,
      external_readiness: "ready",
      consecutive_failures: 0
    },
    board: {
      local_status: "ready",
      url_drift: false,
      external_readiness: boardReadiness,
      consecutive_failures: boardFailures
    },
    identity: {
      status: boardReadiness === "identity_enforced" ? "enforced" : "not_checked"
    },
    tunnel: {
      status: boardReadiness === "identity_enforced" ? "connected" : "not_checked",
      consecutive_failures: 0
    }
  };
}
