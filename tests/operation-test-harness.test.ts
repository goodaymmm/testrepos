import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTempProject } from "./test-utils.js";

const powershell = findPowerShell();
const runIfPowerShell = powershell ? it : it.skip;

describe("kairon-operation-test.ps1", () => {
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
    expect(summary.summary).toEqual({ pass: 1, fail: 0, total: 1 });
    expect(summary.results[0]).toMatchObject({
      id: "DOCTOR",
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

async function writeFakeKairon(binRoot: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(
      path.join(binRoot, "kairon.cmd"),
      [
        "@echo off",
        "if \"%1\"==\"doctor\" (",
        "  echo doctor.ok=true",
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
