import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  createOperationEvidenceCatalog,
  inspectOperationEvidenceRetention,
  listOperationEvidence,
  verifyOperationEvidenceCatalog,
  type OperationEvidenceCatalog
} from "../src/operation-test/evidence-catalog.js";
import {
  applyCleanupProposal,
  planCleanupRetention
} from "../src/maintenance/cleanup-proposals.js";
import { scanCleanupRetention } from "../src/maintenance/retention-scanner.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const now = new Date("2026-07-29T00:00:00.000Z");

describe("operation evidence catalog", () => {
  it("catalogs aliases and protects the latest and only PASS generations", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const oldRoot = "operation-test-results/run-old";
    const newRoot = "operation-test-results/run-new";
    await writeSummary(root, oldRoot, "2026-07-01T00:00:00.000Z", [
      { id: "STABLE_SOAK", status: "PASS" }
    ]);
    await writeSummary(root, newRoot, "2026-07-28T00:00:00.000Z", [
      { id: "STABLE_SOAK", status: "PASS" },
      { id: "OT-T200-01-02", status: "PASS" }
    ]);
    const testList = "docs/t200-operation-test-list.md";
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, testList),
      [
        "<!-- kairon:alias STABLE_SOAK=OT-T199-01-01 -->",
        "| ID | Task | Result |",
        "|---|---|---|",
        "| OT-T199-01-01 | T199 | PASS |",
        "| OT-T200-01-02 | T200 | PASS |"
      ].join("\n"),
      "utf8"
    );

    const result = await createOperationEvidenceCatalog(root, {
      resultRoots: [oldRoot, newRoot],
      testLists: [testList],
      sourceCommit,
      now: () => now
    });

    expect(result.catalog.summary).toMatchObject({
      result_roots: 2,
      entries: 3,
      pass: 3,
      protected: 2,
      candidates: 1
    });
    const stableEntries = result.catalog.entries.filter(
      (entry) => entry.test_id === "OT-T199-01-01"
    );
    expect(stableEntries).toHaveLength(2);
    expect(stableEntries.find((entry) => entry.result_root === newRoot)).toMatchObject({
      original_test_id: "STABLE_SOAK",
      task_id: "T199",
      integrity: "verified",
      retention: {
        disposition: "protected",
        reasons: ["latest_verified_pass"]
      }
    });
    expect(stableEntries.find((entry) => entry.result_root === oldRoot)).toMatchObject({
      integrity: "stale",
      retention: {
        disposition: "candidate",
        reasons: ["superseded"]
      }
    });
    expect(
      result.catalog.entries.find((entry) => entry.test_id === "OT-T200-01-02")
    ).toMatchObject({
      retention: {
        disposition: "protected",
        reasons: ["latest_verified_pass", "only_pass_generation"]
      }
    });
    expect(JSON.stringify(result.catalog)).not.toContain(root);

    const listed = await listOperationEvidence(
      root,
      result.catalog_path,
      { task: "T199", status: "PASS" }
    );
    expect(listed).toHaveLength(2);
    await expect(listOperationEvidence(
      root,
      result.catalog_path,
      { status: "BROKEN" }
    )).rejects.toThrow("Unknown operation evidence status");
    expect((await verifyOperationEvidenceCatalog(
      root,
      result.catalog_path,
      { sourceCommit, now }
    )).status).toBe("PASS");
  });

  it("detects tampering and rejects result roots outside the project", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const resultRoot = "operation-test-results/run-tamper";
    const summaryPath = await writeSummary(
      root,
      resultRoot,
      "2026-07-28T00:00:00.000Z",
      [{ id: "OT-T200-01-03", status: "PASS" }]
    );
    const result = await createOperationEvidenceCatalog(root, {
      resultRoots: [resultRoot],
      sourceCommit,
      now: () => now
    });
    await writeFile(summaryPath, "{\"tampered\":true}\n", "utf8");

    const verification = await verifyOperationEvidenceCatalog(
      root,
      result.catalog_path,
      { sourceCommit, now }
    );
    expect(verification).toMatchObject({
      status: "FAIL",
      counts: {
        tampered: 1
      },
      reasons: ["evidence_digest_mismatch"]
    });

    const catalogPath = path.join(root, result.catalog_path);
    const malformedCatalog = JSON.parse(
      await readFile(catalogPath, "utf8")
    ) as Record<string, unknown>;
    malformedCatalog.entries = [{}];
    await writeFile(catalogPath, `${JSON.stringify(malformedCatalog)}\n`, "utf8");
    await expect(inspectOperationEvidenceRetention(root, { now })).resolves.toMatchObject({
      catalog_status: "invalid",
      protected_paths: ["operation-test-results"],
      candidate_paths: []
    });

    await expect(createOperationEvidenceCatalog(root, {
      resultRoots: ["../outside"],
      sourceCommit
    })).rejects.toThrow("Path escapes project root");
  });

  it("protects evidence referenced by a readiness manifest", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const resultRoot = "operation-test-results/referenced";
    const evidencePath = await writeSummary(
      root,
      resultRoot,
      "2026-07-01T00:00:00.000Z",
      [{ id: "OT-T200-01-04", status: "FAIL" }]
    );
    await writeJsonFileAtomic(
      path.join(root, resultRoot, "readiness-manifest.json"),
      {
        schema_version: "0.1",
        artifact_kind: "stable_readiness_evidence_manifest",
        generated_at: "2026-07-28T00:00:00.000Z",
        source_commit: sourceCommit,
        status: "PASS",
        evidence: [
          {
            gate_id: "EVIDENCE_CATALOG",
            path: toProjectPath(root, evidencePath)
          }
        ]
      }
    );

    const result = await createOperationEvidenceCatalog(root, {
      resultRoots: [resultRoot],
      sourceCommit,
      now: () => now
    });
    expect(
      result.catalog.entries.find((entry) => entry.test_id === "OT-T200-01-04")
    ).toMatchObject({
      retention: {
        disposition: "protected",
        reasons: ["readiness_reference"]
      }
    });
    expect(result.catalog.result_roots[0]).toMatchObject({
      protected: true,
      retention_candidate: false
    });
  });

  it("passes only catalog candidates into retention planning", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const oldRoot = "operation-test-results/old-generation";
    const newRoot = "operation-test-results/current-generation";
    await writeSummary(root, oldRoot, "2026-07-01T00:00:00.000Z", [
      { id: "OT-T199-01-01", status: "PASS" }
    ]);
    await writeSummary(root, newRoot, "2026-07-28T00:00:00.000Z", [
      { id: "OT-T199-01-01", status: "PASS" }
    ]);
    await createOperationEvidenceCatalog(root, {
      resultRoots: [oldRoot, newRoot],
      sourceCommit,
      now: () => now
    });

    const inspection = await inspectOperationEvidenceRetention(root, { now });
    expect(inspection).toMatchObject({
      catalog_status: "verified",
      protected_paths: [newRoot],
      candidate_paths: [oldRoot]
    });

    const scan = await scanCleanupRetention(root, {
      now,
      includeEvidenceCatalog: true
    });
    expect(scan.candidates).toEqual([
      expect.objectContaining({
        category: "operation_evidence",
        path: oldRoot
      })
    ]);
    const plan = await planCleanupRetention(root, {
      now,
      includeEvidenceCatalog: true
    });
    expect(plan.proposal.candidates.map((candidate) => candidate.path)).toEqual([
      oldRoot
    ]);
    expect(plan.proposal.candidates[0]).toMatchObject({
      category: "operation_evidence",
      proposed_action: "move_to_kairon_tmp"
    });
  });

  it("rechecks catalog protection before applying a legacy cleanup proposal", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const resultRoot = "operation-test-results/current";
    await writeSummary(root, resultRoot, "2026-07-28T00:00:00.000Z", [
      { id: "OT-T200-01-05", status: "PASS" }
    ]);
    await createOperationEvidenceCatalog(root, {
      resultRoots: [resultRoot],
      sourceCommit,
      now: () => now
    });
    const proposalId = "retention-20260729000000";
    const proposalPath = path.join(
      root,
      ".kairon",
      "cleanup",
      "proposals",
      `${proposalId}.json`
    );
    await writeJsonFileAtomic(proposalPath, {
      schema_version: "0.1",
      proposal_id: proposalId,
      date: "2026-07-29",
      proposal_path: toProjectPath(root, proposalPath),
      direct_delete: false,
      candidates: [
        {
          id: "CLN-001",
          path: "operation-test-results",
          kind: "directory",
          reason: "legacy operation evidence candidate",
          proposed_action: "move_to_kairon_tmp",
          destination: ".kairon/tmp/2026-07-29/operation-test-results",
          size_bytes: 1
        }
      ],
      morning_review_task: {
        type: "cleanup_triage",
        title: "Review cleanup",
        priority: 100,
        schedule_mode: "active_work",
        resources: [],
        acceptance: []
      },
      created_at: now.toISOString()
    });

    const applied = await applyCleanupProposal({
      projectRoot: root,
      proposalId,
      now,
      dryRun: true
    });
    expect(applied).toMatchObject({
      moved: 0,
      blocked: 1,
      candidates: [
        {
          path: "operation-test-results",
          status: "blocked_evidence_catalog"
        }
      ]
    });
    await expect(readJsonFile<OperationEvidenceCatalog>(
      path.join(root, ".kairon", "runtime", "operation-test", "evidence-catalog.json")
    )).resolves.toMatchObject({
      artifact_kind: "operation_evidence_catalog"
    });
  });
});

async function writeSummary(
  root: string,
  resultRoot: string,
  generatedAt: string,
  results: Array<{ id: string; status: string }>
): Promise<string> {
  const summaryPath = path.join(root, resultRoot, "summary.json");
  await writeJsonFileAtomic(summaryPath, {
    schema_version: "0.1",
    artifact_kind: "operation_test_summary",
    generated_at: generatedAt,
    source_commit: sourceCommit,
    results
  });
  return summaryPath;
}

function toProjectPath(root: string, value: string): string {
  return path.relative(root, value).replaceAll("\\", "/");
}
