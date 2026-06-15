import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("kairon-daemon-task.ps1", () => {
  it("documents safe Task Scheduler actions without embedding secret env names", async () => {
    const script = await readScript();

    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain("Start-ScheduledTask");
    expect(script).toContain("Stop-ScheduledTask");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain("start --daemon --interval-ms");
    expect(script).toContain("Secrets are read from user environment variables.");
    expect(script).not.toContain("KAIRON_DISCORD_BOT_TOKEN");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("GITHUB_TOKEN");
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
