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
import {
  detectReadinessEvidenceStatus,
  inspectReadinessEvidence,
  resolveCurrentCommit,
  sha256,
  type ReadinessStatus
} from "./evidence-manifest.js";

export type RcReadinessGateId =
  | "BASELINE_DOCS"
  | "RELEASE_ARTIFACT"
  | "GITHUB_DISTRIBUTION"
  | "UPDATE_ROLLBACK"
  | "SUPPORT_BUNDLE"
  | "WATCHDOG_INCIDENT"
  | "WORKFLOW_DURABILITY"
  | "SESSION_COMPACTION"
  | "CAPABILITY_POLICY"
  | "RAG_QUALITY"
  | "MULTI_PROJECT_ISOLATION"
  | "STABLE_REMOTE"
  | "PERFORMANCE_REGRESSION"
  | "BUILD_UNIT_INTEGRATION"
  | "SECURITY_INTEGRITY";

export type RcReadinessGateClass =
  | "required"
  | "external_required"
  | "optional";

export type RcReadinessGateDefinition = {
  id: RcReadinessGateId;
  title: string;
  classification: RcReadinessGateClass;
  freshness_ms: number;
  evidence_source: string;
  accepted_artifact_kinds: readonly string[];
};

export type RcReadinessEvidenceEntry = {
  gate_id: RcReadinessGateId;
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

export type RcReadinessEvidenceManifest = {
  schema_version: "0.1";
  artifact_kind: "rc_readiness_evidence_manifest";
  generated_at: string;
  source_commit: string;
  evidence: RcReadinessEvidenceEntry[];
};

export type RcReadinessEvidenceResult = {
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

export type RcReadinessGateResult = {
  id: RcReadinessGateId;
  title: string;
  classification: RcReadinessGateClass;
  evidence_source: string;
  status: ReadinessStatus;
  evidence: RcReadinessEvidenceResult[];
  reasons: string[];
  remediation: string;
};

export type RcReadinessBlocker = {
  code:
    | "SOURCE_COMMIT_UNAVAILABLE"
    | "SOURCE_COMMIT_MISMATCH"
    | "UNRESOLVED_INCIDENT"
    | "INCIDENT_STORE_UNAVAILABLE"
    | "SECURITY_FINDING";
  severity: "high" | "critical";
  summary: string;
  remediation: string;
  reference?: string;
};

export type RcReadinessResult = {
  schema_version: "0.1";
  artifact_kind: "rc_readiness_result";
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
  rc_ready: boolean;
  counts: Record<ReadinessStatus, number> & { total: number };
  gates: RcReadinessGateResult[];
  blockers: RcReadinessBlocker[];
  incidents: {
    unresolved_high: number;
    unresolved_critical: number;
  };
  secret_scan: {
    status: "passed" | "redacted";
    redacted_fields: number;
    redacted_values: number;
    exposed_findings: 0;
  };
};

export type CreateRcReadinessManifestOptions = {
  evidence: string[];
  output?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type EvaluateRcReadinessOptions = {
  manifest?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type RcReadinessFormat = "json" | "markdown";

type BlockingIncident = IncidentArtifact & {
  severity: "high" | "critical";
};

const commonArtifactKinds = [
  "test_evidence",
  "operation_test_summary",
  "json",
  "text"
] as const;

export const rcReadinessGateDefinitions: readonly RcReadinessGateDefinition[] = [
  rcGate("BASELINE_DOCS", "Baseline documentation inventory", "required", 24, "T160 documentation inventory", [
    "documentation_inventory"
  ]),
  rcGate("RELEASE_ARTIFACT", "Reproducible release artifact", "required", 168, "T161 package and release manifest verification", [
    "kairon_release",
    "local_beta_package"
  ]),
  rcGate("GITHUB_DISTRIBUTION", "GitHub release distribution", "external_required", 168, "T162 GitHub release verification", [
    "github_release_result"
  ]),
  rcGate("UPDATE_ROLLBACK", "Verified update and rollback", "external_required", 168, "T163 clean Windows lifecycle", [
    "verified_update_download",
    "update_lifecycle_result"
  ]),
  rcGate("SUPPORT_BUNDLE", "Sanitized support bundle", "required", 168, "T164 bundle verification and secret scan", [
    "support_bundle"
  ]),
  rcGate("WATCHDOG_INCIDENT", "Watchdog and incident recovery", "required", 168, "T165-T166 detection and recovery", [
    "incident",
    "incident_recovery_plan",
    "watchdog_certification"
  ]),
  rcGate("WORKFLOW_DURABILITY", "Workflow durability", "required", 168, "T167-T169 restart and checkpoint verification", [
    "workflow_run",
    "workflow_checkpoint_verification",
    "workflow_checkpoint_store_status"
  ]),
  rcGate("SESSION_COMPACTION", "Agent session compaction and rotation", "required", 168, "T170 budget and rotation", [
    "session_budget_result",
    "session_rotation_result"
  ]),
  rcGate("CAPABILITY_POLICY", "Capability trust policy", "required", 168, "T171 deny-before-dispatch evidence", [
    "capability_policy_evaluation"
  ]),
  rcGate("RAG_QUALITY", "RAG retrieval quality", "external_required", 168, "T172 lexical and hybrid evaluation", [
    "rag_evaluation",
    "rag_integrity",
    "rag_vector_build"
  ]),
  rcGate("MULTI_PROJECT_ISOLATION", "Multi-project isolation", "required", 168, "T173 two-project isolation", [
    "multi_project_supervisor",
    "project_registry_diagnostic"
  ]),
  rcGate("STABLE_REMOTE", "Stable remote operations", "external_required", 168, "T174 Discord, smartphone, and identity verification", [
    "stable_remote_status",
    "stable_remote_verification"
  ]),
  rcGate("PERFORMANCE_REGRESSION", "Capacity and performance regression", "required", 168, "T187 representative performance benchmark and same-environment comparison", [
    "performance_benchmark_result",
    "performance_comparison_result"
  ]),
  rcGate("BUILD_UNIT_INTEGRATION", "Current commit build and full test", "required", 24, "Current commit build and full test result", [
    "build_test_result"
  ]),
  rcGate("SECURITY_INTEGRITY", "Stable security and state integrity", "external_required", 24, "T188 Stable security baseline with fresh npm audit evidence", [
    "security_baseline_result",
    "secret_scan",
    "support_bundle",
    "rag_integrity",
    "state_integrity"
  ])
];

const defaultManifestPath = ".kairon/readiness/rc-evidence-manifest.json";
const defaultJsonResultPath = ".kairon/readiness/rc-result.json";
const defaultMarkdownReportPath = ".kairon/readiness/rc-report.md";
const gateById = new Map(rcReadinessGateDefinitions.map((gate) => [gate.id, gate]));
const statusPriority: Record<ReadinessStatus, number> = {
  UNPASSED: 5,
  UNKNOWN: 4,
  SETUP_REQUIRED: 3,
  PASS: 2,
  OPTIONAL: 1
};

export async function createRcReadinessManifest(
  projectRoot: string,
  options: CreateRcReadinessManifestOptions
): Promise<{ manifest: RcReadinessEvidenceManifest; output_path: string }> {
  if (options.evidence.length === 0) {
    throw new Error("Specify at least one --evidence <GATE_ID=path> value.");
  }

  const now = options.now?.() ?? new Date();
  const sourceCommit = options.sourceCommit ?? await resolveCurrentCommit(
    projectRoot,
    options.commandRunner
  );
  const entries: RcReadinessEvidenceEntry[] = [];

  for (const specification of options.evidence) {
    const { gateId, evidencePath } = parseEvidenceSpecification(specification);
    const definition = gateById.get(gateId);
    if (definition === undefined) {
      throw new Error(`Unknown RC readiness gate id: ${gateId}`);
    }

    const absolutePath = resolveInside(projectRoot, evidencePath);
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      throw new Error(`RC readiness evidence must be a file: ${evidencePath}`);
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

  const manifest: RcReadinessEvidenceManifest = {
    schema_version: "0.1",
    artifact_kind: "rc_readiness_evidence_manifest",
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

export async function evaluateRcReadiness(
  projectRoot: string,
  options: EvaluateRcReadinessOptions = {}
): Promise<RcReadinessResult> {
  const now = options.now?.() ?? new Date();
  const manifestPath = options.manifest ?? defaultManifestPath;
  const absoluteManifestPath = resolveInside(projectRoot, manifestPath);
  const currentCommit = options.sourceCommit ?? await resolveCommitOrUnavailable(
    projectRoot,
    options.commandRunner
  );
  const loaded = await loadManifest(absoluteManifestPath);
  const gates = loaded.manifest === undefined
    ? rcReadinessGateDefinitions.map((definition) => missingGate(
        definition,
        loaded.status === "missing"
          ? "No evidence is registered for this gate."
          : "The RC evidence manifest is invalid."
      ))
    : await Promise.all(rcReadinessGateDefinitions.map((definition) =>
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

  const incidentInspection = await inspectBlockingIncidents(projectRoot);
  let blockers = buildIntegrityBlockers({
    currentCommit,
    manifest: loaded.manifest,
    gates,
    incidents: incidentInspection.incidents,
    incidentStoreUnavailable: incidentInspection.unavailable
  });
  let report = buildResult({
    now,
    currentCommit,
    manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
    loaded,
    gates,
    blockers,
    incidents: incidentInspection.incidents
  });

  const sanitized = sanitizeBoardProjection(report);
  const redactedCount =
    sanitized.summary.redacted_fields + sanitized.summary.redacted_values;
  if (redactedCount > 0) {
    const sanitizedGates = sanitized.projection.gates.map((gate) =>
      gate.id === "SECURITY_INTEGRITY"
        ? {
            ...gate,
            status: "UNPASSED" as const,
            reasons: uniqueValues([
              ...gate.reasons,
              "RC readiness output required secret redaction."
            ]),
            remediation: "Remove secret-bearing evidence fields and regenerate the RC manifest."
          }
        : gate
    );
    blockers = uniqueBlockers([
      ...sanitized.projection.blockers,
      {
        code: "SECURITY_FINDING",
        severity: "critical",
        summary: "RC readiness evidence contained secret-bearing output.",
        remediation: "Rotate any exposed credential, sanitize the source evidence, and regenerate the manifest."
      }
    ]);
    report = buildResult({
      now,
      currentCommit,
      manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
      loaded,
      gates: sanitizedGates,
      blockers,
      incidents: incidentInspection.incidents
    });
  }

  const finalSanitized = sanitizeBoardProjection(report);
  return {
    ...finalSanitized.projection,
    secret_scan: {
      status: redactedCount === 0 ? "passed" : "redacted",
      redacted_fields: sanitized.summary.redacted_fields,
      redacted_values: sanitized.summary.redacted_values,
      exposed_findings: 0
    }
  };
}

export function formatRcReadinessResult(
  result: RcReadinessResult,
  format: RcReadinessFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "# Kairon Release Candidate Readiness Report",
    "",
    `generated_at: ${result.generated_at}`,
    `source_commit: \`${result.source_commit}\``,
    `status: **${result.status}**`,
    `rc_ready: **${result.rc_ready}**`,
    `manifest: \`${escapeMarkdown(result.manifest.path)}\` (${result.manifest.status})`,
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
        ...(evidence.executed_at === undefined
          ? []
          : [`  - executed_at: ${evidence.executed_at}`]),
        ...(evidence.expires_at === undefined
          ? []
          : [`  - expires_at: ${evidence.expires_at}`]),
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
    `- secret_scan: ${result.secret_scan.status}`,
    `- exposed_findings: ${result.secret_scan.exposed_findings}`,
    ""
  ].join("\n");
}

export async function writeRcReadinessResult(
  projectRoot: string,
  result: RcReadinessResult,
  format: RcReadinessFormat,
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
      formatRcReadinessResult(result, "markdown"),
      "utf8"
    );
  }
  return toProjectPath(projectRoot, absoluteOutput);
}

export function parseRcReadinessFormat(
  value: string | undefined
): RcReadinessFormat {
  if (value === undefined || value === "markdown" || value === "md") {
    return "markdown";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid RC readiness report format: ${value}`);
}

export async function rcReadinessManifestExists(
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

function rcGate(
  id: RcReadinessGateId,
  title: string,
  classification: RcReadinessGateClass,
  freshnessHours: number,
  evidenceSource: string,
  acceptedArtifactKinds: readonly string[]
): RcReadinessGateDefinition {
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
  gateId: RcReadinessGateId;
  evidencePath: string;
} {
  const separator = specification.indexOf("=");
  if (separator <= 0 || separator === specification.length - 1) {
    throw new Error(
      `Invalid evidence specification: ${specification}. Use GATE_ID=path.`
    );
  }
  const gateId = specification.slice(0, separator).trim().toUpperCase();
  if (!gateById.has(gateId as RcReadinessGateId)) {
    throw new Error(`Unknown RC readiness gate id: ${gateId}`);
  }
  return {
    gateId: gateId as RcReadinessGateId,
    evidencePath: specification.slice(separator + 1).trim()
  };
}

async function evaluateGate(input: {
  projectRoot: string;
  definition: RcReadinessGateDefinition;
  entries: RcReadinessEvidenceEntry[];
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<RcReadinessGateResult> {
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
  definition: RcReadinessGateDefinition;
  entry: RcReadinessEvidenceEntry;
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<RcReadinessEvidenceResult> {
  const reasons: string[] = [];
  const result: RcReadinessEvidenceResult = {
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
    if (expiresAt.getTime() >
        executedAt.getTime() + input.definition.freshness_ms) {
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
  definition: RcReadinessGateDefinition,
  reason: string
): RcReadinessGateResult {
  const status: ReadinessStatus = definition.classification === "optional"
    ? "OPTIONAL"
    : definition.classification === "external_required"
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
  definition: RcReadinessGateDefinition,
  status: ReadinessStatus
): string {
  if (status === "PASS" || status === "OPTIONAL") {
    return "No action required.";
  }
  if (
    definition.classification === "external_required" &&
    status === "SETUP_REQUIRED"
  ) {
    return `Prepare the external environment, rerun ${definition.evidence_source}, and regenerate the RC manifest.`;
  }
  return `Rerun ${definition.evidence_source} on the current commit and regenerate the RC manifest.`;
}

function buildIntegrityBlockers(input: {
  currentCommit: string;
  manifest?: RcReadinessEvidenceManifest;
  gates: RcReadinessGateResult[];
  incidents: BlockingIncident[];
  incidentStoreUnavailable: boolean;
}): RcReadinessBlocker[] {
  const blockers: RcReadinessBlocker[] = [];
  if (input.currentCommit === "unavailable") {
    blockers.push({
      code: "SOURCE_COMMIT_UNAVAILABLE",
      severity: "critical",
      summary: "The current Git commit could not be resolved.",
      remediation: "Run the check in a valid Git worktree and regenerate the RC manifest."
    });
  } else if (
    input.manifest !== undefined &&
    input.manifest.source_commit !== input.currentCommit
  ) {
    blockers.push({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical",
      summary: "The RC manifest source commit does not match the current Git commit.",
      remediation: "Regenerate all evidence and the RC manifest from the current commit."
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
      summary: "One or more RC evidence files target another Git commit.",
      remediation: "Regenerate the affected evidence from the current commit."
    });
  }
  if (input.incidentStoreUnavailable) {
    blockers.push({
      code: "INCIDENT_STORE_UNAVAILABLE",
      severity: "critical",
      summary: "The incident store could not be inspected.",
      remediation: "Repair the incident store before evaluating RC readiness."
    });
  }
  for (const incident of input.incidents) {
    blockers.push({
      code: "UNRESOLVED_INCIDENT",
      severity: incident.severity,
      summary: `Unresolved ${incident.severity} incident: ${incident.title}`,
      remediation: "Resolve the incident and attach recovery verification evidence.",
      reference: incident.incident_id
    });
  }
  const securityGate = input.gates.find(
    (gate) => gate.id === "SECURITY_INTEGRITY"
  );
  if (securityGate?.status === "UNPASSED") {
    blockers.push({
      code: "SECURITY_FINDING",
      severity: "critical",
      summary: "Security integrity evidence is unpassed.",
      remediation: securityGate.remediation
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

function buildResult(input: {
  now: Date;
  currentCommit: string;
  manifestPath: string;
  loaded: LoadedManifest;
  gates: RcReadinessGateResult[];
  blockers: RcReadinessBlocker[];
  incidents: BlockingIncident[];
}): RcReadinessResult {
  const counts = countStatuses(input.gates);
  const requiredGatesPass = input.gates.every((gate) =>
    gate.classification === "optional" || gate.status === "PASS"
  );
  const rcReady = requiredGatesPass && input.blockers.length === 0;
  return {
    schema_version: "0.1",
    artifact_kind: "rc_readiness_result",
    generated_at: input.now.toISOString(),
    source_commit: input.currentCommit,
    manifest: {
      path: input.manifestPath,
      status: input.loaded.status,
      sha256: input.loaded.sha256,
      source_commit: input.loaded.manifest?.source_commit,
      reason: input.loaded.reason
    },
    status: overallStatus(input.gates, input.blockers, rcReady),
    rc_ready: rcReady,
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
    secret_scan: {
      status: "passed",
      redacted_fields: 0,
      redacted_values: 0,
      exposed_findings: 0
    }
  };
}

type LoadedManifest = {
  status: "verified" | "missing" | "invalid";
  manifest?: RcReadinessEvidenceManifest;
  sha256?: string;
  reason?: string;
};

async function loadManifest(absolutePath: string): Promise<LoadedManifest> {
  try {
    const content = await readFile(absolutePath);
    const parsed = JSON.parse(
      content.toString("utf8").replace(/^\uFEFF/, "")
    ) as unknown;
    if (!isManifest(parsed)) {
      return {
        status: "invalid",
        sha256: sha256(content),
        reason: "RC manifest schema is invalid."
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
        reason: "RC evidence manifest was not found."
      };
    }
    return {
      status: "invalid",
      reason: "RC evidence manifest could not be parsed."
    };
  }
}

function isManifest(value: unknown): value is RcReadinessEvidenceManifest {
  if (!isRecord(value)) {
    return false;
  }
  return value.schema_version === "0.1" &&
    value.artifact_kind === "rc_readiness_evidence_manifest" &&
    typeof value.generated_at === "string" &&
    typeof value.source_commit === "string" &&
    /^[0-9a-f]{40}$/i.test(value.source_commit) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceEntry);
}

function isEvidenceEntry(value: unknown): value is RcReadinessEvidenceEntry {
  if (!isRecord(value)) {
    return false;
  }
  return gateById.has(value.gate_id as RcReadinessGateId) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.artifact_kind === "string" &&
    ["PASS", "UNPASSED", "SETUP_REQUIRED", "OPTIONAL", "UNKNOWN"].includes(
      String(value.detected_status)
    ) &&
    typeof value.source_commit === "string" &&
    /^[0-9a-f]{40}$/i.test(value.source_commit) &&
    typeof value.executed_at === "string" &&
    typeof value.expires_at === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(value.sha256) &&
    typeof value.size_bytes === "number" &&
    Number.isFinite(value.size_bytes) &&
    value.size_bytes >= 0;
}

function countStatuses(
  gates: RcReadinessGateResult[]
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
  gates: RcReadinessGateResult[],
  blockers: RcReadinessBlocker[],
  rcReady: boolean
): ReadinessStatus {
  if (rcReady) {
    return "PASS";
  }
  if (blockers.length > 0) {
    return "UNPASSED";
  }
  const statuses = gates
    .filter((gate) => gate.classification !== "optional")
    .map((gate) => gate.status);
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
  left: RcReadinessEvidenceEntry,
  right: RcReadinessEvidenceEntry
): number {
  return left.gate_id === right.gate_id
    ? left.path.localeCompare(right.path)
    : left.gate_id.localeCompare(right.gate_id);
}

function uniqueBlockers(
  blockers: RcReadinessBlocker[]
): RcReadinessBlocker[] {
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

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}
