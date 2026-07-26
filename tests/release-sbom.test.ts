import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createReleaseSbom,
  type ReleaseSbom,
  verifyReleaseSbom
} from "../src/release/sbom.js";

describe("release SBOM", () => {
  let root: string;
  let checksumPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kairon-release-sbom-"));
    checksumPath = path.join(root, "kairon-0.3.0.tgz.sha256.json");
    await writeFixture(root, checksumPath);
  });

  it("creates a deterministic CycloneDX inventory with normalized dependency facts", async () => {
    const firstPath = path.join(root, "first.cdx.json");
    const secondPath = path.join(root, "second.cdx.json");
    const first = await createReleaseSbom(root, checksumPath, { output: firstPath });
    const second = await createReleaseSbom(root, checksumPath, { output: secondPath });
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(firstPath),
      readFile(secondPath)
    ]);
    const sbom = JSON.parse(firstBytes.toString("utf8")) as ReleaseSbom;
    const direct = sbom.components.find((entry) => entry.purl === "pkg:npm/direct@1.0.0");
    const development = sbom.components.find(
      (entry) => entry.purl === "pkg:npm/dev-only@2.0.0"
    );
    const duplicate = sbom.components.filter(
      (entry) => entry.purl === "pkg:npm/shared@3.0.0"
    );

    expect(first.verification.ok).toBe(true);
    expect(second.verification.ok).toBe(true);
    expect(secondBytes).toEqual(firstBytes);
    expect(sbom).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          name: "kairon",
          version: "0.3.0"
        }
      }
    });
    expect(direct?.properties).toContainEqual({
      name: "kairon:dependency-depth",
      value: "direct"
    });
    expect(direct?.properties).toContainEqual({
      name: "kairon:dependency-environment",
      value: "runtime"
    });
    expect(direct?.licenses).toEqual([{ license: { id: "MIT" } }]);
    expect(direct?.hashes?.[0]).toMatchObject({ alg: "SHA-512" });
    expect(development?.properties).toContainEqual({
      name: "kairon:dependency-environment",
      value: "development"
    });
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.scope).toBe("required");
  });

  it("detects package-lock drift after SBOM generation", async () => {
    const output = path.join(root, "sbom.cdx.json");
    await createReleaseSbom(root, checksumPath, { output });
    const lock = JSON.parse(
      await readFile(path.join(root, "package-lock.json"), "utf8")
    ) as { packages: Record<string, { version?: string }> };
    lock.packages["node_modules/direct"]!.version = "1.0.1";
    await writeFile(
      path.join(root, "package-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
      "utf8"
    );

    const verification = await verifyReleaseSbom(output, {
      projectRoot: root,
      checksumManifest: checksumPath
    });

    expect(verification.ok).toBe(false);
    expect(verification.checks).toContainEqual(expect.objectContaining({
      id: "package_lock_binding",
      status: "fail"
    }));
  });

  it("does not serialize local paths or credential-like fields", async () => {
    const output = path.join(root, "sbom.cdx.json");
    await createReleaseSbom(root, checksumPath, { output });
    const serialized = await readFile(output, "utf8");

    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/(?:token|password|secret|authorization)/iu);
  });
});

async function writeFixture(root: string, checksumPath: string): Promise<void> {
  const integrity = `sha512-${Buffer.from("fixture-integrity").toString("base64")}`;
  await Promise.all([
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
        "node_modules/direct": {
          version: "1.0.0",
          integrity,
          license: "MIT"
        },
        "node_modules/dev-only": {
          version: "2.0.0",
          dev: true,
          integrity,
          license: "Apache-2.0"
        },
        "node_modules/shared": {
          version: "3.0.0",
          optional: true,
          integrity,
          license: "ISC"
        },
        "node_modules/direct/node_modules/shared": {
          version: "3.0.0",
          integrity,
          license: "ISC"
        },
        "node_modules/@scope/library": {
          version: "4.0.0",
          integrity,
          license: "BSD-3-Clause"
        }
      }
    }, null, 2)}\n`, "utf8"),
    writeFile(checksumPath, `${JSON.stringify({
      schema_version: "0.1",
      artifact_kind: "local_beta_package",
      package_name: "kairon",
      package_version: "0.3.0",
      package_file: "kairon-0.3.0.tgz",
      sha256: "a".repeat(64),
      size_bytes: 1,
      files: [
        { path: "package/package.json", size_bytes: 100, type: "file" },
        { path: "package/dist/cli/main.js", size_bytes: 200, type: "file" }
      ],
      created_at: "2026-07-26T00:00:00.000Z"
    }, null, 2)}\n`, "utf8")
  ]);
}
