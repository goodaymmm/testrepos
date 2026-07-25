import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  evaluateBetaReadiness,
  formatBetaReadinessReport,
  writeBetaReadinessReport
} from "../src/readiness/beta-readiness.js";
import {
  createReadinessEvidenceManifest,
  detectReadinessEvidenceStatus,
  readinessGateDefinitions,
  type ReadinessEvidenceManifest
} from "../src/readiness/evidence-manifest.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const createdAt = new Date("2026-07-18T00:00:00.000Z");

describe("Beta readiness gate", () => {
  it("does not let a completed wrapper hide failing summary results", () => {
    expect(detectReadinessEvidenceStatus(JSON.stringify({
      status: "completed",
      summary: { pass: 2, fail: 1, total: 3 }
    }))).toBe("UNPASSED");
  });

  it("recognizes successful lifecycle artifact statuses", () => {
    for (const status of [
      "verified",
      "published",
      "applied",
      "executed",
      "healthy",
      "resolved",
      "enforced"
    ]) {
      expect(detectReadinessEvidenceStatus(JSON.stringify({ status }))).toBe(
        "PASS"
      );
    }
  });

  it("passes only when every required gate has current verified PASS evidence", async () => {
    const root = await createCompleteManifest();
    const report = await evaluateBetaReadiness(root, {
      sourceCommit,
      now: () => new Date("2026-07-18T01:00:00.000Z")
    });

    expect(report.ready).toBe(true);
    expect(report.status).toBe("PASS");
    expect(report.gates.filter((gate) => gate.required).every((gate) => gate.status === "PASS")).toBe(true);
    expect(report.gates.find((gate) => gate.id === "KNOWN_LIMITATIONS")?.status).toBe("OPTIONAL");
    expect(report.secret_scan).toMatchObject({ status: "passed", exposed_findings: 0 });
  });

  it("keeps missing external setup separate from unknown internal evidence", async () => {
    const root = await createTempProject();
    const report = await evaluateBetaReadiness(root, { sourceCommit, now: () => createdAt });

    expect(report.ready).toBe(false);
    expect(report.manifest.status).toBe("missing");
    expect(report.gates.find((gate) => gate.id === "GITHUB_MERGE_DEPLOY_GUARD")?.status).toBe("SETUP_REQUIRED");
    expect(report.gates.find((gate) => gate.id === "BUILD_UNIT_INTEGRATION")?.status).toBe("UNKNOWN");
  });

  it("refuses evidence paths outside the project root", async () => {
    const root = await createTempProject();
    await expect(createReadinessEvidenceManifest(root, {
      evidence: ["BUILD_UNIT_INTEGRATION=../outside.json"],
      sourceCommit,
      now: () => createdAt
    })).rejects.toThrow("Path escapes project root");
  });

  it("rejects modified evidence instead of trusting the recorded PASS", async () => {
    const root = await createCompleteManifest();
    await writeFile(
      path.join(root, "evidence", "pass.json"),
      JSON.stringify({ status: "UNPASSED", generated_at: createdAt.toISOString() }),
      "utf8"
    );

    const report = await evaluateBetaReadiness(root, {
      sourceCommit,
      now: () => new Date("2026-07-18T01:00:00.000Z")
    });
    const gate = report.gates.find((item) => item.id === "BUILD_UNIT_INTEGRATION");

    expect(report.ready).toBe(false);
    expect(gate?.status).toBe("UNKNOWN");
    expect(gate?.evidence[0]?.reasons).toContain("Evidence checksum or size does not match the manifest.");
  });

  it("rejects stale evidence and evidence from another commit", async () => {
    const staleRoot = await createCompleteManifest();
    const stale = await evaluateBetaReadiness(staleRoot, {
      sourceCommit,
      now: () => new Date("2026-07-19T01:00:01.000Z")
    });
    expect(stale.gates.find((gate) => gate.id === "BUILD_UNIT_INTEGRATION")?.status).toBe("UNKNOWN");
    expect(stale.gates.find((gate) => gate.id === "BUILD_UNIT_INTEGRATION")?.reasons).toContain("Evidence is stale.");

    const wrongCommitRoot = await createCompleteManifest();
    const wrongCommit = await evaluateBetaReadiness(wrongCommitRoot, {
      sourceCommit: otherCommit,
      now: () => new Date("2026-07-18T01:00:00.000Z")
    });
    expect(wrongCommit.ready).toBe(false);
    expect(wrongCommit.gates.find((gate) => gate.id === "PACKAGE_LIFECYCLE")?.status).toBe("UNKNOWN");
    expect(wrongCommit.gates.find((gate) => gate.id === "PACKAGE_LIFECYCLE")?.reasons).toContain(
      "Evidence source commit does not match the current Git commit."
    );
  });

  it("redacts manifest summaries and blocks readiness when output contains a secret", async () => {
    const root = await createCompleteManifest();
    const manifestPath = path.join(root, ".kairon", "readiness", "evidence-manifest.json");
    const manifest = await readJsonFile<ReadinessEvidenceManifest>(manifestPath);
    const simulatedCredential = ["github", "pat", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    manifest.evidence[0].summary = `token=${simulatedCredential}`;
    await writeJsonFileAtomic(manifestPath, manifest);

    const report = await evaluateBetaReadiness(root, {
      sourceCommit,
      now: () => new Date("2026-07-18T01:00:00.000Z")
    });
    const serialized = JSON.stringify(report);

    expect(report.ready).toBe(false);
    expect(report.secret_scan.status).toBe("redacted");
    expect(report.gates.find((gate) => gate.id === "SECRET_ARTIFACT_INTEGRITY")?.status).toBe("UNPASSED");
    expect(serialized).not.toContain(simulatedCredential);
    expect(report.secret_scan.exposed_findings).toBe(0);
  });

  it("writes traceable JSON and Markdown reports", async () => {
    const root = await createCompleteManifest();
    const report = await evaluateBetaReadiness(root, {
      sourceCommit,
      now: () => new Date("2026-07-18T01:00:00.000Z")
    });
    const jsonPath = await writeBetaReadinessReport(root, report, "json");
    const markdownPath = await writeBetaReadinessReport(root, report, "markdown");
    const markdown = formatBetaReadinessReport(report, "markdown");

    expect(jsonPath).toBe(".kairon/reports/readiness/latest.json");
    expect(markdownPath).toBe(".kairon/reports/readiness/latest.md");
    expect(JSON.parse(await readFile(path.join(root, jsonPath), "utf8"))).toMatchObject({ ready: true });
    expect(markdown).toContain("# Kairon Beta Readiness Report");
    expect(markdown).toContain("BUILD_UNIT_INTEGRATION");
    expect(markdown).toContain("sha256:");
  });
});

async function createCompleteManifest(): Promise<string> {
  const root = await createTempProject();
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
  await createReadinessEvidenceManifest(root, {
    evidence: readinessGateDefinitions
      .filter((definition) => definition.required)
      .map((definition) => `${definition.id}=evidence/pass.json`),
    sourceCommit,
    now: () => createdAt
  });
  return root;
}
