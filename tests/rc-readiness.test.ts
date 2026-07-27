import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { attachIncidentResource } from "../src/incidents/store.js";
import {
  createRcReadinessManifest,
  evaluateRcReadiness,
  formatRcReadinessResult,
  rcReadinessGateDefinitions,
  writeRcReadinessResult,
  type RcReadinessEvidenceManifest
} from "../src/readiness/rc-readiness.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const createdAt = new Date("2026-07-25T00:00:00.000Z");
const checkedAt = new Date("2026-07-25T01:00:00.000Z");

describe("Release Candidate readiness gate", () => {
  it("passes only when every required and external required gate is current", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateRcReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.rc_ready).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.gates).toHaveLength(15);
    expect(result.gates.find(
      (gate) => gate.id === "PERFORMANCE_REGRESSION"
    )?.status).toBe("PASS");
    expect(result.gates.find(
      (gate) => gate.id === "SECURITY_INTEGRITY"
    )).toMatchObject({
      status: "PASS",
      classification: "external_required"
    });
    expect(result.gates.every((gate) => gate.status === "PASS")).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.secret_scan).toMatchObject({
      status: "passed",
      exposed_findings: 0
    });
  });

  it("separates missing external setup from missing internal evidence", async () => {
    const root = await createProject();
    const result = await evaluateRcReadiness(root, {
      sourceCommit,
      now: () => createdAt
    });

    expect(result.rc_ready).toBe(false);
    expect(result.gates.find(
      (gate) => gate.id === "GITHUB_DISTRIBUTION"
    )?.status).toBe("SETUP_REQUIRED");
    expect(result.gates.find(
      (gate) => gate.id === "BUILD_UNIT_INTEGRATION"
    )?.status).toBe("UNKNOWN");
  });

  it("rejects stale and tampered evidence", async () => {
    const staleRoot = await createCompleteManifest();
    const stale = await evaluateRcReadiness(staleRoot, {
      sourceCommit,
      now: () => new Date("2026-08-02T01:00:00.000Z")
    });
    expect(stale.rc_ready).toBe(false);
    expect(stale.gates.find(
      (gate) => gate.id === "BUILD_UNIT_INTEGRATION"
    )?.reasons).toContain("Evidence is stale.");

    const tamperedRoot = await createCompleteManifest();
    await writeFile(
      path.join(tamperedRoot, "evidence", "pass.json"),
      JSON.stringify({
        status: "UNPASSED",
        generated_at: createdAt.toISOString()
      }),
      "utf8"
    );
    const tampered = await evaluateRcReadiness(tamperedRoot, {
      sourceCommit,
      now: () => checkedAt
    });
    expect(tampered.rc_ready).toBe(false);
    expect(tampered.gates.find(
      (gate) => gate.id === "RELEASE_ARTIFACT"
    )?.reasons).toContain(
      "Evidence checksum or size does not match the manifest."
    );
  });

  it("blocks evidence bound to another source commit", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateRcReadiness(root, {
      sourceCommit: otherCommit,
      now: () => checkedAt
    });

    expect(result.rc_ready).toBe(false);
    expect(result.status).toBe("UNPASSED");
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical"
    }));
  });

  it("blocks unresolved high and critical incidents", async () => {
    const root = await createCompleteManifest();
    await attachIncidentResource(root, {
      fingerprint: "watchdog:rc-critical",
      severity: "critical",
      title: "RC runtime integrity failure",
      summary: "The recovery verification has not completed.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-RC-0001",
        status: "open"
      },
      now: createdAt
    });

    const result = await evaluateRcReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.rc_ready).toBe(false);
    expect(result.incidents.unresolved_critical).toBe(1);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "UNRESOLVED_INCIDENT",
      severity: "critical"
    }));
  });

  it("redacts secret-bearing evidence and creates a security blocker", async () => {
    const root = await createCompleteManifest();
    const manifestPath = path.join(
      root,
      ".kairon",
      "readiness",
      "rc-evidence-manifest.json"
    );
    const manifest = await readJsonFile<RcReadinessEvidenceManifest>(
      manifestPath
    );
    const simulatedCredential = [
      "github",
      "pat",
      "abcdefghijklmnopqrstuvwxyz1234567890"
    ].join("_");
    manifest.evidence[0]!.summary = `token=${simulatedCredential}`;
    await writeJsonFileAtomic(manifestPath, manifest);

    const result = await evaluateRcReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });
    const serialized = JSON.stringify(result);

    expect(result.rc_ready).toBe(false);
    expect(result.secret_scan.status).toBe("redacted");
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: "SECURITY_FINDING"
    }));
    expect(result.gates.find(
      (gate) => gate.id === "SECURITY_INTEGRITY"
    )?.status).toBe("UNPASSED");
    expect(serialized).not.toContain(simulatedCredential);
  });

  it("writes canonical JSON and operator Markdown to fixed default paths", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateRcReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });
    const jsonPath = await writeRcReadinessResult(root, result, "json");
    const markdownPath = await writeRcReadinessResult(
      root,
      result,
      "markdown"
    );
    const markdown = formatRcReadinessResult(result, "markdown");

    expect(jsonPath).toBe(".kairon/readiness/rc-result.json");
    expect(markdownPath).toBe(".kairon/readiness/rc-report.md");
    expect(JSON.parse(await readFile(path.join(root, jsonPath), "utf8")))
      .toMatchObject({ rc_ready: true, artifact_kind: "rc_readiness_result" });
    expect(markdown).toContain(
      "# Kairon Release Candidate Readiness Report"
    );
    expect(markdown).toContain("GITHUB_DISTRIBUTION");
    expect(markdown).toContain("Global Blockers");
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function createCompleteManifest(): Promise<string> {
  const root = await createProject();
  await mkdir(path.join(root, "evidence"), { recursive: true });
  await writeFile(
    path.join(root, "evidence", "pass.json"),
    `${JSON.stringify({
      schema_version: "0.1",
      artifact_kind: "test_evidence",
      status: "PASS",
      generated_at: createdAt.toISOString(),
      source_commit: sourceCommit
    }, null, 2)}\n`,
    "utf8"
  );
  await createRcReadinessManifest(root, {
    evidence: rcReadinessGateDefinitions.map(
      (definition) => `${definition.id}=evidence/pass.json`
    ),
    sourceCommit,
    now: () => createdAt
  });
  return root;
}
