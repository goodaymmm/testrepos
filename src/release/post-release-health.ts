import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  listIncidents,
  type IncidentArtifact
} from "../incidents/store.js";
import type { RuntimeSloSummary } from "../observability/slo.js";
import type { StableCanaryFinalResult } from "../operation-test/stable-canary.js";
import type { SecurityBaselineArtifact } from "../security/baseline.js";
import { checkStateIntegrity } from "../state/integrity-check.js";
import {
  findVerifiedUpdateDownloadByVersion,
  updateDownloadMetadataPath,
  updateRegistryPath,
  type UpdateRegistry,
  type VerifiedUpdateDownload
} from "../update/registry.js";
import {
  updateTransactionArtifactPath,
  type UpdateTransactionArtifact
} from "../update/transaction.js";
import type {
  StableReleaseVerificationResult
} from "./stable-verification.js";

export type PostReleaseHealthDecision =
  | "continue"
  | "hold"
  | "rollback_required";

export type PostReleaseHealthCheckStatus =
  | "pass"
  | "hold"
  | "rollback_required";

export type PostReleaseHealthCheckId =
  | "release_verification"
  | "canary_result"
  | "release_binding"
  | "update_transaction"
  | "update_download_binding"
  | "post_check"
  | "observation_window"
  | "runtime_slo"
  | "incident_status"
  | "security_baseline"
  | "state_integrity"
  | "rollback_source"
  | "read_only_execution";

export type PostReleaseHealthCheck = {
  id: PostReleaseHealthCheckId;
  status: PostReleaseHealthCheckStatus;
  reason: string;
  remediation?: string;
};

export type PostReleaseEvidenceReference = {
  kind:
    | "stable_release_verification"
    | "stable_canary_final_result"
    | "update_transaction"
    | "verified_update_download"
    | "runtime_slo_summary"
    | "security_baseline_result";
  path: string;
  sha256: string | null;
  status: "verified" | "missing" | "invalid";
  observed_status: string | null;
  recorded_at: string | null;
};

export type PostReleaseHealthResult = {
  schema_version: "0.1";
  artifact_kind: "post_release_health_result";
  health_id: string;
  decision: PostReleaseHealthDecision;
  release: {
    verification_id: string | null;
    release_id: number | null;
    repository: string | null;
    version: string | null;
    tag: string | null;
    source_commit: string | null;
    artifact_digest: string | null;
  };
  update: {
    transaction_id: string | null;
    download_id: string | null;
    transaction_status: string | null;
    rollback_target: string | null;
    verified_cache: boolean;
    approval_required: true;
    exact_command: string | null;
  };
  observation: {
    required_minutes: number;
    canary_finalized_at: string | null;
    slo_window_start: string | null;
    slo_window_end: string | null;
    completed: boolean;
  };
  incidents: {
    unresolved_warning: number;
    unresolved_high: number;
    unresolved_critical: number;
    references: string[];
  };
  security: {
    status: string | null;
    high: number;
    critical: number;
    secret_exposures: number;
  };
  state: {
    status: string;
    errors: number;
    warnings: number;
  };
  evidence: PostReleaseEvidenceReference[];
  checks: PostReleaseHealthCheck[];
  reasons: string[];
  remediation: string[];
  state_digest: string;
  read_only_guard: {
    project_state_digest_before: string;
    project_state_digest_after: string;
    installed_state_digest_before: string;
    installed_state_digest_after: string;
    mutation_detected: boolean;
  };
  generated_at: string;
  expires_at: string;
  rollback_automatic: false;
  approval_automatic: false;
};

export type EvaluatePostReleaseHealthOptions = {
  releaseVerification: string;
  canary: string;
  transaction: string;
  slo?: string;
  security?: string;
  observationMinutes?: number;
  output?: string;
  now?: () => Date;
};

export type PostReleaseHealthExecution = {
  result: PostReleaseHealthResult;
  result_path: string;
  latest_result_path: string;
  report_path: string;
};

export type LatestPostReleaseHealth =
  | { status: "missing" }
  | { status: "invalid" }
  | {
      status: "available";
      result: PostReleaseHealthResult;
      result_path: string;
    };

type EvidenceLoad<T> = {
  reference: PostReleaseEvidenceReference;
  value?: T;
};

const defaultSloPath = ".kairon/metrics/slo/latest.json";
const defaultSecurityPath = ".kairon/security/security-baseline.json";
const defaultOutputDirectory = ".kairon/release/post-release-health";
const defaultObservationMinutes = 60;
const evidenceFreshnessMs = 24 * 60 * 60_000;
const resultLifetimeMs = 24 * 60 * 60_000;
const shaPattern = /^[a-f0-9]{40,64}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export async function evaluatePostReleaseHealth(
  projectRoot: string,
  options: EvaluatePostReleaseHealthOptions
): Promise<PostReleaseHealthExecution> {
  const root = path.resolve(projectRoot);
  const now = options.now?.() ?? new Date();
  const observationMinutes = normalizeObservationMinutes(
    options.observationMinutes
  );
  const transactionPath = resolveTransactionPath(root, options.transaction);
  const projectDigestBefore = await projectStateDigest(root);
  const installedDigestBefore = await optionalFileDigest(
    updateRegistryPath(root)
  );
  const checks: PostReleaseHealthCheck[] = [];

  const release = await loadEvidence<StableReleaseVerificationResult>(
    root,
    options.releaseVerification,
    "stable_release_verification",
    isStableReleaseVerification
  );
  const canary = await loadEvidence<StableCanaryFinalResult>(
    root,
    options.canary,
    "stable_canary_final_result",
    isStableCanaryFinalResult
  );
  const transaction = await loadEvidence<UpdateTransactionArtifact>(
    root,
    toProjectPath(root, transactionPath),
    "update_transaction",
    isUpdateTransactionArtifact
  );
  const slo = await loadEvidence<RuntimeSloSummary>(
    root,
    options.slo ?? defaultSloPath,
    "runtime_slo_summary",
    isRuntimeSloSummary
  );
  const security = await loadEvidence<SecurityBaselineArtifact>(
    root,
    options.security ?? defaultSecurityPath,
    "security_baseline_result",
    isSecurityBaselineArtifact
  );
  const download = transaction.value === undefined
    ? missingEvidence<VerifiedUpdateDownload>(
        root,
        ".kairon/update/downloads/unknown.json",
        "verified_update_download"
      )
    : await loadEvidence<VerifiedUpdateDownload>(
        root,
        toProjectPath(
          root,
          updateDownloadMetadataPath(root, transaction.value.download_id)
        ),
        "verified_update_download",
        isVerifiedUpdateDownload
      );

  evaluateReleaseVerification(release, now, checks);
  evaluateCanary(canary, now, checks);
  evaluateReleaseBinding(release, canary, checks);
  evaluateTransaction(transaction, checks);
  evaluateDownloadBinding(release, transaction, download, checks);
  evaluatePostCheck(transaction, checks);
  const observationCompleted = evaluateObservationWindow(
    canary,
    slo,
    now,
    observationMinutes,
    checks
  );
  evaluateSlo(slo, now, checks);

  let incidents: IncidentArtifact[] = [];
  let incidentReadFailed = false;
  try {
    incidents = await listIncidents(root);
  } catch {
    incidentReadFailed = true;
  }
  const incidentSummary = evaluateIncidents(
    incidents,
    incidentReadFailed,
    checks
  );
  evaluateSecurity(release, security, now, checks);

  const state = await checkStateIntegrity(root, { now: () => now });
  if (state.summary.errors > 0) {
    checks.push(healthCheck(
      "state_integrity",
      "rollback_required",
      "canonical_state_integrity_failed",
      "stop rollout and use the approved recovery or rollback workflow"
    ));
  } else if (state.summary.warnings > 0) {
    checks.push(healthCheck(
      "state_integrity",
      "hold",
      "canonical_state_integrity_has_warnings",
      "review state integrity warnings before continuing rollout"
    ));
  } else {
    checks.push(healthCheck(
      "state_integrity",
      "pass",
      "canonical_state_integrity_passed"
    ));
  }

  const rollback = await evaluateRollbackSource(root, transaction, checks);
  const projectDigestAfter = await projectStateDigest(root);
  const installedDigestAfter = await optionalFileDigest(
    updateRegistryPath(root)
  );
  const mutationDetected =
    projectDigestBefore !== projectDigestAfter ||
    installedDigestBefore !== installedDigestAfter;
  checks.push(healthCheck(
    "read_only_execution",
    mutationDetected ? "rollback_required" : "pass",
    mutationDetected
      ? "health_check_mutated_project_or_installed_state"
      : "health_check_is_read_only",
    mutationDetected
      ? "restore the affected state and inspect the health checker"
      : undefined
  ));

  const decision = decide(checks);
  const releaseValue = release.value;
  const canaryValue = canary.value;
  const transactionValue = transaction.value;
  const securityValue = security.value;
  const sloValue = slo.value;
  const generatedAt = now.toISOString();
  const evidence = [
    release.reference,
    canary.reference,
    transaction.reference,
    download.reference,
    slo.reference,
    security.reference
  ];
  const stateDigest = calculateStateDigest(
    evidence,
    decision,
    checks,
    incidentSummary.references
  );
  const healthId =
    `PRH-${formatTimestamp(now)}-${stateDigest.slice(0, 12)}`;
  const result: PostReleaseHealthResult = {
    schema_version: "0.1",
    artifact_kind: "post_release_health_result",
    health_id: healthId,
    decision,
    release: {
      verification_id: releaseValue?.verification_id ?? null,
      release_id: releaseValue?.release_id ?? null,
      repository: releaseValue?.repository ?? null,
      version: releaseValue?.version ?? null,
      tag: releaseValue?.tag ?? null,
      source_commit: releaseValue?.target_commit_sha ?? null,
      artifact_digest: releaseValue?.manifest.sha256 ?? null
    },
    update: {
      transaction_id: transactionValue?.transaction_id ?? null,
      download_id: transactionValue?.download_id ?? null,
      transaction_status: transactionValue?.status ?? null,
      rollback_target: rollback.target,
      verified_cache: rollback.verified,
      approval_required: true,
      exact_command: rollback.command
    },
    observation: {
      required_minutes: observationMinutes,
      canary_finalized_at: canaryValue?.finalized_at ?? null,
      slo_window_start: sloValue?.window.start ?? null,
      slo_window_end: sloValue?.window.end ?? null,
      completed: observationCompleted
    },
    incidents: incidentSummary,
    security: {
      status: securityValue?.status ?? null,
      high: securityValue?.summary.high ?? 0,
      critical: securityValue?.summary.critical ?? 0,
      secret_exposures: securityValue?.summary.secret_exposures ?? 0
    },
    state: {
      status: state.status,
      errors: state.summary.errors,
      warnings: state.summary.warnings
    },
    evidence,
    checks,
    reasons: unique(
      checks
        .filter((entry) => entry.status !== "pass")
        .map((entry) => entry.reason)
    ),
    remediation: unique(
      checks
        .map((entry) => entry.remediation)
        .filter((entry): entry is string => entry !== undefined)
    ),
    state_digest: stateDigest,
    read_only_guard: {
      project_state_digest_before: projectDigestBefore,
      project_state_digest_after: projectDigestAfter,
      installed_state_digest_before: installedDigestBefore,
      installed_state_digest_after: installedDigestAfter,
      mutation_detected: mutationDetected
    },
    generated_at: generatedAt,
    expires_at: new Date(now.getTime() + resultLifetimeMs).toISOString(),
    rollback_automatic: false,
    approval_automatic: false
  };
  const outputDirectory = resolveInside(
    root,
    options.output ?? defaultOutputDirectory
  );
  const resultPath = resolveInside(outputDirectory, `${healthId}.json`);
  const latestPath = resolveInside(outputDirectory, "latest.json");
  const reportPath = resolveInside(outputDirectory, "latest.md");
  await writeJsonFileAtomic(resultPath, result);
  await writeJsonFileAtomic(latestPath, result);
  await writeTextFileAtomic(
    reportPath,
    formatPostReleaseHealthReport(result)
  );
  return {
    result,
    result_path: resultPath,
    latest_result_path: latestPath,
    report_path: reportPath
  };
}

export async function inspectLatestPostReleaseHealth(
  projectRoot: string
): Promise<LatestPostReleaseHealth> {
  const resultPath = resolveInside(
    projectRoot,
    defaultOutputDirectory,
    "latest.json"
  );
  try {
    const value = await readJsonFile<unknown>(resultPath);
    return isPostReleaseHealthResult(value)
      ? { status: "available", result: value, result_path: resultPath }
      : { status: "invalid" };
  } catch (error) {
    return isMissingError(error)
      ? { status: "missing" }
      : { status: "invalid" };
  }
}

export async function writePostReleaseHealthReport(
  projectRoot: string,
  options: {
    format: "json" | "markdown";
    output?: string;
  }
): Promise<{ text: string; output_path?: string }> {
  const latest = await inspectLatestPostReleaseHealth(projectRoot);
  if (latest.status !== "available") {
    throw new Error(
      latest.status === "missing"
        ? "Post-release health has not been evaluated."
        : "Latest post-release health result is invalid."
    );
  }
  const text = options.format === "json"
    ? `${JSON.stringify(latest.result, null, 2)}\n`
    : formatPostReleaseHealthReport(latest.result);
  if (options.output === undefined) {
    return { text };
  }
  const outputPath = resolveInside(projectRoot, options.output);
  if (options.format === "json") {
    await writeJsonFileAtomic(outputPath, latest.result);
  } else {
    await writeTextFileAtomic(outputPath, text);
  }
  return {
    text,
    output_path: toProjectPath(projectRoot, outputPath)
  };
}

export function formatPostReleaseHealthExecution(
  execution: PostReleaseHealthExecution,
  projectRoot: string,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(execution.result, null, 2)}\n`;
  }
  const result = execution.result;
  return [
    "Kairon post-release health decision:",
    `decision=${result.decision}`,
    `health_id=${result.health_id}`,
    `release_id=${result.release.release_id ?? "none"}`,
    `version=${result.release.version ?? "none"}`,
    `transaction_id=${result.update.transaction_id ?? "none"}`,
    `observation_completed=${result.observation.completed}`,
    `rollback_target=${result.update.rollback_target ?? "none"}`,
    `verified_cache=${result.update.verified_cache}`,
    `approval_required=${result.update.approval_required}`,
    `rollback_automatic=${result.rollback_automatic}`,
    `result=${toProjectPath(projectRoot, execution.result_path)}`,
    `report=${toProjectPath(projectRoot, execution.report_path)}`,
    ...result.checks.map(
      (entry) =>
        `${entry.status.toUpperCase()} ${entry.id} reason=${entry.reason}`
    ),
    ...result.remediation.map((entry) => `remediation=${entry}`),
    ...(result.update.exact_command === null
      ? []
      : [`rollback_command=${result.update.exact_command}`])
  ].join("\n");
}

export function formatPostReleaseHealthReport(
  result: PostReleaseHealthResult
): string {
  return [
    "# Kairon Post-release Health",
    "",
    `- decision: **${result.decision}**`,
    `- health id: \`${result.health_id}\``,
    `- release: \`${result.release.version ?? "unknown"}\` (id=${
      result.release.release_id ?? "unknown"
    })`,
    `- update transaction: \`${result.update.transaction_id ?? "unknown"}\``,
    `- observation completed: \`${result.observation.completed}\``,
    `- generated at: \`${result.generated_at}\``,
    `- expires at: \`${result.expires_at}\``,
    "",
    "| Check | Status | Reason |",
    "| --- | --- | --- |",
    ...result.checks.map(
      (entry) =>
        `| ${entry.id} | ${entry.status} | ${escapeMarkdown(entry.reason)} |`
    ),
    "",
    "## Rollback Plan",
    "",
    `- automatic rollback: \`${result.rollback_automatic}\``,
    `- approval required: \`${result.update.approval_required}\``,
    `- target: \`${result.update.rollback_target ?? "not_available"}\``,
    `- verified cache: \`${result.update.verified_cache}\``,
    `- exact command: \`${
      result.update.exact_command ?? "not_available"
    }\``,
    "",
    "## Remediation",
    "",
    ...(result.remediation.length === 0
      ? ["- none"]
      : result.remediation.map((entry) => `- ${escapeMarkdown(entry)}`)),
    ""
  ].join("\n");
}

function evaluateReleaseVerification(
  release: EvidenceLoad<StableReleaseVerificationResult>,
  now: Date,
  checks: PostReleaseHealthCheck[]
): void {
  if (release.reference.status === "missing") {
    checks.push(healthCheck(
      "release_verification",
      "hold",
      "stable_release_verification_missing",
      "rerun kairon release stable verify for the target release"
    ));
    return;
  }
  if (release.value === undefined) {
    checks.push(healthCheck(
      "release_verification",
      "rollback_required",
      "stable_release_verification_invalid",
      "stop rollout and regenerate the Stable verification"
    ));
    return;
  }
  const value = release.value;
  if (
    value.status === "PASS" &&
    value.integrity_status === "PASS" &&
    value.currentness_status === "PASS" &&
    Date.parse(value.expires_at) > now.getTime()
  ) {
    checks.push(healthCheck(
      "release_verification",
      "pass",
      "stable_release_verification_passed"
    ));
  } else if (value.status === "SETUP_REQUIRED" || isExpired(value.expires_at, now)) {
    checks.push(healthCheck(
      "release_verification",
      "hold",
      isExpired(value.expires_at, now)
        ? "stable_release_verification_expired"
        : "stable_release_verification_setup_required",
      "rerun kairon release stable verify for the target release"
    ));
  } else {
    checks.push(healthCheck(
      "release_verification",
      "rollback_required",
      "stable_release_verification_failed",
      "stop rollout and inspect Stable release integrity"
    ));
  }
}

function evaluateCanary(
  canary: EvidenceLoad<StableCanaryFinalResult>,
  now: Date,
  checks: PostReleaseHealthCheck[]
): void {
  if (canary.reference.status === "missing") {
    checks.push(healthCheck(
      "canary_result",
      "hold",
      "stable_canary_result_missing",
      "run the T195 Clean Windows canary"
    ));
    return;
  }
  if (canary.value === undefined) {
    checks.push(healthCheck(
      "canary_result",
      "rollback_required",
      "stable_canary_result_invalid",
      "stop rollout and regenerate the canary result"
    ));
    return;
  }
  const finalizedAt = Date.parse(canary.value.finalized_at);
  if (
    canary.value.status === "PASS" &&
    canary.value.sandbox_result_status === "PASS" &&
    canary.value.checks.every((entry) => entry.status === "pass") &&
    finalizedAt <= now.getTime() &&
    now.getTime() - finalizedAt <= evidenceFreshnessMs
  ) {
    checks.push(healthCheck(
      "canary_result",
      "pass",
      "stable_canary_passed"
    ));
  } else if (canary.value.status === "SETUP_REQUIRED") {
    checks.push(healthCheck(
      "canary_result",
      "hold",
      "stable_canary_setup_required",
      "complete the Clean Windows canary prerequisites"
    ));
  } else if (
    Number.isFinite(finalizedAt) &&
    now.getTime() - finalizedAt > evidenceFreshnessMs
  ) {
    checks.push(healthCheck(
      "canary_result",
      "hold",
      "stable_canary_result_stale",
      "rerun the T195 Clean Windows canary"
    ));
  } else {
    checks.push(healthCheck(
      "canary_result",
      "rollback_required",
      "stable_canary_failed",
      "stop rollout and inspect the failed canary checks"
    ));
  }
}

function evaluateReleaseBinding(
  release: EvidenceLoad<StableReleaseVerificationResult>,
  canary: EvidenceLoad<StableCanaryFinalResult>,
  checks: PostReleaseHealthCheck[]
): void {
  if (release.value === undefined || canary.value === undefined) {
    checks.push(healthCheck(
      "release_binding",
      "hold",
      "release_binding_evidence_incomplete",
      "provide valid Stable verification and canary evidence"
    ));
    return;
  }
  const matches =
    release.value.verification_id === canary.value.source_verification_id &&
    release.value.state_digest === canary.value.source_state_digest &&
    release.value.release_id === canary.value.source_release_id &&
    release.value.version === canary.value.version;
  checks.push(healthCheck(
    "release_binding",
    matches ? "pass" : "rollback_required",
    matches
      ? "release_and_canary_binding_verified"
      : "release_and_canary_binding_mismatch",
    matches
      ? undefined
      : "stop rollout and rerun the canary against the exact Stable verification"
  ));
}

function evaluateTransaction(
  transaction: EvidenceLoad<UpdateTransactionArtifact>,
  checks: PostReleaseHealthCheck[]
): void {
  if (transaction.reference.status === "missing") {
    checks.push(healthCheck(
      "update_transaction",
      "hold",
      "update_transaction_missing",
      "provide the completed update transaction for this rollout"
    ));
    return;
  }
  if (transaction.value === undefined) {
    checks.push(healthCheck(
      "update_transaction",
      "rollback_required",
      "update_transaction_invalid",
      "stop rollout and inspect update transaction integrity"
    ));
    return;
  }
  const value = transaction.value;
  if (value.action === "apply" && value.status === "completed") {
    checks.push(healthCheck(
      "update_transaction",
      "pass",
      "update_transaction_completed"
    ));
  } else if (value.status === "running") {
    checks.push(healthCheck(
      "update_transaction",
      "hold",
      "update_transaction_still_running",
      "wait for the update transaction to complete"
    ));
  } else {
    checks.push(healthCheck(
      "update_transaction",
      "rollback_required",
      `update_transaction_${value.status}`,
      "use the approved recovery or rollback workflow"
    ));
  }
}

function evaluateDownloadBinding(
  release: EvidenceLoad<StableReleaseVerificationResult>,
  transaction: EvidenceLoad<UpdateTransactionArtifact>,
  download: EvidenceLoad<VerifiedUpdateDownload>,
  checks: PostReleaseHealthCheck[]
): void {
  if (
    release.value === undefined ||
    transaction.value === undefined ||
    download.value === undefined
  ) {
    checks.push(healthCheck(
      "update_download_binding",
      download.reference.status === "invalid"
        ? "rollback_required"
        : "hold",
      "update_download_binding_evidence_incomplete",
      "restore the verified update download metadata for this transaction"
    ));
    return;
  }
  const matches =
    download.value.download_id === transaction.value.download_id &&
    download.value.release_channel === "stable" &&
    download.value.release_id === release.value.release_id &&
    download.value.repository === release.value.repository &&
    download.value.version === release.value.version &&
    download.value.tag === release.value.tag &&
    download.value.source_commit === release.value.target_commit_sha &&
    download.value.package_sha256 === transaction.value.package_sha256 &&
    download.value.package_size_bytes === transaction.value.package_size_bytes;
  checks.push(healthCheck(
    "update_download_binding",
    matches ? "pass" : "rollback_required",
    matches
      ? "release_download_transaction_binding_verified"
      : "release_download_transaction_binding_mismatch",
    matches
      ? undefined
      : "stop rollout and inspect the selected package and update metadata"
  ));
}

function evaluatePostCheck(
  transaction: EvidenceLoad<UpdateTransactionArtifact>,
  checks: PostReleaseHealthCheck[]
): void {
  if (transaction.value === undefined) {
    checks.push(healthCheck(
      "post_check",
      "hold",
      "transaction_post_check_unavailable",
      "provide a valid completed update transaction"
    ));
    return;
  }
  const passed = transaction.value.timeline.some(
    (entry) =>
      entry.phase === "post_check" &&
      entry.status === "passed" &&
      entry.code === "post_check_passed"
  );
  const failed = transaction.value.timeline.some(
    (entry) => entry.phase === "post_check" && entry.status === "failed"
  );
  checks.push(healthCheck(
    "post_check",
    passed
      ? "pass"
      : failed
        ? "rollback_required"
        : "hold",
    passed
      ? "transaction_post_check_passed"
      : failed
        ? "transaction_post_check_failed"
        : "transaction_post_check_missing",
    passed
      ? undefined
      : failed
        ? "use the approved rollback workflow"
        : "wait for the update transaction post-check"
  ));
}

function evaluateObservationWindow(
  canary: EvidenceLoad<StableCanaryFinalResult>,
  slo: EvidenceLoad<RuntimeSloSummary>,
  now: Date,
  requiredMinutes: number,
  checks: PostReleaseHealthCheck[]
): boolean {
  if (canary.value === undefined || slo.value === undefined) {
    checks.push(healthCheck(
      "observation_window",
      "hold",
      "observation_window_evidence_incomplete",
      "collect a fresh SLO window after the canary"
    ));
    return false;
  }
  const canaryTime = Date.parse(canary.value.finalized_at);
  const start = Date.parse(slo.value.window.start);
  const end = Date.parse(slo.value.window.end);
  const requiredEnd = canaryTime + requiredMinutes * 60_000;
  const completed =
    Number.isFinite(canaryTime) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    canaryTime <= now.getTime() &&
    start <= canaryTime &&
    end >= requiredEnd &&
    now.getTime() >= requiredEnd;
  checks.push(healthCheck(
    "observation_window",
    completed ? "pass" : "hold",
    completed
      ? "post_release_observation_completed"
      : "post_release_observation_incomplete",
    completed
      ? undefined
      : `collect at least ${requiredMinutes} minutes of SLO evidence after the canary`
  ));
  return completed;
}

function evaluateSlo(
  slo: EvidenceLoad<RuntimeSloSummary>,
  now: Date,
  checks: PostReleaseHealthCheck[]
): void {
  if (slo.reference.status === "missing") {
    checks.push(healthCheck(
      "runtime_slo",
      "hold",
      "runtime_slo_missing",
      "run kairon metrics slo check after the observation window"
    ));
    return;
  }
  if (slo.value === undefined) {
    checks.push(healthCheck(
      "runtime_slo",
      "rollback_required",
      "runtime_slo_invalid",
      "stop rollout and repair observability evidence"
    ));
    return;
  }
  if (now.getTime() - Date.parse(slo.value.evaluated_at) > evidenceFreshnessMs) {
    checks.push(healthCheck(
      "runtime_slo",
      "hold",
      "runtime_slo_stale",
      "generate a fresh runtime SLO summary"
    ));
    return;
  }
  const status = slo.value.status;
  checks.push(healthCheck(
    "runtime_slo",
    status === "PASS"
      ? "pass"
      : status === "WARNING" || status === "INSUFFICIENT_DATA"
        ? "hold"
        : "rollback_required",
    `runtime_slo_${status.toLowerCase()}`,
    status === "PASS"
      ? undefined
      : status === "WARNING" || status === "INSUFFICIENT_DATA"
        ? "extend observation and resolve SLO warnings"
        : "stop rollout and use the approved rollback workflow"
  ));
}

function evaluateIncidents(
  incidents: IncidentArtifact[],
  readFailed: boolean,
  checks: PostReleaseHealthCheck[]
): PostReleaseHealthResult["incidents"] {
  if (readFailed) {
    checks.push(healthCheck(
      "incident_status",
      "hold",
      "incident_store_unavailable",
      "repair incident state before continuing rollout"
    ));
    return {
      unresolved_warning: 0,
      unresolved_high: 0,
      unresolved_critical: 0,
      references: []
    };
  }
  const unresolved = incidents.filter((entry) => entry.status !== "resolved");
  const warning = unresolved.filter((entry) => entry.severity === "warning");
  const high = unresolved.filter((entry) => entry.severity === "high");
  const critical = unresolved.filter((entry) => entry.severity === "critical");
  const status: PostReleaseHealthCheckStatus =
    high.length > 0 || critical.length > 0
      ? "rollback_required"
      : warning.length > 0
        ? "hold"
        : "pass";
  checks.push(healthCheck(
    "incident_status",
    status,
    status === "pass"
      ? "no_unresolved_blocking_incidents"
      : status === "hold"
        ? "unresolved_warning_incident"
        : "unresolved_high_or_critical_incident",
    status === "pass"
      ? undefined
      : status === "hold"
        ? "resolve or explicitly disposition warning incidents"
        : "stop rollout and follow incident recovery"
  ));
  return {
    unresolved_warning: warning.length,
    unresolved_high: high.length,
    unresolved_critical: critical.length,
    references: unresolved
      .filter((entry) =>
        entry.severity === "warning" ||
        entry.severity === "high" ||
        entry.severity === "critical"
      )
      .map((entry) => entry.incident_id)
      .sort()
  };
}

function evaluateSecurity(
  release: EvidenceLoad<StableReleaseVerificationResult>,
  security: EvidenceLoad<SecurityBaselineArtifact>,
  now: Date,
  checks: PostReleaseHealthCheck[]
): void {
  if (security.reference.status === "missing") {
    checks.push(healthCheck(
      "security_baseline",
      "hold",
      "security_baseline_missing",
      "run kairon security baseline with fresh npm audit evidence"
    ));
    return;
  }
  if (security.value === undefined) {
    checks.push(healthCheck(
      "security_baseline",
      "rollback_required",
      "security_baseline_invalid",
      "stop rollout and repair security evidence"
    ));
    return;
  }
  const value = security.value;
  if (
    release.value !== undefined &&
    value.source_commit !== release.value.target_commit_sha
  ) {
    checks.push(healthCheck(
      "security_baseline",
      "rollback_required",
      "security_baseline_source_mismatch",
      "regenerate security evidence for the exact release source commit"
    ));
    return;
  }
  if (now.getTime() - Date.parse(value.generated_at) > evidenceFreshnessMs) {
    checks.push(healthCheck(
      "security_baseline",
      "hold",
      "security_baseline_stale",
      "generate a fresh security baseline"
    ));
    return;
  }
  const blocked =
    value.status === "UNPASSED" ||
    value.summary.high > 0 ||
    value.summary.critical > 0 ||
    value.summary.secret_exposures > 0;
  checks.push(healthCheck(
    "security_baseline",
    blocked
      ? "rollback_required"
      : value.status === "SETUP_REQUIRED"
        ? "hold"
        : "pass",
    blocked
      ? "security_baseline_failed"
      : value.status === "SETUP_REQUIRED"
        ? "security_baseline_setup_required"
        : "security_baseline_passed",
    blocked
      ? "stop rollout and resolve security findings"
      : value.status === "SETUP_REQUIRED"
        ? "complete external security evidence"
        : undefined
  ));
}

async function evaluateRollbackSource(
  projectRoot: string,
  transaction: EvidenceLoad<UpdateTransactionArtifact>,
  checks: PostReleaseHealthCheck[]
): Promise<{
  target: string | null;
  verified: boolean;
  command: string | null;
}> {
  const target = transaction.value?.current_version ?? null;
  if (target === null) {
    checks.push(healthCheck(
      "rollback_source",
      "hold",
      "rollback_target_unknown",
      "provide a valid update transaction"
    ));
    return { target, verified: false, command: null };
  }
  let verified = false;
  try {
    const registry = await readJsonFile<unknown>(updateRegistryPath(projectRoot));
    if (!isUpdateRegistry(registry)) {
      throw new Error("invalid registry");
    }
    const cached = await findVerifiedUpdateDownloadByVersion(
      projectRoot,
      target
    );
    verified =
      registry.previous?.version === target &&
      registry.previous.source === "verified_download" &&
      registry.previous.download_id === cached.download_id &&
      cached.version === target;
  } catch {
    verified = false;
  }
  checks.push(healthCheck(
    "rollback_source",
    verified ? "pass" : "hold",
    verified
      ? "verified_rollback_cache_available"
      : "verified_rollback_cache_missing",
    verified
      ? undefined
      : `download and verify rollback target ${target} before continuing rollout`
  ));
  return {
    target,
    verified,
    command: verified
      ? `kairon update rollback --to ${target} --confirm ${target}`
      : null
  };
}

async function loadEvidence<T>(
  projectRoot: string,
  requestedPath: string,
  kind: PostReleaseEvidenceReference["kind"],
  guard: (value: unknown) => value is T
): Promise<EvidenceLoad<T>> {
  const absolutePath = resolveInside(projectRoot, requestedPath);
  const relativePath = toProjectPath(projectRoot, absolutePath);
  try {
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      lstat(absolutePath)
    ]);
    const value = JSON.parse(content.toString("utf8")) as unknown;
    if (!fileStats.isFile() || !guard(value)) {
      return {
        reference: {
          kind,
          path: relativePath,
          sha256: sha256(content),
          status: "invalid",
          observed_status: observedStatus(value),
          recorded_at: observedTimestamp(value)
        }
      };
    }
    return {
      reference: {
        kind,
        path: relativePath,
        sha256: sha256(content),
        status: "verified",
        observed_status: observedStatus(value),
        recorded_at: observedTimestamp(value)
      },
      value
    };
  } catch (error) {
    if (isMissingError(error)) {
      return missingEvidence(projectRoot, requestedPath, kind);
    }
    return {
      reference: {
        kind,
        path: relativePath,
        sha256: null,
        status: "invalid",
        observed_status: null,
        recorded_at: null
      }
    };
  }
}

function missingEvidence<T>(
  projectRoot: string,
  requestedPath: string,
  kind: PostReleaseEvidenceReference["kind"]
): EvidenceLoad<T> {
  const absolutePath = resolveInside(projectRoot, requestedPath);
  return {
    reference: {
      kind,
      path: toProjectPath(projectRoot, absolutePath),
      sha256: null,
      status: "missing",
      observed_status: null,
      recorded_at: null
    }
  };
}

function resolveTransactionPath(
  projectRoot: string,
  input: string
): string {
  const value = input.trim();
  if (/^UTX-\d{4,}$/u.test(value)) {
    return updateTransactionArtifactPath(projectRoot, value);
  }
  if (value.length === 0) {
    throw new Error("Update transaction path or id is required.");
  }
  return resolveInside(projectRoot, value);
}

async function projectStateDigest(projectRoot: string): Promise<string> {
  const roots = [
    resolveInside(projectRoot, ".kairon", "config"),
    resolveInside(projectRoot, ".kairon", "state"),
    resolveInside(projectRoot, ".kairon", "project.json")
  ];
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const root of roots) {
    await collectDigestEntries(projectRoot, root, entries);
  }
  return sha256(Buffer.from(JSON.stringify(
    entries.sort((left, right) => left.path.localeCompare(right.path))
  ), "utf8"));
}

async function collectDigestEntries(
  projectRoot: string,
  candidate: string,
  entries: Array<{ path: string; sha256: string }>
): Promise<void> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    entries.push({
      path: toProjectPath(projectRoot, candidate),
      sha256: sha256(Buffer.from("symbolic_link_rejected", "utf8"))
    });
    return;
  }
  if (info.isFile()) {
    entries.push({
      path: toProjectPath(projectRoot, candidate),
      sha256: sha256(await readFile(candidate))
    });
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  const names = (await readdir(candidate)).sort();
  for (const name of names) {
    await collectDigestEntries(
      projectRoot,
      resolveInside(candidate, name),
      entries
    );
  }
}

async function optionalFileDigest(filePath: string): Promise<string> {
  try {
    return sha256(await readFile(filePath));
  } catch (error) {
    if (isMissingError(error)) {
      return sha256(Buffer.alloc(0));
    }
    throw error;
  }
}

async function writeTextFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      `Failed to write text file ${filePath}: ${String(error)}`
    );
  }
}

function healthCheck(
  id: PostReleaseHealthCheckId,
  status: PostReleaseHealthCheckStatus,
  reason: string,
  remediation?: string
): PostReleaseHealthCheck {
  return {
    id,
    status,
    reason,
    ...(remediation === undefined ? {} : { remediation })
  };
}

function decide(
  checks: PostReleaseHealthCheck[]
): PostReleaseHealthDecision {
  if (checks.some((entry) => entry.status === "rollback_required")) {
    return "rollback_required";
  }
  if (checks.some((entry) => entry.status === "hold")) {
    return "hold";
  }
  return "continue";
}

function normalizeObservationMinutes(value?: number): number {
  const normalized = value ?? defaultObservationMinutes;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > 7 * 24 * 60
  ) {
    throw new Error(
      "Post-release observation minutes must be an integer from 1 to 10080."
    );
  }
  return normalized;
}

function isStableReleaseVerification(
  value: unknown
): value is StableReleaseVerificationResult {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_release_verification" &&
    typeof candidate.verification_id === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.integrity_status === "string" &&
    typeof candidate.currentness_status === "string" &&
    typeof candidate.repository === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.release_id === "number" &&
    typeof candidate.target_commit_sha === "string" &&
    shaPattern.test(candidate.target_commit_sha) &&
    typeof candidate.state_digest === "string" &&
    digestPattern.test(candidate.state_digest) &&
    record(candidate.manifest) !== undefined &&
    typeof record(candidate.manifest)?.sha256 === "string" &&
    Array.isArray(candidate.checks) &&
    typeof candidate.checked_at === "string" &&
    typeof candidate.expires_at === "string";
}

function isStableCanaryFinalResult(
  value: unknown
): value is StableCanaryFinalResult {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_canary_final_result" &&
    typeof candidate.canary_id === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.source_verification_id === "string" &&
    typeof candidate.source_state_digest === "string" &&
    digestPattern.test(candidate.source_state_digest) &&
    typeof candidate.source_release_id === "number" &&
    typeof candidate.version === "string" &&
    typeof candidate.sandbox_result_status === "string" &&
    Array.isArray(candidate.checks) &&
    typeof candidate.finalized_at === "string";
}

function isUpdateTransactionArtifact(
  value: unknown
): value is UpdateTransactionArtifact {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "update_transaction" &&
    typeof candidate.transaction_id === "string" &&
    /^UTX-\d{4,}$/u.test(candidate.transaction_id) &&
    typeof candidate.action === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.current_version === "string" &&
    typeof candidate.target_version === "string" &&
    typeof candidate.download_id === "string" &&
    typeof candidate.package_sha256 === "string" &&
    digestPattern.test(candidate.package_sha256) &&
    typeof candidate.package_size_bytes === "number" &&
    Array.isArray(candidate.timeline) &&
    typeof candidate.updated_at === "string";
}

function isVerifiedUpdateDownload(
  value: unknown
): value is VerifiedUpdateDownload {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "verified_update_download" &&
    typeof candidate.download_id === "string" &&
    typeof candidate.repository === "string" &&
    typeof candidate.release_id === "number" &&
    candidate.release_channel === "stable" &&
    typeof candidate.version === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.source_commit === "string" &&
    shaPattern.test(candidate.source_commit) &&
    typeof candidate.package_sha256 === "string" &&
    digestPattern.test(candidate.package_sha256) &&
    typeof candidate.package_size_bytes === "number" &&
    typeof candidate.downloaded_at === "string";
}

function isRuntimeSloSummary(
  value: unknown
): value is RuntimeSloSummary {
  const candidate = record(value);
  const window = record(candidate?.window);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "runtime_slo_summary" &&
    typeof candidate.status === "string" &&
    typeof candidate.evaluated_at === "string" &&
    window !== undefined &&
    typeof window.start === "string" &&
    typeof window.end === "string" &&
    typeof window.minutes === "number" &&
    record(candidate.objectives) !== undefined;
}

function isSecurityBaselineArtifact(
  value: unknown
): value is SecurityBaselineArtifact {
  const candidate = record(value);
  const summary = record(candidate?.summary);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "security_baseline_result" &&
    typeof candidate.status === "string" &&
    typeof candidate.source_commit === "string" &&
    shaPattern.test(candidate.source_commit) &&
    typeof candidate.generated_at === "string" &&
    summary !== undefined &&
    typeof summary.high === "number" &&
    typeof summary.critical === "number" &&
    typeof summary.secret_exposures === "number";
}

function isUpdateRegistry(value: unknown): value is UpdateRegistry {
  const candidate = record(value);
  const installed = record(candidate?.installed);
  const previous = candidate?.previous === null
    ? null
    : record(candidate?.previous);
  return candidate?.schema_version === "0.1" &&
    installed !== undefined &&
    typeof installed.version === "string" &&
    (previous === null ||
      (previous !== undefined && typeof previous.version === "string")) &&
    Array.isArray(candidate.history);
}

function isPostReleaseHealthResult(
  value: unknown
): value is PostReleaseHealthResult {
  const candidate = record(value);
  if (!(candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "post_release_health_result" &&
    typeof candidate.health_id === "string" &&
    /^PRH-\d{14}-[a-f0-9]{12}$/u.test(candidate.health_id) &&
    (
      candidate.decision === "continue" ||
      candidate.decision === "hold" ||
      candidate.decision === "rollback_required"
    ) &&
    Array.isArray(candidate.evidence) &&
    candidate.evidence.every(isEvidenceReference) &&
    Array.isArray(candidate.checks) &&
    candidate.checks.every(isHealthCheck) &&
    Array.isArray(record(candidate.incidents)?.references) &&
    typeof candidate.state_digest === "string" &&
    digestPattern.test(candidate.state_digest) &&
    typeof candidate.generated_at === "string" &&
    typeof candidate.expires_at === "string" &&
    candidate.rollback_automatic === false &&
    candidate.approval_automatic === false)) {
    return false;
  }
  const typed = value as PostReleaseHealthResult;
  const expectedDigest = calculateStateDigest(
    typed.evidence,
    typed.decision,
    typed.checks,
    typed.incidents.references
  );
  return typed.state_digest === expectedDigest &&
    typed.health_id.endsWith(expectedDigest.slice(0, 12));
}

function isEvidenceReference(
  value: unknown
): value is PostReleaseEvidenceReference {
  const candidate = record(value);
  return candidate !== undefined &&
    typeof candidate.kind === "string" &&
    typeof candidate.path === "string" &&
    (
      candidate.sha256 === null ||
      (typeof candidate.sha256 === "string" &&
        digestPattern.test(candidate.sha256))
    ) &&
    (
      candidate.status === "verified" ||
      candidate.status === "missing" ||
      candidate.status === "invalid"
    );
}

function isHealthCheck(value: unknown): value is PostReleaseHealthCheck {
  const candidate = record(value);
  return candidate !== undefined &&
    typeof candidate.id === "string" &&
    (
      candidate.status === "pass" ||
      candidate.status === "hold" ||
      candidate.status === "rollback_required"
    ) &&
    typeof candidate.reason === "string";
}

function observedStatus(value: unknown): string | null {
  const status = record(value)?.status;
  return typeof status === "string" ? status : null;
}

function observedTimestamp(value: unknown): string | null {
  const candidate = record(value);
  if (candidate === undefined) {
    return null;
  }
  for (const key of [
    "finalized_at",
    "evaluated_at",
    "generated_at",
    "updated_at",
    "checked_at",
    "downloaded_at"
  ]) {
    if (typeof candidate[key] === "string") {
      return candidate[key] as string;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isExpired(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ||
    String(error).includes("ENOENT");
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function calculateStateDigest(
  evidence: PostReleaseEvidenceReference[],
  decision: PostReleaseHealthDecision,
  checks: PostReleaseHealthCheck[],
  incidentReferences: string[]
): string {
  return sha256(Buffer.from(JSON.stringify({
    evidence: evidence.map((entry) => ({
      kind: entry.kind,
      sha256: entry.sha256,
      status: entry.status
    })),
    decision,
    checks,
    incidents: incidentReferences
  }), "utf8"));
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}

function formatTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:TZ.]/gu, "")
    .slice(0, 14);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}
