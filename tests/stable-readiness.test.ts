import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { attachIncidentResource } from "../src/incidents/store.js";
import { listStableAcceptanceScenarios } from "../src/operation-test/stable-acceptance.js";
import { sha256 } from "../src/readiness/evidence-manifest.js";
import {
  createStableReadinessManifest,
  evaluateStableReadiness,
  formatStableReadinessResult,
  stableReadinessGateDefinitions,
  writeStableReadinessResult,
  type StableReadinessEvidenceManifest
} from "../src/readiness/stable-readiness.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const createdAt = new Date("2026-07-27T00:00:00.000Z");
const checkedAt = new Date("2026-07-27T01:00:00.000Z");

describe("Stable Local Release readiness gate", () => {
  it("passes only when all 16 gates and Stable cleanup are verified", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.stable_ready).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.gates).toHaveLength(16);
    expect(result.gates.every((gate) => gate.status === "PASS")).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.cleanup).toMatchObject({
      status: "verified",
      resources_total: 2,
      unresolved_resources: 0
    });
    expect(result.promotion_automatic).toBe(false);
    expect(result.promotion_command).toContain(
      "kairon release github promote apply"
    );
  });

  it("keeps missing external setup separate from missing required evidence", async () => {
    const root = await createProject();
    const result = await evaluateStableReadiness(root, {
      sourceCommit,
      now: () => createdAt
    });

    expect(result.stable_ready).toBe(false);
    expect(result.gates.find(
      (gate) => gate.id === "STABLE_PROMOTION"
    )?.status).toBe("SETUP_REQUIRED");
    expect(result.gates.find(
      (gate) => gate.id === "BUILD_UNIT_INTEGRATION"
    )?.status).toBe("UNKNOWN");
    expect(result.rerun_commands).toContain(
      "kairon readiness stable check"
    );
  });

  it("rejects stale, tampered, and wrong-commit evidence", async () => {
    const staleRoot = await createCompleteManifest();
    const stale = await evaluateStableReadiness(staleRoot, {
      sourceCommit,
      now: () => new Date("2026-08-04T01:00:00.000Z")
    });
    expect(stale.stable_ready).toBe(false);
    expect(stale.gates.find(
      (gate) => gate.id === "BUILD_UNIT_INTEGRATION"
    )?.reasons).toContain("Evidence is stale.");

    const tamperedRoot = await createCompleteManifest();
    await writeFile(
      path.join(tamperedRoot, "evidence", "pass.json"),
      JSON.stringify({ status: "UNPASSED" }),
      "utf8"
    );
    const tampered = await evaluateStableReadiness(tamperedRoot, {
      sourceCommit,
      now: () => checkedAt
    });
    expect(tampered.stable_ready).toBe(false);
    expect(tampered.gates.find(
      (gate) => gate.id === "RELEASE_ARTIFACT"
    )?.reasons).toContain(
      "Evidence checksum or size does not match the manifest."
    );

    const wrongCommitRoot = await createCompleteManifest();
    const wrongCommit = await evaluateStableReadiness(wrongCommitRoot, {
      sourceCommit: otherCommit,
      now: () => checkedAt
    });
    expect(wrongCommit.stable_ready).toBe(false);
    expect(wrongCommit.blockers).toContainEqual(expect.objectContaining({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical"
    }));
  });

  it("blocks unresolved high incidents and security findings", async () => {
    const root = await createCompleteManifest();
    await attachIncidentResource(root, {
      fingerprint: "stable:critical",
      severity: "critical",
      title: "Stable integrity incident",
      summary: "Recovery verification is incomplete.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-STABLE-0001",
        status: "open"
      },
      now: createdAt
    });
    const securityPath = path.join(root, "evidence", "security.json");
    await writeFile(
      securityPath,
      `${JSON.stringify({
        artifact_kind: "security_baseline_result",
        status: "PASS",
        source_commit: sourceCommit,
        generated_at: createdAt.toISOString(),
        summary: {
          high: 1,
          critical: 0,
          secret_exposures: 0
        },
        findings: [{ severity: "high", code: "fixture" }]
      }, null, 2)}\n`,
      "utf8"
    );
    await replaceGateEvidence(root, "SECURITY_BASELINE", "evidence/security.json");

    const result = await evaluateStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.stable_ready).toBe(false);
    expect(result.incidents.unresolved_critical).toBe(1);
    expect(result.security.high).toBe(1);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNRESOLVED_INCIDENT" }),
      expect.objectContaining({ code: "SECURITY_FINDING" })
    ]));
  });

  it("blocks incomplete exact-ID cleanup and secret-bearing manifest output", async () => {
    const cleanupRoot = await createCompleteManifest();
    const cleanupPath = path.join(
      cleanupRoot,
      "stable-acceptance",
      "cleanup-plan.json"
    );
    const cleanup = await readJsonFile<Record<string, unknown>>(cleanupPath);
    cleanup.status = "planned";
    await writeJsonFileAtomic(cleanupPath, cleanup);
    await refreshStableAcceptanceBinding(cleanupRoot, "CLEANUP_PLAN");
    await replaceGateEvidence(
      cleanupRoot,
      "STABLE_ACCEPTANCE",
      "stable-acceptance/evidence-manifest.json"
    );
    const cleanupResult = await evaluateStableReadiness(cleanupRoot, {
      sourceCommit,
      now: () => checkedAt
    });
    expect(cleanupResult.stable_ready).toBe(false);
    expect(cleanupResult.cleanup.status).toBe("failed");
    expect(cleanupResult.blockers).toContainEqual(expect.objectContaining({
      code: "CLEANUP_FAILURE"
    }));

    const secretRoot = await createCompleteManifest();
    const manifestPath = path.join(
      secretRoot,
      ".kairon",
      "readiness",
      "stable-evidence-manifest.json"
    );
    const manifest = await readJsonFile<StableReadinessEvidenceManifest>(
      manifestPath
    );
    const credential = [
      "github",
      "pat",
      "abcdefghijklmnopqrstuvwxyz1234567890"
    ].join("_");
    manifest.evidence[0]!.summary = `token=${credential}`;
    await writeJsonFileAtomic(manifestPath, manifest);

    const secretResult = await evaluateStableReadiness(secretRoot, {
      sourceCommit,
      now: () => checkedAt
    });
    expect(secretResult.stable_ready).toBe(false);
    expect(secretResult.secret_scan.status).toBe("redacted");
    expect(secretResult.blockers).toContainEqual(expect.objectContaining({
      code: "SECRET_EXPOSURE"
    }));
    expect(JSON.stringify(secretResult)).not.toContain(credential);
  });

  it("writes canonical JSON and an actionable operator report", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });
    const jsonPath = await writeStableReadinessResult(root, result, "json");
    const markdownPath = await writeStableReadinessResult(
      root,
      result,
      "markdown"
    );
    const markdown = formatStableReadinessResult(result, "markdown");

    expect(jsonPath).toBe(".kairon/readiness/stable-result.json");
    expect(markdownPath).toBe(".kairon/readiness/stable-report.md");
    expect(JSON.parse(await readFile(path.join(root, jsonPath), "utf8")))
      .toMatchObject({
        stable_ready: true,
        artifact_kind: "stable_readiness_result",
        promotion_automatic: false
      });
    expect(markdown).toContain(
      "# Kairon Stable Local Release Readiness Report"
    );
    expect(markdown).toContain("Release Decision");
    expect(markdown).toContain("Rerun Commands");
    expect(markdown).toContain("STABLE_ACCEPTANCE");
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
  await createStableAcceptanceEvidence(root);
  await createStableReadinessManifest(root, {
    evidence: stableReadinessGateDefinitions.map((definition) =>
      definition.id === "STABLE_ACCEPTANCE"
        ? `${definition.id}=stable-acceptance/evidence-manifest.json`
        : `${definition.id}=evidence/pass.json`
    ),
    sourceCommit,
    now: () => createdAt
  });
  return root;
}

async function createStableAcceptanceEvidence(root: string): Promise<void> {
  const resultRoot = path.join(root, "stable-acceptance");
  await mkdir(resultRoot, { recursive: true });
  const files = {
    TEST_LIST: path.join(resultRoot, "test-list.md"),
    COMMAND_LIST: path.join(resultRoot, "commands.md"),
    CLEANUP_PLAN: path.join(resultRoot, "cleanup-plan.json"),
    SUMMARY: path.join(resultRoot, "summary.json")
  };
  await writeFile(files.TEST_LIST, "# Stable test list\n", "utf8");
  await writeFile(files.COMMAND_LIST, "# Stable commands\n", "utf8");
  await writeFile(
    files.CLEANUP_PLAN,
    `${JSON.stringify({
      schema_version: "0.1",
      kind: "stable_acceptance_cleanup_plan",
      run_id: "STABLE-TEST",
      source_commit: sourceCommit,
      status: "completed",
      safety: {
        exact_ids_only: true,
        created_by_harness_only: true,
        missing_id_action: "skip"
      },
      resources: [
        {
          alias: "release",
          type: "github_release",
          exact_id: "123",
          created_by_harness: true,
          cleanup_status: "deleted"
        },
        {
          alias: "sandbox",
          type: "windows_sandbox",
          exact_id: null,
          created_by_harness: true,
          cleanup_status: "not_created"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    files.SUMMARY,
    `${JSON.stringify({
      schema_version: "0.1",
      status: "PASS",
      source_commit: sourceCommit,
      cleanup_status: "completed",
      results: listStableAcceptanceScenarios().map((scenario) => ({
        id: scenario.test_id,
        status: "PASS"
      }))
    }, null, 2)}\n`,
    "utf8"
  );
  const documents = await Promise.all(
    Object.entries(files).map(async ([alias, filePath]) => ({
      alias,
      path: toProjectPath(root, filePath),
      sha256: sha256(await readFile(filePath))
    }))
  );
  await writeFile(
    path.join(resultRoot, "evidence-manifest.json"),
    `${JSON.stringify({
      schema_version: "0.1",
      kind: "stable_acceptance_evidence_manifest",
      run_id: "STABLE-TEST",
      status: "completed",
      source_commit: sourceCommit,
      result_root: "stable-acceptance",
      previous_result_root: null,
      selected_test_ids: listStableAcceptanceScenarios().map(
        (scenario) => scenario.test_id
      ),
      carried_pass_ids: [],
      documents,
      scenarios: listStableAcceptanceScenarios().map((scenario) => ({
        ...scenario,
        status: "PASS",
        carried_from_previous: false,
        evidence_paths: [`stable-acceptance/results/${scenario.test_id}.json`]
      })),
      cleanup_plan_path: "stable-acceptance/cleanup-plan.json",
      generated_at: createdAt.toISOString(),
      completed_at: createdAt.toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

async function replaceGateEvidence(
  root: string,
  gateId: string,
  evidencePath: string
): Promise<void> {
  const manifestPath = path.join(
    root,
    ".kairon",
    "readiness",
    "stable-evidence-manifest.json"
  );
  const manifest = await readJsonFile<StableReadinessEvidenceManifest>(
    manifestPath
  );
  manifest.evidence = manifest.evidence.filter(
    (entry) => entry.gate_id !== gateId
  );
  await writeJsonFileAtomic(manifestPath, manifest);
  const regenerated = await createStableReadinessManifest(root, {
    evidence: [
      ...manifest.evidence.map((entry) => `${entry.gate_id}=${entry.path}`),
      `${gateId}=${evidencePath}`
    ],
    sourceCommit,
    now: () => createdAt
  });
  expect(regenerated.manifest.evidence).toHaveLength(16);
}

async function refreshStableAcceptanceBinding(
  root: string,
  alias: string
): Promise<void> {
  const manifestPath = path.join(
    root,
    "stable-acceptance",
    "evidence-manifest.json"
  );
  const manifest = await readJsonFile<{
    documents: Array<{ alias: string; path: string; sha256: string }>;
  }>(manifestPath);
  const binding = manifest.documents.find((entry) => entry.alias === alias)!;
  binding.sha256 = sha256(await readFile(path.join(root, binding.path)));
  await writeJsonFileAtomic(manifestPath, manifest);
}

function toProjectPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/gu, "/");
}
