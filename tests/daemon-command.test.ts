import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { daemonTaskCommand } from "../src/cli/commands/daemon.js";

describe("daemonTaskCommand", () => {
  it("returns setup guidance without invoking PowerShell outside Windows", async () => {
    const invocations: CliInvocation[] = [];

    const output = await daemonTaskCommand("/tmp/project", "status", {
      platform: "linux",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation);
      }
    });

    expect(output).toContain("status=setup_required");
    expect(output).toContain("reason=windows_task_scheduler_required");
    expect(invocations).toHaveLength(0);
  });

  it("delegates an install dry run with fixed non-secret arguments", async () => {
    const invocations: CliInvocation[] = [];
    const projectRoot = "C:\\work\\project";

    const output = await daemonTaskCommand(projectRoot, "install", {
      platform: "win32",
      taskName: "Kairon Runtime Test",
      kaironCommand: "kairon",
      intervalMs: "30000",
      logRoot: "C:\\work\\logs",
      atStartup: true,
      dryRun: true,
      helperPath: "C:\\kairon\\scripts\\kairon-daemon-task.ps1",
      powerShellCommand: "pwsh.exe",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation, {
          stdout: [
            "dry_run=true",
            "task.action=register",
            "secret_values=not_in_task_arguments"
          ].join("\n")
        });
      }
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      command: "pwsh.exe",
      cwd: projectRoot,
      timeoutMs: 120_000
    });
    expect(invocations[0]?.env).toBeUndefined();
    expect(invocations[0]?.args).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\kairon\\scripts\\kairon-daemon-task.ps1",
      "-Action",
      "Register",
      "-TaskName",
      "Kairon Runtime Test",
      "-ProjectRoot",
      projectRoot,
      "-KaironCommand",
      "kairon",
      "-IntervalMs",
      "30000",
      "-LogRoot",
      "C:\\work\\logs",
      "-AtStartup",
      "-DryRun"
    ]);
    expect(invocations[0]?.args.join(" ")).not.toContain("GH_TOKEN");
    expect(invocations[0]?.args.join(" ")).not.toContain("KAIRON_DISCORD_BOT_TOKEN");
    expect(output).toContain("status=completed");
    expect(output).toContain("action=install");
    expect(output).toContain("dry_run=true");
  });

  it("treats a missing scheduled task status as a successful result", async () => {
    const output = await daemonTaskCommand("C:\\work\\project", "status", {
      platform: "win32",
      helperPath: "C:\\kairon\\scripts\\kairon-daemon-task.ps1",
      commandRunner: async (invocation) =>
        commandResult(invocation, { stdout: "task.exists=false\n" })
    });

    expect(output).toContain("status=completed");
    expect(output).toContain("task.exists=false");
  });

  it("delegates uninstall dry runs without mutation arguments", async () => {
    const invocations: CliInvocation[] = [];

    await daemonTaskCommand("C:\\work\\project", "uninstall", {
      platform: "win32",
      dryRun: true,
      helperPath: "C:\\kairon\\scripts\\kairon-daemon-task.ps1",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation, { stdout: "task.mutation=skipped\n" });
      }
    });

    expect(invocations[0]?.args).toContain("Unregister");
    expect(invocations[0]?.args).toContain("-DryRun");
    expect(invocations[0]?.args).not.toContain("-KaironCommand");
  });

  it("rejects invalid install intervals before invoking PowerShell", async () => {
    const invocations: CliInvocation[] = [];

    await expect(
      daemonTaskCommand("C:\\work\\project", "install", {
        platform: "win32",
        intervalMs: "0",
        commandRunner: async (invocation) => {
          invocations.push(invocation);
          return commandResult(invocation);
        }
      })
    ).rejects.toThrow("Invalid interval-ms: 0");
    expect(invocations).toHaveLength(0);
  });

  it("redacts secret-like helper errors", async () => {
    await expect(
      daemonTaskCommand("C:\\work\\project", "restart", {
        platform: "win32",
        helperPath: "C:\\kairon\\scripts\\kairon-daemon-task.ps1",
        commandRunner: async (invocation) =>
          commandResult(invocation, {
            exitCode: 1,
            stderr: "token=should-not-leak"
          })
      })
    ).rejects.toThrow("token=[redacted]");
  });
});

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
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    timedOut: false,
    ...overrides
  };
}
