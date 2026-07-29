import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../agents/command-runner.js";
import { agentIds } from "../agents/types.js";
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

export type OperationalStableGateId =
  | "STABLE_BASELINE_CURRENT"
  | "CONSUMER_MANIFEST_VERIFY"
  | "PUBLISHED_STABLE_VERIFY"
  | "CLEAN_WINDOWS_CANARY"
  | "POST_RELEASE_HEALTH"
  | "UPDATE_CHECK_SCHEDULE"
  | "MULTI_PROJECT_ROLLOUT"
  | "STABLE_SOAK"
  | "EVIDENCE_CATALOG"
  | "SCHEDULED_DR_VERIFY"
  | "AGENT_COMPATIBILITY"
  | "DIAGNOSTICS_TRIAGE"
  | "PATCH_RELEASE_REHEARSAL"
  | "BUILD_UNIT_SECURITY"
  | "STATE_SECRET_CLEANUP";

export type OperationalStableGateClass =
  | "required"
  | "external_required";

export type OperationalStableGateDefinition = {
  id: OperationalStableGateId;
  title: string;
  classification: OperationalStableGateClass;
  freshness_ms: number;
  evidence_source: string;
  accepted_artifact_kinds: readonly string[];
  required_artifact_kind_groups?: readonly (readonly string[])[];
};

export type OperationalStableEvidenceEntry = {
  gate_id: OperationalStableGateId;
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

export type OperationalStableEvidenceManifest = {
  schema_version: "0.1";
  artifact_kind: "operational_stable_evidence_manifest";
  generated_at: string;
  source_commit: string;
  evidence: OperationalStableEvidenceEntry[];
};

export type OperationalReleaseIdentity = {
  version?: string;
  tag?: string;
  release_id?: number;
  source_commit?: string;
};

export type OperationalStableEvidenceResult = {
  path: string;
  artifact_kind?: string;
  status: ReadinessStatus;
  verified: boolean;
  source_commit?: string;
  executed_at?: string;
  expires_at?: string;
  sha256?: string;
  summary?: string;
  release_identity?: OperationalReleaseIdentity;
  reasons: string[];
};

export type OperationalStableGateResult = {
  id: OperationalStableGateId;
  title: string;
  classification: OperationalStableGateClass;
  evidence_source: string;
  status: ReadinessStatus;
  evidence: OperationalStableEvidenceResult[];
  reasons: string[];
  remediation: string;
};

export type OperationalStableBlocker = {
  code:
    | "SOURCE_COMMIT_UNAVAILABLE"
    | "SOURCE_COMMIT_MISMATCH"
    | "RELEASE_IDENTITY_MISMATCH"
    | "UNRESOLVED_INCIDENT"
    | "INCIDENT_STORE_UNAVAILABLE"
    | "SECURITY_FINDING"
    | "SECRET_EXPOSURE"
    | "ROLLBACK_FAILURE"
    | "CLEANUP_FAILURE";
  severity: "high" | "critical";
  summary: string;
  remediation: string;
  reference?: string;
};

export type OperationalStableReadinessResult = {
  schema_version: "0.1";
  artifact_kind: "operational_stable_readiness_result";
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
  operational_stable_ready: boolean;
  external_write_performed: false;
  counts: Record<ReadinessStatus, number> & { total: number };
  gates: OperationalStableGateResult[];
  blockers: OperationalStableBlocker[];
  release: OperationalReleaseIdentity | null;
  incidents: {
    unresolved_high: number;
    unresolved_critical: number;
  };
  security: {
    high: number;
    critical: number;
    secret_exposures: number;
  };
  rollback: {
    status: "verified" | "missing" | "failed";
    failures: number;
    reasons: string[];
  };
  cleanup: {
    status: "verified" | "missing" | "failed";
    failures: number;
    reasons: string[];
  };
  secret_scan: {
    status: "passed" | "redacted";
    redacted_fields: number;
    redacted_values: number;
    exposed_findings: number;
  };
  rerun_commands: string[];
  command_references: {
    release:
      "kairon release github promote apply <PLAN_ID> --approval-id <APPROVAL_ID> --confirm <PLAN_ID>";
    update:
      "kairon update apply <DOWNLOAD_ID> --approval-id <APPROVAL_ID> --confirm <DOWNLOAD_ID>";
    restore:
      "kairon state dr restore <BACKUP_ID> --approval-id <APPROVAL_ID> --confirm <BACKUP_ID>";
  };
};

export type CreateOperationalStableManifestOptions = {
  evidence: string[];
  output?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type EvaluateOperationalStableOptions = {
  manifest?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type OperationalStableFormat = "json" | "markdown";

type BlockingIncident = IncidentArtifact & {
  severity: "high" | "critical";
};

type SemanticInspection = {
  status: ReadinessStatus;
  reasons: string[];
  release_identity?: OperationalReleaseIdentity;
};

type OperationalSignals = {
  security: OperationalStableReadinessResult["security"];
  rollback: OperationalStableReadinessResult["rollback"];
  cleanup: OperationalStableReadinessResult["cleanup"];
};

const sourceCommitPattern = /^[a-f0-9]{40}$/iu;
const digestPattern = /^[a-f0-9]{64}$/iu;
const defaultManifestPath =
  ".kairon/readiness/operational-stable-evidence-manifest.json";
const defaultJsonResultPath =
  ".kairon/readiness/operational-stable-result.json";
const defaultMarkdownReportPath =
  ".kairon/readiness/operational-stable-report.md";

export const operationalStableGateDefinitions:
readonly OperationalStableGateDefinition[] = [
  operationalGate(
    "STABLE_BASELINE_CURRENT",
    "Current Stable baseline documentation",
    "required",
    24,
    "T192 Stable baseline documentation",
    ["documentation_inventory", "stable_readiness_result"]
  ),
  operationalGate(
    "CONSUMER_MANIFEST_VERIFY",
    "Consumer release manifest verification",
    "required",
    24,
    "T193 consumer integration verification",
    ["stable_release_verification"]
  ),
  operationalGate(
    "PUBLISHED_STABLE_VERIFY",
    "Published Stable release verification",
    "external_required",
    24,
    "T194 published Stable verification",
    ["stable_release_verification"]
  ),
  operationalGate(
    "CLEAN_WINDOWS_CANARY",
    "Clean Windows Stable canary",
    "external_required",
    24,
    "T195 Windows Sandbox canary",
    ["stable_canary_final_result"]
  ),
  operationalGate(
    "POST_RELEASE_HEALTH",
    "Post-release health decision",
    "required",
    24,
    "T196 post-release health result",
    ["post_release_health_result"]
  ),
  operationalGate(
    "UPDATE_CHECK_SCHEDULE",
    "Read-only scheduled update check",
    "external_required",
    24,
    "T197 Windows scheduled update check",
    ["scheduled_update_check"]
  ),
  operationalGate(
    "MULTI_PROJECT_ROLLOUT",
    "Canary-first multi-project rollout",
    "required",
    24,
    "T198 multi-project rollout plan",
    ["multi_project_rollout_plan"]
  ),
  operationalGate(
    "STABLE_SOAK",
    "Seven-day Stable soak certificate",
    "external_required",
    24,
    "T199 Stable soak certificate",
    ["stable_soak_certificate"]
  ),
  operationalGate(
    "EVIDENCE_CATALOG",
    "Verified operation evidence catalog",
    "required",
    24,
    "T200 evidence catalog verification",
    ["operation_evidence_catalog_verification"]
  ),
  operationalGate(
    "SCHEDULED_DR_VERIFY",
    "Scheduled off-device DR verification",
    "external_required",
    24,
    "T201 scheduled DR verification",
    ["scheduled_dr_verification"]
  ),
  operationalGate(
    "AGENT_COMPATIBILITY",
    "Official Agent CLI compatibility",
    "external_required",
    24,
    "T202 Agent compatibility certification",
    ["agent_cli_compatibility_certification_summary"]
  ),
  operationalGate(
    "DIAGNOSTICS_TRIAGE",
    "Read-only diagnostics triage",
    "required",
    24,
    "T203 diagnostics triage report",
    ["diagnostics_triage_report"]
  ),
  operationalGate(
    "PATCH_RELEASE_REHEARSAL",
    "0.3.x patch release rehearsal",
    "external_required",
    24,
    "T204 patch release rehearsal",
    ["patch_release_verification_result"]
  ),
  operationalGate(
    "BUILD_UNIT_SECURITY",
    "Current build, full test, and security baseline",
    "required",
    24,
    "Current commit build, full test, and security baseline",
    [
      "build_test_result",
      "operation_test_summary",
      "security_baseline_result"
    ],
    [
      ["build_test_result", "operation_test_summary"],
      ["security_baseline_result"]
    ]
  ),
  operationalGate(
    "STATE_SECRET_CLEANUP",
    "State, secret, and cleanup integrity",
    "required",
    24,
    "Current state integrity, secret scan, and exact cleanup",
    [
      "security_baseline_result",
      "secret_scan",
      "patch_release_cleanup_result"
    ],
    [
      ["security_baseline_result", "secret_scan"],
      ["patch_release_cleanup_result"]
    ]
  )
];

const gateById = new Map(
  operationalStableGateDefinitions.map((definition) => [
    definition.id,
    definition
  ])
);
const statusPriority: Record<ReadinessStatus, number> = {
  UNPASSED: 5,
  UNKNOWN: 4,
  SETUP_REQUIRED: 3,
  PASS: 2,
  OPTIONAL: 1
};

export async function createOperationalStableManifest(
  projectRoot: string,
  options: CreateOperationalStableManifestOptions
): Promise<{
  manifest: OperationalStableEvidenceManifest;
  output_path: string;
}> {
  if (options.evidence.length === 0) {
    throw new Error("Specify at least one --evidence <GATE_ID=path> value.");
  }
  const now = options.now?.() ?? new Date();
  const sourceCommit = options.sourceCommit ?? await resolveCurrentCommit(
    projectRoot,
    options.commandRunner
  );
  const entries: OperationalStableEvidenceEntry[] = [];
  for (const specification of options.evidence) {
    const { gateId, evidencePath } =
      parseEvidenceSpecification(specification);
    const definition = gateById.get(gateId)!;
    const absolutePath = resolveInside(projectRoot, evidencePath);
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      throw new Error(
        `Operational Stable evidence must be a file: ${evidencePath}`
      );
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
  const manifest: OperationalStableEvidenceManifest = {
    schema_version: "0.1",
    artifact_kind: "operational_stable_evidence_manifest",
    generated_at: now.toISOString(),
    source_commit: sourceCommit,
    evidence: entries.sort(compareEntries)
  };
  const outputPath = options.output ?? defaultManifestPath;
  const absoluteOutput = resolveInside(projectRoot, outputPath);
  await writeJsonFileAtomic(absoluteOutput, manifest);
  return {
    manifest,
    output_path: toProjectPath(projectRoot, absoluteOutput)
  };
}

export async function evaluateOperationalStableReadiness(
  projectRoot: string,
  options: EvaluateOperationalStableOptions = {}
): Promise<OperationalStableReadinessResult> {
  const now = options.now?.() ?? new Date();
  const manifestPath = options.manifest ?? defaultManifestPath;
  const absoluteManifestPath = resolveInside(projectRoot, manifestPath);
  const currentCommit = options.sourceCommit ??
    await resolveCommitOrUnavailable(projectRoot, options.commandRunner);
  const loaded = await loadManifest(absoluteManifestPath);
  let gates = loaded.manifest === undefined
    ? operationalStableGateDefinitions.map((definition) =>
        missingGate(
          definition,
          loaded.status === "missing"
            ? "No evidence is registered for this gate."
            : "The Operational Stable evidence manifest is invalid."
        ))
    : await Promise.all(
        operationalStableGateDefinitions.map((definition) =>
          evaluateGate({
            projectRoot,
            definition,
            entries: loaded.manifest!.evidence.filter(
              (entry) => entry.gate_id === definition.id
            ),
            manifestCommit: loaded.manifest!.source_commit,
            currentCommit,
            now
          }))
      );
  const releaseConsistency = enforceReleaseConsistency(gates);
  gates = releaseConsistency.gates;
  const incidents = await inspectBlockingIncidents(projectRoot);
  const signals = await inspectOperationalSignals(
    projectRoot,
    loaded.manifest?.evidence ?? []
  );
  let blockers = buildBlockers({
    currentCommit,
    manifest: loaded.manifest,
    gates,
    incidents: incidents.incidents,
    incidentStoreUnavailable: incidents.unavailable,
    releaseMismatch: releaseConsistency.mismatch,
    signals
  });
  let result = buildResult({
    now,
    currentCommit,
    manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
    loaded,
    gates,
    blockers,
    release: releaseConsistency.release,
    incidents: incidents.incidents,
    signals
  });

  const sanitized = sanitizeBoardProjection(result);
  const redactedCount =
    sanitized.summary.redacted_fields + sanitized.summary.redacted_values;
  if (redactedCount > 0) {
    gates = sanitized.projection.gates.map((gate) =>
      gate.id === "STATE_SECRET_CLEANUP"
        ? {
            ...gate,
            status: "UNPASSED" as const,
            reasons: uniqueValues([
              ...gate.reasons,
              "Operational Stable output required secret redaction."
            ]),
            remediation:
              "Rotate exposed credentials, sanitize evidence, and regenerate the Operational Stable manifest."
          }
        : gate
    );
    blockers = uniqueBlockers([
      ...sanitized.projection.blockers,
      {
        code: "SECRET_EXPOSURE",
        severity: "critical",
        summary:
          "Operational Stable readiness evidence contained secret-bearing output.",
        remediation:
          "Rotate exposed credentials, sanitize source evidence, and regenerate the manifest."
      }
    ]);
    result = buildResult({
      now,
      currentCommit,
      manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
      loaded,
      gates,
      blockers,
      release: releaseConsistency.release,
      incidents: incidents.incidents,
      signals: {
        ...signals,
        security: {
          ...signals.security,
          secret_exposures: Math.max(
            signals.security.secret_exposures,
            redactedCount
          )
        }
      }
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

export function formatOperationalStableResult(
  result: OperationalStableReadinessResult,
  format: OperationalStableFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "# Kairon Operational Stable Readiness Report",
    "",
    `generated_at: ${result.generated_at}`,
    `source_commit: \`${result.source_commit}\``,
    `status: **${result.status}**`,
    `operational_stable_ready: **${result.operational_stable_ready}**`,
    `external_write_performed: **${result.external_write_performed}**`,
    `manifest: \`${escapeMarkdown(result.manifest.path)}\` (${result.manifest.status})`,
    `manifest_sha256: \`${result.manifest.sha256 ?? "unknown"}\``,
    "",
    "## Decision",
    "",
    result.operational_stable_ready
      ? "- All 15 Operational Stable gates are current, verified PASS and blocker-free."
      : "- Operational Stable is blocked. Resolve every non-PASS gate and global blocker.",
    "- Release, update, and restore commands below are references only and were not executed.",
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
    "## Integrity",
    "",
    `- unresolved_high_incidents: ${result.incidents.unresolved_high}`,
    `- unresolved_critical_incidents: ${result.incidents.unresolved_critical}`,
    `- security_high: ${result.security.high}`,
    `- security_critical: ${result.security.critical}`,
    `- secret_exposures: ${result.security.secret_exposures}`,
    `- rollback_status: ${result.rollback.status}`,
    `- rollback_failures: ${result.rollback.failures}`,
    `- cleanup_status: ${result.cleanup.status}`,
    `- cleanup_failures: ${result.cleanup.failures}`,
    `- secret_scan: ${result.secret_scan.status}`,
    "",
    "## Rerun Commands",
    "",
    ...result.rerun_commands.map(
      (command) => `- \`${escapeMarkdown(command)}\``
    ),
    "",
    "## External Command References",
    "",
    `- release: \`${result.command_references.release}\``,
    `- update: \`${result.command_references.update}\``,
    `- restore: \`${result.command_references.restore}\``,
    "",
    "## Gate Details",
    "",
    ...result.gates.flatMap((gate) => [
      `### ${gate.id}`,
      "",
      `- status: ${gate.status}`,
      `- evidence_source: ${escapeMarkdown(gate.evidence_source)}`,
      `- remediation: ${escapeMarkdown(gate.remediation)}`,
      ...gate.reasons.map(
        (reason) => `- reason: ${escapeMarkdown(reason)}`
      ),
      ...gate.evidence.flatMap((evidence) => [
        `- evidence: \`${escapeMarkdown(evidence.path)}\``,
        `  - artifact_kind: ${escapeMarkdown(evidence.artifact_kind ?? "unknown")}`,
        `  - verified: ${evidence.verified}`,
        `  - status: ${evidence.status}`,
        ...(evidence.sha256 === undefined
          ? []
          : [`  - sha256: \`${evidence.sha256}\``]),
        ...evidence.reasons.map(
          (reason) => `  - reason: ${escapeMarkdown(reason)}`
        )
      ]),
      ""
    ])
  ].join("\n");
}

export async function writeOperationalStableResult(
  projectRoot: string,
  result: OperationalStableReadinessResult,
  format: OperationalStableFormat,
  output?: string
): Promise<string> {
  const outputPath = output ?? (
    format === "json"
      ? defaultJsonResultPath
      : defaultMarkdownReportPath
  );
  const absoluteOutput = resolveInside(projectRoot, outputPath);
  if (format === "json") {
    await writeJsonFileAtomic(absoluteOutput, result);
  } else {
    await writeTextAtomic(
      absoluteOutput,
      formatOperationalStableResult(result, "markdown")
    );
  }
  return toProjectPath(projectRoot, absoluteOutput);
}

export function parseOperationalStableFormat(
  value: string | undefined
): OperationalStableFormat {
  if (value === undefined || value === "markdown" || value === "md") {
    return "markdown";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(
    `Invalid Operational Stable report format: ${value}`
  );
}

export async function operationalStableManifestExists(
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

function operationalGate(
  id: OperationalStableGateId,
  title: string,
  classification: OperationalStableGateClass,
  freshnessHours: number,
  evidenceSource: string,
  acceptedArtifactKinds: readonly string[],
  requiredArtifactKindGroups?: readonly (readonly string[])[]
): OperationalStableGateDefinition {
  return {
    id,
    title,
    classification,
    freshness_ms: freshnessHours * 60 * 60 * 1_000,
    evidence_source: evidenceSource,
    accepted_artifact_kinds: acceptedArtifactKinds,
    required_artifact_kind_groups: requiredArtifactKindGroups
  };
}

function parseEvidenceSpecification(specification: string): {
  gateId: OperationalStableGateId;
  evidencePath: string;
} {
  const separator = specification.indexOf("=");
  if (separator <= 0 || separator === specification.length - 1) {
    throw new Error(
      `Invalid evidence specification: ${specification}. Use GATE_ID=path.`
    );
  }
  const gateId = specification.slice(0, separator).trim().toUpperCase();
  if (!gateById.has(gateId as OperationalStableGateId)) {
    throw new Error(
      `Unknown Operational Stable readiness gate id: ${gateId}`
    );
  }
  return {
    gateId: gateId as OperationalStableGateId,
    evidencePath: specification.slice(separator + 1).trim()
  };
}

async function evaluateGate(input: {
  projectRoot: string;
  definition: OperationalStableGateDefinition;
  entries: OperationalStableEvidenceEntry[];
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<OperationalStableGateResult> {
  if (input.entries.length === 0) {
    return missingGate(
      input.definition,
      "No evidence is registered for this gate."
    );
  }
  const evidence = await Promise.all(
    input.entries.map((entry) =>
      verifyEntry({
        projectRoot: input.projectRoot,
        definition: input.definition,
        entry,
        manifestCommit: input.manifestCommit,
        currentCommit: input.currentCommit,
        now: input.now
      }))
  );
  const missingArtifactGroups =
    input.definition.required_artifact_kind_groups?.filter(
      (group) => !input.entries.some(
        (entry) => group.includes(entry.artifact_kind)
      )
    ) ?? [];
  const status = [
    ...evidence.map((item) => item.status),
    ...(missingArtifactGroups.length === 0
      ? []
      : ["UNKNOWN" as const])
  ]
    .sort(
      (left, right) =>
        statusPriority[right] - statusPriority[left]
    )[0] ?? "UNKNOWN";
  const reasons = uniqueValues(
    [
      ...evidence.flatMap((item) => item.reasons),
      ...missingArtifactGroups.map(
        (group) =>
          `Missing required evidence artifact kind: ${group.join(" or ")}.`
      )
    ]
  );
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
  definition: OperationalStableGateDefinition;
  entry: OperationalStableEvidenceEntry;
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<OperationalStableEvidenceResult> {
  const integrityReasons: string[] = [];
  let semantic: SemanticInspection = {
    status: input.entry.detected_status,
    reasons: []
  };
  const result: OperationalStableEvidenceResult = {
    path: input.entry.path,
    artifact_kind: input.entry.artifact_kind,
    status: input.entry.detected_status,
    verified: false,
    source_commit: input.entry.source_commit,
    executed_at: input.entry.executed_at,
    expires_at: input.entry.expires_at,
    sha256: input.entry.sha256,
    summary: input.entry.summary,
    reasons: []
  };
  if (input.currentCommit === "unavailable") {
    integrityReasons.push("Current Git commit could not be resolved.");
  } else if (
    input.manifestCommit !== input.currentCommit ||
    input.entry.source_commit !== input.currentCommit
  ) {
    integrityReasons.push(
      "Evidence source commit does not match the current Git commit."
    );
  }
  const executedAt = new Date(input.entry.executed_at);
  const expiresAt = new Date(input.entry.expires_at);
  if (
    !Number.isFinite(executedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    integrityReasons.push("Evidence timestamp is invalid.");
  } else {
    if (executedAt > input.now) {
      integrityReasons.push("Evidence execution time is in the future.");
    }
    if (expiresAt <= input.now) {
      integrityReasons.push("Evidence is stale.");
    }
    if (
      expiresAt.getTime() >
      executedAt.getTime() + input.definition.freshness_ms
    ) {
      integrityReasons.push(
        "Evidence expiry exceeds the gate freshness policy."
      );
    }
  }
  if (
    !input.definition.accepted_artifact_kinds.includes(
      input.entry.artifact_kind
    )
  ) {
    integrityReasons.push(
      `Evidence artifact kind is not accepted for ${input.definition.id}.`
    );
  }
  try {
    const absolutePath = resolveInside(
      input.projectRoot,
      input.entry.path
    );
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      integrityReasons.push("Evidence path is not a file.");
    } else {
      if (
        sha256(content) !== input.entry.sha256 ||
        content.byteLength !== input.entry.size_bytes
      ) {
        integrityReasons.push(
          "Evidence checksum or size does not match the manifest."
        );
      }
      if (
        detectReadinessEvidenceStatus(content.toString("utf8")) !==
        input.entry.detected_status
      ) {
        integrityReasons.push(
          "Evidence status does not match the manifest."
        );
      }
      semantic = inspectSemanticEvidence(
        input.definition.id,
        parseArtifact(content)
      );
    }
  } catch {
    integrityReasons.push(
      "Evidence file is missing, unreadable, invalid JSON, or outside the project root."
    );
  }
  if (integrityReasons.length > 0) {
    result.status = "UNKNOWN";
    result.reasons = uniqueValues(integrityReasons);
    return result;
  }
  result.verified = true;
  result.status = semantic.status;
  result.release_identity = semantic.release_identity;
  result.reasons = uniqueValues(semantic.reasons);
  return result;
}

function inspectSemanticEvidence(
  gateId: OperationalStableGateId,
  artifact: Record<string, unknown>
): SemanticInspection {
  const generic = detectReadinessEvidenceStatus(
    JSON.stringify(artifact)
  );
  const release = recordValue(artifact.release);
  switch (gateId) {
    case "PUBLISHED_STABLE_VERIFY":
      return semantic(
        artifact.status === "PASS" &&
          artifact.integrity_status === "PASS" &&
          artifact.currentness_status === "PASS" &&
          artifact.execution_performed === false,
        "Published Stable verification is not a read-only PASS.",
        {
          version: stringValue(artifact.version),
          tag: stringValue(artifact.tag),
          release_id: integerValue(artifact.release_id),
          source_commit: stringValue(artifact.target_commit_sha)
        }
      );
    case "CLEAN_WINDOWS_CANARY": {
      const cleanup = recordValue(artifact.cleanup);
      return semantic(
        artifact.status === "PASS" &&
          cleanup?.unknown_sandbox_terminated === false &&
          cleanup.host_cache_created === false &&
          cleanup.host_credential_persisted === false,
        "Clean Windows canary is non-PASS or left unsafe host state.",
        {
          version: stringValue(artifact.version),
          release_id: integerValue(artifact.source_release_id)
        }
      );
    }
    case "POST_RELEASE_HEALTH":
      {
        const guard = recordValue(artifact.read_only_guard);
        const incidents = recordValue(artifact.incidents);
        const security = recordValue(artifact.security);
        const state = recordValue(artifact.state);
        const passed =
          artifact.decision === "continue" &&
          guard?.mutation_detected === false &&
          numberValue(incidents?.unresolved_high) === 0 &&
          numberValue(incidents?.unresolved_critical) === 0 &&
          numberValue(security?.high) === 0 &&
          numberValue(security?.critical) === 0 &&
          numberValue(security?.secret_exposures) === 0 &&
          numberValue(state?.errors) === 0;
      return {
        status:
          passed
            ? "PASS"
            : artifact.decision === "hold" ||
                artifact.decision === "rollback_required"
              ? "UNPASSED"
              : "UNKNOWN",
        reasons:
          artifact.decision === "continue"
            ? []
            : [
                `Post-release health decision is ${String(
                  artifact.decision ?? "unknown"
                )}.`
              ],
        release_identity: {
          version: stringValue(release?.version),
          tag: stringValue(release?.tag),
          release_id: integerValue(release?.release_id),
          source_commit: stringValue(release?.source_commit)
        }
      };
      }
    case "UPDATE_CHECK_SCHEDULE": {
      const guard = recordValue(artifact.read_only_guard);
      return semantic(
        artifact.status === "completed" &&
          guard?.mutation_detected === false &&
          artifact.automatic_download === false &&
          artifact.automatic_apply === false &&
          artifact.automatic_restart === false,
        "Scheduled update check is incomplete or violated the read-only boundary."
      );
    }
    case "MULTI_PROJECT_ROLLOUT": {
      const stable = recordValue(artifact.stable_verification);
      const canary = recordValue(artifact.canary_gate);
      return semantic(
        (artifact.status === "ready" ||
          artifact.status === "completed") &&
          stable?.status === "verified" &&
          canary?.status === "satisfied" &&
          artifact.execution_performed === false &&
          artifact.automatic_update === false,
        "Multi-project rollout is blocked, stale, or not canary-first.",
        {
          version: stringValue(artifact.target_version),
          release_id: integerValue(stable?.release_id)
        }
      );
    }
    case "STABLE_SOAK": {
      const evaluation = recordValue(artifact.evaluation);
      return semantic(
        artifact.status === "PASS" &&
          evaluation?.evidence_mode === "real_time" &&
          evaluation.duration_satisfied === true &&
          numberValue(evaluation.elapsed_hours) >= 168 &&
          evaluation.release_drift === false,
        "Stable soak is non-PASS, shorter than 168 hours, simulated, or release-drifted.",
        {
          version: stringValue(release?.version),
          release_id: integerValue(release?.release_id),
          source_commit: stringValue(release?.target_commit_sha)
        }
      );
    }
    case "EVIDENCE_CATALOG":
      return semantic(
        artifact.status === "PASS" &&
          artifact.catalog_digest_status === "verified" &&
          artifact.secret_scan_status === "passed",
        "Evidence catalog digest or secret scan is not verified."
      );
    case "SCHEDULED_DR_VERIFY": {
      const verification = recordValue(artifact.verification);
      const rehearsal = recordValue(artifact.rehearsal);
      return semantic(
        artifact.status === "PASS" &&
          verification?.status === "verified" &&
          (
            rehearsal?.status === "passed" ||
            rehearsal?.status === "not_due"
          ) &&
          artifact.automatic_restore === false &&
          artifact.cleanup_performed === false,
        "Scheduled DR verification is non-PASS or crossed the automatic restore boundary."
      );
    }
    case "AGENT_COMPATIBILITY": {
      const certifications = Array.isArray(artifact.certifications)
        ? artifact.certifications.filter(isRecord)
        : [];
      const observedAgents = new Set(
        certifications.map((entry) => entry.agent)
      );
      return semantic(
        artifact.status === "PASS" &&
          agentIds.every((agent) => observedAgents.has(agent)) &&
          certifications.every((entry) => entry.status === "PASS"),
        "Agent compatibility does not contain PASS certifications for all official agents."
      );
    }
    case "DIAGNOSTICS_TRIAGE": {
      const summary = recordValue(artifact.summary);
      const redaction = recordValue(artifact.redaction);
      return semantic(
        artifact.status === "PASS" &&
          artifact.read_only === true &&
          numberValue(summary?.critical) === 0 &&
          numberValue(summary?.high) === 0 &&
          numberValue(summary?.unavailable_sources) === 0 &&
          redaction?.secret_scan_status === "passed" &&
          numberValue(redaction.secret_finding_count) === 0,
        "Diagnostics triage requires attention, is partial, or is not secret-free."
      );
    }
    case "PATCH_RELEASE_REHEARSAL":
      return semantic(
        artifact.status === "PASS" &&
          artifact.mode === "rehearsal" &&
          artifact.cleanup_status === "completed" &&
          artifact.external_publish_performed === false &&
          artifact.automatic_promotion === false &&
          artifact.automatic_update === false,
        "Patch rehearsal is non-PASS, incomplete, or crossed an external-write boundary."
      );
    case "BUILD_UNIT_SECURITY":
    case "STATE_SECRET_CLEANUP":
      if (artifact.artifact_kind === "security_baseline_result") {
        const summary = recordValue(artifact.summary);
        return semantic(
          artifact.status === "PASS" &&
            numberValue(summary?.high) === 0 &&
            numberValue(summary?.critical) === 0 &&
            numberValue(summary?.secret_exposures) === 0,
          "Security, state, or secret evidence contains blocking findings."
        );
      }
      return {
        status: generic,
        reasons:
          generic === "PASS"
            ? []
            : ["Current build, state, secret, or cleanup evidence is non-PASS."]
      };
    case "CONSUMER_MANIFEST_VERIFY":
      {
        const manifest = recordValue(artifact.manifest);
      return {
        status:
          artifact.status === "PASS" &&
          manifest?.status === "verified" &&
          manifest.verification_context === "consumer"
            ? "PASS"
            : "UNPASSED",
        reasons:
          artifact.status === "PASS" &&
          manifest?.status === "verified" &&
          manifest.verification_context === "consumer"
            ? []
            : [
                "Consumer manifest verification is not a verified consumer-context PASS."
              ],
        release_identity: releaseIdentityFromConsumerArtifact(artifact)
      };
      }
    case "STABLE_BASELINE_CURRENT":
      return {
        status: generic,
        reasons:
          generic === "PASS"
            ? []
            : ["Stable baseline documentation evidence is non-PASS."]
      };
  }
}

function semantic(
  passed: boolean,
  reason: string,
  releaseIdentity?: OperationalReleaseIdentity
): SemanticInspection {
  return {
    status: passed ? "PASS" : "UNPASSED",
    reasons: passed ? [] : [reason],
    release_identity: releaseIdentity
  };
}

function releaseIdentityFromConsumerArtifact(
  artifact: Record<string, unknown>
): OperationalReleaseIdentity | undefined {
  if (artifact.artifact_kind === "stable_release_verification") {
    return {
      version: stringValue(artifact.version),
      tag: stringValue(artifact.tag),
      release_id: integerValue(artifact.release_id),
      source_commit: stringValue(artifact.target_commit_sha)
    };
  }
  return undefined;
}

function enforceReleaseConsistency(
  gates: OperationalStableGateResult[]
): {
  gates: OperationalStableGateResult[];
  release: OperationalReleaseIdentity | null;
  mismatch: boolean;
} {
  const anchor = gates
    .find((gate) => gate.id === "PUBLISHED_STABLE_VERIFY")
    ?.evidence.find(
      (entry) =>
        entry.status === "PASS" &&
        entry.release_identity !== undefined
    )?.release_identity;
  if (anchor === undefined) {
    return { gates, release: null, mismatch: false };
  }
  let mismatch = false;
  const comparedIds = new Set<OperationalStableGateId>([
    "CONSUMER_MANIFEST_VERIFY",
    "CLEAN_WINDOWS_CANARY",
    "POST_RELEASE_HEALTH",
    "MULTI_PROJECT_ROLLOUT",
    "STABLE_SOAK"
  ]);
  const next = gates.map((gate) => {
    if (gate.status !== "PASS" || !comparedIds.has(gate.id)) {
      return gate;
    }
    const mismatched = gate.evidence.some(
      (entry) =>
        entry.release_identity !== undefined &&
        !releaseIdentityMatches(anchor, entry.release_identity)
    );
    if (!mismatched) {
      return gate;
    }
    mismatch = true;
    const reason =
      "Evidence release identity does not match the published Stable release.";
    return {
      ...gate,
      status: "UNKNOWN" as const,
      reasons: uniqueValues([...gate.reasons, reason]),
      remediation:
        "Regenerate this evidence against the exact published Stable release."
    };
  });
  return { gates: next, release: anchor, mismatch };
}

function releaseIdentityMatches(
  expected: OperationalReleaseIdentity,
  observed: OperationalReleaseIdentity
): boolean {
  for (const key of [
    "version",
    "tag",
    "release_id",
    "source_commit"
  ] as const) {
    if (
      expected[key] !== undefined &&
      observed[key] !== undefined &&
      expected[key] !== observed[key]
    ) {
      return false;
    }
  }
  return true;
}

function missingGate(
  definition: OperationalStableGateDefinition,
  reason: string
): OperationalStableGateResult {
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
  definition: OperationalStableGateDefinition,
  status: ReadinessStatus
): string {
  if (status === "PASS") {
    return "No action required.";
  }
  if (
    definition.classification === "external_required" &&
    status === "SETUP_REQUIRED"
  ) {
    return (
      `Prepare the external environment, rerun ${definition.evidence_source}, ` +
      "and regenerate the Operational Stable manifest."
    );
  }
  return (
    `Rerun ${definition.evidence_source} on the current commit and ` +
    "regenerate the Operational Stable manifest."
  );
}

async function inspectBlockingIncidents(
  projectRoot: string
): Promise<{ incidents: BlockingIncident[]; unavailable: boolean }> {
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

async function inspectOperationalSignals(
  projectRoot: string,
  entries: OperationalStableEvidenceEntry[]
): Promise<OperationalSignals> {
  let high = 0;
  let critical = 0;
  let secretExposures = 0;
  let rollbackFailures = 0;
  let cleanupFailures = 0;
  const rollbackReasons: string[] = [];
  const cleanupReasons: string[] = [];
  let rollbackEvidence = false;
  let cleanupEvidence = false;
  for (const entry of entries) {
    try {
      const artifact = parseArtifact(
        await readFile(resolveInside(projectRoot, entry.path))
      );
      const summary = recordValue(artifact.summary);
      const findings = Array.isArray(artifact.findings)
        ? artifact.findings.filter(isRecord)
        : [];
      high += Math.max(
        numberValue(summary?.high),
        findings.filter(
          (finding) => finding.severity === "high"
        ).length
      );
      critical += Math.max(
        numberValue(summary?.critical),
        findings.filter(
          (finding) => finding.severity === "critical"
        ).length
      );
      secretExposures += numberValue(summary?.secret_exposures);
      if (entry.gate_id === "POST_RELEASE_HEALTH") {
        rollbackEvidence = true;
        if (artifact.decision === "rollback_required") {
          rollbackFailures += 1;
          rollbackReasons.push(
            "Post-release health requires rollback."
          );
        }
      }
      if (
        entry.gate_id === "CLEAN_WINDOWS_CANARY" ||
        entry.gate_id === "PATCH_RELEASE_REHEARSAL" ||
        entry.gate_id === "STATE_SECRET_CLEANUP"
      ) {
        cleanupEvidence = true;
        const semantic = inspectSemanticEvidence(
          entry.gate_id,
          artifact
        );
        if (semantic.status === "UNPASSED") {
          cleanupFailures += 1;
          cleanupReasons.push(...semantic.reasons);
        }
      }
    } catch {
      // The owning gate reports unreadable evidence.
    }
  }
  return {
    security: { high, critical, secret_exposures: secretExposures },
    rollback: {
      status:
        rollbackFailures > 0
          ? "failed"
          : rollbackEvidence
            ? "verified"
            : "missing",
      failures: rollbackFailures,
      reasons: uniqueValues(rollbackReasons)
    },
    cleanup: {
      status:
        cleanupFailures > 0
          ? "failed"
          : cleanupEvidence
            ? "verified"
            : "missing",
      failures: cleanupFailures,
      reasons: uniqueValues(cleanupReasons)
    }
  };
}

function buildBlockers(input: {
  currentCommit: string;
  manifest?: OperationalStableEvidenceManifest;
  gates: OperationalStableGateResult[];
  incidents: BlockingIncident[];
  incidentStoreUnavailable: boolean;
  releaseMismatch: boolean;
  signals: OperationalSignals;
}): OperationalStableBlocker[] {
  const blockers: OperationalStableBlocker[] = [];
  if (input.currentCommit === "unavailable") {
    blockers.push({
      code: "SOURCE_COMMIT_UNAVAILABLE",
      severity: "critical",
      summary: "The current Git commit could not be resolved.",
      remediation:
        "Run the check in a valid Git worktree and regenerate the manifest."
    });
  } else if (
    input.manifest !== undefined &&
    input.manifest.source_commit !== input.currentCommit
  ) {
    blockers.push({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical",
      summary:
        "The Operational Stable manifest targets another Git commit.",
      remediation:
        "Regenerate all evidence and the manifest from the current commit."
    });
  }
  if (
    input.gates.some((gate) =>
      gate.reasons.includes(
        "Evidence source commit does not match the current Git commit."
      ))
  ) {
    blockers.push({
      code: "SOURCE_COMMIT_MISMATCH",
      severity: "critical",
      summary:
        "One or more Operational Stable evidence files target another Git commit.",
      remediation:
        "Regenerate the affected evidence from the current commit."
    });
  }
  if (input.releaseMismatch) {
    blockers.push({
      code: "RELEASE_IDENTITY_MISMATCH",
      severity: "critical",
      summary:
        "One or more evidence files target a different Stable release.",
      remediation:
        "Regenerate canary, health, rollout, and soak evidence for the exact published Stable release."
    });
  }
  if (input.incidentStoreUnavailable) {
    blockers.push({
      code: "INCIDENT_STORE_UNAVAILABLE",
      severity: "critical",
      summary: "The incident store could not be inspected.",
      remediation:
        "Repair the incident store before evaluating Operational Stable readiness."
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
  if (
    input.signals.security.high > 0 ||
    input.signals.security.critical > 0
  ) {
    blockers.push({
      code: "SECURITY_FINDING",
      severity:
        input.signals.security.critical > 0 ? "critical" : "high",
      summary:
        `Operational security evidence contains high=${input.signals.security.high} ` +
        `critical=${input.signals.security.critical}.`,
      remediation:
        "Resolve all high and critical security findings and regenerate evidence."
    });
  }
  if (input.signals.security.secret_exposures > 0) {
    blockers.push({
      code: "SECRET_EXPOSURE",
      severity: "critical",
      summary:
        `Operational evidence contains secret_exposures=${input.signals.security.secret_exposures}.`,
      remediation:
        "Rotate exposed credentials, sanitize artifacts, and regenerate evidence."
    });
  }
  if (input.signals.rollback.status === "failed") {
    blockers.push({
      code: "ROLLBACK_FAILURE",
      severity: "critical",
      summary:
        `Operational evidence contains rollback_failures=${input.signals.rollback.failures}.`,
      remediation:
        "Repair rollback compatibility and regenerate post-release health evidence."
    });
  }
  if (input.signals.cleanup.status === "failed") {
    blockers.push({
      code: "CLEANUP_FAILURE",
      severity: "critical",
      summary:
        `Operational evidence contains cleanup_failures=${input.signals.cleanup.failures}.`,
      remediation:
        "Clean up exact-ID rehearsal resources and regenerate cleanup evidence."
    });
  }
  return uniqueBlockers(blockers);
}

function buildResult(input: {
  now: Date;
  currentCommit: string;
  manifestPath: string;
  loaded: LoadedManifest;
  gates: OperationalStableGateResult[];
  blockers: OperationalStableBlocker[];
  release: OperationalReleaseIdentity | null;
  incidents: BlockingIncident[];
  signals: OperationalSignals;
}): OperationalStableReadinessResult {
  const counts = countStatuses(input.gates);
  const gatesPass = input.gates.every(
    (gate) => gate.status === "PASS"
  );
  const ready = gatesPass && input.blockers.length === 0;
  const rerunCommands = input.gates
    .filter((gate) => gate.status !== "PASS")
    .flatMap((gate) => [
      `Rerun ${gate.evidence_source}`,
      `kairon readiness operational manifest --evidence ${gate.id}=<fresh-evidence-path>`
    ]);
  rerunCommands.push("kairon readiness operational check");
  return {
    schema_version: "0.1",
    artifact_kind: "operational_stable_readiness_result",
    generated_at: input.now.toISOString(),
    source_commit: input.currentCommit,
    manifest: {
      path: input.manifestPath,
      status: input.loaded.status,
      sha256: input.loaded.sha256,
      source_commit: input.loaded.manifest?.source_commit,
      reason: input.loaded.reason
    },
    status: overallStatus(input.gates, input.blockers, ready),
    operational_stable_ready: ready,
    external_write_performed: false,
    counts,
    gates: input.gates,
    blockers: input.blockers,
    release: input.release,
    incidents: {
      unresolved_high: input.incidents.filter(
        (incident) => incident.severity === "high"
      ).length,
      unresolved_critical: input.incidents.filter(
        (incident) => incident.severity === "critical"
      ).length
    },
    security: input.signals.security,
    rollback: input.signals.rollback,
    cleanup: input.signals.cleanup,
    secret_scan: {
      status: "passed",
      redacted_fields: 0,
      redacted_values: 0,
      exposed_findings: input.signals.security.secret_exposures
    },
    rerun_commands: uniqueValues(rerunCommands),
    command_references: {
      release:
        "kairon release github promote apply <PLAN_ID> --approval-id <APPROVAL_ID> --confirm <PLAN_ID>",
      update:
        "kairon update apply <DOWNLOAD_ID> --approval-id <APPROVAL_ID> --confirm <DOWNLOAD_ID>",
      restore:
        "kairon state dr restore <BACKUP_ID> --approval-id <APPROVAL_ID> --confirm <BACKUP_ID>"
    }
  };
}

type LoadedManifest = {
  status: "verified" | "missing" | "invalid";
  manifest?: OperationalStableEvidenceManifest;
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
        reason:
          "Operational Stable readiness manifest schema is invalid."
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
        reason:
          "Operational Stable readiness evidence manifest was not found."
      };
    }
    return {
      status: "invalid",
      reason:
        "Operational Stable readiness evidence manifest could not be parsed."
    };
  }
}

function isManifest(
  value: unknown
): value is OperationalStableEvidenceManifest {
  return (
    isRecord(value) &&
    value.schema_version === "0.1" &&
    value.artifact_kind ===
      "operational_stable_evidence_manifest" &&
    typeof value.generated_at === "string" &&
    typeof value.source_commit === "string" &&
    sourceCommitPattern.test(value.source_commit) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceEntry)
  );
}

function isEvidenceEntry(
  value: unknown
): value is OperationalStableEvidenceEntry {
  return (
    isRecord(value) &&
    gateById.has(value.gate_id as OperationalStableGateId) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.artifact_kind === "string" &&
    [
      "PASS",
      "UNPASSED",
      "SETUP_REQUIRED",
      "OPTIONAL",
      "UNKNOWN"
    ].includes(String(value.detected_status)) &&
    typeof value.source_commit === "string" &&
    sourceCommitPattern.test(value.source_commit) &&
    typeof value.executed_at === "string" &&
    typeof value.expires_at === "string" &&
    typeof value.sha256 === "string" &&
    digestPattern.test(value.sha256) &&
    typeof value.size_bytes === "number" &&
    Number.isFinite(value.size_bytes) &&
    value.size_bytes >= 0
  );
}

function parseArtifact(content: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(
    content.toString("utf8").replace(/^\uFEFF/u, "")
  ) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Operational evidence must be a JSON object.");
  }
  return parsed;
}

function countStatuses(
  gates: OperationalStableGateResult[]
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
  gates: OperationalStableGateResult[],
  blockers: OperationalStableBlocker[],
  ready: boolean
): ReadinessStatus {
  if (ready) {
    return "PASS";
  }
  if (blockers.length > 0) {
    return "UNPASSED";
  }
  const statuses = gates.map((gate) => gate.status);
  for (const status of [
    "UNPASSED",
    "UNKNOWN",
    "SETUP_REQUIRED"
  ] as const) {
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

async function writeTextAtomic(
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
    throw error;
  }
}

function compareEntries(
  left: OperationalStableEvidenceEntry,
  right: OperationalStableEvidenceEntry
): number {
  return left.gate_id === right.gate_id
    ? left.path.localeCompare(right.path)
    : left.gate_id.localeCompare(right.gate_id);
}

function uniqueBlockers(
  blockers: OperationalStableBlocker[]
): OperationalStableBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key =
      `${blocker.code}:${blocker.reference ?? blocker.summary}`;
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

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function recordValue(
  value: unknown
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function isBlockingIncident(
  incident: IncidentArtifact
): incident is BlockingIncident {
  return (
    incident.status !== "resolved" &&
    (incident.severity === "high" ||
      incident.severity === "critical")
  );
}

function toProjectPath(
  projectRoot: string,
  absolutePath: string
): string {
  return toPosixPath(
    path.relative(path.resolve(projectRoot), absolutePath)
  );
}

function escapeMarkdown(value: string): string {
  return value.replace(/[|`]/gu, "\\$&");
}
