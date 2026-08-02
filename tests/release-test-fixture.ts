import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  calculateReleaseInventorySha256,
  normalizeReleaseInventory,
  type ReleaseInventoryEntry,
  type ReleaseManifest
} from "../src/release/release-manifest.js";
import { createReleaseProvenance } from "../src/release/provenance.js";
import { createReleaseSbom } from "../src/release/sbom.js";
import type { CommandRunner } from "../src/agents/command-runner.js";

export async function createReleaseBundleFixture(
  projectRoot: string,
  sourceCommit: string,
  version = "0.2.0"
): Promise<{
  artifactRoot: string;
  packagePath: string;
  checksumPath: string;
  releaseManifestPath: string;
}> {
  const artifactRoot = path.join(projectRoot, "release-artifacts", version);
  await mkdir(artifactRoot, { recursive: true });
  const packageMetadata = {
    name: "kairon",
    version,
    private: true,
    license: "UNLICENSED",
    bin: { kairon: "./dist/cli/main.js" },
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
  const packagePath = path.join(artifactRoot, `kairon-${version}.tgz`);
  const checksumPath = `${packagePath}.sha256.json`;
  const packageInventory: ReleaseInventoryEntry[] = entries.map((entry) => ({
    path: entry.path,
    size_bytes: entry.content.length,
    type: "file"
  }));
  const checksum = {
    schema_version: "0.1",
    artifact_kind: "local_beta_package",
    package_name: "kairon",
    package_version: version,
    package_file: path.basename(packagePath),
    sha256: sha256(packageBytes),
    size_bytes: packageBytes.length,
    files: packageInventory,
    created_at: "2026-07-22T00:00:00.000Z"
  };
  const checksumBytes = Buffer.from(`${JSON.stringify(checksum, null, 2)}\n`, "utf8");
  const inventory = normalizeReleaseInventory(packageInventory);
  const releaseManifestPath = path.join(artifactRoot, "release-manifest.json");
  const releaseManifest: ReleaseManifest = {
    schema_version: "0.1",
    artifact_kind: "kairon_release",
    release_channel: "local_beta",
    package_name: "kairon",
    package_version: version,
    source: { commit_sha: sourceCommit, dirty: false },
    runtime_support: {
      operating_systems: ["windows_10_11", "windows_server"],
      node: ">=22",
      npm: "required",
      powershell: ">=5.1",
      git: "required"
    },
    artifact: {
      package_file: path.basename(packagePath),
      checksum_manifest_file: path.basename(checksumPath),
      sha256: checksum.sha256,
      size_bytes: packageBytes.length,
      checksum_manifest_sha256: sha256(checksumBytes)
    },
    package_inventory: {
      sha256: calculateReleaseInventorySha256(inventory),
      files: inventory
    },
    created_at: "2026-07-22T00:01:00.000Z"
  };
  await Promise.all([
    writeFile(packagePath, packageBytes),
    writeFile(checksumPath, checksumBytes),
    writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8")
  ]);
  return { artifactRoot, packagePath, checksumPath, releaseManifestPath };
}

export async function createAttestedReleaseBundleFixture(
  projectRoot: string,
  sourceCommit: string,
  version = "0.2.0"
): Promise<Awaited<ReturnType<typeof createReleaseBundleFixture>> & {
  sbomPath: string;
  provenancePath: string;
}> {
  const bundle = await createReleaseBundleFixture(projectRoot, sourceCommit, version);
  await writeFile(
    path.join(projectRoot, "package-lock.json"),
    `${JSON.stringify({
      name: "kairon",
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "kairon",
          version,
          license: "UNLICENSED"
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  const sbomPath = path.join(bundle.artifactRoot, "sbom.cdx.json");
  const provenancePath = path.join(bundle.artifactRoot, "provenance.json");
  const runner = fixtureCommandRunner(sourceCommit);
  const sbom = await createReleaseSbom(projectRoot, bundle.checksumPath, {
    output: sbomPath
  });
  const provenance = await createReleaseProvenance(
    projectRoot,
    bundle.packagePath,
    bundle.checksumPath,
    sbomPath,
    {
      output: provenancePath,
      commandRunner: runner,
      npmVersion: "10.9.2",
      nodeVersion: "v22.17.0",
      now: () => new Date("2026-07-22T00:00:30.000Z")
    }
  );
  const manifest = JSON.parse(
    await readFile(bundle.releaseManifestPath, "utf8")
  ) as ReleaseManifest;
  manifest.attestations = {
    sbom: {
      file: path.basename(sbomPath),
      format: "cyclonedx-json",
      schema_version: "1.6",
      sha256: sbom.sha256,
      size_bytes: sbom.size_bytes
    },
    provenance: {
      file: path.basename(provenancePath),
      format: "kairon-local-build-provenance",
      schema_version: "0.1",
      sha256: provenance.sha256,
      size_bytes: provenance.size_bytes
    }
  };
  await writeFile(
    bundle.releaseManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return { ...bundle, sbomPath, provenancePath };
}

function fixtureCommandRunner(sourceCommit: string): CommandRunner {
  return async (invocation) => {
    const stdout = invocation.command === "git" && invocation.args[0] === "rev-parse"
      ? `${sourceCommit}\n`
      : invocation.command === "npm"
        ? "10.9.2\n"
        : "";
    return {
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      pid: 1,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      startedAt: "2026-07-22T00:00:00.000Z",
      finishedAt: "2026-07-22T00:00:01.000Z",
      timedOut: false
    };
  };
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
