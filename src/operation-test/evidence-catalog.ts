import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  stat
} from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import {
  sanitizeSupportText,
  scanSupportEntries
} from "../diagnostics/support-redaction.js";
import {
  detectReadinessEvidenceStatus,
  resolveCurrentCommit
} from "../readiness/evidence-manifest.js";
import {
  parseOperationTestListAliases,
  type OperationTestListAlias
} from "./test-list-matcher.js";

const defaultFreshnessHours = 168;
const catalogArtifactKind = "operation_evidence_catalog";
const catalogRelativePath = ".kairon/runtime/operation-test/evidence-catalog.json";
const supportedStatuses = new Set([
  "PASS",
  "FAIL",
  "SETUP_REQUIRED",
  "OPTIONAL",
  "UNKNOWN"
]);

export type OperationEvidenceStatus =
  | "PASS"
  | "FAIL"
  | "SETUP_REQUIRED"
  | "OPTIONAL"
  | "UNKNOWN";

export type OperationEvidenceIntegrity =
  | "verified"
  | "stale"
  | "tampered"
  | "missing"
  | "wrong_commit";

export type OperationEvidenceRetentionDisposition =
  | "protected"
  | "candidate"
  | "retain";

export type OperationEvidenceCatalogEntry = {
  evidence_id: string;
  result_root: string;
  path: string;
  artifact_kind: string;
  task_id?: string;
  test_id?: string;
  original_test_id?: string;
  status: OperationEvidenceStatus;
  source_commit: string;
  executed_at: string;
  expires_at: string;
  size_bytes: number;
  sha256: string;
  integrity: OperationEvidenceIntegrity;
  supersedes: string[];
  superseded_by?: string;
  retention: {
    disposition: OperationEvidenceRetentionDisposition;
    reasons: string[];
  };
};

export type OperationEvidenceCatalogRoot = {
  path: string;
  entries: number;
  protected: boolean;
  retention_candidate: boolean;
  protection_reasons: string[];
};

export type OperationEvidenceCatalog = {
  schema_version: "0.1";
  artifact_kind: typeof catalogArtifactKind;
  generated_at: string;
  source_commit: string;
  default_freshness_hours: number;
  result_roots: OperationEvidenceCatalogRoot[];
  entries: OperationEvidenceCatalogEntry[];
  summary: {
    result_roots: number;
    entries: number;
    pass: number;
    fail: number;
    setup_required: number;
    optional: number;
    unknown: number;
    verified: number;
    stale: number;
    wrong_commit: number;
    protected: number;
    candidates: number;
  };
  catalog_sha256: string;
};

export type CreateOperationEvidenceCatalogOptions = {
  resultRoots: string[];
  testLists?: string[];
  output?: string;
  sourceCommit?: string;
  freshnessHours?: number;
  now?: () => Date;
};

export type OperationEvidenceCatalogCreateResult = {
  catalog: OperationEvidenceCatalog;
  catalog_path: string;
};

export type OperationEvidenceCatalogVerification = {
  schema_version: "0.1";
  artifact_kind: "operation_evidence_catalog_verification";
  catalog_path: string;
  status: "PASS" | "FAIL";
  catalog_digest_status: "verified" | "tampered";
  secret_scan_status: "passed" | "failed";
  source_commit: string;
  checked_at: string;
  counts: Record<OperationEvidenceIntegrity, number> & {
    total: number;
  };
  entries: OperationEvidenceCatalogEntry[];
  reasons: string[];
};

export type OperationEvidenceListOptions = {
  task?: string;
  testId?: string;
  status?: string;
  integrity?: string;
};

export type OperationEvidenceRetentionInspection = {
  catalog_status: "missing" | "verified" | "invalid";
  catalog_path: string;
  protected_paths: string[];
  candidate_paths: string[];
  reasons: string[];
};

type ParsedEvidence = {
  artifactKind: string;
  status: OperationEvidenceStatus;
  taskId?: string;
  testId?: string;
  originalTestId?: string;
  sourceCommit?: string;
  executedAt?: string;
  expiresAt?: string;
};

type CatalogableFile = {
  absolutePath: string;
  projectPath: string;
  resultRoot: string;
  content: Buffer;
  parsed: Record<string, unknown>;
  modifiedAt: Date;
};

export async function createOperationEvidenceCatalog(
  projectRoot: string,
  options: CreateOperationEvidenceCatalogOptions
): Promise<OperationEvidenceCatalogCreateResult> {
  const root = path.resolve(projectRoot);
  const now = options.now?.() ?? new Date();
  const freshnessHours = normalizeFreshnessHours(options.freshnessHours);
  const sourceCommit = normalizeCommit(
    options.sourceCommit ?? await resolveCurrentCommit(root)
  );
  const resultRoots = normalizeResultRoots(root, options.resultRoots);
  if (resultRoots.length === 0) {
    throw new Error("Specify at least one --result-root <path>.");
  }

  const aliases = await loadAliasIndex(root, options.testLists ?? []);
  const referencedPaths = new Set<string>();
  const files: CatalogableFile[] = [];
  for (const resultRoot of resultRoots) {
    files.push(...await collectCatalogableFiles(root, resultRoot));
  }

  for (const file of files) {
    collectManifestReferences(root, file.parsed, referencedPaths);
  }

  const entries: OperationEvidenceCatalogEntry[] = [];
  for (const file of files) {
    const parsedEntries = parseEvidenceFile(file, aliases);
    for (const parsed of parsedEntries) {
      entries.push(toCatalogEntry({
        file,
        parsed,
        sourceCommit,
        now,
        freshnessHours,
        referencedPaths
      }));
    }
  }

  for (const reference of [...referencedPaths].sort()) {
    if (files.some((file) => file.projectPath === reference)) {
      continue;
    }
    const referenced = await loadReferencedEvidence(root, reference);
    if (referenced === undefined) {
      continue;
    }
    const ownerRoot = findOwningResultRoot(reference, resultRoots) ?? resultRoots[0]!;
    const file: CatalogableFile = {
      ...referenced,
      resultRoot: ownerRoot
    };
    for (const parsed of parseEvidenceFile(file, aliases)) {
      entries.push(toCatalogEntry({
        file,
        parsed,
        sourceCommit,
        now,
        freshnessHours,
        referencedPaths
      }));
    }
  }

  const deduped = dedupeEntries(entries);
  applySupersessionAndRetention(deduped, referencedPaths);
  const catalogWithoutDigest = {
    schema_version: "0.1" as const,
    artifact_kind: catalogArtifactKind as typeof catalogArtifactKind,
    generated_at: now.toISOString(),
    source_commit: sourceCommit,
    default_freshness_hours: freshnessHours,
    result_roots: summarizeResultRoots(resultRoots, deduped),
    entries: deduped.sort(compareEntries),
    summary: summarizeEntries(deduped)
  };
  const catalog: OperationEvidenceCatalog = {
    ...catalogWithoutDigest,
    catalog_sha256: digestCatalog(catalogWithoutDigest)
  };

  const outputPath = resolveInside(root, options.output ?? catalogRelativePath);
  assertCatalogIsSafe(root, catalog, toProjectPath(root, outputPath));
  await writeJsonFileAtomic(outputPath, catalog);
  return {
    catalog,
    catalog_path: toProjectPath(root, outputPath)
  };
}

export async function verifyOperationEvidenceCatalog(
  projectRoot: string,
  catalogPath = catalogRelativePath,
  options: { now?: Date; sourceCommit?: string } = {}
): Promise<OperationEvidenceCatalogVerification> {
  const root = path.resolve(projectRoot);
  const absoluteCatalogPath = resolveInside(root, catalogPath);
  const raw = await readFile(absoluteCatalogPath, "utf8");
  const catalog = parseCatalog(raw);
  const actualCatalogDigest = digestCatalog({
    schema_version: catalog.schema_version,
    artifact_kind: catalog.artifact_kind,
    generated_at: catalog.generated_at,
    source_commit: catalog.source_commit,
    default_freshness_hours: catalog.default_freshness_hours,
    result_roots: catalog.result_roots,
    entries: catalog.entries,
    summary: catalog.summary
  });
  const digestStatus =
    actualCatalogDigest === catalog.catalog_sha256 ? "verified" : "tampered";
  const currentCommit = normalizeCommit(options.sourceCommit ?? catalog.source_commit);
  const now = options.now ?? new Date();
  const entries = await Promise.all(
    catalog.entries.map((entry) => inspectCatalogEntry(root, entry, currentCommit, now))
  );
  const counts = countIntegrity(entries);
  const secretScan = scanSupportEntries([
    {
      path: toProjectPath(root, absoluteCatalogPath),
      content: raw
    }
  ]);
  const reasons: string[] = [];
  if (digestStatus === "tampered") {
    reasons.push("catalog_digest_mismatch");
  }
  if (secretScan.status === "failed") {
    reasons.push("catalog_secret_scan_failed");
  }
  if (counts.tampered > 0) {
    reasons.push("evidence_digest_mismatch");
  }
  if (counts.missing > 0) {
    reasons.push("evidence_missing");
  }

  return {
    schema_version: "0.1",
    artifact_kind: "operation_evidence_catalog_verification",
    catalog_path: toProjectPath(root, absoluteCatalogPath),
    status: reasons.length === 0 ? "PASS" : "FAIL",
    catalog_digest_status: digestStatus,
    secret_scan_status: secretScan.status,
    source_commit: currentCommit,
    checked_at: now.toISOString(),
    counts,
    entries,
    reasons
  };
}

export async function listOperationEvidence(
  projectRoot: string,
  catalogPath = catalogRelativePath,
  options: OperationEvidenceListOptions = {}
): Promise<OperationEvidenceCatalogEntry[]> {
  const verification = await verifyOperationEvidenceCatalog(projectRoot, catalogPath);
  const status =
    options.status === undefined
      ? undefined
      : normalizeStatus(options.status);
  if (options.status !== undefined && status === undefined) {
    throw new Error(`Unknown operation evidence status: ${options.status}`);
  }
  return verification.entries.filter((entry) => {
    if (
      options.task !== undefined &&
      entry.task_id !== normalizeTaskId(options.task)
    ) {
      return false;
    }
    if (
      options.testId !== undefined &&
      entry.test_id !== normalizeTestId(options.testId)
    ) {
      return false;
    }
    if (
      status !== undefined &&
      entry.status !== status
    ) {
      return false;
    }
    if (
      options.integrity !== undefined &&
      entry.integrity !== normalizeIntegrity(options.integrity)
    ) {
      return false;
    }
    return true;
  });
}

export async function inspectOperationEvidenceRetention(
  projectRoot: string,
  options: { catalogPath?: string; now?: Date } = {}
): Promise<OperationEvidenceRetentionInspection> {
  const root = path.resolve(projectRoot);
  const catalogPath = options.catalogPath ?? catalogRelativePath;
  const projectCatalogPath = toProjectPath(root, resolveInside(root, catalogPath));
  let catalog: OperationEvidenceCatalog;
  try {
    catalog = parseCatalog(await readFile(resolveInside(root, catalogPath), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT")) {
      return {
        catalog_status: "missing",
        catalog_path: projectCatalogPath,
        protected_paths: [],
        candidate_paths: [],
        reasons: ["evidence_catalog_missing"]
      };
    }
    return {
      catalog_status: "invalid",
      catalog_path: projectCatalogPath,
      protected_paths: ["operation-test-results"],
      candidate_paths: [],
      reasons: ["evidence_catalog_invalid"]
    };
  }

  let verification: OperationEvidenceCatalogVerification;
  try {
    verification = await verifyOperationEvidenceCatalog(root, catalogPath, {
      now: options.now,
      sourceCommit: catalog.source_commit
    });
  } catch {
    return {
      catalog_status: "invalid",
      catalog_path: projectCatalogPath,
      protected_paths: ["operation-test-results"],
      candidate_paths: [],
      reasons: ["evidence_catalog_verification_failed"]
    };
  }
  if (verification.status !== "PASS") {
    return {
      catalog_status: "invalid",
      catalog_path: projectCatalogPath,
      protected_paths: uniquePaths([
        "operation-test-results",
        ...catalog.result_roots.map((item) => item.path)
      ]),
      candidate_paths: [],
      reasons: verification.reasons
    };
  }

  const entriesByRoot = new Map<string, OperationEvidenceCatalogEntry[]>();
  for (const entry of verification.entries) {
    const values = entriesByRoot.get(entry.result_root) ?? [];
    values.push(entry);
    entriesByRoot.set(entry.result_root, values);
  }
  const protectedPaths: string[] = [];
  const candidatePaths: string[] = [];
  for (const resultRoot of catalog.result_roots) {
    const entries = entriesByRoot.get(resultRoot.path) ?? [];
    const unsafe = entries.some(
      (entry) => entry.integrity === "missing" || entry.integrity === "tampered"
    );
    const protectedEntry = entries.some(
      (entry) => entry.retention.disposition === "protected"
    );
    if (unsafe || protectedEntry || resultRoot.protected) {
      protectedPaths.push(resultRoot.path);
      continue;
    }
    if (
      resultRoot.retention_candidate &&
      entries.length > 0 &&
      entries.every((entry) => entry.retention.disposition === "candidate")
    ) {
      candidatePaths.push(resultRoot.path);
    }
  }

  return {
    catalog_status: "verified",
    catalog_path: projectCatalogPath,
    protected_paths: uniquePaths(protectedPaths),
    candidate_paths: uniquePaths(candidatePaths),
    reasons: []
  };
}

export function getDefaultOperationEvidenceCatalogPath(): string {
  return catalogRelativePath;
}

export function formatOperationEvidenceCatalog(
  result: OperationEvidenceCatalogCreateResult
): string {
  const summary = result.catalog.summary;
  return [
    "Kairon operation evidence catalog created.",
    `catalog=${result.catalog_path}`,
    `source_commit=${result.catalog.source_commit}`,
    `result_roots=${summary.result_roots}`,
    `entries=${summary.entries}`,
    `pass=${summary.pass}`,
    `fail=${summary.fail}`,
    `setup_required=${summary.setup_required}`,
    `optional=${summary.optional}`,
    `unknown=${summary.unknown}`,
    `verified=${summary.verified}`,
    `stale=${summary.stale}`,
    `wrong_commit=${summary.wrong_commit}`,
    `protected=${summary.protected}`,
    `candidates=${summary.candidates}`,
    `catalog_sha256=${result.catalog.catalog_sha256}`
  ].join("\n");
}

export function formatOperationEvidenceVerification(
  verification: OperationEvidenceCatalogVerification
): string {
  return [
    "Kairon operation evidence catalog verification.",
    `catalog=${verification.catalog_path}`,
    `status=${verification.status}`,
    `catalog_digest=${verification.catalog_digest_status}`,
    `secret_scan=${verification.secret_scan_status}`,
    `source_commit=${verification.source_commit}`,
    `entries=${verification.counts.total}`,
    `verified=${verification.counts.verified}`,
    `stale=${verification.counts.stale}`,
    `wrong_commit=${verification.counts.wrong_commit}`,
    `tampered=${verification.counts.tampered}`,
    `missing=${verification.counts.missing}`,
    `reasons=${verification.reasons.join(",") || "none"}`
  ].join("\n");
}

export function formatOperationEvidenceList(
  entries: OperationEvidenceCatalogEntry[]
): string {
  if (entries.length === 0) {
    return "No operation evidence entries matched.";
  }
  return [
    "Kairon operation evidence entries:",
    `entries=${entries.length}`,
    ...entries.map((entry) =>
      [
        `evidence_id=${entry.evidence_id}`,
        `task=${entry.task_id ?? "none"}`,
        `test=${entry.test_id ?? "none"}`,
        `status=${entry.status}`,
        `integrity=${entry.integrity}`,
        `retention=${entry.retention.disposition}`,
        `path=${entry.path}`,
        `source_commit=${entry.source_commit}`,
        `executed_at=${entry.executed_at}`
      ].join(" ")
    )
  ].join("\n");
}

async function collectCatalogableFiles(
  projectRoot: string,
  resultRoot: string
): Promise<CatalogableFile[]> {
  const absoluteRoot = resolveInside(projectRoot, resultRoot);
  const rootStats = await lstat(absoluteRoot);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Operation evidence result root must not be a symbolic link: ${resultRoot}`);
  }
  const files: CatalogableFile[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolveInside(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Operation evidence must not contain symbolic links: ${toProjectPath(projectRoot, absolutePath)}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
        continue;
      }
      const content = await readFile(absolutePath);
      const parsed = parseJsonRecord(content);
      if (parsed === undefined || !isCatalogableJson(entry.name, parsed)) {
        continue;
      }
      const fileStats = await stat(absolutePath);
      files.push({
        absolutePath,
        projectPath: toProjectPath(projectRoot, absolutePath),
        resultRoot,
        content,
        parsed,
        modifiedAt: fileStats.mtime
      });
    }
  }

  if (rootStats.isFile()) {
    const content = await readFile(absoluteRoot);
    const parsed = parseJsonRecord(content);
    if (parsed !== undefined && isCatalogableJson(path.basename(absoluteRoot), parsed)) {
      files.push({
        absolutePath: absoluteRoot,
        projectPath: toProjectPath(projectRoot, absoluteRoot),
        resultRoot: toProjectPath(projectRoot, path.dirname(absoluteRoot)),
        content,
        parsed,
        modifiedAt: rootStats.mtime
      });
    }
    return files;
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Operation evidence result root must be a file or directory: ${resultRoot}`);
  }
  await visit(absoluteRoot);
  return files.sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

async function loadReferencedEvidence(
  projectRoot: string,
  projectPath: string
): Promise<Omit<CatalogableFile, "resultRoot"> | undefined> {
  const absolutePath = resolveInside(projectRoot, projectPath);
  try {
    const fileStats = await lstat(absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      return undefined;
    }
    const content = await readFile(absolutePath);
    const parsed = parseJsonRecord(content);
    if (parsed === undefined || !isCatalogableJson(path.basename(absolutePath), parsed)) {
      return undefined;
    }
    return {
      absolutePath,
      projectPath: toProjectPath(projectRoot, absolutePath),
      content,
      parsed,
      modifiedAt: fileStats.mtime
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseEvidenceFile(
  file: CatalogableFile,
  aliases: Map<string, OperationTestListAlias>
): ParsedEvidence[] {
  const parsed = file.parsed;
  const base = baseParsedEvidence(parsed, file);
  const resultValues = [
    ...(Array.isArray(parsed.results) ? parsed.results : []),
    ...(Array.isArray(parsed.scenarios) ? parsed.scenarios : [])
  ];
  const entries = resultValues.flatMap((value) => {
    const record = asRecord(value);
    if (record === undefined) {
      return [];
    }
    const rawTestId = readString(record.test_id) ?? readString(record.id);
    const normalized = canonicalizeTestId(rawTestId, aliases);
    const status = normalizeStatus(record.status);
    if (normalized.testId === undefined || status === undefined) {
      return [];
    }
    return [{
      ...base,
      artifactKind:
        readString(record.artifact_kind) ??
        (path.basename(file.absolutePath).toLowerCase() === "summary.json"
          ? "operation_test_summary_result"
          : base.artifactKind),
      testId: normalized.testId,
      originalTestId: normalized.originalTestId,
      taskId:
        normalizeTaskId(readString(record.task_id)) ??
        inferTaskId(normalized.testId),
      status,
      sourceCommit: inferSourceCommit(record) ?? base.sourceCommit,
      executedAt: inferTimestamp(record) ?? base.executedAt,
      expiresAt: inferExpiresAt(record) ?? base.expiresAt
    }];
  });
  if (entries.length > 0) {
    return entries;
  }

  const rawTestId = readString(parsed.test_id) ?? readString(parsed.id);
  const normalized = canonicalizeTestId(rawTestId, aliases);
  const explicitStatus = normalizeStatus(parsed.status);
  const detectedStatus = normalizeStatus(
    detectReadinessEvidenceStatus(file.content.toString("utf8"))
  );
  if (
    normalized.testId !== undefined ||
    explicitStatus !== undefined ||
    readString(parsed.artifact_kind) !== undefined ||
    readString(parsed.kind) !== undefined
  ) {
    return [{
      ...base,
      testId: normalized.testId,
      originalTestId: normalized.originalTestId,
      taskId:
        normalizeTaskId(readString(parsed.task_id)) ??
        inferTaskId(normalized.testId),
      status: explicitStatus ?? detectedStatus ?? "UNKNOWN"
    }];
  }
  return [];
}

function baseParsedEvidence(
  parsed: Record<string, unknown>,
  file: CatalogableFile
): ParsedEvidence {
  return {
    artifactKind: inferArtifactKind(parsed, file.absolutePath),
    status: normalizeStatus(parsed.status) ?? "UNKNOWN",
    sourceCommit: inferSourceCommit(parsed),
    executedAt: inferTimestamp(parsed),
    expiresAt: inferExpiresAt(parsed)
  };
}

function toCatalogEntry(input: {
  file: CatalogableFile;
  parsed: ParsedEvidence;
  sourceCommit: string;
  now: Date;
  freshnessHours: number;
  referencedPaths: Set<string>;
}): OperationEvidenceCatalogEntry {
  const sourceCommit = normalizeCommit(input.parsed.sourceCommit ?? input.sourceCommit);
  const executedAt = parseDate(input.parsed.executedAt) ?? input.file.modifiedAt;
  const expiresAt =
    parseDate(input.parsed.expiresAt) ??
    new Date(executedAt.getTime() + input.freshnessHours * 60 * 60 * 1000);
  const integrity: OperationEvidenceIntegrity =
    sourceCommit !== input.sourceCommit
      ? "wrong_commit"
      : input.now.getTime() > expiresAt.getTime()
        ? "stale"
        : "verified";
  const evidenceId = createEvidenceId(
    input.file.projectPath,
    input.parsed.testId,
    input.parsed.artifactKind,
    executedAt.toISOString()
  );
  const reasons = input.referencedPaths.has(input.file.projectPath)
    ? ["readiness_reference"]
    : [];
  return {
    evidence_id: evidenceId,
    result_root: input.file.resultRoot,
    path: input.file.projectPath,
    artifact_kind: sanitizeIdentifier(input.parsed.artifactKind, "unknown"),
    task_id: input.parsed.taskId,
    test_id: input.parsed.testId,
    original_test_id: input.parsed.originalTestId,
    status: input.parsed.status,
    source_commit: sourceCommit,
    executed_at: executedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    size_bytes: input.file.content.byteLength,
    sha256: sha256(input.file.content),
    integrity,
    supersedes: [],
    retention: {
      disposition: reasons.length > 0 ? "protected" : "retain",
      reasons
    }
  };
}

function applySupersessionAndRetention(
  entries: OperationEvidenceCatalogEntry[],
  referencedPaths: Set<string>
): void {
  const passGroups = new Map<string, OperationEvidenceCatalogEntry[]>();
  for (const entry of entries) {
    if (entry.status !== "PASS") {
      continue;
    }
    const key = entry.test_id ?? `${entry.artifact_kind}:${entry.path}`;
    const values = passGroups.get(key) ?? [];
    values.push(entry);
    passGroups.set(key, values);
  }

  for (const group of passGroups.values()) {
    const sorted = [...group].sort(compareNewestFirst);
    const latest = sorted[0];
    if (latest === undefined) {
      continue;
    }
    const latestVerified = sorted.find((entry) => entry.integrity === "verified");
    if (latestVerified !== undefined) {
      addProtectionReason(latestVerified, "latest_verified_pass");
    }
    if (sorted.length === 1) {
      addProtectionReason(latest, "only_pass_generation");
    }
    for (const older of sorted.slice(1)) {
      older.superseded_by = latest.evidence_id;
      latest.supersedes.push(older.evidence_id);
    }
  }

  for (const entry of entries) {
    if (referencedPaths.has(entry.path)) {
      addProtectionReason(entry, "readiness_reference");
    }
    if (entry.retention.reasons.length > 0) {
      entry.retention.disposition = "protected";
      continue;
    }
    if (
      entry.superseded_by !== undefined ||
      entry.integrity === "stale" ||
      entry.integrity === "tampered" ||
      entry.integrity === "missing"
    ) {
      entry.retention.disposition = "candidate";
      entry.retention.reasons = [
        entry.superseded_by !== undefined
          ? "superseded"
          : `integrity_${entry.integrity}`
      ];
    }
  }
}

async function inspectCatalogEntry(
  projectRoot: string,
  entry: OperationEvidenceCatalogEntry,
  currentCommit: string,
  now: Date
): Promise<OperationEvidenceCatalogEntry> {
  let integrity: OperationEvidenceIntegrity;
  try {
    const absolutePath = resolveInside(projectRoot, entry.path);
    const fileStats = await lstat(absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      integrity = "missing";
    } else {
      const content = await readFile(absolutePath);
      integrity =
        content.byteLength !== entry.size_bytes || sha256(content) !== entry.sha256
          ? "tampered"
          : entry.source_commit !== currentCommit
            ? "wrong_commit"
            : now.getTime() > Date.parse(entry.expires_at)
              ? "stale"
              : "verified";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      integrity = "missing";
    } else {
      throw error;
    }
  }
  return {
    ...entry,
    integrity
  };
}

function summarizeResultRoots(
  resultRoots: string[],
  entries: OperationEvidenceCatalogEntry[]
): OperationEvidenceCatalogRoot[] {
  return resultRoots.map((resultRoot) => {
    const rootEntries = entries.filter((entry) => entry.result_root === resultRoot);
    const protectionReasons = uniqueValues(
      rootEntries.flatMap((entry) =>
        entry.retention.disposition === "protected"
          ? entry.retention.reasons
          : []
      )
    );
    return {
      path: resultRoot,
      entries: rootEntries.length,
      protected: protectionReasons.length > 0,
      retention_candidate:
        rootEntries.length > 0 &&
        protectionReasons.length === 0 &&
        rootEntries.every((entry) => entry.retention.disposition === "candidate"),
      protection_reasons: protectionReasons
    };
  });
}

function summarizeEntries(entries: OperationEvidenceCatalogEntry[]) {
  return {
    result_roots: new Set(entries.map((entry) => entry.result_root)).size,
    entries: entries.length,
    pass: entries.filter((entry) => entry.status === "PASS").length,
    fail: entries.filter((entry) => entry.status === "FAIL").length,
    setup_required: entries.filter((entry) => entry.status === "SETUP_REQUIRED").length,
    optional: entries.filter((entry) => entry.status === "OPTIONAL").length,
    unknown: entries.filter((entry) => entry.status === "UNKNOWN").length,
    verified: entries.filter((entry) => entry.integrity === "verified").length,
    stale: entries.filter((entry) => entry.integrity === "stale").length,
    wrong_commit: entries.filter((entry) => entry.integrity === "wrong_commit").length,
    protected: entries.filter(
      (entry) => entry.retention.disposition === "protected"
    ).length,
    candidates: entries.filter(
      (entry) => entry.retention.disposition === "candidate"
    ).length
  };
}

function countIntegrity(entries: OperationEvidenceCatalogEntry[]) {
  return {
    total: entries.length,
    verified: entries.filter((entry) => entry.integrity === "verified").length,
    stale: entries.filter((entry) => entry.integrity === "stale").length,
    tampered: entries.filter((entry) => entry.integrity === "tampered").length,
    missing: entries.filter((entry) => entry.integrity === "missing").length,
    wrong_commit: entries.filter((entry) => entry.integrity === "wrong_commit").length
  };
}

async function loadAliasIndex(
  projectRoot: string,
  testLists: string[]
): Promise<Map<string, OperationTestListAlias>> {
  const aliases = new Map<string, OperationTestListAlias>();
  for (const testList of testLists) {
    const absolutePath = resolveInside(projectRoot, testList);
    const markdown = await readFile(absolutePath, "utf8");
    for (const alias of parseOperationTestListAliases(markdown)) {
      aliases.set(alias.source_id, alias);
    }
  }
  return aliases;
}

function collectManifestReferences(
  projectRoot: string,
  parsed: Record<string, unknown>,
  output: Set<string>
): void {
  for (const collection of [
    parsed.evidence,
    parsed.bindings,
    parsed.documents,
    parsed.scenarios
  ]) {
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const value of collection) {
      const record = asRecord(value);
      const referencedPath = readString(record?.path);
      if (referencedPath === undefined) {
        continue;
      }
      try {
        output.add(toProjectPath(projectRoot, resolveInside(projectRoot, referencedPath)));
      } catch {
        throw new Error(`Evidence manifest reference escapes project root: ${referencedPath}`);
      }
    }
  }
}

function canonicalizeTestId(
  value: string | undefined,
  aliases: Map<string, OperationTestListAlias>
): { testId?: string; originalTestId?: string } {
  if (value === undefined) {
    return {};
  }
  const direct = normalizeTestId(value);
  if (direct !== undefined) {
    return { testId: direct };
  }
  const sourceId = normalizeAliasSourceId(value);
  const alias = sourceId === undefined ? undefined : aliases.get(sourceId);
  if (alias === undefined) {
    return {};
  }
  return {
    testId: alias.target_id,
    originalTestId: sourceId
  };
}

function normalizeResultRoots(projectRoot: string, values: string[]): string[] {
  return uniquePaths(values.map((value) =>
    toProjectPath(projectRoot, resolveInside(projectRoot, value))
  ));
}

function normalizeFreshnessHours(value: number | undefined): number {
  const normalized = value ?? defaultFreshnessHours;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > 24 * 3650) {
    throw new Error("Evidence freshness hours must be a positive integer.");
  }
  return normalized;
}

function normalizeStatus(value: unknown): OperationEvidenceStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/[\s-]+/g, "_").toUpperCase();
  if (normalized === "UNPASSED" || normalized === "FAILED" || normalized === "FAILURE") {
    return "FAIL";
  }
  if (normalized === "SETUP_REQUIRED") {
    return "SETUP_REQUIRED";
  }
  if (supportedStatuses.has(normalized)) {
    return normalized as OperationEvidenceStatus;
  }
  return undefined;
}

function normalizeIntegrity(value: string): OperationEvidenceIntegrity {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "verified" ||
    normalized === "stale" ||
    normalized === "tampered" ||
    normalized === "missing" ||
    normalized === "wrong_commit"
  ) {
    return normalized;
  }
  throw new Error(`Unknown operation evidence integrity: ${value}`);
}

function normalizeTaskId(value: string | undefined): string | undefined {
  const match = value?.trim().toUpperCase().match(/^T\d+[A-Z]?$/u);
  return match?.[0];
}

function normalizeTestId(value: string | undefined): string | undefined {
  const match = value?.trim().toUpperCase().match(/^(?:OT|RET)-[A-Z0-9][A-Z0-9_-]*$/u);
  return match?.[0];
}

function normalizeAliasSourceId(value: string): string | undefined {
  const normalized = value
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9_]*$/u.test(normalized) ? normalized : undefined;
}

function normalizeCommit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error(`Invalid source commit: ${value}`);
  }
  return normalized;
}

function inferTaskId(testId: string | undefined): string | undefined {
  return testId?.match(/(?:^|-)(T\d+[A-Z]?)(?:-|$)/u)?.[1];
}

function inferArtifactKind(
  parsed: Record<string, unknown>,
  absolutePath: string
): string {
  const explicit =
    readString(parsed.artifact_kind) ??
    readString(parsed.kind) ??
    readString(parsed.schema_name);
  if (explicit !== undefined) {
    return explicit;
  }
  return path.basename(absolutePath).toLowerCase() === "summary.json"
    ? "operation_test_summary"
    : "operation_test_result";
}

function inferSourceCommit(record: Record<string, unknown>): string | undefined {
  for (const value of [
    record.source_commit,
    record.commit_sha,
    record.target_commit,
    asRecord(record.release)?.target_commit,
    asRecord(record.verification)?.source_commit,
    asRecord(record.manifest)?.source_commit
  ]) {
    if (typeof value === "string" && /^[a-f0-9]{40}$/iu.test(value.trim())) {
      return value.trim().toLowerCase();
    }
  }
  return undefined;
}

function inferTimestamp(record: Record<string, unknown>): string | undefined {
  for (const value of [
    record.executed_at,
    record.generated_at,
    record.completed_at,
    record.finished_at,
    record.recorded_at,
    record.created_at,
    record.updated_at
  ]) {
    if (typeof value === "string" && parseDate(value) !== undefined) {
      return value;
    }
  }
  return undefined;
}

function inferExpiresAt(record: Record<string, unknown>): string | undefined {
  const value = record.expires_at;
  return typeof value === "string" && parseDate(value) !== undefined
    ? value
    : undefined;
}

function isCatalogableJson(
  fileName: string,
  parsed: Record<string, unknown>
): boolean {
  if (fileName.toLowerCase() === "summary.json") {
    return true;
  }
  if (
    Array.isArray(parsed.results) ||
    Array.isArray(parsed.scenarios) ||
    Array.isArray(parsed.evidence)
  ) {
    return true;
  }
  return (
    readString(parsed.artifact_kind) !== undefined ||
    readString(parsed.kind) !== undefined ||
    normalizeTestId(readString(parsed.test_id) ?? readString(parsed.id)) !== undefined
  );
}

function parseCatalog(raw: string): OperationEvidenceCatalog {
  const parsed = JSON.parse(stripBom(raw)) as unknown;
  if (!isOperationEvidenceCatalog(parsed)) {
    throw new Error("Operation evidence catalog schema is invalid.");
  }
  for (const resultRoot of parsed.result_roots) {
    assertRelativeProjectPath(resultRoot.path);
  }
  for (const entry of parsed.entries) {
    assertRelativeProjectPath(entry.path);
    assertRelativeProjectPath(entry.result_root);
  }
  return parsed;
}

function isOperationEvidenceCatalog(value: unknown): value is OperationEvidenceCatalog {
  const record = asRecord(value);
  const summary = asRecord(record?.summary);
  return (
    record?.schema_version === "0.1" &&
    record.artifact_kind === catalogArtifactKind &&
    isIsoDate(record.generated_at) &&
    isCommit(record.source_commit) &&
    Number.isInteger(record.default_freshness_hours) &&
    Number(record.default_freshness_hours) > 0 &&
    Array.isArray(record.result_roots) &&
    record.result_roots.every(isOperationEvidenceCatalogRoot) &&
    Array.isArray(record.entries) &&
    record.entries.every(isOperationEvidenceCatalogEntry) &&
    summary !== undefined &&
    [
      "result_roots",
      "entries",
      "pass",
      "fail",
      "setup_required",
      "optional",
      "unknown",
      "verified",
      "stale",
      "wrong_commit",
      "protected",
      "candidates"
    ].every((key) => isNonNegativeInteger(summary[key])) &&
    typeof record.catalog_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.catalog_sha256)
  );
}

function isOperationEvidenceCatalogRoot(
  value: unknown
): value is OperationEvidenceCatalogRoot {
  const record = asRecord(value);
  return (
    typeof record?.path === "string" &&
    isNonNegativeInteger(record.entries) &&
    typeof record.protected === "boolean" &&
    typeof record.retention_candidate === "boolean" &&
    isStringArray(record.protection_reasons)
  );
}

function isOperationEvidenceCatalogEntry(
  value: unknown
): value is OperationEvidenceCatalogEntry {
  const record = asRecord(value);
  const retention = asRecord(record?.retention);
  return (
    typeof record?.evidence_id === "string" &&
    typeof record.result_root === "string" &&
    typeof record.path === "string" &&
    typeof record.artifact_kind === "string" &&
    (record.task_id === undefined || typeof record.task_id === "string") &&
    (record.test_id === undefined || typeof record.test_id === "string") &&
    (record.original_test_id === undefined ||
      typeof record.original_test_id === "string") &&
    typeof record.status === "string" &&
    supportedStatuses.has(record.status) &&
    isCommit(record.source_commit) &&
    isIsoDate(record.executed_at) &&
    isIsoDate(record.expires_at) &&
    isNonNegativeInteger(record.size_bytes) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.sha256) &&
    typeof record.integrity === "string" &&
    ["verified", "stale", "tampered", "missing", "wrong_commit"].includes(
      record.integrity
    ) &&
    isStringArray(record.supersedes) &&
    (record.superseded_by === undefined ||
      typeof record.superseded_by === "string") &&
    retention !== undefined &&
    typeof retention.disposition === "string" &&
    ["protected", "candidate", "retain"].includes(retention.disposition) &&
    isStringArray(retention.reasons)
  );
}

function assertCatalogIsSafe(
  projectRoot: string,
  catalog: OperationEvidenceCatalog,
  catalogPath: string
): void {
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const scan = scanSupportEntries([{ path: catalogPath, content: serialized }]);
  if (scan.status !== "passed") {
    throw new Error("Operation evidence catalog failed the secret scan.");
  }
  const rootCandidates = [
    path.resolve(projectRoot),
    path.resolve(projectRoot).replaceAll("\\", "/")
  ];
  if (rootCandidates.some((candidate) => serialized.includes(candidate))) {
    throw new Error("Operation evidence catalog contains an absolute project path.");
  }
}

function digestCatalog(value: Omit<OperationEvidenceCatalog, "catalog_sha256">): string {
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown;
  return sha256(Buffer.from(stableStringify(jsonValue), "utf8"));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createEvidenceId(
  projectPath: string,
  testId: string | undefined,
  artifactKind: string,
  executedAt: string
): string {
  return `EVC-${sha256(Buffer.from(
    [projectPath, testId ?? "", artifactKind, executedAt].join("\n"),
    "utf8"
  )).slice(0, 20)}`;
}

function parseJsonRecord(content: Buffer): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stripBom(content.toString("utf8"))));
  } catch {
    return undefined;
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const sanitized = sanitizeSupportText(value)
    .replace(/[^A-Za-z0-9_.:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : fallback;
}

function addProtectionReason(
  entry: OperationEvidenceCatalogEntry,
  reason: string
): void {
  entry.retention.disposition = "protected";
  entry.retention.reasons = uniqueValues([...entry.retention.reasons, reason]);
}

function dedupeEntries(
  entries: OperationEvidenceCatalogEntry[]
): OperationEvidenceCatalogEntry[] {
  const byKey = new Map<string, OperationEvidenceCatalogEntry>();
  for (const entry of entries) {
    const key = [
      entry.path,
      entry.test_id ?? "",
      entry.artifact_kind,
      entry.executed_at
    ].join("\u0000");
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function compareEntries(
  left: OperationEvidenceCatalogEntry,
  right: OperationEvidenceCatalogEntry
): number {
  return (
    left.result_root.localeCompare(right.result_root) ||
    (left.task_id ?? "").localeCompare(right.task_id ?? "") ||
    (left.test_id ?? "").localeCompare(right.test_id ?? "") ||
    left.executed_at.localeCompare(right.executed_at) ||
    left.path.localeCompare(right.path)
  );
}

function compareNewestFirst(
  left: OperationEvidenceCatalogEntry,
  right: OperationEvidenceCatalogEntry
): number {
  return (
    right.executed_at.localeCompare(left.executed_at) ||
    right.path.localeCompare(left.path)
  );
}

function findOwningResultRoot(
  projectPath: string,
  resultRoots: string[]
): string | undefined {
  return resultRoots
    .filter((resultRoot) =>
      projectPath === resultRoot || projectPath.startsWith(`${resultRoot}/`)
    )
    .sort((left, right) => right.length - left.length)[0];
}

function assertRelativeProjectPath(value: string): void {
  const normalized = toPosixPath(value);
  if (
    path.isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Catalog path escapes the project root: ${value}`);
  }
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniquePaths(values: string[]): string[] {
  return uniqueValues(
    values
      .map((value) => toPosixPath(value).replace(/^\.\/+/u, ""))
      .filter((value) => value.length > 0)
  );
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
