import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalBetaPackage,
  formatLocalBetaVerification,
  verifyLocalBetaPackage
} from "../src/release/local-beta.js";

const powershell = findPowerShell();
const runIfPowerShell = powershell === undefined ? it.skip : it;

describe("local release package", () => {
  it("packs and verifies only the fixed private local release file set", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "kairon-local-beta-pack-"));
    const result = await createLocalBetaPackage(path.resolve("."), {
      output,
      now: () => new Date("2026-07-16T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "created",
      package_name: "kairon",
      package_version: "0.3.0",
      verification: { ok: true }
    });
    expect(result.files).toBeGreaterThan(10);
    expect(result.verification.checks.every((check) => check.status === "pass")).toBe(
      true
    );
    const manifest = JSON.parse(
      await readFile(result.manifest_path, "utf8")
    ) as { files: Array<{ path: string }> };
    const paths = manifest.files.map((entry) => entry.path);
    expect(paths).toContain("package/dist/cli/main.js");
    expect(paths).toContain("package/docs/installation.md");
    expect(paths).not.toContain("package/tests/local-beta-package.test.ts");
    expect(paths.some((entry) => entry.startsWith("package/.kairon/"))).toBe(false);
    expect(paths.some((entry) => entry.startsWith("package/operation-test-results/"))).toBe(
      false
    );
  }, 60_000);

  it("fails verification when the checksum manifest is changed", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "kairon-local-beta-tamper-"));
    const packed = await createLocalBetaPackage(path.resolve("."), { output });
    const manifest = JSON.parse(
      await readFile(packed.manifest_path, "utf8")
    ) as Record<string, unknown>;
    manifest.sha256 = "0".repeat(64);
    await writeFile(packed.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await verifyLocalBetaPackage(
      packed.package_path,
      packed.manifest_path
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "package_sha256", status: "fail" })
    );
    expect(formatLocalBetaVerification(result)).toContain("verification.ok=false");
  }, 60_000);

  it("keeps package metadata private and allowlisted", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
      private: boolean;
      license: string;
      files: string[];
      scripts: Record<string, string>;
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe("UNLICENSED");
    expect(packageJson.files).toEqual([
      "dist/",
      "scripts/local-beta-common.ps1",
      "scripts/install-local-beta.ps1",
      "scripts/update-local-beta.ps1",
      "scripts/uninstall-local-beta.ps1",
      "scripts/kairon-update-check-task.ps1",
      "docs/installation.md",
      "README.md"
    ]);
    expect(packageJson.scripts["release:pack"]).toContain("release pack");
  });

  runIfPowerShell("parses all lifecycle scripts and runs non-mutating dry runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-local-beta-script-"));
    const packagePath = path.join(root, "kairon-0.1.0.tgz");
    const packageBytes = Buffer.from("local beta fixture", "utf8");
    await writeFile(packagePath, packageBytes);
    await writeFile(
      `${packagePath}.sha256.json`,
      `${JSON.stringify({
        schema_version: "0.1",
        artifact_kind: "local_beta_package",
        package_name: "kairon",
        package_version: "0.1.0",
        package_file: path.basename(packagePath),
        sha256: createHash("sha256").update(packageBytes).digest("hex"),
        size_bytes: packageBytes.length,
        files: [],
        created_at: "2026-07-16T00:00:00.000Z"
      })}\n`,
      "utf8"
    );

    for (const script of [
      "local-beta-common.ps1",
      "install-local-beta.ps1",
      "update-local-beta.ps1",
      "uninstall-local-beta.ps1",
      "kairon-update-check-task.ps1"
    ]) {
      const scriptPath = path.resolve("scripts", script);
      const parsed = spawnSync(
        powershell!,
        [
          "-NoProfile",
          "-Command",
          `[scriptblock]::Create((Get-Content -LiteralPath '${escapePowerShell(scriptPath)}' -Raw)) | Out-Null`
        ],
        { encoding: "utf8", timeout: 10_000 }
      );
      expect(parsed.status, `${script}: ${parsed.stderr}`).toBe(0);
    }

    const install = runPowerShellScript("install-local-beta.ps1", [
      "-Package",
      packagePath,
      "-DryRun"
    ]);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain(
      "install.action=would_stage_verify_and_install_global_package"
    );

    const uninstall = runPowerShellScript("uninstall-local-beta.ps1", [
      "-ProjectRoot",
      root,
      "-DryRun"
    ]);
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).toContain("project_state_action=preserve");
    expect(uninstall.stdout).toContain(
      "uninstall.action=would_remove_global_package_only"
    );
  }, 30_000);

  runIfPowerShell("accepts native stderr when the process exits successfully", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-local-beta-stderr-"));
    const childScript = path.join(root, "native-stderr-success.ps1");
    const probeScript = path.join(root, "invoke-probe.ps1");
    await writeFile(
      childScript,
      '[Console]::Error.WriteLine("npm notice"); exit 0\n',
      "utf8"
    );
    await writeFile(
      probeScript,
      [
        '$ErrorActionPreference = "Stop"',
        `. '${escapePowerShell(path.resolve("scripts", "local-beta-common.ps1"))}'`,
        `$output = Invoke-KaironLocalBetaCommand -Command '${escapePowerShell(powershell!)}' -Arguments @('-NoProfile', '-File', '${escapePowerShell(childScript)}')`,
        '$output | ForEach-Object { Write-Output $_ }',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = spawnSync(
      powershell!,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probeScript],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("npm notice");
  }, 30_000);

  it("documents rollback and never removes project state directly", async () => {
    const [update, uninstall, installation] = await Promise.all([
      readFile(path.resolve("scripts", "update-local-beta.ps1"), "utf8"),
      readFile(path.resolve("scripts", "uninstall-local-beta.ps1"), "utf8"),
      readFile(path.resolve("docs", "installation.md"), "utf8")
    ]);

    expect(update).toContain("state\", \"backup\", \"create");
    expect(update).toContain("ReleaseManifest");
    expect(update).toContain("--release-manifest");
    expect(update).toContain("--verification-context");
    expect(update).toContain("\"consumer\"");
    expect(update).toContain("rollback_package_restored");
    expect(update).toContain("state\", \"backup\", \"restore");
    expect(update).toContain("doctor.ok=true");
    expect(update).toContain("transaction.staging_health=passed");
    expect(update).toContain("transaction.switch=completed");
    expect(update).toContain("transaction.post_check=passed");
    expect(update).toContain("rollback.status=");
    expect(update).toContain("rollback_package_sha256");
    expect(update).toContain("ApproveSchemaMigration");
    expect(update).toContain('@("migrate", "plan")');
    expect(update).toContain('"migrate", "apply", $migrationPlanId');
    expect(uninstall).toContain("npm_uninstall");
    expect(uninstall).not.toMatch(/Remove-Item[^\n]+\.kairon/iu);
    expect(installation).toContain("public npm registryへpublishせず");
    expect(installation).toContain("diagnostic_bundle");
  });
});

function runPowerShellScript(script: string, args: string[]) {
  return spawnSync(
    powershell!,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts", script),
      ...args
    ],
    { cwd: path.resolve("."), encoding: "utf8", timeout: 20_000 }
  );
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function findPowerShell(): string | undefined {
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(
      command,
      ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      { encoding: "utf8" }
    );
    if (result.status === 0) {
      return command;
    }
  }
  return undefined;
}
