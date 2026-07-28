import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { attachIncidentResource } from "../src/incidents/store.js";
import {
  evaluatePostReleaseHealth,
  formatPostReleaseHealthReport,
  inspectLatestPostReleaseHealth,
  writePostReleaseHealthReport
} from "../src/release/post-release-health.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const packageDigest = "b".repeat(64);
const releaseStateDigest = "c".repeat(64);
const manifestDigest = "d".repeat(64);
const releaseId = 501;

describe("post-release health", () => {
  it("continues a fully bound healthy rollout without mutating project or installed state", async () => {
    const fixture = await createHealthyFixture();
    const projectBefore = await readFile(fixture.projectPath, "utf8");
    const registryBefore = await readFile(fixture.registryPath, "utf8");

    const execution = await evaluatePostReleaseHealth(
      fixture.root,
      fixture.options
    );

    expect(execution.result.decision).toBe("continue");
    expect(execution.result.release).toMatchObject({
      release_id: releaseId,
      version: "0.3.0",
      source_commit: sourceCommit
    });
    expect(execution.result.update).toMatchObject({
      transaction_id: "UTX-0001",
      rollback_target: "0.2.0",
      verified_cache: true,
      approval_required: true,
      exact_command:
        "kairon update rollback --to 0.2.0 --confirm 0.2.0"
    });
    expect(execution.result.observation.completed).toBe(true);
    expect(execution.result.read_only_guard).toMatchObject({
      mutation_detected: false
    });
    expect(execution.result.rollback_automatic).toBe(false);
    expect(execution.result.approval_automatic).toBe(false);
    expect(await readFile(fixture.projectPath, "utf8")).toBe(projectBefore);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(registryBefore);
    expect(
      await inspectLatestPostReleaseHealth(fixture.root)
    ).toMatchObject({
      status: "available",
      result: { decision: "continue" }
    });
    expect(
      formatPostReleaseHealthReport(execution.result)
    ).toContain("automatic rollback: `false`");
  });

  it("holds when the observation window or required external evidence is incomplete", async () => {
    const fixture = await createHealthyFixture();
    const execution = await evaluatePostReleaseHealth(fixture.root, {
      ...fixture.options,
      slo: ".kairon/metrics/slo/missing.json",
      security: ".kairon/security/missing.json"
    });

    expect(execution.result.decision).toBe("hold");
    expect(execution.result.reasons).toEqual(
      expect.arrayContaining([
        "observation_window_evidence_incomplete",
        "runtime_slo_missing",
        "security_baseline_missing"
      ])
    );
    expect(
      execution.result.checks.some(
        (entry) =>
          entry.status === "rollback_required" &&
          entry.id !== "read_only_execution"
      )
    ).toBe(false);
  });

  it("requires rollback for a failed transaction post-check", async () => {
    const fixture = await createHealthyFixture();
    const transaction = await readJson(fixture.transactionPath);
    transaction.timeline = [
      {
        phase: "post_check",
        status: "failed",
        code: "health_probe_failed",
        recorded_at: "2026-07-28T09:00:00.000Z"
      }
    ];
    await writeJsonFileAtomic(fixture.transactionPath, transaction);

    const execution = await evaluatePostReleaseHealth(
      fixture.root,
      fixture.options
    );

    expect(execution.result.decision).toBe("rollback_required");
    expect(execution.result.reasons).toContain(
      "transaction_post_check_failed"
    );
    expect(execution.result.update.exact_command).toBe(
      "kairon update rollback --to 0.2.0 --confirm 0.2.0"
    );
  });

  it("requires rollback for a release binding mismatch or critical incident", async () => {
    const fixture = await createHealthyFixture();
    const canary = await readJson(fixture.canaryPath);
    canary.source_release_id = 999;
    await writeJsonFileAtomic(fixture.canaryPath, canary);
    await attachIncidentResource(fixture.root, {
      fingerprint: "post-release:critical",
      severity: "critical",
      title: "Post-release state failure",
      summary: "The release health probe detected a critical failure.",
      resource: {
        kind: "update_transaction",
        id: "UTX-0001",
        status: "recovery_required",
        severity: "critical"
      },
      now: new Date("2026-07-28T10:30:00.000Z")
    });

    const execution = await evaluatePostReleaseHealth(
      fixture.root,
      fixture.options
    );

    expect(execution.result.decision).toBe("rollback_required");
    expect(execution.result.reasons).toEqual(
      expect.arrayContaining([
        "release_and_canary_binding_mismatch",
        "unresolved_high_or_critical_incident"
      ])
    );
    expect(execution.result.incidents.unresolved_critical).toBe(1);
  });

  it("renders the latest result as JSON or Markdown without reevaluating evidence", async () => {
    const fixture = await createHealthyFixture();
    await evaluatePostReleaseHealth(fixture.root, fixture.options);

    const json = await writePostReleaseHealthReport(fixture.root, {
      format: "json"
    });
    const markdown = await writePostReleaseHealthReport(fixture.root, {
      format: "markdown",
      output: ".kairon/reports/post-release-health.md"
    });

    expect(JSON.parse(json.text)).toMatchObject({
      artifact_kind: "post_release_health_result",
      decision: "continue"
    });
    expect(markdown.text).toContain("# Kairon Post-release Health");
    expect(markdown.output_path).toBe(
      ".kairon/reports/post-release-health.md"
    );
  });

  it("rejects a tampered latest decision artifact", async () => {
    const fixture = await createHealthyFixture();
    const execution = await evaluatePostReleaseHealth(
      fixture.root,
      fixture.options
    );
    const latest = await readJson(execution.latest_result_path);
    latest.decision = "rollback_required";
    await writeJsonFileAtomic(execution.latest_result_path, latest);

    expect(
      await inspectLatestPostReleaseHealth(fixture.root)
    ).toEqual({ status: "invalid" });
  });
});

async function createHealthyFixture(): Promise<{
  root: string;
  options: {
    releaseVerification: string;
    canary: string;
    transaction: string;
    observationMinutes: number;
    now: () => Date;
  };
  projectPath: string;
  registryPath: string;
  transactionPath: string;
  canaryPath: string;
}> {
  const root = await createTempProject();
  const projectPath = path.join(root, ".kairon", "project.json");
  const releasePath = path.join(
    root,
    ".kairon",
    "release",
    "stable-verifications",
    "STV-20260728080000-aaaaaaaaaaaa.json"
  );
  const canaryPath = path.join(
    root,
    ".kairon",
    "release",
    "stable-canaries",
    "CAN-20260728090000-aaaaaaaaaaaa",
    "final-result.json"
  );
  const transactionPath = path.join(
    root,
    ".kairon",
    "update",
    "transactions",
    "UTX-0001.json"
  );
  const targetDownloadPath = path.join(
    root,
    ".kairon",
    "update",
    "downloads",
    "UPD-0002.json"
  );
  const rollbackDownloadPath = path.join(
    root,
    ".kairon",
    "update",
    "downloads",
    "UPD-0001.json"
  );
  const registryPath = path.join(
    root,
    ".kairon",
    "update",
    "registry.json"
  );
  const sloPath = path.join(
    root,
    ".kairon",
    "metrics",
    "slo",
    "latest.json"
  );
  const securityPath = path.join(
    root,
    ".kairon",
    "security",
    "security-baseline.json"
  );
  const absoluteCache = path.join(root, "cache");
  await writeJsonFileAtomic(projectPath, {
    schema_version: "0.1",
    project_id: "fixture"
  });
  await writeJsonFileAtomic(releasePath, {
    schema_version: "0.1",
    artifact_kind: "stable_release_verification",
    verification_id: "STV-20260728080000-aaaaaaaaaaaa",
    status: "PASS",
    integrity_status: "PASS",
    currentness_status: "PASS",
    repository: "goodaymmm/Kairon",
    base_branch: "main",
    version: "0.3.0",
    tag: "v0.3.0",
    release_id: releaseId,
    release_name: "Kairon 0.3.0",
    target_commit_sha: sourceCommit,
    tag_commit_sha: sourceCommit,
    draft: false,
    prerelease: false,
    assets: [],
    manifest: {
      status: "verified",
      package_version: "0.3.0",
      source_commit: sourceCommit,
      sha256: manifestDigest,
      verification_context: "consumer",
      failed_checks: []
    },
    channel_selection: {
      channel: "stable",
      selected_release_id: releaseId,
      selected_version: "0.3.0",
      matches_requested_release: true
    },
    credential_provider: null,
    checks: [],
    reasons: [],
    remediation: [],
    state_digest: releaseStateDigest,
    checked_at: "2026-07-28T08:00:00.000Z",
    expires_at: "2026-07-29T08:00:00.000Z",
    execution_performed: false
  });
  await writeJsonFileAtomic(canaryPath, {
    schema_version: "0.1",
    artifact_kind: "stable_canary_final_result",
    finalization_id: "SCF-20260728090000-aaaaaaaaaaaa",
    canary_id: "CAN-20260728090000-aaaaaaaaaaaa",
    status: "PASS",
    source_verification_id: "STV-20260728080000-aaaaaaaaaaaa",
    source_state_digest: releaseStateDigest,
    source_release_id: releaseId,
    version: "0.3.0",
    sandbox_result_status: "PASS",
    sandbox_result_sha256: "e".repeat(64),
    checks: [
      {
        id: "doctor",
        status: "pass",
        reason: "doctor_passed"
      },
      {
        id: "state_integrity",
        status: "pass",
        reason: "state_integrity_passed"
      }
    ],
    cleanup: {
      unknown_sandbox_terminated: false,
      host_cache_created: false,
      host_credential_persisted: false,
      sandbox_work_directory_removed: true,
      package_removed: true
    },
    reasons: [],
    remediation: [],
    finalized_at: "2026-07-28T09:00:00.000Z"
  });
  await writeJsonFileAtomic(transactionPath, {
    schema_version: "0.1",
    artifact_kind: "update_transaction",
    transaction_id: "UTX-0001",
    action: "apply",
    status: "completed",
    phase: "completed",
    current_version: "0.2.0",
    target_version: "0.3.0",
    download_id: "UPD-0002",
    package_sha256: packageDigest,
    package_size_bytes: 1234,
    staging_path: path.join(root, "staging", "UTX-0001"),
    artifact_path: ".kairon/update/transactions/UTX-0001.json",
    timeline: [
      {
        phase: "post_check",
        status: "passed",
        code: "post_check_passed",
        recorded_at: "2026-07-28T08:45:00.000Z"
      }
    ],
    created_at: "2026-07-28T08:30:00.000Z",
    updated_at: "2026-07-28T08:45:00.000Z"
  });
  await writeJsonFileAtomic(targetDownloadPath, verifiedDownload({
    downloadId: "UPD-0002",
    version: "0.3.0",
    releaseId,
    sourceCommit,
    packageDigest,
    cache: absoluteCache
  }));
  await writeJsonFileAtomic(rollbackDownloadPath, verifiedDownload({
    downloadId: "UPD-0001",
    version: "0.2.0",
    releaseId: 401,
    sourceCommit: "f".repeat(40),
    packageDigest: "1".repeat(64),
    cache: absoluteCache
  }));
  await writeJsonFileAtomic(registryPath, {
    schema_version: "0.1",
    installed: {
      version: "0.3.0",
      source: "verified_download",
      download_id: "UPD-0002",
      package_path: path.join(absoluteCache, "kairon-0.3.0.tgz"),
      checksum_manifest_path: path.join(absoluteCache, "0.3.0.sha256.json"),
      release_manifest_path: path.join(absoluteCache, "release-manifest.json"),
      source_commit: sourceCommit,
      installed_at: "2026-07-28T08:45:00.000Z"
    },
    previous: {
      version: "0.2.0",
      source: "verified_download",
      download_id: "UPD-0001",
      package_path: path.join(absoluteCache, "kairon-0.2.0.tgz"),
      checksum_manifest_path: path.join(absoluteCache, "0.2.0.sha256.json"),
      release_manifest_path: path.join(absoluteCache, "release-manifest-0.2.0.json"),
      source_commit: "f".repeat(40),
      installed_at: "2026-07-27T08:00:00.000Z"
    },
    last_successful_version: "0.3.0",
    automatic_updates: false,
    history: [
      {
        transaction_id: "UTX-0001",
        action: "apply",
        from_version: "0.2.0",
        to_version: "0.3.0",
        download_id: "UPD-0002",
        status: "completed",
        completed_at: "2026-07-28T08:45:00.000Z"
      }
    ],
    updated_at: "2026-07-28T08:45:00.000Z"
  });
  await writeJsonFileAtomic(sloPath, {
    schema_version: "0.1",
    artifact_kind: "runtime_slo_summary",
    evaluated_at: "2026-07-28T10:30:00.000Z",
    status: "PASS",
    window: {
      start: "2026-07-28T08:30:00.000Z",
      end: "2026-07-28T10:30:00.000Z",
      minutes: 120
    },
    minimum_samples: 5,
    corrupt_samples: 0,
    objectives: {}
  });
  await writeJsonFileAtomic(securityPath, {
    schema_version: "0.1",
    artifact_kind: "security_baseline_result",
    status: "PASS",
    offline_status: "PASS",
    source_commit: sourceCommit,
    generated_at: "2026-07-28T10:30:00.000Z",
    checks: [],
    findings: [],
    dependency: {
      package_lock_sha256: "2".repeat(64),
      production_packages: 0,
      direct_dependencies: [],
      licenses: [],
      external_audit: {
        status: "PASS",
        captured_at: "2026-07-28T10:30:00.000Z",
        high: 0,
        critical: 0
      }
    },
    artifact_scan: {
      scanned_entries: 0,
      finding_count: 0
    },
    state_integrity: {
      files_checked: 1,
      errors: 0,
      warnings: 0
    },
    summary: {
      pass: 1,
      unpassed: 0,
      setup_required: 0,
      high: 0,
      critical: 0,
      secret_exposures: 0,
      total: 1
    }
  });
  return {
    root,
    options: {
      releaseVerification:
        ".kairon/release/stable-verifications/STV-20260728080000-aaaaaaaaaaaa.json",
      canary:
        ".kairon/release/stable-canaries/CAN-20260728090000-aaaaaaaaaaaa/final-result.json",
      transaction: "UTX-0001",
      observationMinutes: 60,
      now: () => new Date("2026-07-28T11:00:00.000Z")
    },
    projectPath,
    registryPath,
    transactionPath,
    canaryPath
  };
}

function verifiedDownload(input: {
  downloadId: string;
  version: string;
  releaseId: number;
  sourceCommit: string;
  packageDigest: string;
  cache: string;
}): Record<string, unknown> {
  return {
    schema_version: "0.1",
    artifact_kind: "verified_update_download",
    download_id: input.downloadId,
    repository: "goodaymmm/Kairon",
    release_id: input.releaseId,
    release_channel: "stable",
    version: input.version,
    tag: `v${input.version}`,
    source_commit: input.sourceCommit,
    package_sha256: input.packageDigest,
    package_size_bytes: 1234,
    cache_directory: input.cache,
    package_path: path.join(input.cache, `kairon-${input.version}.tgz`),
    checksum_manifest_path: path.join(
      input.cache,
      `${input.version}.sha256.json`
    ),
    release_manifest_path: path.join(
      input.cache,
      `release-manifest-${input.version}.json`
    ),
    downloaded_at: "2026-07-28T08:00:00.000Z"
  };
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
}
