import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import {
  releaseManifestCommand,
  releaseVerifyCommand
} from "../src/cli/commands/release.js";
import { createLocalBetaPackage } from "../src/release/local-beta.js";
import {
  createReleaseManifest,
  formatReleaseManifest,
  verifyReleaseManifest,
  type ReleaseManifest
} from "../src/release/release-manifest.js";

const sourceCommit = "a".repeat(40);
let outputRoot: string;
let packagePath: string;
let checksumManifestPath: string;
let releaseManifestPath: string;
let currentVersion: string;

describe("release manifest", () => {
  beforeAll(async () => {
    outputRoot = await mkdtemp(path.join(os.tmpdir(), "kairon-release-manifest-"));
    currentVersion = await readPackageVersion(path.resolve("."));
    const packed = await createPackageFixture(outputRoot, currentVersion);
    packagePath = packed.packagePath;
    checksumManifestPath = packed.manifestPath;
    const released = await createReleaseManifest(
      path.resolve("."),
      packagePath,
      checksumManifestPath,
      {
        commandRunner: cleanGitRunner,
        now: () => new Date("2026-07-22T00:01:00.000Z")
      }
    );
    releaseManifestPath = released.release_manifest_path;
  }, 60_000);

  it("binds a verified current-version package to clean source and normalized inventory", async () => {
    const manifest = JSON.parse(
      await readFile(releaseManifestPath, "utf8")
    ) as ReleaseManifest;
    const paths = manifest.package_inventory.files.map((entry) => entry.path);
    const verification = await verifyReleaseManifest(
      releaseManifestPath,
      packagePath,
      checksumManifestPath,
      {
        projectRoot: path.resolve("."),
        commandRunner: cleanGitRunner
      }
    );

    expect(manifest).toMatchObject({
      artifact_kind: "kairon_release",
      release_channel: "local_beta",
      package_version: currentVersion,
      source: {
        commit_sha: sourceCommit,
        dirty: false
      },
      runtime_support: {
        node: ">=22",
        powershell: ">=5.1"
      }
    });
    expect(paths).toEqual([...paths].sort());
    expect(manifest.package_inventory.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.artifact.checksum_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.ok).toBe(true);
    expect(verification.checks.every((entry) => entry.status === "pass")).toBe(true);
    expect(formatReleaseManifest({
      schema_version: "0.1",
      status: "created",
      release_manifest_path: releaseManifestPath,
      package_path: packagePath,
      checksum_manifest_path: checksumManifestPath,
      package_version: manifest.package_version,
      source_commit: manifest.source.commit_sha,
      artifact_sha256: manifest.artifact.sha256,
      inventory_sha256: manifest.package_inventory.sha256,
      files: manifest.package_inventory.files.length,
      verification
    })).toContain("verification.ok=true");
  });

  it("exposes release manifest creation and verification through release commands", async () => {
    const commandManifestPath = path.join(outputRoot, "command-release-manifest.json");
    const output = await releaseManifestCommand(path.resolve("."), {
      package: packagePath,
      manifest: checksumManifestPath,
      output: commandManifestPath,
      commandRunner: cleanGitRunner
    });
    const verification = await releaseVerifyCommand(packagePath, {
      manifest: checksumManifestPath,
      releaseManifest: commandManifestPath,
      commandRunner: cleanGitRunner
    }, path.resolve("."));

    expect(output).toContain("Kairon release manifest created.");
    expect(output).toContain("verification.ok=true");
    expect(verification.ok).toBe(true);
    expect(verification.text).toContain("release_manifest.verification.ok=true");
  });

  it("rejects release manifest generation from a dirty tracked worktree", async () => {
    await expect(createReleaseManifest(
      path.resolve("."),
      packagePath,
      checksumManifestPath,
      {
        commandRunner: async (invocation) => invocation.args[0] === "status"
          ? commandResult(invocation, { stdout: " M package.json\n" })
          : commandResult(invocation, { stdout: `${sourceCommit}\n` })
      }
    )).rejects.toThrow("clean tracked worktree");
  });

  it("detects release manifest inventory tampering", async () => {
    const tamperedPath = path.join(outputRoot, "release-manifest-tampered.json");
    const manifest = JSON.parse(
      await readFile(releaseManifestPath, "utf8")
    ) as ReleaseManifest;
    manifest.package_inventory.sha256 = "0".repeat(64);
    await writeFile(tamperedPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await verifyReleaseManifest(
      tamperedPath,
      packagePath,
      checksumManifestPath,
      {
        projectRoot: path.resolve("."),
        commandRunner: cleanGitRunner
      }
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "package_inventory_binding",
      status: "fail"
    }));
  });

  it("detects checksum manifest replacement even when package verification still passes", async () => {
    const replacementRoot = await mkdtemp(
      path.join(os.tmpdir(), "kairon-release-manifest-replacement-")
    );
    const copiedPackage = path.join(replacementRoot, path.basename(packagePath));
    const copiedChecksum = `${copiedPackage}.sha256.json`;
    await copyFile(packagePath, copiedPackage);
    await copyFile(checksumManifestPath, copiedChecksum);
    const released = await createReleaseManifest(
      path.resolve("."),
      copiedPackage,
      copiedChecksum,
      { commandRunner: cleanGitRunner }
    );
    const checksum = JSON.parse(await readFile(copiedChecksum, "utf8")) as {
      created_at: string;
    };
    checksum.created_at = "2030-01-01T00:00:00.000Z";
    await writeFile(copiedChecksum, `${JSON.stringify(checksum, null, 2)}\n`, "utf8");

    const result = await verifyReleaseManifest(
      released.release_manifest_path,
      copiedPackage,
      copiedChecksum,
      {
        projectRoot: path.resolve("."),
        commandRunner: cleanGitRunner
      }
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "checksum_manifest_binding",
      status: "fail"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "package_verification",
      status: "pass"
    }));
  });

  it("reproduces normalized inventory and release metadata from the same source", async () => {
    const firstOutput = await mkdtemp(path.join(os.tmpdir(), "kairon-rc-first-"));
    const secondOutput = await mkdtemp(path.join(os.tmpdir(), "kairon-rc-second-"));
    const fixedNow = () => new Date("2026-07-26T00:00:00.000Z");
    const firstPackage = await createLocalBetaPackage(
      path.resolve("."),
      { output: firstOutput, now: fixedNow }
    );
    const secondPackage = await createLocalBetaPackage(
      path.resolve("."),
      { output: secondOutput, now: fixedNow }
    );
    const [firstRelease, secondRelease] = await Promise.all([
      createReleaseManifest(
        path.resolve("."),
        firstPackage.package_path,
        firstPackage.manifest_path,
        { commandRunner: cleanGitRunner, now: fixedNow }
      ),
      createReleaseManifest(
        path.resolve("."),
        secondPackage.package_path,
        secondPackage.manifest_path,
        { commandRunner: cleanGitRunner, now: fixedNow }
      )
    ]);
    const [firstManifest, secondManifest] = await Promise.all([
      readReleaseManifest(firstRelease.release_manifest_path),
      readReleaseManifest(secondRelease.release_manifest_path)
    ]);

    expect(firstManifest.package_version).toBe(currentVersion);
    expect(secondManifest.package_version).toBe(currentVersion);
    expect(secondManifest.source).toEqual(firstManifest.source);
    expect(secondManifest.runtime_support).toEqual(firstManifest.runtime_support);
    expect(secondManifest.package_inventory).toEqual(firstManifest.package_inventory);
    expect(secondManifest.artifact.package_file).toBe(firstManifest.artifact.package_file);
    expect(secondManifest.artifact.checksum_manifest_file).toBe(
      firstManifest.artifact.checksum_manifest_file
    );
  }, 120_000);
});

const cleanGitRunner: CommandRunner = async (invocation) =>
  invocation.args[0] === "rev-parse"
    ? commandResult(invocation, { stdout: `${sourceCommit}\n` })
    : commandResult(invocation);

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

async function createPackageFixture(root: string, version: string): Promise<{
  packagePath: string;
  manifestPath: string;
}> {
  const packageMetadata = {
    name: "kairon",
    version,
    private: true,
    license: "UNLICENSED",
    bin: {
      kairon: "./dist/cli/main.js"
    },
    files: [
      "dist/",
      "scripts/local-beta-common.ps1",
      "scripts/install-local-beta.ps1",
      "scripts/update-local-beta.ps1",
      "scripts/uninstall-local-beta.ps1",
      "scripts/kairon-background-launcher.vbs",
      "scripts/kairon-task-scheduler-common.ps1",
      "scripts/kairon-daemon-task.ps1",
      "scripts/kairon-supervisor-health-task.ps1",
      "scripts/kairon-update-check-task.ps1",
      "scripts/kairon-dr-verify-task.ps1",
      "docs/installation.md",
      "README.md"
    ]
  };
  const entries = [
    { path: "package/package.json", content: `${JSON.stringify(packageMetadata)}\n` },
    { path: "package/README.md", content: "# Kairon\n" },
    { path: "package/dist/cli/main.js", content: "#!/usr/bin/env node\n" },
    { path: "package/docs/installation.md", content: "# Installation\n" },
    { path: "package/scripts/local-beta-common.ps1", content: "# common\n" },
    { path: "package/scripts/install-local-beta.ps1", content: "# install\n" },
    { path: "package/scripts/update-local-beta.ps1", content: "# update\n" },
    { path: "package/scripts/uninstall-local-beta.ps1", content: "# uninstall\n" },
    { path: "package/scripts/kairon-background-launcher.vbs", content: "' background launcher\n" },
    { path: "package/scripts/kairon-task-scheduler-common.ps1", content: "# task scheduler common\n" },
    { path: "package/scripts/kairon-daemon-task.ps1", content: "# daemon task\n" },
    { path: "package/scripts/kairon-supervisor-health-task.ps1", content: "# supervisor health task\n" },
    { path: "package/scripts/kairon-update-check-task.ps1", content: "# scheduled update\n" },
    { path: "package/scripts/kairon-dr-verify-task.ps1", content: "# scheduled DR verification\n" }
  ].map((entry) => ({
    path: entry.path,
    content: Buffer.from(entry.content, "utf8")
  }));
  const packageBytes = gzipSync(createTar(entries));
  const packagePath = path.join(root, `kairon-${version}.tgz`);
  const manifestPath = `${packagePath}.sha256.json`;
  await writeFile(packagePath, packageBytes);
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: "0.1",
    artifact_kind: "local_beta_package",
    package_name: "kairon",
    package_version: version,
    package_file: path.basename(packagePath),
    sha256: createHash("sha256").update(packageBytes).digest("hex"),
    size_bytes: packageBytes.length,
    files: entries.map((entry) => ({
      path: entry.path,
      size_bytes: entry.content.length,
      type: "file"
    })),
    created_at: "2026-07-22T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");
  return { packagePath, manifestPath };
}

async function readPackageVersion(root: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  ) as { version: string };
  return packageJson.version;
}

async function readReleaseManifest(file: string): Promise<ReleaseManifest> {
  return JSON.parse(await readFile(file, "utf8")) as ReleaseManifest;
}

function createTar(entries: Array<{ path: string; content: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.content.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((total, value) => total + value, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeTarOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
