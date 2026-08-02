import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("kairon-daemon-task.ps1", () => {
  it("documents safe Task Scheduler actions without embedding secret env names", async () => {
    const script = await readScript();

    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain("-ErrorAction Stop");
    expect(script).toContain("task_register_failed");
    expect(script).toContain("Start-ScheduledTask");
    expect(script).toContain("Stop-ScheduledTask");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain("start --daemon --interval-ms");
    expect(script).toContain("-RunLevel Limited");
    expect(script).toContain("-ExecutionTimeLimit (New-TimeSpan -Seconds 0)");
    expect(script).not.toContain("-ExecutionTimeLimit (New-TimeSpan -Days 1)");
    expect(script).not.toContain("LeastPrivilege");
    expect(script).toContain("Push-Location");
    expect(script).toContain("Pop-Location");
    expect(script).toContain("Require-KaironScheduledTask");
    expect(script).toContain("[switch]$DryRun");
    expect(script).toContain("task.mutation=skipped");
    expect(script).toContain("secret_values=not_in_task_arguments");
    expect(script).toContain("Get-KaironBackgroundPowerShellActionSpec");
    expect(script).toContain("task.window_mode=background");
    expect(script).toContain("Secrets are read from user environment variables.");
    expect(script).not.toContain("KAIRON_DISCORD_BOT_TOKEN");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("GITHUB_TOKEN");
  });

  it("uses a consoleless background launcher for managed tasks", async () => {
    const common = await readFile(
      path.resolve("scripts", "kairon-task-scheduler-common.ps1"),
      "utf8"
    );
    const launcher = await readFile(
      path.resolve("scripts", "kairon-background-launcher.vbs"),
      "utf8"
    );

    expect(common).toContain("wscript.exe");
    expect(common).toContain("//B");
    expect(common).toContain("//NoLogo");
    expect(common).toContain('"-WindowStyle"');
    expect(common).toContain('"Hidden"');
    expect(common).toContain("New-KaironBackgroundTaskAction");
    expect(launcher).toContain('CreateObject("WScript.Shell")');
    expect(launcher).toContain("shell.Run(commandLine, 0, True)");
  });

  it("keeps the Windows daemon operation guide linked from README", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const guide = await readFile(
      path.resolve("docs", "windows-daemon-ops-v0.md"),
      "utf8"
    );

    expect(readme).toContain("docs/windows-daemon-ops-v0.md");
    expect(readme).toContain("scripts/kairon-daemon-task.ps1");
    expect(guide).toContain("Task Scheduler");
    expect(guide).toContain("kairon recovery run");
    expect(guide).toContain("secret");
    expect(guide).toContain("scripts/kairon-daemon-task.ps1");
    expect(guide).toContain("kairon daemon task status");
    expect(guide).toContain("kairon daemon task install");
    expect(guide).toContain("kairon daemon task uninstall");
    expect(guide).toContain("kairon daemon task restart");
    expect(guide).toContain("task_scheduler_permission_denied");
    expect(guide).toContain("管理者として実行");
  });

  runIfPowerShell("parses as a PowerShell script", async () => {
    const scriptPath = path.resolve("scripts", "kairon-daemon-task.ps1");
    const result = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `[scriptblock]::Create((Get-Content -LiteralPath '${scriptPath.replaceAll("'", "''")}' -Raw)) | Out-Null`
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 10_000
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  runIfPowerShell("builds a background action spec and runs it without a console", async () => {
    const commonPath = path.resolve(
      "scripts",
      "kairon-task-scheduler-common.ps1"
    );
    const launcherPath = path.resolve(
      "scripts",
      "kairon-background-launcher.vbs"
    );
    const spec = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `. '${commonPath.replaceAll("'", "''")}'; ` +
          "$spec = Get-KaironBackgroundPowerShellActionSpec -ArgumentList @('-Command', 'exit 0'); " +
          "$spec | ConvertTo-Json -Compress"
      ],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );

    expect(spec.status, spec.stderr).toBe(0);
    expect(JSON.parse(spec.stdout)).toMatchObject({
      WindowMode: "background"
    });
    expect(JSON.parse(spec.stdout).Execute.toLowerCase()).toMatch(/wscript\.exe$/u);

    const host = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cscript.exe");
    const run = spawnSync(
      host,
      ["//B", "//NoLogo", launcherPath, powershell!, "-NoProfile", "-Command", "exit 0"],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 }
    );
    expect(run.status, run.stderr).toBe(0);

    const roundTripValue = 'space "quoted" trailing\\';
    const roundTripRoot = await mkdtemp(
      path.join(os.tmpdir(), "kairon-background-launcher-")
    );
    const roundTripScript = path.join(roundTripRoot, "round-trip.ps1");
    const roundTripOutput = path.join(roundTripRoot, "actual.txt");
    await writeFile(
      roundTripScript,
      [
        "param([string]$OutputPath, [string]$Expected, [string]$Actual)",
        "[IO.File]::WriteAllText($OutputPath, $Actual)",
        "if ($Actual -cne $Expected) { exit 9 }",
        "exit 0",
        ""
      ].join("\n"),
      "utf8"
    );
    const roundTripSpecResult = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `. '${commonPath.replaceAll("'", "''")}'; ` +
          "$spec = Get-KaironBackgroundProcessActionSpec " +
          "-Executable (Get-Command pwsh.exe -ErrorAction Stop).Source " +
          "-ArgumentList @('-NoProfile', '-File', $env:KAIRON_PROBE_SCRIPT, " +
          "$env:KAIRON_PROBE_OUTPUT, $env:KAIRON_PROBE_VALUE, $env:KAIRON_PROBE_VALUE); " +
          "$process = Start-Process -FilePath $spec.Execute -ArgumentList $spec.Arguments " +
          "-WorkingDirectory $env:KAIRON_PROBE_ROOT -WindowStyle Hidden -Wait -PassThru; " +
          "[pscustomobject]@{ ExitCode = $process.ExitCode; WindowMode = $spec.WindowMode } " +
          "| ConvertTo-Json -Compress"
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          KAIRON_PROBE_SCRIPT: roundTripScript,
          KAIRON_PROBE_OUTPUT: roundTripOutput,
          KAIRON_PROBE_ROOT: roundTripRoot,
          KAIRON_PROBE_VALUE: roundTripValue
        }
      }
    );
    expect(roundTripSpecResult.status, roundTripSpecResult.stderr).toBe(0);
    const roundTrip = JSON.parse(roundTripSpecResult.stdout) as {
      ExitCode: number;
      WindowMode: string;
    };
    expect(roundTrip).toMatchObject({ ExitCode: 0, WindowMode: "background" });
    expect(await readFile(roundTripOutput, "utf8")).toBe(roundTripValue);
  });

  it("keeps scheduled supervisor health read-only and secret-free", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-supervisor-health-task.ps1"),
      "utf8"
    );

    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain('"projects"');
    expect(script).toContain('"health"');
    expect(script).toContain('"scan"');
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("New-KaironBackgroundTaskAction");
    expect(script).toContain('"-TaskName"');
    expect(script).not.toContain("runtime start");
    expect(script).not.toContain("queue claim");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("GITHUB_TOKEN");
    expect(script).not.toContain("KAIRON_DISCORD");
  });

  runIfPowerShell("parses the scheduled supervisor health helper", async () => {
    const scriptPath = path.resolve(
      "scripts",
      "kairon-supervisor-health-task.ps1"
    );
    const result = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `[scriptblock]::Create((Get-Content -LiteralPath '${scriptPath.replaceAll("'", "''")}' -Raw)) | Out-Null`
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 10_000
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps the scheduled update task read-only and secret-free", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-update-check-task.ps1"),
      "utf8"
    );

    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain("update schedule run");
    expect(script).toContain("Test-KaironManagedTask");
    expect(script).toContain("Refusing to remove a task");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("New-KaironBackgroundTaskAction");
    expect(script).toContain("Get-ExpectedLegacyTaskArguments");
    expect(script).toContain("task.migration_required=");
    expect(script).not.toContain("update download");
    expect(script).not.toContain("update apply");
    expect(script).not.toContain("update rollback");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("GITHUB_TOKEN");
    expect(script).not.toContain("KAIRON_DISCORD");
  });

  runIfPowerShell("parses the scheduled update helper", async () => {
    const scriptPath = path.resolve(
      "scripts",
      "kairon-update-check-task.ps1"
    );
    const result = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `[scriptblock]::Create((Get-Content -LiteralPath '${scriptPath.replaceAll("'", "''")}' -Raw)) | Out-Null`
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 10_000
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps scheduled DR verification secret-free and non-restoring", async () => {
    const script = await readFile(
      path.resolve("scripts", "kairon-dr-verify-task.ps1"),
      "utf8"
    );

    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain("state backup dr schedule run");
    expect(script).toContain("Test-KaironManagedTask");
    expect(script).toContain("Refusing to remove a task");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("New-KaironBackgroundTaskAction");
    expect(script).toContain("Get-ExpectedLegacyTaskArguments");
    expect(script).toContain("task.migration_required=");
    expect(script).toContain("-MinimumGenerations");
    expect(script).not.toContain("state backup restore");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("GITHUB_TOKEN");
    expect(script).not.toContain("KAIRON_DISCORD");
  });

  runIfPowerShell("parses the scheduled DR verification helper", async () => {
    const scriptPath = path.resolve(
      "scripts",
      "kairon-dr-verify-task.ps1"
    );
    const result = spawnSync(
      powershell!,
      [
        "-NoProfile",
        "-Command",
        `[scriptblock]::Create((Get-Content -LiteralPath '${scriptPath.replaceAll("'", "''")}' -Raw)) | Out-Null`
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 10_000
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

async function readScript(): Promise<string> {
  return readFile(path.resolve("scripts", "kairon-daemon-task.ps1"), "utf8");
}

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
