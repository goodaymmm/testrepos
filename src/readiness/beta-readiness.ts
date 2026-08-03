import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../agents/command-runner.js";
import { sanitizeBoardProjection } from "../board/secret-scan.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  detectReadinessEvidenceStatus,
  readinessGateDefinitions,
  resolveCurrentCommit,
  sha256,
  type ReadinessEvidenceEntry,
  type ReadinessEvidenceManifest,
  type ReadinessGateDefinition,
  type ReadinessGateId,
  type ReadinessStatus
} from "./evidence-manifest.js";

export type BetaReadinessEvidenceResult = {
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

export type BetaReadinessGateResult = {
  id: ReadinessGateId;
  title: string;
  required: boolean;
  external_setup: boolean;
  evidence_source: string;
  status: ReadinessStatus;
  evidence: BetaReadinessEvidenceResult[];
  reasons: string[];
};

export type BetaReadinessReport = {
  schema_version: "0.1";
  artifact_kind: "beta_readiness_report";
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
  ready: boolean;
  counts: Record<ReadinessStatus, number> & { total: number };
  gates: BetaReadinessGateResult[];
  secret_scan: {
    status: "passed" | "redacted";
    redacted_fields: number;
    redacted_values: number;
    exposed_findings: 0;
  };
};

export type EvaluateBetaReadinessOptions = {
  manifest?: string;
  now?: () => Date;
  sourceCommit?: string;
  commandRunner?: CommandRunner;
};

export type BetaReadinessFormat = "json" | "markdown";

const defaultManifestPath = ".kairon/readiness/evidence-manifest.json";
const statusPriority: Record<ReadinessStatus, number> = {
  UNPASSED: 5,
  UNKNOWN: 4,
  SETUP_REQUIRED: 3,
  PASS: 2,
  OPTIONAL: 1
};

export async function evaluateBetaReadiness(
  projectRoot: string,
  options: EvaluateBetaReadinessOptions = {}
): Promise<BetaReadinessReport> {
  const now = options.now?.() ?? new Date();
  const manifestPath = options.manifest ?? defaultManifestPath;
  const absoluteManifestPath = resolveInside(projectRoot, manifestPath);
  const currentCommit = options.sourceCommit ?? await resolveCommitOrUnavailable(
    projectRoot,
    options.commandRunner
  );
  const loaded = await loadManifest(projectRoot, absoluteManifestPath);
  let gates: BetaReadinessGateResult[];

  if (loaded.manifest === undefined) {
    gates = readinessGateDefinitions.map((definition) => missingGate(
      definition,
      loaded.status === "missing" ? "No evidence is registered for this gate." : "The evidence manifest is invalid."
    ));
  } else {
    gates = await Promise.all(
      readinessGateDefinitions.map((definition) => evaluateGate({
        projectRoot,
        definition,
        entries: loaded.manifest!.evidence.filter((entry) => entry.gate_id === definition.id),
        manifestCommit: loaded.manifest!.source_commit,
        currentCommit,
        now
      }))
    );
  }

  let report = buildReport({
    now,
    currentCommit,
    manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
    loaded,
    gates
  });
  const sanitized = sanitizeBoardProjection(report);
  const redactedCount = sanitized.summary.redacted_fields + sanitized.summary.redacted_values;
  if (redactedCount > 0) {
    gates = sanitized.projection.gates.map((gate) =>
      gate.id === "SECRET_ARTIFACT_INTEGRITY"
        ? {
            ...gate,
            status: "UNPASSED" as const,
            reasons: [...gate.reasons, "Readiness output required secret redaction."]
          }
        : gate
    );
    report = buildReport({
      now,
      currentCommit,
      manifestPath: toProjectPath(projectRoot, absoluteManifestPath),
      loaded,
      gates
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

export function formatBetaReadinessReport(
  report: BetaReadinessReport,
  format: BetaReadinessFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  return [
    "# Kairon Beta Readiness Report",
    "",
    `generated_at: ${report.generated_at}`,
    `source_commit: \`${report.source_commit}\``,
    `status: **${report.status}**`,
    `ready: **${report.ready}**`,
    `manifest: \`${escapeMarkdown(report.manifest.path)}\` (${report.manifest.status})`,
    "",
    "## Gate Summary",
    "",
    "| Gate | Required | Status | Evidence |",
    "| --- | --- | --- | --- |",
    ...report.gates.map((gate) =>
      `| ${gate.id} | ${gate.required} | ${gate.status} | ${gate.evidence.length} |`
    ),
    "",
    "## Gate Details",
    "",
    ...report.gates.flatMap((gate) => [
      `### ${gate.id}`,
      "",
      `- title: ${escapeMarkdown(gate.title)}`,
      `- status: ${gate.status}`,
      `- evidence_source: ${escapeMarkdown(gate.evidence_source)}`,
      ...gate.reasons.map((reason) => `- reason: ${escapeMarkdown(reason)}`),
      ...gate.evidence.flatMap((evidence) => [
        `- evidence: \`${escapeMarkdown(evidence.path)}\``,
        `  - verified: ${evidence.verified}`,
        `  - status: ${evidence.status}`,
        ...(evidence.sha256 === undefined ? [] : [`  - sha256: \`${evidence.sha256}\``]),
        ...(evidence.executed_at === undefined ? [] : [`  - executed_at: ${evidence.executed_at}`]),
        ...(evidence.expires_at === undefined ? [] : [`  - expires_at: ${evidence.expires_at}`]),
        ...evidence.reasons.map((reason) => `  - reason: ${escapeMarkdown(reason)}`)
      ]),
      ""
    ]),
    "## Secret Scan",
    "",
    `- status: ${report.secret_scan.status}`,
    `- exposed_findings: ${report.secret_scan.exposed_findings}`,
    ""
  ].join("\n");
}

export async function writeBetaReadinessReport(
  projectRoot: string,
  report: BetaReadinessReport,
  format: BetaReadinessFormat,
  output?: string
): Promise<string> {
  const outputPath = output ?? `.kairon/reports/readiness/latest.${format === "json" ? "json" : "md"}`;
  const absoluteOutput = resolveInside(projectRoot, outputPath);
  if (format === "json") {
    await writeJsonFileAtomic(absoluteOutput, report);
  } else {
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, formatBetaReadinessReport(report, format), "utf8");
  }
  return toProjectPath(projectRoot, absoluteOutput);
}

export function parseBetaReadinessFormat(value: string | undefined): BetaReadinessFormat {
  if (value === undefined || value === "markdown" || value === "md") {
    return "markdown";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid readiness report format: ${value}`);
}

export async function readinessManifestExists(
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

async function evaluateGate(input: {
  projectRoot: string;
  definition: ReadinessGateDefinition;
  entries: ReadinessEvidenceEntry[];
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<BetaReadinessGateResult> {
  if (input.entries.length === 0) {
    return missingGate(input.definition, "No evidence is registered for this gate.");
  }

  const evidence = await Promise.all(input.entries.map((entry) => verifyEntry({
    projectRoot: input.projectRoot,
    entry,
    manifestCommit: input.manifestCommit,
    currentCommit: input.currentCommit,
    now: input.now
  })));
  const status = evidence
    .map((item) => item.status)
    .sort((left, right) => statusPriority[right] - statusPriority[left])[0] ?? "UNKNOWN";
  const reasons = evidence.flatMap((item) => item.reasons).filter(unique);
  return {
    id: input.definition.id,
    title: input.definition.title,
    required: input.definition.required,
    external_setup: input.definition.external_setup,
    evidence_source: input.definition.evidence_source,
    status,
    evidence,
    reasons
  };
}

async function verifyEntry(input: {
  projectRoot: string;
  entry: ReadinessEvidenceEntry;
  manifestCommit: string;
  currentCommit: string;
  now: Date;
}): Promise<BetaReadinessEvidenceResult> {
  const reasons: string[] = [];
  const result: BetaReadinessEvidenceResult = {
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
  if (!Number.isFinite(executedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
    reasons.push("Evidence timestamp is invalid.");
  } else {
    if (executedAt > input.now) {
      reasons.push("Evidence execution time is in the future.");
    }
    if (expiresAt <= input.now) {
      reasons.push("Evidence is stale.");
    }
  }

  try {
    const absolutePath = resolveInside(input.projectRoot, input.entry.path);
    const [content, fileStats] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    if (!fileStats.isFile()) {
      reasons.push("Evidence path is not a file.");
    } else {
      const actualHash = sha256(content);
      if (actualHash !== input.entry.sha256 || content.byteLength !== input.entry.size_bytes) {
        reasons.push("Evidence checksum or size does not match the manifest.");
      }
      const actualStatus = detectReadinessEvidenceStatus(content.toString("utf8"));
      if (actualStatus !== input.entry.detected_status) {
        reasons.push("Evidence status does not match the manifest.");
      }
    }
  } catch {
    reasons.push("Evidence file is missing, unreadable, or outside the project root.");
  }

  if (reasons.length > 0) {
    result.status = "UNKNOWN";
    return result;
  }
  result.verified = true;
  return result;
}

function buildReport(input: {
  now: Date;
  currentCommit: string;
  manifestPath: string;
  loaded: LoadedManifest;
  gates: BetaReadinessGateResult[];
}): BetaReadinessReport {
  const counts = countStatuses(input.gates);
  const ready = input.gates.every((gate) => !gate.required || gate.status === "PASS");
  return {
    schema_version: "0.1",
    artifact_kind: "beta_readiness_report",
    generated_at: input.now.toISOString(),
    source_commit: input.currentCommit,
    manifest: {
      path: input.manifestPath,
      status: input.loaded.status,
      sha256: input.loaded.sha256,
      source_commit: input.loaded.manifest?.source_commit,
      reason: input.loaded.reason
    },
    status: overallStatus(input.gates, ready),
    ready,
    counts,
    gates: input.gates,
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
  manifest?: ReadinessEvidenceManifest;
  sha256?: string;
  reason?: string;
};

async function loadManifest(
  projectRoot: string,
  absolutePath: string
): Promise<LoadedManifest> {
  try {
    resolveInside(projectRoot, path.relative(projectRoot, absolutePath));
    const content = await readFile(absolutePath);
    const parsed = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
    if (!isManifest(parsed)) {
      return { status: "invalid", sha256: sha256(content), reason: "Manifest schema is invalid." };
    }
    return { status: "verified", manifest: parsed, sha256: sha256(content) };
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return { status: "missing", reason: "Evidence manifest was not found." };
    }
    return { status: "invalid", reason: "Evidence manifest could not be parsed." };
  }
}

function isManifest(value: unknown): value is ReadinessEvidenceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.schema_version === "0.1" &&
    record.artifact_kind === "beta_readiness_evidence_manifest" &&
    typeof record.generated_at === "string" &&
    typeof record.source_commit === "string" &&
    /^[0-9a-f]{40}$/i.test(record.source_commit) &&
    Array.isArray(record.evidence) &&
    record.evidence.every(isEvidenceEntry);
}

function isEvidenceEntry(value: unknown): value is ReadinessEvidenceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return readinessGateDefinitions.some((gate) => gate.id === record.gate_id) &&
    typeof record.path === "string" && record.path.length > 0 &&
    typeof record.artifact_kind === "string" &&
    ["PASS", "UNPASSED", "SETUP_REQUIRED", "OPTIONAL", "UNKNOWN"].includes(String(record.detected_status)) &&
    typeof record.source_commit === "string" && /^[0-9a-f]{40}$/i.test(record.source_commit) &&
    typeof record.executed_at === "string" &&
    typeof record.expires_at === "string" &&
    typeof record.sha256 === "string" && /^[0-9a-f]{64}$/i.test(record.sha256) &&
    typeof record.size_bytes === "number" && Number.isFinite(record.size_bytes) && record.size_bytes >= 0;
}

function missingGate(
  definition: ReadinessGateDefinition,
  reason: string
): BetaReadinessGateResult {
  return {
    id: definition.id,
    title: definition.title,
    required: definition.required,
    external_setup: definition.external_setup,
    evidence_source: definition.evidence_source,
    status: definition.required
      ? definition.external_setup ? "SETUP_REQUIRED" : "UNKNOWN"
      : "OPTIONAL",
    evidence: [],
    reasons: [reason]
  };
}

function countStatuses(
  gates: BetaReadinessGateResult[]
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

function overallStatus(gates: BetaReadinessGateResult[], ready: boolean): ReadinessStatus {
  if (ready) {
    return "PASS";
  }
  const requiredStatuses = gates.filter((gate) => gate.required).map((gate) => gate.status);
  for (const status of ["UNPASSED", "UNKNOWN", "SETUP_REQUIRED"] as const) {
    if (requiredStatuses.includes(status)) {
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

function unique(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}
