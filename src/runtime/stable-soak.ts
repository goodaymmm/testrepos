import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { sanitizeSupportText } from "../diagnostics/support-redaction.js";
import { listIncidents, type IncidentArtifact } from "../incidents/store.js";
import {
  createRuntimeMetricsSnapshot,
  type RuntimeMetricsSnapshot
} from "../observability/metrics-store.js";
import {
  checkRuntimeSlo,
  type RuntimeSloSummary
} from "../observability/slo.js";
import {
  inspectLatestStableReleaseVerification,
  type StableReleaseVerificationResult
} from "../release/stable-verification.js";
import {
  createDaemonSoakCertification,
  type DaemonCertificationRestart,
  type DaemonSoakCertification
} from "./daemon-certification.js";
import {
  createDaemonEvidenceReport,
  type DaemonEvidenceReport,
  type DaemonReportFormat
} from "./daemon-report.js";

export type StableSoakEvidenceMode = "real_time" | "simulated";
export type StableSoakStatus =
  | "active"
  | "ready_to_certify"
  | "PASS"
  | "FAIL"
  | "SETUP_REQUIRED";
export type StableSoakMarkerKind = "planned_reboot" | "maintenance";

export type StableSoakManifest = {
  schema_version: "0.1";
  artifact_kind: "stable_soak_manifest";
  soak_id: string;
  status: "active";
  evidence_mode: StableSoakEvidenceMode;
  release: {
    verification_id: string;
    version: string;
    release_id: number;
    target_commit_sha: string;
    state_digest: string;
    artifact_path: string;
    artifact_sha256: string;
  };
  profile: {
    minimum_hours: number;
    expected_interval_ms: number;
    max_heartbeat_gap_ms: number;
    max_restart_gap_ms: number;
    minimum_coverage_ratio: number;
    max_fatal_errors: number;
    max_high_incidents: number;
    max_critical_incidents: number;
  };
  started_at: string;
  manifest_digest: string;
};

export type StableSoakMarker = {
  schema_version: "0.1";
  artifact_kind: "stable_soak_marker";
  marker_id: string;
  soak_id: string;
  kind: StableSoakMarkerKind;
  from: string;
  until: string;
  reason: string;
  recorded_at: string;
};

export type StableSoakGap = {
  from: string;
  to: string;
  gap_ms: number;
  classification:
    | "heartbeat"
    | "planned_reboot"
    | "maintenance"
    | "scheduled_restart";
  explained: boolean;
  marker_id?: string;
};

export type StableSoakDailyRollup = {
  schema_version: "0.1";
  artifact_kind: "stable_soak_daily_rollup";
  soak_id: string;
  date: string;
  window: {
    from: string;
    until: string;
    duration_ms: number;
  };
  daemon: {
    event_count: number;
    ticks: number;
    fatal_errors: number;
    heartbeat_gaps: number;
    unexplained_gaps: number;
    coverage_ratio: number;
    source_log_digests: Array<{ path: string; sha256: string }>;
  };
  slo: {
    status: RuntimeSloSummary["status"];
    corrupt_samples: number;
    objectives: Record<string, string>;
  };
  incidents: {
    high: number;
    critical: number;
    recovered: number;
  };
  generated_at: string;
  rollup_digest: string;
};

export type StableSoakEvaluation = {
  soak_id: string;
  status: StableSoakStatus;
  evidence_mode: StableSoakEvidenceMode;
  release: StableSoakManifest["release"];
  elapsed_hours: number;
  minimum_hours: number;
  duration_satisfied: boolean;
  coverage_ratio: number;
  daemon: {
    ticks: number;
    fatal_errors: number;
    allowed_restarts: number;
    unexpected_restarts: number;
    unexplained_gaps: number;
  };
  incidents: {
    high: number;
    critical: number;
    recovered: number;
  };
  slo_statuses: RuntimeSloSummary["status"][];
  release_drift: boolean;
  reasons: string[];
  next_action: string;
  daily_rollups: Array<{
    date: string;
    path: string;
    digest: string;
  }>;
  evaluated_at: string;
};

export type StableSoakCertificate = {
  schema_version: "0.1";
  artifact_kind: "stable_soak_certificate";
  certificate_id: string;
  soak_id: string;
  status: "PASS" | "FAIL" | "SETUP_REQUIRED";
  manifest_digest: string;
  release: StableSoakManifest["release"];
  evaluation: StableSoakEvaluation;
  marker_digest: string;
  certified_at: string;
  certificate_digest: string;
};

export type StartStableSoakOptions = {
  releaseVerification: string;
  minimumHours?: number;
  expectedIntervalMs?: number;
  maxHeartbeatGapMs?: number;
  maxRestartGapMs?: number;
  minimumCoverageRatio?: number;
  now?: () => Date;
};

export type EvaluateStableSoakOptions = {
  now?: () => Date;
  persistRollups?: boolean;
};

export type StableSoakInspection =
  | { status: "not_run" }
  | { status: "corrupt"; reason: string }
  | {
      status: "active" | "certified";
      soak_id: string;
      evidence_mode: StableSoakEvidenceMode;
      release_version: string;
      elapsed_hours: number;
      minimum_hours: number;
      coverage_ratio: number | null;
      result: StableSoakCertificate["status"] | null;
      next_action: string;
    };

const soakIdPattern = /^SSK-\d{14}-[a-f0-9]{12}$/u;
const markerIdPattern = /^SMK-\d{14}-[a-f0-9]{12}$/u;
const certificateIdPattern = /^SSC-\d{14}-[a-f0-9]{12}$/u;
const minimumStableHours = 168;
const maximumDailyRollups = 400;

export async function startStableSoak(
  projectRoot: string,
  options: StartStableSoakOptions
): Promise<{ manifest: StableSoakManifest; manifest_path: string }> {
  const root = path.resolve(projectRoot);
  const now = options.now?.() ?? new Date();
  const releasePath = resolveProjectFile(root, options.releaseVerification);
  const releaseBytes = await readFile(releasePath);
  const release = parseStableVerification(
    JSON.parse(releaseBytes.toString("utf8")) as unknown
  );
  if (
    release.status !== "PASS" ||
    release.integrity_status !== "PASS" ||
    release.currentness_status !== "PASS" ||
    release.release_id === null ||
    release.target_commit_sha === null
  ) {
    throw new Error("Stable soak requires a passing Stable release verification.");
  }
  if (Date.parse(release.expires_at) <= now.getTime()) {
    throw new Error("Stable release verification is expired.");
  }
  const minimumHours = requireInteger(
    options.minimumHours ?? minimumStableHours,
    "minimumHours",
    minimumStableHours
  );
  const expectedIntervalMs = requirePositive(
    options.expectedIntervalMs ?? 60_000,
    "expectedIntervalMs"
  );
  const maxHeartbeatGapMs = requirePositive(
    options.maxHeartbeatGapMs ?? expectedIntervalMs * 3,
    "maxHeartbeatGapMs"
  );
  const maxRestartGapMs = requirePositive(
    options.maxRestartGapMs ?? expectedIntervalMs * 30,
    "maxRestartGapMs"
  );
  const minimumCoverageRatio = requireRatio(
    options.minimumCoverageRatio ?? 0.99,
    "minimumCoverageRatio"
  );
  const releaseBinding = {
    verification_id: release.verification_id,
    version: release.version,
    release_id: release.release_id,
    target_commit_sha: release.target_commit_sha,
    state_digest: release.state_digest,
    artifact_path: toProjectPath(root, releasePath),
    artifact_sha256: sha256(releaseBytes)
  };
  const startedAt = now.toISOString();
  const soakId = stableSoakId(startedAt, releaseBinding);
  const unsigned = {
    schema_version: "0.1" as const,
    artifact_kind: "stable_soak_manifest" as const,
    soak_id: soakId,
    status: "active" as const,
    evidence_mode: options.now === undefined ? "real_time" as const : "simulated" as const,
    release: releaseBinding,
    profile: {
      minimum_hours: minimumHours,
      expected_interval_ms: expectedIntervalMs,
      max_heartbeat_gap_ms: maxHeartbeatGapMs,
      max_restart_gap_ms: maxRestartGapMs,
      minimum_coverage_ratio: minimumCoverageRatio,
      max_fatal_errors: 0,
      max_high_incidents: 0,
      max_critical_incidents: 0
    },
    started_at: startedAt
  };
  const manifest: StableSoakManifest = {
    ...unsigned,
    manifest_digest: digest(unsigned)
  };
  const paths = stableSoakPaths(root, soakId);
  await writeJsonFileAtomic(paths.manifest, manifest);
  await writeJsonFileAtomic(stableSoakLatestPath(root), {
    schema_version: "0.1",
    artifact_kind: "stable_soak_latest",
    soak_id: soakId,
    manifest_digest: manifest.manifest_digest,
    updated_at: startedAt
  });
  return {
    manifest,
    manifest_path: toProjectPath(root, paths.manifest)
  };
}

export async function markStableSoakWindow(
  projectRoot: string,
  soakId: string,
  input: {
    kind: StableSoakMarkerKind;
    from: string;
    until: string;
    reason: string;
    now?: () => Date;
  }
): Promise<{ marker: StableSoakMarker; marker_path: string }> {
  const root = path.resolve(projectRoot);
  const manifest = await readStableSoakManifest(root, soakId);
  const from = parseTimestamp(input.from, "marker from");
  const until = parseTimestamp(input.until, "marker until");
  if (until.getTime() <= from.getTime()) {
    throw new Error("Stable soak marker until must be after from.");
  }
  if (from.getTime() < Date.parse(manifest.started_at)) {
    throw new Error("Stable soak marker cannot start before the soak.");
  }
  if (input.kind !== "planned_reboot" && input.kind !== "maintenance") {
    throw new Error(`Invalid Stable soak marker kind: ${input.kind}`);
  }
  const reason = sanitizeSupportText(input.reason, { projectRoot: root })
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
  if (reason.length < 3) {
    throw new Error("Stable soak marker reason must contain at least 3 characters.");
  }
  const recordedAt = input.now?.() ?? new Date();
  if (recordedAt.getTime() > from.getTime()) {
    throw new Error("Stable soak marker must be recorded before its window starts.");
  }
  const markerId = stableSoakMarkerId(recordedAt.toISOString(), {
    soak_id: soakId,
    kind: input.kind,
    from: from.toISOString(),
    until: until.toISOString()
  });
  const marker: StableSoakMarker = {
    schema_version: "0.1",
    artifact_kind: "stable_soak_marker",
    marker_id: markerId,
    soak_id: soakId,
    kind: input.kind,
    from: from.toISOString(),
    until: until.toISOString(),
    reason,
    recorded_at: recordedAt.toISOString()
  };
  const markerPath = resolveInside(
    stableSoakPaths(root, soakId).markers,
    `${markerId}.json`
  );
  await writeJsonFileAtomic(markerPath, marker);
  return { marker, marker_path: toProjectPath(root, markerPath) };
}

export async function evaluateStableSoak(
  projectRoot: string,
  soakId: string,
  options: EvaluateStableSoakOptions = {}
): Promise<StableSoakEvaluation> {
  const root = path.resolve(projectRoot);
  const manifest = await readStableSoakManifest(root, soakId);
  const now = options.now?.() ?? new Date();
  const startedAt = parseTimestamp(manifest.started_at, "soak start");
  if (now.getTime() < startedAt.getTime()) {
    throw new Error("Stable soak evaluation cannot precede the soak start.");
  }
  const markers = await readStableSoakMarkers(root, soakId);
  const daemon = await createDaemonSoakCertification(root, {
    since: manifest.started_at,
    now: () => now,
    expectedIntervalMs: manifest.profile.expected_interval_ms,
    maxHeartbeatGapMs: manifest.profile.max_heartbeat_gap_ms,
    maxRestartGapMs: manifest.profile.max_restart_gap_ms,
    maxFatalErrors: manifest.profile.max_fatal_errors,
    minimumTicks: 0
  });
  const report = await createDaemonEvidenceReport(root, {
    since: manifest.started_at,
    now: () => now,
    heartbeatGapMs: manifest.profile.max_heartbeat_gap_ms
  });
  const gaps = classifyGaps(manifest, daemon, report, markers, now);
  const durationMs = now.getTime() - startedAt.getTime();
  const unexplainedGapMs = gaps
    .filter((gap) => !gap.explained)
    .reduce((total, gap) => total + gap.gap_ms, 0);
  const coverageRatio =
    durationMs === 0
      ? 0
      : roundRatio(Math.max(0, durationMs - unexplainedGapMs) / durationMs);
  const rollups = await createDailyRollups(
    root,
    manifest,
    startedAt,
    now,
    markers,
    daemon.restarts,
    options.persistRollups !== false
  );
  const incidents = summarizeIncidents(await listIncidents(root), startedAt, now);
  const releaseDrift = await detectReleaseDrift(root, manifest);
  const elapsedHours = durationMs / 3_600_000;
  const durationSatisfied = elapsedHours >= manifest.profile.minimum_hours;
  const unexpectedRestarts = countUnexpectedRestarts(daemon.restarts, markers);
  const sloStatuses = [...new Set(rollups.map((rollup) => rollup.rollup.slo.status))];
  const reasons: string[] = [];
  if (manifest.evidence_mode !== "real_time") {
    reasons.push("simulated_clock_cannot_certify");
  }
  if (!durationSatisfied) {
    reasons.push("minimum_duration_not_reached");
  }
  if (releaseDrift) {
    reasons.push("release_binding_drift");
  }
  if (coverageRatio < manifest.profile.minimum_coverage_ratio) {
    reasons.push("coverage_below_threshold");
  }
  if (gaps.some((gap) => !gap.explained)) {
    reasons.push("unexplained_runtime_gap");
  }
  if (daemon.metrics.fatal_errors > manifest.profile.max_fatal_errors) {
    reasons.push("fatal_error_detected");
  }
  if (unexpectedRestarts > 0) {
    reasons.push("unexpected_restart_detected");
  }
  if (incidents.critical > manifest.profile.max_critical_incidents) {
    reasons.push("critical_incident_detected");
  }
  if (incidents.high > manifest.profile.max_high_incidents) {
    reasons.push("high_incident_detected");
  }
  if (sloStatuses.some((status) => status === "CRITICAL" || status === "CORRUPT_DATA")) {
    reasons.push("slo_gate_failed");
  }
  if (sloStatuses.some((status) => status === "INSUFFICIENT_DATA")) {
    reasons.push("slo_evidence_incomplete");
  }
  const hardFailureReasons = reasons.filter(
    (reason) =>
      reason !== "minimum_duration_not_reached" &&
      reason !== "simulated_clock_cannot_certify"
  );
  const status: StableSoakStatus =
    hardFailureReasons.length > 0
      ? "FAIL"
      : manifest.evidence_mode !== "real_time" || !durationSatisfied
        ? "SETUP_REQUIRED"
        : "ready_to_certify";
  const nextAction =
    status === "ready_to_certify"
      ? `run kairon daemon soak certify ${soakId}`
      : status === "SETUP_REQUIRED"
        ? manifest.evidence_mode === "simulated"
          ? "start a new soak without clock injection and collect 168 real-time hours"
          : `continue the daemon soak for ${Math.max(
              0,
              manifest.profile.minimum_hours - elapsedHours
            ).toFixed(2)} hours`
        : "resolve the listed failures and start a new Stable soak certification";
  return {
    soak_id: soakId,
    status,
    evidence_mode: manifest.evidence_mode,
    release: manifest.release,
    elapsed_hours: round(elapsedHours, 3),
    minimum_hours: manifest.profile.minimum_hours,
    duration_satisfied: durationSatisfied,
    coverage_ratio: coverageRatio,
    daemon: {
      ticks: daemon.metrics.ticks,
      fatal_errors: daemon.metrics.fatal_errors,
      allowed_restarts: daemon.metrics.allowed_restarts,
      unexpected_restarts: unexpectedRestarts,
      unexplained_gaps: gaps.filter((gap) => !gap.explained).length
    },
    incidents,
    slo_statuses: sloStatuses,
    release_drift: releaseDrift,
    reasons: [...new Set(reasons)].sort(),
    next_action: nextAction,
    daily_rollups: rollups.map((entry) => ({
      date: entry.rollup.date,
      path: entry.path,
      digest: entry.rollup.rollup_digest
    })),
    evaluated_at: now.toISOString()
  };
}

export async function certifyStableSoak(
  projectRoot: string,
  soakId: string,
  options: EvaluateStableSoakOptions = {}
): Promise<{ certificate: StableSoakCertificate; certificate_path: string }> {
  const root = path.resolve(projectRoot);
  const manifest = await readStableSoakManifest(root, soakId);
  const evaluation = await evaluateStableSoak(root, soakId, options);
  const markers = await readStableSoakMarkers(root, soakId);
  const certifiedAt = options.now?.() ?? new Date();
  const status: StableSoakCertificate["status"] =
    evaluation.status === "ready_to_certify"
      ? "PASS"
      : evaluation.status === "FAIL"
        ? "FAIL"
        : "SETUP_REQUIRED";
  const unsigned = {
    schema_version: "0.1" as const,
    artifact_kind: "stable_soak_certificate" as const,
    certificate_id: stableSoakCertificateId(certifiedAt.toISOString(), {
      soak_id: soakId,
      manifest_digest: manifest.manifest_digest,
      evaluated_at: evaluation.evaluated_at
    }),
    soak_id: soakId,
    status,
    manifest_digest: manifest.manifest_digest,
    release: manifest.release,
    evaluation,
    marker_digest: digest(markers),
    certified_at: certifiedAt.toISOString()
  };
  const certificate: StableSoakCertificate = {
    ...unsigned,
    certificate_digest: digest(unsigned)
  };
  const certificatePath = stableSoakPaths(root, soakId).certificate;
  await writeJsonFileAtomic(certificatePath, certificate);
  return {
    certificate,
    certificate_path: toProjectPath(root, certificatePath)
  };
}

export async function readStableSoakCertificate(
  projectRoot: string,
  soakId: string
): Promise<StableSoakCertificate | undefined> {
  const certificatePath = stableSoakPaths(path.resolve(projectRoot), soakId).certificate;
  try {
    const value = await readJsonFile<unknown>(certificatePath);
    if (!isStableSoakCertificate(value)) {
      throw new Error(`Stable soak certificate is invalid: ${soakId}`);
    }
    const { certificate_digest: observed, ...unsigned } = value;
    if (digest(unsigned) !== observed) {
      throw new Error(`Stable soak certificate digest mismatch: ${soakId}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function inspectLatestStableSoak(
  projectRoot: string,
  now = new Date()
): Promise<StableSoakInspection> {
  const root = path.resolve(projectRoot);
  let latest: unknown;
  try {
    latest = await readJsonFile<unknown>(stableSoakLatestPath(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT")) {
      return { status: "not_run" };
    }
    return { status: "corrupt", reason: "latest_pointer_unreadable" };
  }
  if (
    !isRecord(latest) ||
    typeof latest.soak_id !== "string" ||
    !soakIdPattern.test(latest.soak_id)
  ) {
    return { status: "corrupt", reason: "latest_pointer_invalid" };
  }
  try {
    const manifest = await readStableSoakManifest(root, latest.soak_id);
    const certificate = await readStableSoakCertificate(root, latest.soak_id);
    const rollups = await readStableSoakDailyRollups(root, latest.soak_id);
    const elapsedHours = Math.max(
      0,
      (now.getTime() - Date.parse(manifest.started_at)) / 3_600_000
    );
    const rollupDuration = rollups.reduce(
      (total, rollup) => total + rollup.window.duration_ms,
      0
    );
    const coverageRatio =
      rollupDuration === 0
        ? null
        : roundRatio(
            rollups.reduce(
              (total, rollup) =>
                total +
                rollup.window.duration_ms * rollup.daemon.coverage_ratio,
              0
            ) / rollupDuration
          );
    return {
      status: certificate === undefined ? "active" : "certified",
      soak_id: manifest.soak_id,
      evidence_mode: manifest.evidence_mode,
      release_version: manifest.release.version,
      elapsed_hours: round(elapsedHours, 3),
      minimum_hours: manifest.profile.minimum_hours,
      coverage_ratio: coverageRatio,
      result: certificate?.status ?? null,
      next_action:
        certificate === undefined
          ? elapsedHours >= manifest.profile.minimum_hours
            ? `run kairon daemon soak certify ${manifest.soak_id}`
            : "continue the Stable soak"
          : certificate.status === "PASS"
            ? "retain the certificate as Stable release evidence"
            : "review certificate reasons and start a new Stable soak"
    };
  } catch {
    return { status: "corrupt", reason: "soak_artifact_invalid" };
  }
}

export function formatStableSoak(
  input:
    | StableSoakManifest
    | StableSoakEvaluation
    | StableSoakCertificate,
  format: DaemonReportFormat = "markdown"
): string {
  if (format === "json") {
    return `${JSON.stringify(input, null, 2)}\n`;
  }
  if ("artifact_kind" in input && input.artifact_kind === "stable_soak_manifest") {
    return [
      "# Kairon Stable Soak",
      "",
      `soak_id: ${input.soak_id}`,
      `status: ${input.status}`,
      `evidence_mode: ${input.evidence_mode}`,
      `release_version: ${input.release.version}`,
      `release_id: ${input.release.release_id}`,
      `source_commit: ${input.release.target_commit_sha}`,
      `started_at: ${input.started_at}`,
      `minimum_hours: ${input.profile.minimum_hours}`,
      ""
    ].join("\n");
  }
  const evaluation =
    "artifact_kind" in input && input.artifact_kind === "stable_soak_certificate"
      ? input.evaluation
      : input as StableSoakEvaluation;
  const status =
    "artifact_kind" in input && input.artifact_kind === "stable_soak_certificate"
      ? input.status
      : evaluation.status;
  return [
    "# Kairon Stable Soak Report",
    "",
    `soak_id: ${evaluation.soak_id}`,
    `status: ${status}`,
    `evidence_mode: ${evaluation.evidence_mode}`,
    `release_version: ${evaluation.release.version}`,
    `elapsed_hours: ${evaluation.elapsed_hours}`,
    `minimum_hours: ${evaluation.minimum_hours}`,
    `coverage_ratio: ${evaluation.coverage_ratio}`,
    `ticks: ${evaluation.daemon.ticks}`,
    `fatal_errors: ${evaluation.daemon.fatal_errors}`,
    `unexpected_restarts: ${evaluation.daemon.unexpected_restarts}`,
    `unexplained_gaps: ${evaluation.daemon.unexplained_gaps}`,
    `high_incidents: ${evaluation.incidents.high}`,
    `critical_incidents: ${evaluation.incidents.critical}`,
    `recovered_incidents: ${evaluation.incidents.recovered}`,
    `release_drift: ${evaluation.release_drift}`,
    "",
    "## Reasons",
    "",
    ...(evaluation.reasons.length === 0
      ? ["All Stable soak checks are currently satisfied."]
      : evaluation.reasons.map((reason) => `- ${reason}`)),
    "",
    `next_action: ${evaluation.next_action}`,
    ""
  ].join("\n");
}

async function createDailyRollups(
  projectRoot: string,
  manifest: StableSoakManifest,
  startedAt: Date,
  now: Date,
  markers: StableSoakMarker[],
  restarts: DaemonCertificationRestart[],
  persist: boolean
): Promise<Array<{ rollup: StableSoakDailyRollup; path: string }>> {
  const windows = dailyWindows(startedAt, now);
  if (windows.length > maximumDailyRollups) {
    throw new Error("Stable soak exceeds the supported daily rollup retention.");
  }
  const incidents = await listIncidents(projectRoot);
  const output: Array<{ rollup: StableSoakDailyRollup; path: string }> = [];
  for (const window of windows) {
    const report = await createDaemonEvidenceReport(projectRoot, {
      since: window.from.toISOString(),
      now: () => window.until,
      heartbeatGapMs: manifest.profile.max_heartbeat_gap_ms
    });
    const snapshot = await createRuntimeMetricsSnapshot(projectRoot, {
      now: window.until,
      windowMinutes: Math.max(
        1,
        Math.ceil((window.until.getTime() - window.from.getTime()) / 60_000)
      ),
      persist: false
    });
    const slo = await checkRuntimeSlo(projectRoot, {
      now: window.until,
      snapshot,
      persist: false
    });
    const incidentSummary = summarizeIncidents(
      incidents,
      window.from,
      window.until
    );
    const sourceLogDigests = await hashProjectFiles(projectRoot, report.logs.paths);
    const durationMs = window.until.getTime() - window.from.getTime();
    const classifiedGaps = report.heartbeat_gaps.map((gap) =>
      classifyGap(new Date(gap.from), new Date(gap.to), markers, restarts)
    );
    const unexplainedGapMs = classifiedGaps
      .filter((gap) => !gap.explained)
      .reduce(
      (total, gap) => total + gap.gap_ms,
      0
    );
    const unsigned = {
      schema_version: "0.1" as const,
      artifact_kind: "stable_soak_daily_rollup" as const,
      soak_id: manifest.soak_id,
      date: window.date,
      window: {
        from: window.from.toISOString(),
        until: window.until.toISOString(),
        duration_ms: durationMs
      },
      daemon: {
        event_count: report.logs.event_count,
        ticks: report.summary.ticks,
        fatal_errors: report.summary.fatal_errors,
        heartbeat_gaps: report.summary.heartbeat_gaps,
        unexplained_gaps: classifiedGaps.filter((gap) => !gap.explained).length,
        coverage_ratio:
          durationMs === 0
            ? 0
            : roundRatio(Math.max(0, durationMs - unexplainedGapMs) / durationMs),
        source_log_digests: sourceLogDigests
      },
      slo: {
        status: slo.status,
        corrupt_samples: slo.corrupt_samples,
        objectives: Object.fromEntries(
          Object.entries(slo.objectives).map(([name, objective]) => [
            name,
            objective.status
          ])
        )
      },
      incidents: incidentSummary,
      generated_at: now.toISOString()
    };
    const rollup: StableSoakDailyRollup = {
      ...unsigned,
      rollup_digest: digest(unsigned)
    };
    const absolutePath = resolveInside(
      stableSoakPaths(projectRoot, manifest.soak_id).daily,
      `${window.date}.json`
    );
    if (persist) {
      await writeJsonFileAtomic(absolutePath, rollup);
    }
    output.push({ rollup, path: toProjectPath(projectRoot, absolutePath) });
  }
  return output;
}

function classifyGaps(
  manifest: StableSoakManifest,
  daemon: DaemonSoakCertification,
  report: DaemonEvidenceReport,
  markers: StableSoakMarker[],
  now: Date
): StableSoakGap[] {
  const gaps: StableSoakGap[] = [];
  const startedAt = new Date(manifest.started_at);
  const first = daemon.source.first_event_at === undefined
    ? undefined
    : new Date(daemon.source.first_event_at);
  const latest = daemon.source.latest_event_at === undefined
    ? undefined
    : new Date(daemon.source.latest_event_at);
  if (first === undefined || first.getTime() - startedAt.getTime() > manifest.profile.max_heartbeat_gap_ms) {
    const to = first ?? now;
    gaps.push(classifyGap(startedAt, to, markers, daemon.restarts));
  }
  for (const gap of report.heartbeat_gaps) {
    gaps.push(
      classifyGap(new Date(gap.from), new Date(gap.to), markers, daemon.restarts)
    );
  }
  if (
    latest !== undefined &&
    now.getTime() - latest.getTime() > manifest.profile.max_heartbeat_gap_ms
  ) {
    gaps.push(classifyGap(latest, now, markers, daemon.restarts));
  }
  return uniqueGaps(gaps);
}

function classifyGap(
  from: Date,
  to: Date,
  markers: StableSoakMarker[],
  restarts: DaemonCertificationRestart[]
): StableSoakGap {
  const marker = markers.find(
    (candidate) =>
      Date.parse(candidate.from) <= from.getTime() &&
      Date.parse(candidate.until) >= to.getTime()
  );
  const verifiedMarker =
    marker?.kind === "planned_reboot"
      ? restarts.some(
          (restart) =>
            restart.kind === "host_reboot" &&
            restart.to !== undefined &&
            Date.parse(marker.from) <= Date.parse(restart.from) &&
            Date.parse(marker.until) >= Date.parse(restart.to) &&
            Date.parse(restart.from) <= to.getTime() &&
            Date.parse(restart.to) >= from.getTime()
        )
      : marker !== undefined;
  if (marker !== undefined && verifiedMarker) {
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      gap_ms: Math.max(0, to.getTime() - from.getTime()),
      classification:
        marker.kind === "planned_reboot" ? "planned_reboot" : "maintenance",
      explained: true,
      marker_id: marker.marker_id
    };
  }
  const scheduledRestart = restarts.find(
    (restart) =>
      restart.kind === "scheduled_restart" &&
      restart.to !== undefined &&
      Math.abs(Date.parse(restart.from) - from.getTime()) <= 1_000 &&
      Math.abs(Date.parse(restart.to) - to.getTime()) <= 1_000
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    gap_ms: Math.max(0, to.getTime() - from.getTime()),
    classification: scheduledRestart === undefined ? "heartbeat" : "scheduled_restart",
    explained: scheduledRestart !== undefined
  };
}

function countUnexpectedRestarts(
  restarts: DaemonCertificationRestart[],
  markers: StableSoakMarker[]
): number {
  return restarts.filter((restart) => {
    if (restart.kind === "scheduled_restart" || restart.kind === "final_stop") {
      return false;
    }
    if (restart.to === undefined) {
      return true;
    }
    return !markers.some(
      (marker) =>
        marker.kind === "planned_reboot" &&
        restart.kind === "host_reboot" &&
        Date.parse(marker.from) <= Date.parse(restart.from) &&
        Date.parse(marker.until) >= Date.parse(restart.to!)
    );
  }).length;
}

async function detectReleaseDrift(
  projectRoot: string,
  manifest: StableSoakManifest
): Promise<boolean> {
  try {
    const artifactPath = resolveProjectFile(
      projectRoot,
      manifest.release.artifact_path
    );
    const artifactBytes = await readFile(artifactPath);
    if (sha256(artifactBytes) !== manifest.release.artifact_sha256) {
      return true;
    }
    const artifact = parseStableVerification(
      JSON.parse(artifactBytes.toString("utf8")) as unknown
    );
    if (
      artifact.verification_id !== manifest.release.verification_id ||
      artifact.version !== manifest.release.version ||
      artifact.release_id !== manifest.release.release_id ||
      artifact.target_commit_sha !== manifest.release.target_commit_sha ||
      artifact.state_digest !== manifest.release.state_digest
    ) {
      return true;
    }
    const latest = await inspectLatestStableReleaseVerification(projectRoot);
    if (latest.status !== "available") {
      return true;
    }
    return latest.result.version !== manifest.release.version ||
      latest.result.release_id !== manifest.release.release_id ||
      latest.result.target_commit_sha !== manifest.release.target_commit_sha;
  } catch {
    return true;
  }
}

function summarizeIncidents(
  incidents: IncidentArtifact[],
  from: Date,
  until: Date
): StableSoakEvaluation["incidents"] {
  const relevant = incidents.filter(
    (incident) =>
      Date.parse(incident.created_at) <= until.getTime() &&
      Date.parse(incident.updated_at) >= from.getTime()
  );
  return {
    high: relevant.filter((incident) => incident.severity === "high").length,
    critical: relevant.filter((incident) => incident.severity === "critical").length,
    recovered: relevant.filter(
      (incident) =>
        incident.status === "resolved" &&
        incident.resolved_at !== undefined &&
        Date.parse(incident.resolved_at) >= from.getTime() &&
        Date.parse(incident.resolved_at) <= until.getTime()
    ).length
  };
}

async function readStableSoakManifest(
  projectRoot: string,
  soakId: string
): Promise<StableSoakManifest> {
  validateSoakId(soakId);
  const value = await readJsonFile<unknown>(stableSoakPaths(projectRoot, soakId).manifest);
  if (!isStableSoakManifest(value)) {
    throw new Error(`Stable soak manifest is invalid: ${soakId}`);
  }
  const { manifest_digest: observed, ...unsigned } = value;
  if (digest(unsigned) !== observed) {
    throw new Error(`Stable soak manifest digest mismatch: ${soakId}`);
  }
  return value;
}

async function readStableSoakMarkers(
  projectRoot: string,
  soakId: string
): Promise<StableSoakMarker[]> {
  const markerDirectory = stableSoakPaths(projectRoot, soakId).markers;
  let names: string[];
  try {
    names = (await readdir(markerDirectory))
      .filter((name) => markerIdPattern.test(name.replace(/\.json$/u, "")))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const markers: StableSoakMarker[] = [];
  for (const name of names) {
    const value = await readJsonFile<unknown>(resolveInside(markerDirectory, name));
    if (!isStableSoakMarker(value) || value.soak_id !== soakId) {
      throw new Error(`Stable soak marker is invalid: ${name}`);
    }
    markers.push(value);
  }
  return markers;
}

async function readStableSoakDailyRollups(
  projectRoot: string,
  soakId: string
): Promise<StableSoakDailyRollup[]> {
  const directory = stableSoakPaths(projectRoot, soakId).daily;
  try {
    const names = (await readdir(directory))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
      .sort();
    const rollups: StableSoakDailyRollup[] = [];
    for (const name of names) {
      const rollup = await readJsonFile<unknown>(resolveInside(directory, name));
      if (!isStableSoakDailyRollup(rollup) || rollup.soak_id !== soakId) {
        throw new Error(`Stable soak daily rollup is invalid: ${name}`);
      }
      const { rollup_digest: observed, ...unsigned } = rollup;
      if (digest(unsigned) !== observed) {
        throw new Error(`Stable soak daily rollup digest mismatch: ${name}`);
      }
      rollups.push(rollup);
    }
    return rollups;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function stableSoakPaths(projectRoot: string, soakId: string): {
  root: string;
  manifest: string;
  markers: string;
  daily: string;
  certificate: string;
} {
  validateSoakId(soakId);
  const root = resolveInside(stableSoakRoot(projectRoot), soakId);
  return {
    root,
    manifest: resolveInside(root, "manifest.json"),
    markers: resolveInside(root, "markers"),
    daily: resolveInside(root, "daily"),
    certificate: resolveInside(root, "certificate.json")
  };
}

function stableSoakRoot(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).runtimeDir, "soak");
}

function stableSoakLatestPath(projectRoot: string): string {
  return resolveInside(stableSoakRoot(projectRoot), "latest.json");
}

function resolveProjectFile(projectRoot: string, value: string): string {
  const resolved = path.resolve(projectRoot, value);
  const relative = path.relative(path.resolve(projectRoot), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Stable soak evidence path must remain inside the project.");
  }
  return resolved;
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}

async function hashProjectFiles(
  projectRoot: string,
  projectPaths: string[]
): Promise<Array<{ path: string; sha256: string }>> {
  const output: Array<{ path: string; sha256: string }> = [];
  for (const projectPath of [...new Set(projectPaths)].sort()) {
    const absolutePath = resolveProjectFile(projectRoot, projectPath);
    output.push({
      path: projectPath,
      sha256: sha256(await readFile(absolutePath))
    });
  }
  return output;
}

function dailyWindows(
  startedAt: Date,
  now: Date
): Array<{ date: string; from: Date; until: Date }> {
  if (now.getTime() === startedAt.getTime()) {
    return [];
  }
  const windows: Array<{ date: string; from: Date; until: Date }> = [];
  let cursor = new Date(startedAt);
  while (cursor < now) {
    const nextMidnight = new Date(cursor);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    const until = new Date(Math.min(nextMidnight.getTime(), now.getTime()));
    windows.push({
      date: cursor.toISOString().slice(0, 10),
      from: new Date(cursor),
      until
    });
    cursor = until;
  }
  return windows;
}

function parseStableVerification(value: unknown): StableReleaseVerificationResult {
  if (!isRecord(value)) {
    throw new Error("Stable release verification is invalid.");
  }
  if (
    value.schema_version !== "0.1" ||
    value.artifact_kind !== "stable_release_verification" ||
    typeof value.verification_id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.integrity_status !== "string" ||
    typeof value.currentness_status !== "string" ||
    typeof value.version !== "string" ||
    (typeof value.release_id !== "number" && value.release_id !== null) ||
    (typeof value.target_commit_sha !== "string" && value.target_commit_sha !== null) ||
    typeof value.state_digest !== "string" ||
    typeof value.checked_at !== "string" ||
    typeof value.expires_at !== "string" ||
    value.execution_performed !== false
  ) {
    throw new Error("Stable release verification is invalid.");
  }
  return value as StableReleaseVerificationResult;
}

function isStableSoakManifest(value: unknown): value is StableSoakManifest {
  if (!isRecord(value) || !isRecord(value.release) || !isRecord(value.profile)) {
    return false;
  }
  return value.schema_version === "0.1" &&
    value.artifact_kind === "stable_soak_manifest" &&
    typeof value.soak_id === "string" &&
    soakIdPattern.test(value.soak_id) &&
    value.status === "active" &&
    (value.evidence_mode === "real_time" || value.evidence_mode === "simulated") &&
    typeof value.started_at === "string" &&
    Number.isFinite(Date.parse(value.started_at)) &&
    typeof value.manifest_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.manifest_digest) &&
    typeof value.release.verification_id === "string" &&
    typeof value.release.version === "string" &&
    typeof value.release.release_id === "number" &&
    typeof value.release.target_commit_sha === "string" &&
    typeof value.release.state_digest === "string" &&
    typeof value.release.artifact_path === "string" &&
    typeof value.release.artifact_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.release.artifact_sha256) &&
    typeof value.profile.minimum_hours === "number" &&
    value.profile.minimum_hours >= minimumStableHours &&
    typeof value.profile.expected_interval_ms === "number" &&
    value.profile.expected_interval_ms > 0 &&
    typeof value.profile.max_heartbeat_gap_ms === "number" &&
    value.profile.max_heartbeat_gap_ms > 0 &&
    typeof value.profile.max_restart_gap_ms === "number" &&
    value.profile.max_restart_gap_ms > 0 &&
    typeof value.profile.minimum_coverage_ratio === "number" &&
    value.profile.minimum_coverage_ratio > 0 &&
    value.profile.minimum_coverage_ratio <= 1 &&
    typeof value.profile.max_fatal_errors === "number" &&
    value.profile.max_fatal_errors >= 0 &&
    typeof value.profile.max_high_incidents === "number" &&
    value.profile.max_high_incidents >= 0 &&
    typeof value.profile.max_critical_incidents === "number" &&
    value.profile.max_critical_incidents >= 0;
}

function isStableSoakMarker(value: unknown): value is StableSoakMarker {
  return isRecord(value) &&
    value.schema_version === "0.1" &&
    value.artifact_kind === "stable_soak_marker" &&
    typeof value.marker_id === "string" &&
    markerIdPattern.test(value.marker_id) &&
    typeof value.soak_id === "string" &&
    soakIdPattern.test(value.soak_id) &&
    (value.kind === "planned_reboot" || value.kind === "maintenance") &&
    typeof value.from === "string" &&
    Number.isFinite(Date.parse(value.from)) &&
    typeof value.until === "string" &&
    Number.isFinite(Date.parse(value.until)) &&
    Date.parse(value.until) > Date.parse(value.from) &&
    typeof value.reason === "string" &&
    typeof value.recorded_at === "string" &&
    Number.isFinite(Date.parse(value.recorded_at));
}

function isStableSoakDailyRollup(
  value: unknown
): value is StableSoakDailyRollup {
  return isRecord(value) &&
    value.schema_version === "0.1" &&
    value.artifact_kind === "stable_soak_daily_rollup" &&
    typeof value.soak_id === "string" &&
    soakIdPattern.test(value.soak_id) &&
    typeof value.date === "string" &&
    isRecord(value.window) &&
    typeof value.window.duration_ms === "number" &&
    value.window.duration_ms >= 0 &&
    isRecord(value.daemon) &&
    typeof value.daemon.coverage_ratio === "number" &&
    value.daemon.coverage_ratio >= 0 &&
    value.daemon.coverage_ratio <= 1 &&
    typeof value.rollup_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.rollup_digest);
}

function isStableSoakCertificate(value: unknown): value is StableSoakCertificate {
  return isRecord(value) &&
    value.schema_version === "0.1" &&
    value.artifact_kind === "stable_soak_certificate" &&
    typeof value.certificate_id === "string" &&
    certificateIdPattern.test(value.certificate_id) &&
    typeof value.soak_id === "string" &&
    soakIdPattern.test(value.soak_id) &&
    (value.status === "PASS" ||
      value.status === "FAIL" ||
      value.status === "SETUP_REQUIRED") &&
    typeof value.manifest_digest === "string" &&
    isRecord(value.release) &&
    isRecord(value.evaluation) &&
    typeof value.marker_digest === "string" &&
    typeof value.certified_at === "string" &&
    typeof value.certificate_digest === "string";
}

function stableSoakId(
  createdAt: string,
  binding: Record<string, unknown>
): string {
  return `SSK-${timestampId(createdAt)}-${digest(binding).slice(7, 19)}`;
}

function stableSoakMarkerId(
  createdAt: string,
  binding: Record<string, unknown>
): string {
  return `SMK-${timestampId(createdAt)}-${digest(binding).slice(7, 19)}`;
}

function stableSoakCertificateId(
  createdAt: string,
  binding: Record<string, unknown>
): string {
  return `SSC-${timestampId(createdAt)}-${digest(binding).slice(7, 19)}`;
}

function timestampId(value: string): string {
  return value.replace(/\D/gu, "").slice(0, 14);
}

function validateSoakId(value: string): string {
  if (!soakIdPattern.test(value)) {
    throw new Error(`Invalid Stable soak id: ${value}`);
  }
  return value;
}

function uniqueGaps(gaps: StableSoakGap[]): StableSoakGap[] {
  return [
    ...new Map(gaps.map((gap) => [`${gap.from}:${gap.to}`, gap])).values()
  ].sort((left, right) => left.from.localeCompare(right.from));
}

function parseTimestamp(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function requireInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function requireRatio(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than 0 and at most 1.`);
  }
  return value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundRatio(value: number): number {
  return round(value, 6);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return `sha256:${sha256(stableSerialize(value))}`;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
