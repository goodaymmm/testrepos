import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";

export type ReadinessStatus =
  | "PASS"
  | "UNPASSED"
  | "SETUP_REQUIRED"
  | "OPTIONAL"
  | "UNKNOWN";

export type ReadinessGateId =
  | "BUILD_UNIT_INTEGRATION"
  | "CONFIG_MIGRATION_DOCTOR"
  | "RUNTIME_RESILIENCE"
  | "GITHUB_MERGE_DEPLOY_GUARD"
  | "WORKFLOW_RECOVERY_CONTROL"
  | "DISCORD_BOARD_SECURITY"
  | "RAG_INTEGRITY"
  | "PROVIDER_QUOTA_COMPLIANCE"
  | "PACKAGE_LIFECYCLE"
  | "SECRET_ARTIFACT_INTEGRITY"
  | "KNOWN_LIMITATIONS";

export type ReadinessGateDefinition = {
  id: ReadinessGateId;
  title: string;
  required: boolean;
  external_setup: boolean;
  freshness_ms: number;
  evidence_source: string;
};

export type ReadinessEvidenceEntry = {
  gate_id: ReadinessGateId;
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

export type ReadinessEvidenceManifest = {
  schema_version: "0.1";
  artifact_kind: "beta_readiness_evidence_manifest";
  generated_at: string;
  source_commit: string;
  evidence: ReadinessEvidenceEntry[];
};

export type CreateReadinessEvidenceManifestOptions = {
  evidence: string[];
  output?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type ReadinessEvidenceInspection = {
  artifact_kind: string;
  detected_status: ReadinessStatus;
  source_commit: string;
  executed_at: string;
  expires_at: string;
  sha256: string;
  size_bytes: number;
  summary?: string;
};

export const readinessGateDefinitions: readonly ReadinessGateDefinition[] = [
  gate("BUILD_UNIT_INTEGRATION", "Build / unit / integration tests", true, false, 24, "operation test summary"),
  gate("CONFIG_MIGRATION_DOCTOR", "Configuration migration and doctor", true, false, 24, "doctor or migration result"),
  gate("RUNTIME_RESILIENCE", "Daemon soak, retention, and backup recovery", true, false, 168, "daemon certification and recovery evidence"),
  gate("GITHUB_MERGE_DEPLOY_GUARD", "GitHub merge and deploy guard", true, true, 168, "GitHub sandbox evidence"),
  gate("WORKFLOW_RECOVERY_CONTROL", "Workflow recovery and control", true, false, 168, "workflow operation test evidence"),
  gate("DISCORD_BOARD_SECURITY", "Discord and Board security", true, true, 168, "Discord and Board operation test evidence"),
  gate("RAG_INTEGRITY", "RAG integrity", true, false, 168, "RAG verification evidence"),
  gate("PROVIDER_QUOTA_COMPLIANCE", "Provider quota and compliance", true, true, 24, "provider health and compliance evidence"),
  gate("PACKAGE_LIFECYCLE", "Package install, update, and rollback", true, false, 168, "local beta verification evidence"),
  gate("SECRET_ARTIFACT_INTEGRITY", "Secret scan and artifact integrity", true, false, 24, "secret scan and integrity evidence"),
  gate("KNOWN_LIMITATIONS", "Known unresolved limitations", false, false, 720, "known limitation register")
];

const gateById = new Map(readinessGateDefinitions.map((definition) => [definition.id, definition]));

export async function createReadinessEvidenceManifest(
  projectRoot: string,
  options: CreateReadinessEvidenceManifestOptions
): Promise<{ manifest: ReadinessEvidenceManifest; output_path: string }> {
  if (options.evidence.length === 0) {
    throw new Error("Specify at least one --evidence <GATE_ID=path> value.");
  }

  const now = options.now?.() ?? new Date();
  const sourceCommit = options.sourceCommit ?? await resolveCurrentCommit(
    projectRoot,
    options.commandRunner
  );
  const entries: ReadinessEvidenceEntry[] = [];

  for (const specification of options.evidence) {
    const { gateId, evidencePath } = parseEvidenceSpecification(specification);
    const definition = gateById.get(gateId);
    if (definition === undefined) {
      throw new Error(`Unknown readiness gate id: ${gateId}`);
    }

    const absolutePath = resolveInside(projectRoot, evidencePath);
    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath)
    ]);
    if (!fileStats.isFile()) {
      throw new Error(`Readiness evidence must be a file: ${evidencePath}`);
    }

    const inspection = inspectReadinessEvidence({
      content,
      absolutePath,
      modifiedAt: fileStats.mtime,
      now,
      fallbackCommit: sourceCommit,
      freshnessMs: definition.freshness_ms
    });
    entries.push({
      gate_id: gateId,
      path: toProjectPath(projectRoot, absolutePath),
      ...inspection
    });
  }

  const manifest: ReadinessEvidenceManifest = {
    schema_version: "0.1",
    artifact_kind: "beta_readiness_evidence_manifest",
    generated_at: now.toISOString(),
    source_commit: sourceCommit,
    evidence: entries.sort(compareEntries)
  };
  const outputPath = options.output ?? ".kairon/readiness/evidence-manifest.json";
  const absoluteOutput = resolveInside(projectRoot, outputPath);
  await writeJsonFileAtomic(absoluteOutput, manifest);

  return {
    manifest,
    output_path: toProjectPath(projectRoot, absoluteOutput)
  };
}

export function detectReadinessEvidenceStatus(text: string): ReadinessStatus {
  const parsed = parseArtifact(text);
  if (parsed !== undefined) {
    const operationSummary = asRecord(parsed.summary);
    const verification = asRecord(parsed.verification);
    const readiness = asRecord(parsed.readiness);
    const explicitStatus = normalizeStatus(parsed.status) ?? normalizeStatus(readiness?.status);
    const booleanStatus = firstBoolean(parsed.ok, verification?.ok, readiness?.ok);
    if (operationSummary !== undefined) {
      const failCount = numberValue(operationSummary.fail) + numberValue(operationSummary.unpassed);
      if (failCount > 0) {
        return "UNPASSED";
      }
      if (numberValue(operationSummary.setup_required) > 0) {
        return "SETUP_REQUIRED";
      }
      if (numberValue(operationSummary.unknown) > 0) {
        return "UNKNOWN";
      }
      if (explicitStatus !== undefined && explicitStatus !== "PASS") {
        return explicitStatus;
      }
      if (booleanStatus === false) {
        return "UNPASSED";
      }
      if (numberValue(operationSummary.total) > 0) {
        return "PASS";
      }

      const daemonStatus = normalizeStatus(operationSummary.status);
      if (daemonStatus !== undefined) {
        if (daemonStatus === "PASS" && (
          numberValue(operationSummary.fatal_errors) > 0 ||
          numberValue(operationSummary.heartbeat_gaps) > 0 ||
          operationSummary.stale_lock_suspected === true
        )) {
          return "UNPASSED";
        }
        return daemonStatus;
      }
    }

    if (booleanStatus !== undefined) {
      return booleanStatus ? "PASS" : "UNPASSED";
    }

    if (explicitStatus !== undefined) {
      return explicitStatus;
    }
  }

  const assignments = [...text.matchAll(/(?:^|\n)\s*(?:readiness\.)?status\s*[:=]\s*([A-Za-z_-]+)/gi)];
  for (const match of assignments) {
    const status = normalizeStatus(match[1]);
    if (status !== undefined) {
      return status;
    }
  }

  if (/\bSETUP_REQUIRED\b/i.test(text)) {
    return "SETUP_REQUIRED";
  }
  if (/\b(?:UNPASSED|FAIL(?:ED)?)\b/i.test(text)) {
    return "UNPASSED";
  }
  if (/\bPASS(?:ED)?\b/i.test(text)) {
    return "PASS";
  }
  return "UNKNOWN";
}

export function inspectReadinessEvidence(input: {
  content: Buffer;
  absolutePath: string;
  modifiedAt: Date;
  now: Date;
  fallbackCommit: string;
  freshnessMs: number;
}): ReadinessEvidenceInspection {
  const text = input.content.toString("utf8");
  const parsed = parseArtifact(text);
  const executedAt = inferExecutedAt(parsed, input.modifiedAt, input.now);
  return {
    artifact_kind: inferArtifactKind(parsed, input.absolutePath),
    detected_status: detectReadinessEvidenceStatus(text),
    source_commit: inferSourceCommit(parsed) ?? input.fallbackCommit,
    executed_at: executedAt.toISOString(),
    expires_at: new Date(executedAt.getTime() + input.freshnessMs).toISOString(),
    sha256: sha256(input.content),
    size_bytes: input.content.byteLength,
    summary: inferSafeSummary(parsed)
  };
}

export function parseReadinessGateId(value: string): ReadinessGateId {
  const normalized = value.trim().toUpperCase();
  if (!gateById.has(normalized as ReadinessGateId)) {
    throw new Error(`Unknown readiness gate id: ${value}`);
  }
  return normalized as ReadinessGateId;
}

export async function resolveCurrentCommit(
  projectRoot: string,
  commandRunner: CommandRunner = spawnCommandRunner
): Promise<string> {
  const result = await commandRunner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot,
    timeoutMs: 10_000
  });
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Unable to resolve the current Git commit for readiness evidence.");
  }
  return commit.toLowerCase();
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gate(
  id: ReadinessGateId,
  title: string,
  required: boolean,
  externalSetup: boolean,
  freshnessHours: number,
  evidenceSource: string
): ReadinessGateDefinition {
  return {
    id,
    title,
    required,
    external_setup: externalSetup,
    freshness_ms: freshnessHours * 60 * 60 * 1_000,
    evidence_source: evidenceSource
  };
}

function parseEvidenceSpecification(specification: string): {
  gateId: ReadinessGateId;
  evidencePath: string;
} {
  const separator = specification.indexOf("=");
  if (separator <= 0 || separator === specification.length - 1) {
    throw new Error(`Invalid evidence specification: ${specification}. Use GATE_ID=path.`);
  }
  return {
    gateId: parseReadinessGateId(specification.slice(0, separator)),
    evidencePath: specification.slice(separator + 1).trim()
  };
}

function parseArtifact(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {
    return undefined;
  }
}

function inferExecutedAt(
  parsed: Record<string, unknown> | undefined,
  modifiedAt: Date,
  now: Date
): Date {
  const candidates = [
    parsed?.executed_at,
    parsed?.generated_at,
    parsed?.finished_at,
    parsed?.created_at,
    parsed?.rehearsed_at,
    parsed?.verified_at
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const parsedDate = new Date(candidate);
    if (Number.isFinite(parsedDate.getTime()) && parsedDate <= now) {
      return parsedDate;
    }
  }
  return modifiedAt <= now ? modifiedAt : now;
}

function inferSourceCommit(parsed: Record<string, unknown> | undefined): string | undefined {
  const git = asRecord(parsed?.git);
  for (const value of [parsed?.source_commit, parsed?.commit_sha, parsed?.head_sha, git?.commit]) {
    if (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value.trim())) {
      return value.trim().toLowerCase();
    }
  }
  return undefined;
}

function inferArtifactKind(
  parsed: Record<string, unknown> | undefined,
  absolutePath: string
): string {
  for (const value of [parsed?.artifact_kind, parsed?.kind, parsed?.schema_name]) {
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
      return value;
    }
  }
  return path.extname(absolutePath).toLowerCase() === ".json" ? "json" : "text";
}

function inferSafeSummary(parsed: Record<string, unknown> | undefined): string | undefined {
  if (parsed === undefined) {
    return undefined;
  }
  for (const value of [parsed.message, parsed.details, parsed.reason]) {
    if (typeof value === "string") {
      return sanitizeSummary(value);
    }
  }
  return undefined;
}

function sanitizeSummary(value: string): string {
  const sanitized = value
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 200 ? `${sanitized.slice(0, 197)}...` : sanitized;
}

function normalizeStatus(value: unknown): ReadinessStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const status = value.trim().replace(/[ -]+/g, "_").toUpperCase();
  if ([
    "PASS",
    "PASSED",
    "COMPLETED",
    "APPROVED",
    "READY",
    "STOPPED",
    "VERIFIED",
    "PUBLISHED",
    "APPLIED",
    "EXECUTED",
    "HEALTHY",
    "RESOLVED",
    "ENFORCED"
  ].includes(status)) {
    return "PASS";
  }
  if (["UNPASSED", "FAIL", "FAILED", "ERROR", "FATAL_ERROR", "BLOCKED", "CHANGES_REQUESTED"].includes(status)) {
    return "UNPASSED";
  }
  if (["SETUP_REQUIRED", "NOT_CONFIGURED", "INCOMPLETE", "NO_EVENTS"].includes(status)) {
    return "SETUP_REQUIRED";
  }
  if (status === "OPTIONAL" || status === "SKIP" || status === "SKIPPED") {
    return "OPTIONAL";
  }
  if (["UNKNOWN", "RUNNING", "RUNNING_OR_INCOMPLETE"].includes(status)) {
    return "UNKNOWN";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compareEntries(left: ReadinessEvidenceEntry, right: ReadinessEvidenceEntry): number {
  return left.gate_id === right.gate_id
    ? left.path.localeCompare(right.path)
    : left.gate_id.localeCompare(right.gate_id);
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(path.resolve(projectRoot), absolutePath));
}
