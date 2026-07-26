import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import {
  releaseProvenanceCommand,
  releaseSbomCommand
} from "../src/cli/commands/release.js";
import {
  createReleaseProvenance,
  type ReleaseProvenance,
  verifyReleaseProvenance
} from "../src/release/provenance.js";
import {
  createReleaseManifest,
  type ReleaseManifest,
  verifyReleaseManifest
} from "../src/release/release-manifest.js";
import { createReleaseSbom } from "../src/release/sbom.js";
import { createReleaseBundleFixture } from "./release-test-fixture.js";

const sourceCommit = "d".repeat(40);

describe("release provenance", () => {
  let root: string;
  let packagePath: string;
  let checksumPath: string;
  let sbomPath: string;
  let provenancePath: string;
  let releaseManifestPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kairon-release-provenance-"));
    await writeProjectMetadata(root);
    const bundle = await createReleaseBundleFixture(root, sourceCommit, "0.3.0");
    packagePath = bundle.packagePath;
    checksumPath = bundle.checksumPath;
    sbomPath = path.join(bundle.artifactRoot, "sbom.cdx.json");
    provenancePath = path.join(bundle.artifactRoot, "provenance.json");
    releaseManifestPath = path.join(bundle.artifactRoot, "release-manifest-v2.json");
    await createReleaseSbom(root, checksumPath, { output: sbomPath });
    await createReleaseProvenance(
      root,
      packagePath,
      checksumPath,
      sbomPath,
      {
        output: provenancePath,
        commandRunner: cleanRunner,
        nodeVersion: "v22.17.0",
        npmVersion: "10.9.2",
        now: fixedNow
      }
    );
    await createReleaseManifest(root, packagePath, checksumPath, {
      output: releaseManifestPath,
      sbom: sbomPath,
      provenance: provenancePath,
      commandRunner: cleanRunner,
      now: fixedNow
    });
  });

  it("binds local build facts and attestations without host-specific data", async () => {
    const [provenance, manifest, provenanceVerification, manifestVerification] =
      await Promise.all([
        readJson<ReleaseProvenance>(provenancePath),
        readJson<ReleaseManifest>(releaseManifestPath),
        verifyReleaseProvenance(provenancePath, {
          projectRoot: root,
          package: packagePath,
          checksumManifest: checksumPath,
          sbom: sbomPath,
          commandRunner: cleanRunner
        }),
        verifyReleaseManifest(releaseManifestPath, packagePath, checksumPath, {
          projectRoot: root,
          commandRunner: cleanRunner
        })
      ]);
    const serialized = await readFile(provenancePath, "utf8");

    expect(provenance).toMatchObject({
      artifact_kind: "kairon_local_build_provenance",
      package_version: "0.3.0",
      source: { commit_sha: sourceCommit, dirty: false },
      build: {
        command_id: "npm_run_release_pack",
        node_version: "v22.17.0",
        npm_version: "10.9.2"
      }
    });
    expect(provenance.subjects.map((entry) => entry.kind).sort()).toEqual([
      "checksum_manifest",
      "package",
      "sbom"
    ]);
    expect(manifest.attestations).toMatchObject({
      sbom: {
        file: "sbom.cdx.json",
        format: "cyclonedx-json",
        schema_version: "1.6"
      },
      provenance: {
        file: "provenance.json",
        format: "kairon-local-build-provenance",
        schema_version: "0.1"
      }
    });
    expect(provenanceVerification.ok).toBe(true);
    expect(manifestVerification.ok).toBe(true);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/(?:token|password|secret|authorization)/iu);
  });

  it("rejects replaced provenance source and SBOM content", async () => {
    const provenance = await readJson<ReleaseProvenance>(provenancePath);
    provenance.source.commit_sha = "e".repeat(40);
    await writeFile(
      provenancePath,
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8"
    );
    const replacedProvenance = await verifyReleaseProvenance(provenancePath, {
      projectRoot: root,
      package: packagePath,
      checksumManifest: checksumPath,
      sbom: sbomPath,
      commandRunner: cleanRunner
    });
    expect(replacedProvenance.ok).toBe(false);
    expect(replacedProvenance.checks).toContainEqual(expect.objectContaining({
      id: "source_identity",
      status: "fail"
    }));

    const sbom = await readJson<Record<string, unknown>>(sbomPath);
    sbom.version = 2;
    await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
    const manifestVerification = await verifyReleaseManifest(
      releaseManifestPath,
      packagePath,
      checksumPath,
      { projectRoot: root, commandRunner: cleanRunner }
    );
    expect(manifestVerification.ok).toBe(false);
    expect(manifestVerification.checks).toContainEqual(expect.objectContaining({
      id: "sbom_binding",
      status: "fail"
    }));
    expect(manifestVerification.checks).toContainEqual(expect.objectContaining({
      id: "provenance_binding",
      status: "fail"
    }));
  });

  it("exposes SBOM and provenance creation through release commands", async () => {
    const commandSbom = path.join(path.dirname(packagePath), "command-sbom.cdx.json");
    const commandProvenance = path.join(
      path.dirname(packagePath),
      "command-provenance.json"
    );
    const sbomOutput = await releaseSbomCommand(root, {
      manifest: checksumPath,
      output: commandSbom
    });
    const provenanceOutput = await releaseProvenanceCommand(root, {
      package: packagePath,
      manifest: checksumPath,
      sbom: commandSbom,
      output: commandProvenance,
      commandRunner: cleanRunner,
      nodeVersion: "v22.17.0",
      npmVersion: "10.9.2",
      now: fixedNow
    });

    expect(sbomOutput).toContain("Kairon release SBOM created.");
    expect(sbomOutput).toContain("verification.ok=true");
    expect(provenanceOutput).toContain("Kairon release provenance created.");
    expect(provenanceOutput).toContain("verification.ok=true");
  });
});

const fixedNow = () => new Date("2026-07-26T00:00:00.000Z");

const cleanRunner: CommandRunner = async (invocation) => {
  if (invocation.args[0] === "rev-parse") {
    return commandResult(invocation, { stdout: `${sourceCommit}\n` });
  }
  if (invocation.args[0] === "--version") {
    return commandResult(invocation, { stdout: "10.9.2\n" });
  }
  return commandResult(invocation);
};

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
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

async function writeProjectMetadata(root: string): Promise<void> {
  const integrity = `sha512-${Buffer.from("fixture").toString("base64")}`;
  await Promise.all([
    writeFile(path.join(root, "package.json"), `${JSON.stringify({
      name: "kairon",
      version: "0.3.0",
      private: true,
      license: "UNLICENSED",
      engines: { node: ">=22" }
    }, null, 2)}\n`, "utf8"),
    writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
      name: "kairon",
      version: "0.3.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "kairon",
          version: "0.3.0",
          license: "UNLICENSED"
        },
        "node_modules/fixture": {
          version: "1.0.0",
          integrity,
          license: "MIT"
        }
      }
    }, null, 2)}\n`, "utf8")
  ]);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
