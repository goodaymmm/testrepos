import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import { releaseVerifyCommand } from "../src/cli/commands/release.js";
import {
  type ReleaseManifest,
  verifyReleaseManifest
} from "../src/release/release-manifest.js";
import type { ReleaseProvenance } from "../src/release/provenance.js";
import {
  createAttestedReleaseBundleFixture
} from "./release-test-fixture.js";

const sourceCommit = "a".repeat(40);
const consumerCommit = "b".repeat(40);

describe("consumer release verification", () => {
  let sourceRoot: string;
  let consumerRoot: string;
  let bundle: Awaited<ReturnType<typeof createAttestedReleaseBundleFixture>>;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), "kairon-release-source-"));
    consumerRoot = await mkdtemp(path.join(os.tmpdir(), "kairon-release-consumer-"));
    bundle = await createAttestedReleaseBundleFixture(
      sourceRoot,
      sourceCommit,
      "0.3.0"
    );
  });

  it("verifies an attested bundle from an unrelated consumer without reading its Git tree", async () => {
    const verification = await verifyReleaseManifest(
      bundle.releaseManifestPath,
      bundle.packagePath,
      bundle.checksumPath,
      {
        projectRoot: consumerRoot,
        verificationContext: "consumer"
      }
    );
    const command = await releaseVerifyCommand(bundle.packagePath, {
      manifest: bundle.checksumPath,
      releaseManifest: bundle.releaseManifestPath,
      verificationContext: "consumer"
    }, consumerRoot);

    expect(verification.ok).toBe(true);
    expect(verification.verification_context).toBe("consumer");
    expect(verification.checks).toContainEqual(expect.objectContaining({
      id: "source_tree_check",
      status: "pass"
    }));
    expect(verification.checks).toContainEqual(expect.objectContaining({
      id: "artifact_source_binding",
      status: "pass"
    }));
    expect(command.ok).toBe(true);
    expect(command.text).toContain("verification_context=consumer");
  });

  it("keeps source verification bound to the selected clean tracked tree", async () => {
    const verification = await verifyReleaseManifest(
      bundle.releaseManifestPath,
      bundle.packagePath,
      bundle.checksumPath,
      {
        projectRoot: consumerRoot,
        commandRunner: gitRunner(consumerCommit)
      }
    );

    expect(verification.ok).toBe(false);
    expect(verification.verification_context).toBe("source");
    expect(verification.checks).toContainEqual(expect.objectContaining({
      id: "source_tree_check",
      status: "fail"
    }));
  });

  it("rejects a provenance source replacement even when manifest digest metadata is replaced", async () => {
    const provenance = await readJson<ReleaseProvenance>(bundle.provenancePath);
    provenance.source.commit_sha = consumerCommit;
    const provenanceBytes = Buffer.from(
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8"
    );
    await writeFile(bundle.provenancePath, provenanceBytes);

    const manifest = await readJson<ReleaseManifest>(bundle.releaseManifestPath);
    manifest.attestations!.provenance.sha256 = sha256(provenanceBytes);
    manifest.attestations!.provenance.size_bytes =
      (await stat(bundle.provenancePath)).size;
    await writeFile(
      bundle.releaseManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const verification = await verifyConsumer(bundle, consumerRoot);

    expect(verification.ok).toBe(false);
    expect(verification.checks).toContainEqual(expect.objectContaining({
      id: "artifact_source_binding",
      status: "fail"
    }));
    expect(JSON.stringify(verification.checks)).not.toContain(consumerRoot);
  });

  it("rejects package and SBOM replacement in consumer context", async () => {
    await writeFile(bundle.packagePath, "tampered package", "utf8");
    const packageVerification = await verifyConsumer(bundle, consumerRoot);
    expect(packageVerification.ok).toBe(false);
    expect(packageVerification.checks).toContainEqual(expect.objectContaining({
      id: "package_verification",
      status: "fail"
    }));

    bundle = await createAttestedReleaseBundleFixture(
      sourceRoot,
      sourceCommit,
      "0.3.0"
    );
    const sbom = await readJson<Record<string, unknown>>(bundle.sbomPath);
    sbom.version = 2;
    await writeFile(bundle.sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
    const sbomVerification = await verifyConsumer(bundle, consumerRoot);
    expect(sbomVerification.ok).toBe(false);
    expect(sbomVerification.checks).toContainEqual(expect.objectContaining({
      id: "sbom_binding",
      status: "fail"
    }));
  });
});

function verifyConsumer(
  bundle: Awaited<ReturnType<typeof createAttestedReleaseBundleFixture>>,
  consumerRoot: string
) {
  return verifyReleaseManifest(
    bundle.releaseManifestPath,
    bundle.packagePath,
    bundle.checksumPath,
    {
      projectRoot: consumerRoot,
      verificationContext: "consumer"
    }
  );
}

function gitRunner(commit: string): CommandRunner {
  return async (invocation) =>
    commandResult(invocation, {
      stdout: invocation.args[0] === "rev-parse" ? `${commit}\n` : ""
    });
}

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
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
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
