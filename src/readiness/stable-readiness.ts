import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../agents/command-runner.js";
import { sanitizeBoardProjection } from "../board/secret-scan.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  listIncidents,
  type IncidentArtifact
} from "../incidents/store.js";
import { listStableAcceptanceScenarios } from "../operation-test/stable-acceptance.js";
import {
  detectReadinessEvidenceStatus,
  inspectReadinessEvidence,
  resolveCurrentCommit,
  sha256,
  type ReadinessStatus
} from "./evidence-manifest.js";

export type StableReadinessGateId =
  | "STABLE_BASELINE_DOCS"
  | "RELEASE_ARTIFACT"
  | "RELEASE_PROVENANCE_SBOM"
  | "STABLE_PROMOTION"
  | "SCHEMA_MIGRATION"
  | "TRANSACTIONAL_UPGRADE"
  | "OBSERVABILITY_SLO"
  | "ALERT_POLICY"
  | "BOUNDED_SELF_HEALING"
  | "MULTI_PROJECT_SCHEDULE"
  | "DISASTER_RECOVERY"
  | "PERFORMANCE_CAPACITY"
  | "SECURITY_BASELINE"
  | "STABLE_ACCEPTANCE"
  | "BUILD_UNIT_INTEGRATION"
  | "STATE_SECRET_INTEGRITY";

export type StableReadinessGateClass = "required" | "external_required";

export type StableReadinessGateDefinition = {
  id: StableReadinessGateId;
  title: string;
  classification: StableReadinessGateClass;
  freshness_ms: number;
  evidence_source: string;
  accepted_artifact_kinds: readonly string[];
};

export type StableReadinessEvidenceEntry = {
  gate_id: StableReadinessGateId;
  path: string;
  artifact_kind: string;
  detected_status: ReadinessStatus;
  source_commit: string;
  executed_at: string;
  expires_at: string;
  sha256: string;
  size_bytes: number;
  summary?: string;
};

export type StableReadinessEvidenceManifest = {
  schema_version: "0.1";
  artifact_kind: "stable_readiness_evidence_manifest";
  generated_at: string;
  source_commit: string;
  evidence: StableReadinessEvidenceEntry[];
};

export type StableReadinessEvidenceResult = {
  path: string;
  artifact_kind?: string;
  status: ReadinessStatus;
  verified: boolean;
  source_commit?: string;
  executed_at?: string;
  expires_at?: string;
  sha256?: string;
  summary?: string;
  reasons: string[];
};

export type StableReadinessGateResult = {
  id: StableReadinessGateId;
  title: string;
  classification: StableReadinessGateClass;
  evidence_source: string;
  status: ReadinessStatus;
  evidence: StableReadinessEvidenceResult[];
  reasons: string[];
  remediation: string;
};

export type StableReadinessBlocker = {
  code:
    | "SOURCE_COMMIT_UNAVAILABLE"
    | "SOURCE_COMMIT_MISMATCH"
    | "UNRESOLVED_INCIDENT"
    | "INCIDENT_STORE_UNAVAILABLE"
    | "SECURITY_FINDING"
    | "SECRET_EXPOSURE"
    | "CLEANUP_FAILURE";
  severity: "high" | "critical";
  summary: string;
  remediation: string;
  reference?: string;
};

export type StableReadinessResult = {
  schema_version: "0.1";
  artifact_kind: "stable_readiness_result";
  generated_at: string;
  source_commit: string;
  manifest: {
    path: string;
    status: "verified" | "missing" | "invalid";
    sha256?: string;
    source_commit?: string;
    reason?: string;
  };
  status: ReadinessStatus;
  stable_ready: boolean;
  promotion_automatic: false;
  counts: Record<ReadinessStatus, number> & { total: number };
  gates: StableReadinessGateResult[];
  blockers: StableReadinessBlocker[];
  incidents: {
    unresolved_high: number;
    unresolved_critical: number;
  };
  security: {
    high: number;
    critical: number;
    secret_exposures: number;
  };
  cleanup: {
    status: "verified" | "missing" | "invalid" | "failed";
    resources_total: number;
    unresolved_resources: number;
    reasons: string[];
  };
  secret_scan: {
    status: "passed" | "redacted";
    redacted_fields: number;
    redacted_values: number;
    exposed_findings: number;
  };
  rerun_commands: string[];
  promotion_command: "kairon release github promote apply <PLAN_ID> --approval-id <APPROVAL_ID> --confirm <PLAN_ID>";
};

export type CreateStableReadinessManifestOptions = {
  evidence: string[];
  output?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type EvaluateStableReadinessOptions = {
  manifest?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type StableReadinessFormat = "json" | "markdown";

type BlockingIncident = IncidentArtifact & {
  severity: "high" | "critical";
};

type StableAcceptanceInspection = {
  status: StableReadinessResult["cleanup"]["status"];
  resources_total: number;
  unresolved_resources: number;
  reasons: string[];
};

const commonArtifactKinds = [
  "test_evidence",
  "operation_test_summary",
  "json",
  "text"
] as const;

export const stableReadinessGateDefinitions:
readonly StableReadinessGateDefinition[] = [
  stableGate("STABLE_BASELINE_DOCS", "Stable baseline documentation", "required", 24, "T176 baseline documentation", [
    "documentation_inventory"
  ]),
  stableGate("RELEASE_ARTIFACT", "Reproducible Stable release artifact", "required", 168, "T177 release artifact verification", [
    "kairon_release",
    "local_beta_package"
  ]),
  stableGate("RELEASE_PROVENANCE_SBOM", "Release provenance and SBOM", "required", 168, "T178 provenance and SBOM verification", [
    "kairon_local_build_provenance",
    "cyclonedx"
  ]),
  stableGate("STABLE_PROMOTION", "Guarded Stable promotion", "external_required", 168, "T179 Stable promotion live verification", [
    "stable_release_promotion_result",
    "stable_release_pointer"
  ]),
  stableGate("SCHEMA_MIGRATION", "Schema migration contract", "required", 168, "T180 migration rehearsal", [
    "schema_migration_result"
  ]),
  stableGate("TRANSACTIONAL_UPGRADE", "Transactional upgrade and rollback", "external_required", 168, "T181 clean Windows upgrade rehearsal", [
    "update_transaction",
    "verified_update_download"
  ]),
  stableGate("OBSERVABILITY_SLO", "Runtime observability and SLO", "required", 24, "T182 SLO evaluation", [
    "runtime_slo_summary",
    "runtime_metrics_report"
  ]),
  stableGate("ALERT_POLICY", "Alert escalation and maintenance policy", "external_required", 24, "T183 Discord alert policy live verification", [
    "alert_policy_result",
    "watchdog_certification"
  ]),
  stableGate("BOUNDED_SELF_HEALING", "Bounded self-healing", "required", 24, "T184 bounded recovery verification", [
    "self_healing_runbook"
  ]),
  stableGate("MULTI_PROJECT_SCHEDULE", "Scheduled multi-project health", "required", 24, "T185 scheduled health verification", [
    "multi_project_scheduled_health",
    "multi_project_supervisor"
  ]),
  stableGate("DISASTER_RECOVERY", "Off-device disaster recovery", "external_required", 168, "T186 off-device DR rehearsal", [
    "disaster_recovery_rehearsal",
    "state_backup_rehearsal"
  ]),
  stableGate("PERFORMANCE_CAPACITY", "Performance and capacity budget", "required", 24, "T187 performance comparison", [
    "performance_benchmark_result",
    "performance_comparison_result"
  ]),
  stableGate("SECURITY_BASELINE", "Stable security baseline", "external_required", 24, "T188 security baseline with npm audit", [
    "security_baseline_result"
  ]),
  stableGate("STABLE_ACCEPTANCE", "Stable end-to-end acceptance", "external_required", 24, "T189 Stable acceptance final summary", [
    "stable_acceptance_evidence_manifest"
  ]),
  stableGate("BUILD_UNIT_INTEGRATION", "Current commit build and full test", "required", 24, "Current commit build and full test", [
    "build_test_result"
  ]),
  stableGate("STATE_SECRET_INTEGRITY", "State and secret integrity", "required", 24, "Current commit state and secret integrity", [
    "security_baseline_result",
    "state_integrity",
    "secret_scan"
  ])
];

const defaultManifestPath = ".kairon/readiness/stable-evidence-manifest.json";
const defaultJsonResultPath = ".kairon/readiness/stable-result.json";
const defaultMarkdownReportPath = ".kairon/readiness/stable-report.md";
const gateById = new Map(
  stableReadinessGateDefinitions.map((definition) => [definition.id, definition])
);
const statusPriority: Record<ReadinessStatus, number> = {
  UNPASSED: 5,
  UNKNOWN: 4,
  SETUP_REQUIRED: 3,
  PASS: 2,
  OPTIONAL: 1
};

export async function createStableReadinessManifest(
  projectRoot: string,
  options: CreateStableReadinessManifestOptions
): Promise<{ manifest: StableReadinessEvidenceManifest; output_path: string }> {
  if (options.evidence.length === 0) {
    throw new Error("Specify at least one --evidence <GATE_ID=path> value.");
  }
  const now = options.now?.() ?? new Date();
  const sourceCommit = options.sourceCommit ?? await resolveCurrentCommit(
    projectRoot,
    options.commandRunner
  );
  const entries: StableReadinessEvidenceEntry[] = [];
  for (const specification of options.evidence) {
    const { gateId, evidencePath } = parseEvidenceSpecification(specification);
    const definition = gateById.get(gateId)!;
    const absolutePath = resolveInside(projectRoot, evidencePath);
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      throw new Error(`Stable readiness evidence must be a file: ${evidencePath}`);
    }
    entries.push({
      gate_id: gateId,
      path: toProjectPath(projectRoot, absolutePath),
      ...inspectReadinessEvidence({
        content,
        absolutePath,
        modifiedAt: fileStats.mtime,
        now,
        fallbackCommit: sourceCommit,
        freshnessMs: definition.freshness_ms
      })
    });
  }
  const manifest: StableReadinessEvidenceManifest = {
    schema_version: "0.1",
    artifact_kind: "stable_readiness_evidence_manifest",
    generated_at: now.toISOString(),
    source_commit: sourceCommit,
    evidence: entries.sort(compareEntries)
  };
  const absoluteOutput = resolveInside(
    projectRoot,
    options.output ?? defaultManifestPath
  );
  await writeJsonFileAtomic(absoluteOutput, manifest);
  return {
    manifest,
    output_path: toProjectPath(projectRoot, absoluteOutput)
  };
}

export async function evaluateStableReadiness(
  projectRoot: string,
  options: EvaluateStableReadinessOptions = {}
): Promise<StableReadinessResult> {
  const now = options.now?.() ?? new Date();
  const manifestPath = options.manifest ?? defaultManifestPath;
  const absoluteManifestPath = resolveInside(projectRoot, manifestPath);
  const currentCommit = options.sourceCommit ?? await resolveCommitOrUnavailable(
    projectRoot,
    options.commandRunner
  );
  const loaded = await loadManifest(absoluteManifestPath);
  const gates = loaded.manifest === undefined
    ? stableReadinessGateDefinitions.map((definition) => missingGate(
        definition,
        loaded.status === "missing"
          ? "No evidence is registered for this gate."
          : "The Stable evidence manifest is invalid."
      ))
    : await Promise.all(stableReadinessGateDefinitions.map((definition) =>
        evaluateGate({
          projectRoot,
          definition,
          entries: loaded.manifest!.evidence.filter(
            (entry) => entry.gate_id === definition.id
          ),
          manifestCommit: loaded.manifest!.source_commit,
          currentCommit,
          now
        })
      ));

  const incidents = await inspectBlockingIncidents(projectRoot);
  const security = await inspectSecurityEvidence(
    projectRoot,
    loaded.manifest?.evidence.filter((entry) =>
      entry.gate_id === "SECURITY_BASELINE" ||
      entry.gate_id === "STATE_SECRET_INTEGRITY"
    ) ?? []
  );
  const cleanup = await inspectStableAcceptanceState(
    projectRoot,
    loaded.manifest?.evidence.filter(
      (entry) => entry.gate_id === "STABLE_ACCEPTANCE"
    ) ?? [],
    currentCommit
  );
  let blockers = buildIntegrityBlockers({
    currentCommit,
    manifest: loaded.manifest,
    gates,
    incidents: incidents.incidents,
    incidentStoreUnavailable: incidents.unavailable,
    security,
    cleanup
  });
  let result = buildResult({
    now,
    currentCommit,
    manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
    loaded,
    gates,
    blockers,
    incidents: incidents.incidents,
    security,
    cleanup
  });

  const sanitized = sanitizeBoardProjection(result);
  const redactedCount =
    sanitized.summary.redacted_fields + sanitized.summary.redacted_values;
  if (redactedCount > 0) {
    const sanitizedGates = sanitized.projection.gates.map((gate) =>
      gate.id === "STATE_SECRET_INTEGRITY"
        ? {
            ...gate,
            status: "UNPASSED" as const,
            reasons: uniqueValues([
              ...gate.reasons,
              "Stable readiness output required secret redaction."
            ]),
            remediation:
              "Rotate exposed credentials, sanitize evidence, and regenerate the Stable manifest."
          }
        : gate
    );
    blockers = uniqueBlockers([
      ...sanitized.projection.blockers,
      {
        code: "SECRET_EXPOSURE",
        severity: "critical",
        summary: "Stable readiness evidence contained secret-bearing output.",
        remediation:
          "Rotate exposed credentials, sanitize the source evidence, and regenerate the Stable manifest."
      }
    ]);
    result = buildResult({
      now,
      currentCommit,
      manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
      loaded,
      gates: sanitizedGates,
      blockers,
      incidents: incidents.incidents,
      security: {
        ...security,
        secret_exposures: Math.max(security.secret_exposures, redactedCount)
      },
      cleanup
    });
  }

  const finalSanitized = sanitizeBoardProjection(result);
  return {
    ...finalSanitized.projection,
    secret_scan: {
      status: redactedCount === 0 ? "passed" : "redacted",
      redacted_fields: sanitized.summary.redacted_fields,
      redacted_values: sanitized.summary.redacted_values,
      exposed_findings: Math.max(
        result.security.secret_exposures,
        redactedCount
      )
    }
  };
}

export function formatStableReadinessResult(
  result: StableReadinessResult,
  format: StableReadinessFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "# Kairon Stable Local Release Readiness Report",
    "",
    `generated_at: ${result.generated_at}`,
    `source_commit: \`${result.source_commit}\``,
    `status: **${result.status}**`,
    `stable_ready: **${result.stable_ready}**`,
    `automatic_promotion: **${result.promotion_automatic}**`,
    `manifest: \`${escapeMarkdown(result.manifest.path)}\` (${result.manifest.status})`,
    "",
    "## Release Decision",
    "",
    result.stable_ready
      ? "- Stable Local Release gate passed. Promotion still requires the explicit approval-bound command."
      : "- Stable Local Release is blocked. Resolve every non-PASS gate and global blocker.",
    `- explicit promotion command: \`${result.promotion_command}\``,
    "",
    "## Gate Summary",
    "",
    "| Gate | Class | Status | Evidence |",
    "| --- | --- | --- | --- |",
    ...result.gates.map((gate) =>
      `| ${gate.id} | ${gate.classification} | ${gate.status} | ${gate.evidence.length} |`
    ),
    "",
    "## Global Blockers",
    "",
    ...(result.blockers.length === 0
      ? ["- none"]
      : result.blockers.map((blocker) =>
          `- **${blocker.code}** (${blocker.severity}): ${escapeMarkdown(blocker.summary)} ` +
          `Remediation: ${escapeMarkdown(blocker.remediation)}`
        )),
    "",
    "## Rerun Commands",
    "",
    ...result.rerun_commands.map((command) => `- \`${escapeMarkdown(command)}\``),
    "",
    "## Gate Details",
    "",
    ...result.gates.flatMap((gate) => [
      `### ${gate.id}`,
      "",
      `- title: ${escapeMarkdown(gate.title)}`,
      `- class: ${gate.classification}`,
      `- status: ${gate.status}`,
      `- evidence_source: ${escapeMarkdown(gate.evidence_source)}`,
      `- remediation: ${escapeMarkdown(gate.remediation)}`,
      ...gate.reasons.map((reason) => `- reason: ${escapeMarkdown(reason)}`),
      ...gate.evidence.flatMap((evidence) => [
        `- evidence: \`${escapeMarkdown(evidence.path)}\``,
        `  - artifact_kind: ${escapeMarkdown(evidence.artifact_kind ?? "unknown")}`,
        `  - verified: ${evidence.verified}`,
        `  - status: ${evidence.status}`,
        ...(evidence.sha256 === undefined
          ? []
          : [`  - sha256: \`${evidence.sha256}\``]),
        ...evidence.reasons.map((reason) =>
          `  - reason: ${escapeMarkdown(reason)}`
        )
      ]),
      ""
    ]),
    "## Integrity",
    "",
    `- unresolved_high_incidents: ${result.incidents.unresolved_high}`,
    `- unresolved_critical_incidents: ${result.incidents.unresolved_critical}`,
    `- security_high: ${result.security.high}`,
    `- security_critical: ${result.security.critical}`,
    `- secret_exposures: ${result.security.secret_exposures}`,
    `- cleanup_status: ${result.cleanup.status}`,
    `- cleanup_unresolved_resources: ${result.cleanup.unresolved_resources}`,
    ...result.cleanup.reasons.map((reason) =>
      `- cleanup_reason: ${escapeMarkdown(reason)}`
    ),
    `- secret_scan: ${result.secret_scan.status}`,
    ""
  ].join("\n");
}

export async function writeStableReadinessResult(
  projectRoot: string,
  result: StableReadinessResult,
  format: StableReadinessFormat,
  output?: string
): Promise<string> {
  const outputPath = output ?? (
    format === "json" ? defaultJsonResultPath : defaultMarkdownReportPath
  );
  const absoluteOutput = resolveInside(projectRoot, outputPath);
  if (format === "json") {
    await writeJsonFileAtomic(absoluteOutput, result);
  } else {
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(
      absoluteOutput,
      formatStableReadinessResult(result, "markdown"),
      "utf8"
    );
  }
  return toProjectPath(projectRoot, absoluteOutput);
}

export function parseStableReadinessFormat(
  value: string | undefined
): StableReadinessFormat {
  if (value === undefined || value === "markdown" || value === "md") {
    return "markdown";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid Stable readiness report format: ${value}`);
}

export async function stableReadinessManifestExists(
  projectRoot: string,
  manifestPath = defaultManifestPath
): Promise<boolean> {
  try {
    await access(resolveInside(projectRoot, manifestPath));
    return true;
  } catch {
    return false;
  }
}

function stableGate(
  id: StableReadinessGateId,
  title: string,
  classification: StableReadinessGateClass,
  freshnessHours: number,
  evidenceSource: string,
  acceptedArtifactKinds: readonly string[]
): StableReadinessGateDefinition {
  return {
    id,
    title,
    classification,
    freshness_ms: freshnessHours * 60 * 60 * 1_000,
    evidence_source: evidenceSource,
    accepted_artifact_kinds: uniqueValues([
      ...acceptedArtifactKinds,
      ...commonArtifactKinds
    ])
  };
}

function parseEvidenceSpecification(specification: string): {
  gateId: StableReadinessGateId;
  evidencePath: string;
} {
  const separator = specification.indexOf("=");
  if (separator <= 0 || separator === specification.length - 1) {
    throw new Error(
      `Invalid evidence specification: ${specification}. Use GATE_ID=path.`
    );
  }
  const gateId = specification.slice(0, separator).trim().toUpperCase();
  if (!gateById.has(gateId as StableReadinessGateId)) {
    throw new Error(`Unknown Stable readiness gate id: ${gateId}`);
  }
  return {
    gateId: gateId as StableReadinessGateId,
    evidencePath: specification.slice(separator + 1).trim()
  };
}

async function evaluateGate(input: {
  projectRoot: string;
  definition: StableReadinessGateDefinition;
  entries: StableReadinessEvidenceEntry[];
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<StableReadinessGateResult> {
  if (input.entries.length === 0) {
    return missingGate(
      input.definition,
      "No evidence is registered for this gate."
    );
  }
  const evidence = await Promise.all(input.entries.map((entry) =>
    verifyEntry({
      projectRoot: input.projectRoot,
      definition: input.definition,
      entry,
      manifestCommit: input.manifestCommit,
      currentCommit: input.currentCommit,
      now: input.now
    })
  ));
  const status = evidence
    .map((item) => item.status)
    .sort((left, right) => statusPriority[right] - statusPriority[left])[0] ??
    "UNKNOWN";
  const reasons = uniqueValues(evidence.flatMap((item) => item.reasons));
  return {
    id: input.definition.id,
    title: input.definition.title,
    classification: input.definition.classification,
    evidence_source: input.definition.evidence_source,
    status,
    evidence,
    reasons,
    remediation: remediationFor(input.definition, status)
  };
}

async function verifyEntry(input: {
  projectRoot: string;
  definition: StableReadinessGateDefinition;
  entry: StableReadinessEvidenceEntry;
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<StableReadinessEvidenceResult> {
  const reasons: string[] = [];
  const result: StableReadinessEvidenceResult = {
    path: input.entry.path,
    artifact_kind: input.entry.artifact_kind,
    status: input.entry.detected_status,
    verified: false,
    source_commit: input.entry.source_commit,
    executed_at: input.entry.executed_at,
    expires_at: input.entry.expires_at,
    sha256: input.entry.sha256,
    summary: input.entry.summary,
    reasons
  };
  if (input.currentCommit === "unavailable") {
    reasons.push("Current Git commit could not be resolved.");
  } else if (
    input.manifestCommit !== input.currentCommit ||
    input.entry.source_commit !== input.currentCommit
  ) {
    reasons.push("Evidence source commit does not match the current Git commit.");
  }
  const executedAt = new Date(input.entry.executed_at);
  const expiresAt = new Date(input.entry.expires_at);
  if (!Number.isFinite(executedAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime())) {
    reasons.push("Evidence timestamp is invalid.");
  } else {
    if (executedAt > input.now) {
      reasons.push("Evidence execution time is in the future.");
    }
    if (expiresAt <= input.now) {
      reasons.push("Evidence is stale.");
    }
    if (
      expiresAt.getTime() >
      executedAt.getTime() + input.definition.freshness_ms
    ) {
      reasons.push("Evidence expiry exceeds the gate freshness policy.");
    }
  }
  if (!input.definition.accepted_artifact_kinds.includes(
    input.entry.artifact_kind
  )) {
    reasons.push(
      `Evidence artifact kind is not accepted for ${input.definition.id}.`
    );
  }
  try {
    const absolutePath = resolveInside(input.projectRoot, input.entry.path);
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      reasons.push("Evidence path is not a file.");
    } else {
      if (
        sha256(content) !== input.entry.sha256 ||
        content.byteLength !== input.entry.size_bytes
      ) {
        reasons.push("Evidence checksum or size does not match the manifest.");
      }
      if (
        detectReadinessEvidenceStatus(content.toString("utf8")) !==
        input.entry.detected_status
      ) {
        reasons.push("Evidence status does not match the manifest.");
      }
      if (
        input.definition.id === "STABLE_ACCEPTANCE" &&
        input.entry.artifact_kind === "stable_acceptance_evidence_manifest"
      ) {
        const inspection = await inspectStableAcceptanceManifest(
          input.projectRoot,
          input.entry.path,
          input.currentCommit
        );
        reasons.push(...inspection.reasons);
      }
    }
  } catch {
    reasons.push(
      "Evidence file is missing, unreadable, or outside the project root."
    );
  }
  if (reasons.length > 0) {
    result.status = "UNPASSED";
    return result;
  }
  result.verified = true;
  return result;
}

function missingGate(
  definition: StableReadinessGateDefinition,
  reason: string
): StableReadinessGateResult {
  const status: ReadinessStatus =
    definition.classification === "external_required"
      ? "SETUP_REQUIRED"
      : "UNKNOWN";
  return {
    id: definition.id,
    title: definition.title,
    classification: definition.classification,
    evidence_source: definition.evidence_source,
    status,
    evidence: [],
    reasons: [reason],
    remediation: remediationFor(definition, status)
  };
}

function remediationFor(
  definition: StableReadinessGateDefinition,
  status: ReadinessStatus
): string {
  if (status === "PASS") {
    return "No action required.";
  }
  if (
    definition.classification === "external_required" &&
    status === "SETUP_REQUIRED"
  ) {
    return `Prepare the external environment, rerun ${definition.evidence_source}, and regenerate the Stable manifest.`;
  }
  return `Rerun ${definition.evidence_source} on the current commit and regenerate the Stable manifest.`;
}

function buildIntegrityBlockers(input: {
  currentCommit: string;
  manifest?: StableReadinessEvidenceManifest;
  gates: StableReadinessGateResult[];
  incidents: BlockingIncident[];
  incidentStoreUnavailable: boolean;
  security: StableReadinessResult["security"];
  cleanup: StableReadinessResult["cleanup"];
}): StableReadinessBlocker[] {
  const blockers: StableReadinessBlocker[] = [];
  if (input.currentCommit === "unavailable") {
    blockers.push({
      code: "SOURCE_COMMIT_UNAVAILABLE",
      severity: "critical",
      summary: "The current Git commit could not be resolved.",
      remediation:
        "Run the check in a valid Git worktree and regenerate the Stable manifest."
    });
  } else if (
    input.manifest !== undefined &&
    input.manifest.source_commit !== input.currentCommit
  ) {
    blockers.push({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical",
      summary:
        "The Stable manifest source commit does not match the current Git commit.",
      remediation:
        "Regenerate all evidence and the Stable manifest from the current commit."
    });
  }
  if (input.gates.some((gate) =>
    gate.reasons.includes(
      "Evidence source commit does not match the current Git commit."
    )
  )) {
    blockers.push({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical",
      summary: "One or more Stable evidence files target another Git commit.",
      remediation: "Regenerate the affected evidence from the current commit."
    });
  }
  if (input.incidentStoreUnavailable) {
    blockers.push({
      code: "INCIDENT_STORE_UNAVAILABLE",
      severity: "critical",
      summary: "The incident store could not be inspected.",
      remediation:
        "Repair the incident store before evaluating Stable readiness."
    });
  }
  for (const incident of input.incidents) {
    blockers.push({
      code: "UNRESOLVED_INCIDENT",
      severity: incident.severity,
      summary: `Unresolved ${incident.severity} incident: ${incident.title}`,
      remediation:
        "Resolve the incident and attach recovery verification evidence.",
      reference: incident.incident_id
    });
  }
  if (input.security.high > 0 || input.security.critical > 0) {
    blockers.push({
      code: "SECURITY_FINDING",
      severity: input.security.critical > 0 ? "critical" : "high",
      summary:
        `Stable security evidence contains high=${input.security.high} critical=${input.security.critical}.`,
      remediation:
        "Resolve all high and critical security findings and regenerate evidence."
    });
  }
  if (input.security.secret_exposures > 0) {
    blockers.push({
      code: "SECRET_EXPOSURE",
      severity: "critical",
      summary:
        `Stable security evidence contains secret_exposures=${input.security.secret_exposures}.`,
      remediation:
        "Rotate exposed credentials, sanitize artifacts, and regenerate evidence."
    });
  }
  if (input.cleanup.status === "failed") {
    blockers.push({
      code: "CLEANUP_FAILURE",
      severity: "critical",
      summary:
        `Stable acceptance cleanup has ${input.cleanup.unresolved_resources} unresolved resources.`,
      remediation:
        "Delete or verify absence of every exact-ID resource created by the acceptance harness."
    });
  }
  return uniqueBlockers(blockers);
}

async function inspectBlockingIncidents(projectRoot: string): Promise<{
  incidents: BlockingIncident[];
  unavailable: boolean;
}> {
  try {
    const incidents = await listIncidents(projectRoot, { status: "all" });
    return {
      incidents: incidents.filter(isBlockingIncident),
      unavailable: false
    };
  } catch {
    return { incidents: [], unavailable: true };
  }
}

async function inspectSecurityEvidence(
  projectRoot: string,
  entries: StableReadinessEvidenceEntry[]
): Promise<StableReadinessResult["security"]> {
  let high = 0;
  let critical = 0;
  let secretExposures = 0;
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(
        (await readFile(resolveInside(projectRoot, entry.path), "utf8"))
          .replace(/^\uFEFF/u, "")
      ) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const summary = isRecord(parsed.summary) ? parsed.summary : {};
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.filter(isRecord)
        : [];
      high += Math.max(
        numberValue(summary.high),
        findings.filter((finding) => finding.severity === "high").length
      );
      critical += Math.max(
        numberValue(summary.critical),
        findings.filter((finding) => finding.severity === "critical").length
      );
      secretExposures += numberValue(summary.secret_exposures);
    } catch {
      // Evidence verification reports unreadable artifacts on the owning gate.
    }
  }
  return { high, critical, secret_exposures: secretExposures };
}

async function inspectStableAcceptanceState(
  projectRoot: string,
  entries: StableReadinessEvidenceEntry[],
  currentCommit: string
): Promise<StableAcceptanceInspection> {
  if (entries.length === 0) {
    return {
      status: "missing",
      resources_total: 0,
      unresolved_resources: 0,
      reasons: ["Stable acceptance evidence is not registered."]
    };
  }
  const inspections = await Promise.all(entries.map((entry) =>
    inspectStableAcceptanceManifest(projectRoot, entry.path, currentCommit)
  ));
  const reasons = uniqueValues(inspections.flatMap((item) => item.reasons));
  const resourcesTotal = inspections.reduce(
    (sum, item) => sum + item.resources_total,
    0
  );
  const unresolvedResources = inspections.reduce(
    (sum, item) => sum + item.unresolved_resources,
    0
  );
  return {
    status: reasons.length === 0
      ? "verified"
      : unresolvedResources > 0 ||
          inspections.some((item) => item.status === "failed")
        ? "failed"
        : inspections.some((item) => item.status === "missing")
          ? "missing"
          : "invalid",
    resources_total: resourcesTotal,
    unresolved_resources: unresolvedResources,
    reasons
  };
}

async function inspectStableAcceptanceManifest(
  projectRoot: string,
  manifestPath: string,
  currentCommit: string
): Promise<StableAcceptanceInspection> {
  const reasons: string[] = [];
  let resourcesTotal = 0;
  let unresolvedResources = 0;
  try {
    const manifest = JSON.parse(
      (await readFile(resolveInside(projectRoot, manifestPath), "utf8"))
        .replace(/^\uFEFF/u, "")
    ) as unknown;
    if (
      !isRecord(manifest) ||
      manifest.kind !== "stable_acceptance_evidence_manifest" ||
      manifest.status !== "completed" ||
      manifest.source_commit !== currentCommit ||
      typeof manifest.run_id !== "string" ||
      !Array.isArray(manifest.scenarios) ||
      !Array.isArray(manifest.documents) ||
      typeof manifest.cleanup_plan_path !== "string"
    ) {
      return {
        status: "invalid",
        resources_total: 0,
        unresolved_resources: 0,
        reasons: [
          "Stable acceptance manifest is incomplete, invalid, or bound to another commit."
        ]
      };
    }
    const expectedIds = listStableAcceptanceScenarios().map(
      (scenario) => scenario.test_id
    ).sort();
    const scenarios = manifest.scenarios.filter(isRecord);
    const observedIds = scenarios
      .map((scenario) => String(scenario.test_id ?? ""))
      .sort();
    if (
      observedIds.length !== expectedIds.length ||
      observedIds.some((id, index) => id !== expectedIds[index])
    ) {
      reasons.push("Stable acceptance scenario inventory is incomplete or unexpected.");
    }
    if (scenarios.some((scenario) => scenario.status !== "PASS")) {
      reasons.push("Stable acceptance contains a non-PASS scenario.");
    }
    const documents = manifest.documents.filter(isRecord);
    for (const requiredAlias of [
      "TEST_LIST",
      "COMMAND_LIST",
      "CLEANUP_PLAN",
      "SUMMARY"
    ]) {
      if (!documents.some((document) => document.alias === requiredAlias)) {
        reasons.push(`Stable acceptance document binding is missing: ${requiredAlias}.`);
      }
    }
    for (const document of documents) {
      if (
        typeof document.path !== "string" ||
        typeof document.sha256 !== "string"
      ) {
        reasons.push("Stable acceptance document binding is invalid.");
        continue;
      }
      try {
        const content = await readFile(resolveInside(projectRoot, document.path));
        if (sha256(content) !== document.sha256) {
          reasons.push(`Stable acceptance document digest mismatch: ${document.alias}.`);
        }
      } catch {
        reasons.push(`Stable acceptance document is missing: ${document.alias}.`);
      }
    }
    const summaryBinding = documents.find(
      (document) => document.alias === "SUMMARY"
    );
    if (summaryBinding !== undefined && typeof summaryBinding.path === "string") {
      try {
        const summary = JSON.parse(
          (await readFile(
            resolveInside(projectRoot, summaryBinding.path),
            "utf8"
          )).replace(/^\uFEFF/u, "")
        ) as unknown;
        const results = isRecord(summary) && Array.isArray(summary.results)
          ? summary.results.filter(isRecord)
          : [];
        const summaryIds = results
          .map((result) => String(result.id ?? ""))
          .sort();
        if (
          !isRecord(summary) ||
          summary.source_commit !== currentCommit ||
          summary.cleanup_status !== "completed" ||
          summaryIds.length !== expectedIds.length ||
          summaryIds.some((id, index) => id !== expectedIds[index]) ||
          results.some((result) => result.status !== "PASS")
        ) {
          reasons.push(
            "Stable acceptance summary is incomplete, non-PASS, or bound to another commit."
          );
        }
      } catch {
        reasons.push("Stable acceptance summary is unreadable.");
      }
    }
    const cleanup = JSON.parse(
      (await readFile(
        resolveInside(projectRoot, manifest.cleanup_plan_path),
        "utf8"
      )).replace(/^\uFEFF/u, "")
    ) as unknown;
    if (
      !isRecord(cleanup) ||
      cleanup.kind !== "stable_acceptance_cleanup_plan" ||
      cleanup.status !== "completed" ||
      cleanup.source_commit !== currentCommit ||
      cleanup.run_id !== manifest.run_id ||
      !isRecord(cleanup.safety) ||
      cleanup.safety.exact_ids_only !== true ||
      cleanup.safety.created_by_harness_only !== true ||
      !Array.isArray(cleanup.resources)
    ) {
      reasons.push("Stable acceptance cleanup plan is incomplete or invalid.");
    } else {
      const resources = cleanup.resources.filter(isRecord);
      resourcesTotal = resources.length;
      unresolvedResources = resources.filter((resource) =>
        resource.created_by_harness !== true ||
        !["not_created", "deleted", "verified_absent"].includes(
          String(resource.cleanup_status)
        ) ||
        (
          resource.cleanup_status === "deleted" &&
          (typeof resource.exact_id !== "string" ||
            resource.exact_id.trim().length === 0)
        )
      ).length;
      if (unresolvedResources > 0) {
        reasons.push(
          "Stable acceptance cleanup contains unresolved or unsafe resources."
        );
      }
    }
  } catch {
    return {
      status: "missing",
      resources_total: resourcesTotal,
      unresolved_resources: unresolvedResources,
      reasons: ["Stable acceptance manifest or cleanup artifact is unreadable."]
    };
  }
  return {
    status: reasons.length === 0
      ? "verified"
      : unresolvedResources > 0 ||
          reasons.some((reason) => /cleanup/iu.test(reason))
        ? "failed"
        : "invalid",
    resources_total: resourcesTotal,
    unresolved_resources: unresolvedResources,
    reasons: uniqueValues(reasons)
  };
}

function buildResult(input: {
  now: Date;
  currentCommit: string;
  manifestPath: string;
  loaded: LoadedManifest;
  gates: StableReadinessGateResult[];
  blockers: StableReadinessBlocker[];
  incidents: BlockingIncident[];
  security: StableReadinessResult["security"];
  cleanup: StableReadinessResult["cleanup"];
}): StableReadinessResult {
  const counts = countStatuses(input.gates);
  const gatesPass = input.gates.every((gate) => gate.status === "PASS");
  const stableReady = gatesPass && input.blockers.length === 0;
  const rerunCommands = input.gates
    .filter((gate) => gate.status !== "PASS")
    .flatMap((gate) => [
      `Rerun ${gate.evidence_source}`,
      `kairon readiness stable manifest --evidence ${gate.id}=<fresh-evidence-path>`
    ]);
  rerunCommands.push("kairon readiness stable check");
  return {
    schema_version: "0.1",
    artifact_kind: "stable_readiness_result",
    generated_at: input.now.toISOString(),
    source_commit: input.currentCommit,
    manifest: {
      path: input.manifestPath,
      status: input.loaded.status,
      sha256: input.loaded.sha256,
      source_commit: input.loaded.manifest?.source_commit,
      reason: input.loaded.reason
    },
    status: overallStatus(input.gates, input.blockers, stableReady),
    stable_ready: stableReady,
    promotion_automatic: false,
    counts,
    gates: input.gates,
    blockers: input.blockers,
    incidents: {
      unresolved_high: input.incidents.filter(
        (incident) => incident.severity === "high"
      ).length,
      unresolved_critical: input.incidents.filter(
        (incident) => incident.severity === "critical"
      ).length
    },
    security: input.security,
    cleanup: input.cleanup,
    secret_scan: {
      status: "passed",
      redacted_fields: 0,
      redacted_values: 0,
      exposed_findings: input.security.secret_exposures
    },
    rerun_commands: uniqueValues(rerunCommands),
    promotion_command:
      "kairon release github promote apply <PLAN_ID> --approval-id <APPROVAL_ID> --confirm <PLAN_ID>"
  };
}

type LoadedManifest = {
  status: "verified" | "missing" | "invalid";
  manifest?: StableReadinessEvidenceManifest;
  sha256?: string;
  reason?: string;
};

async function loadManifest(absolutePath: string): Promise<LoadedManifest> {
  try {
    const content = await readFile(absolutePath);
    const parsed = JSON.parse(
      content.toString("utf8").replace(/^\uFEFF/u, "")
    ) as unknown;
    if (!isManifest(parsed)) {
      return {
        status: "invalid",
        sha256: sha256(content),
        reason: "Stable readiness manifest schema is invalid."
      };
    }
    return {
      status: "verified",
      manifest: parsed,
      sha256: sha256(content)
    };
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return {
        status: "missing",
        reason: "Stable readiness evidence manifest was not found."
      };
    }
    return {
      status: "invalid",
      reason: "Stable readiness evidence manifest could not be parsed."
    };
  }
}

function isManifest(value: unknown): value is StableReadinessEvidenceManifest {
  return isRecord(value) &&
    value.schema_version === "0.1" &&
    value.artifact_kind === "stable_readiness_evidence_manifest" &&
    typeof value.generated_at === "string" &&
    typeof value.source_commit === "string" &&
    /^[0-9a-f]{40}$/iu.test(value.source_commit) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceEntry);
}

function isEvidenceEntry(value: unknown): value is StableReadinessEvidenceEntry {
  return isRecord(value) &&
    gateById.has(value.gate_id as StableReadinessGateId) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.artifact_kind === "string" &&
    ["PASS", "UNPASSED", "SETUP_REQUIRED", "OPTIONAL", "UNKNOWN"].includes(
      String(value.detected_status)
    ) &&
    typeof value.source_commit === "string" &&
    /^[0-9a-f]{40}$/iu.test(value.source_commit) &&
    typeof value.executed_at === "string" &&
    typeof value.expires_at === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/iu.test(value.sha256) &&
    typeof value.size_bytes === "number" &&
    Number.isFinite(value.size_bytes) &&
    value.size_bytes >= 0;
}

function countStatuses(
  gates: StableReadinessGateResult[]
): Record<ReadinessStatus, number> & { total: number } {
  const counts = {
    PASS: 0,
    UNPASSED: 0,
    SETUP_REQUIRED: 0,
    OPTIONAL: 0,
    UNKNOWN: 0,
    total: gates.length
  };
  for (const gate of gates) {
    counts[gate.status] += 1;
  }
  return counts;
}

function overallStatus(
  gates: StableReadinessGateResult[],
  blockers: StableReadinessBlocker[],
  stableReady: boolean
): ReadinessStatus {
  if (stableReady) {
    return "PASS";
  }
  if (blockers.length > 0) {
    return "UNPASSED";
  }
  const statuses = gates.map((gate) => gate.status);
  for (const status of ["UNPASSED", "UNKNOWN", "SETUP_REQUIRED"] as const) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  return "UNKNOWN";
}

async function resolveCommitOrUnavailable(
  projectRoot: string,
  commandRunner?: CommandRunner
): Promise<string> {
  try {
    return await resolveCurrentCommit(projectRoot, commandRunner);
  } catch {
    return "unavailable";
  }
}

function compareEntries(
  left: StableReadinessEvidenceEntry,
  right: StableReadinessEvidenceEntry
): number {
  return left.gate_id === right.gate_id
    ? left.path.localeCompare(right.path)
    : left.gate_id.localeCompare(right.gate_id);
}

function uniqueBlockers(
  blockers: StableReadinessBlocker[]
): StableReadinessBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.reference ?? blocker.summary}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlockingIncident(
  incident: IncidentArtifact
): incident is BlockingIncident {
  return incident.status !== "resolved" &&
    (incident.severity === "high" || incident.severity === "critical");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}
