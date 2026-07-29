import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { attachIncidentResource } from "../src/incidents/store.js";
import {
  createOperationalStableManifest,
  evaluateOperationalStableReadiness,
  formatOperationalStableResult,
  operationalStableGateDefinitions,
  writeOperationalStableResult,
  type OperationalStableGateId
} from "../src/readiness/operational-stable-readiness.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const generatedAt = new Date("2026-07-29T00:00:00.000Z");
const checkedAt = new Date("2026-07-29T01:00:00.000Z");

describe("Operational Stable readiness gate", () => {
  it("passes only when all 15 operational gates are verified", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateOperationalStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.operational_stable_ready).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.gates).toHaveLength(15);
    expect(result.gates.every((gate) => gate.status === "PASS")).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.release).toEqual({
      version: "0.3.0",
      tag: "v0.3.0",
      release_id: 300,
      source_commit: sourceCommit
    });
    expect(result.external_write_performed).toBe(false);
    expect(result.cleanup.status).toBe("verified");
    expect(result.rollback.status).toBe("verified");
  });

  it("separates missing external setup from missing required evidence", async () => {
    const root = await createProject();
    const result = await evaluateOperationalStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.operational_stable_ready).toBe(false);
    expect(result.gates.find(
      (gate) => gate.id === "PUBLISHED_STABLE_VERIFY"
    )?.status).toBe("SETUP_REQUIRED");
    expect(result.gates.find(
      (gate) => gate.id === "BUILD_UNIT_SECURITY"
    )?.status).toBe("UNKNOWN");
    expect(result.rerun_commands).toContain(
      "kairon readiness operational check"
    );
  });

  it("rejects tampered, stale, wrong-commit, and wrong-release evidence", async () => {
    const tamperedRoot = await createCompleteManifest();
    await writeFile(
      path.join(tamperedRoot, "evidence", "build_unit_security.json"),
      `${JSON.stringify({ status: "UNPASSED" })}\n`,
      "utf8"
    );
    const tampered = await evaluateOperationalStableReadiness(tamperedRoot, {
      sourceCommit,
      now: () => checkedAt
    });
    expect(tampered.gates.find(
      (gate) => gate.id === "BUILD_UNIT_SECURITY"
    )?.status).toBe("UNKNOWN");

    const staleRoot = await createCompleteManifest();
    const stale = await evaluateOperationalStableReadiness(staleRoot, {
      sourceCommit,
      now: () => new Date("2026-08-01T01:00:00.000Z")
    });
    expect(stale.gates.find(
      (gate) => gate.id === "STABLE_BASELINE_CURRENT"
    )?.status).toBe("UNKNOWN");

    const wrongCommitRoot = await createCompleteManifest();
    const wrongCommit = await evaluateOperationalStableReadiness(
      wrongCommitRoot,
      {
        sourceCommit: otherCommit,
        now: () => checkedAt
      }
    );
    expect(wrongCommit.blockers).toContainEqual(expect.objectContaining({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical"
    }));

    const wrongReleaseRoot = await createCompleteManifest({
      CLEAN_WINDOWS_CANARY: {
        version: "0.3.1"
      }
    });
    const wrongRelease = await evaluateOperationalStableReadiness(
      wrongReleaseRoot,
      {
        sourceCommit,
        now: () => checkedAt
      }
    );
    expect(wrongRelease.gates.find(
      (gate) => gate.id === "CLEAN_WINDOWS_CANARY"
    )?.status).toBe("UNKNOWN");
    expect(wrongRelease.blockers).toContainEqual(expect.objectContaining({
      code: "RELEASE_IDENTITY_MISMATCH"
    }));
  });

  it("blocks unresolved incidents, security findings, rollback, and cleanup failures", async () => {
    const root = await createCompleteManifest({
      BUILD_UNIT_SECURITY: {
        summary: {
          high: 1,
          critical: 0,
          secret_exposures: 0
        }
      },
      POST_RELEASE_HEALTH: {
        decision: "rollback_required"
      },
      PATCH_RELEASE_REHEARSAL: {
        cleanup_status: "failed"
      }
    });
    await attachIncidentResource(root, {
      fingerprint: "operational-stable:critical",
      severity: "critical",
      title: "Operational Stable integrity incident",
      summary: "Release recovery is incomplete.",
      resource: {
        kind: "watchdog_alert",
        id: "ALT-OPERATIONAL-0001",
        status: "open"
      },
      now: generatedAt
    });

    const result = await evaluateOperationalStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });

    expect(result.operational_stable_ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNRESOLVED_INCIDENT" }),
      expect.objectContaining({ code: "SECURITY_FINDING" }),
      expect.objectContaining({ code: "ROLLBACK_FAILURE" }),
      expect.objectContaining({ code: "CLEANUP_FAILURE" })
    ]));
  });

  it("writes canonical JSON and an actionable operator report", async () => {
    const root = await createCompleteManifest();
    const result = await evaluateOperationalStableReadiness(root, {
      sourceCommit,
      now: () => checkedAt
    });
    const jsonPath = await writeOperationalStableResult(
      root,
      result,
      "json"
    );
    const markdownPath = await writeOperationalStableResult(
      root,
      result,
      "markdown"
    );
    const markdown = formatOperationalStableResult(result, "markdown");

    expect(jsonPath).toBe(
      ".kairon/readiness/operational-stable-result.json"
    );
    expect(markdownPath).toBe(
      ".kairon/readiness/operational-stable-report.md"
    );
    expect(JSON.parse(
      await readFile(path.join(root, jsonPath), "utf8")
    )).toMatchObject({
      artifact_kind: "operational_stable_readiness_result",
      operational_stable_ready: true,
      external_write_performed: false
    });
    expect(markdown).toContain(
      "# Kairon Operational Stable Readiness Report"
    );
    expect(markdown).toContain("All 15 Operational Stable gates");
    expect(markdown).toContain("External Command References");
  });
});

type ArtifactOverrides = Partial<
  Record<OperationalStableGateId, Record<string, unknown>>
>;

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function createCompleteManifest(
  overrides: ArtifactOverrides = {}
): Promise<string> {
  const root = await createProject();
  await mkdir(path.join(root, "evidence"), { recursive: true });
  const evidence: string[] = [];
  for (const definition of operationalStableGateDefinitions) {
    const filename = `${definition.id.toLowerCase()}.json`;
    const relativePath = `evidence/${filename}`;
    const artifact = {
      ...artifactFor(definition.id),
      ...(overrides[definition.id] ?? {})
    };
    await writeFile(
      path.join(root, relativePath),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8"
    );
    evidence.push(`${definition.id}=${relativePath}`);
    for (const [index, additional] of additionalArtifactsFor(
      definition.id
    ).entries()) {
      const additionalRelativePath =
        `evidence/${definition.id.toLowerCase()}-${index + 2}.json`;
      await writeFile(
        path.join(root, additionalRelativePath),
        `${JSON.stringify(additional, null, 2)}\n`,
        "utf8"
      );
      evidence.push(`${definition.id}=${additionalRelativePath}`);
    }
  }
  await createOperationalStableManifest(root, {
    evidence,
    sourceCommit,
    now: () => generatedAt
  });
  return root;
}

function artifactFor(
  gateId: OperationalStableGateId
): Record<string, unknown> {
  const definition = operationalStableGateDefinitions.find(
    (candidate) => candidate.id === gateId
  )!;
  const base = {
    schema_version: "0.1",
    artifact_kind: definition.accepted_artifact_kinds[0],
    status: "PASS",
    generated_at: generatedAt.toISOString(),
    source_commit: sourceCommit
  };
  switch (gateId) {
    case "CONSUMER_MANIFEST_VERIFY":
      return {
        ...base,
        status: "PASS",
        version: "0.3.0",
        tag: "v0.3.0",
        release_id: 300,
        target_commit_sha: sourceCommit,
        manifest: {
          status: "verified",
          verification_context: "consumer"
        }
      };
    case "PUBLISHED_STABLE_VERIFY":
      return {
        ...base,
        integrity_status: "PASS",
        currentness_status: "PASS",
        execution_performed: false,
        version: "0.3.0",
        tag: "v0.3.0",
        release_id: 300,
        target_commit_sha: sourceCommit
      };
    case "CLEAN_WINDOWS_CANARY":
      return {
        ...base,
        version: "0.3.0",
        source_release_id: 300,
        cleanup: {
          unknown_sandbox_terminated: false,
          host_cache_created: false,
          host_credential_persisted: false
        }
      };
    case "POST_RELEASE_HEALTH":
      return {
        ...base,
        decision: "continue",
        read_only_guard: { mutation_detected: false },
        incidents: {
          unresolved_high: 0,
          unresolved_critical: 0
        },
        security: {
          high: 0,
          critical: 0,
          secret_exposures: 0
        },
        state: { errors: 0 },
        release: {
          version: "0.3.0",
          tag: "v0.3.0",
          release_id: 300,
          source_commit: sourceCommit
        }
      };
    case "UPDATE_CHECK_SCHEDULE":
      return {
        ...base,
        status: "completed",
        read_only_guard: { mutation_detected: false },
        automatic_download: false,
        automatic_apply: false,
        automatic_restart: false
      };
    case "MULTI_PROJECT_ROLLOUT":
      return {
        ...base,
        status: "ready",
        target_version: "0.3.0",
        stable_verification: {
          status: "verified",
          release_id: 300
        },
        canary_gate: { status: "satisfied" },
        execution_performed: false,
        automatic_update: false
      };
    case "STABLE_SOAK":
      return {
        ...base,
        release: {
          version: "0.3.0",
          release_id: 300,
          target_commit_sha: sourceCommit
        },
        evaluation: {
          evidence_mode: "real_time",
          duration_satisfied: true,
          elapsed_hours: 168,
          release_drift: false
        }
      };
    case "EVIDENCE_CATALOG":
      return {
        ...base,
        catalog_digest_status: "verified",
        secret_scan_status: "passed"
      };
    case "SCHEDULED_DR_VERIFY":
      return {
        ...base,
        verification: { status: "verified" },
        rehearsal: { status: "passed" },
        automatic_restore: false,
        cleanup_performed: false
      };
    case "AGENT_COMPATIBILITY":
      return {
        ...base,
        certifications: ["codex", "claude", "gemini"].map((agent) => ({
          agent,
          status: "PASS"
        }))
      };
    case "DIAGNOSTICS_TRIAGE":
      return {
        ...base,
        read_only: true,
        summary: {
          critical: 0,
          high: 0,
          unavailable_sources: 0
        },
        redaction: {
          secret_scan_status: "passed",
          secret_finding_count: 0
        }
      };
    case "PATCH_RELEASE_REHEARSAL":
      return {
        ...base,
        mode: "rehearsal",
        cleanup_status: "completed",
        external_publish_performed: false,
        automatic_promotion: false,
        automatic_update: false
      };
    case "BUILD_UNIT_SECURITY":
    case "STATE_SECRET_CLEANUP":
      return {
        ...base,
        summary: {
          high: 0,
          critical: 0,
          secret_exposures: 0
        }
      };
    case "STABLE_BASELINE_CURRENT":
      return base;
  }
}

function additionalArtifactsFor(
  gateId: OperationalStableGateId
): Record<string, unknown>[] {
  const base = {
    schema_version: "0.1",
    status: "PASS",
    generated_at: generatedAt.toISOString(),
    source_commit: sourceCommit
  };
  if (gateId === "BUILD_UNIT_SECURITY") {
    return [{
      ...base,
      artifact_kind: "security_baseline_result",
      summary: {
        high: 0,
        critical: 0,
        secret_exposures: 0
      }
    }];
  }
  if (gateId === "STATE_SECRET_CLEANUP") {
    return [{
      ...base,
      artifact_kind: "patch_release_cleanup_result",
      status: "completed",
      production_release_retained: false,
      resources: [],
      completed_at: generatedAt.toISOString()
    }];
  }
  return [];
}
