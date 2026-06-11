import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type RagSourceType =
  | "rule"
  | "task_state"
  | "handoff"
  | "document"
  | "decision"
  | "review"
  | "approval"
  | "failure"
  | "daily_report"
  | "code_index";

export type RagCollection =
  | "project_rules"
  | "task_state"
  | "code_index"
  | "decisions"
  | "reviews"
  | "approvals"
  | "failures"
  | "daily_reports"
  | "documents";

export type RagChunkMetadata = {
  collection: RagCollection;
  source_type: RagSourceType;
  task_id?: string;
  run_id?: string;
  approval_id?: string;
  review_id?: string;
  review_loop_id?: string;
  recovery_id?: string;
  severity?: string;
  status?: string;
  date?: string;
  agent?: string;
  persona?: string;
};

export type RagIndexSource = {
  source_id: string;
  source_type: RagSourceType;
  path: string;
  content_hash: string;
  bytes: number;
  updated_at: string;
  metadata: RagChunkMetadata;
};

export type RagIndexChunk = {
  chunk_id: string;
  source_id: string;
  source_type: RagSourceType;
  path: string;
  content_hash: string;
  metadata: RagChunkMetadata;
  text: string;
};

export type RagIndex = {
  schema_version: string;
  kind: "rag_lexical_index";
  created_at: string;
  updated_at: string;
  source_count: number;
  chunk_count: number;
  sources: RagIndexSource[];
  chunks: RagIndexChunk[];
};

export type RagSearchResult = {
  chunk_id: string;
  source_id: string;
  source_type: RagSourceType;
  path: string;
  content_hash: string;
  metadata: RagChunkMetadata;
  score: number;
  text: string;
};

export type BuildRagIndexResult = {
  schema_version: string;
  index_path: string;
  source_count: number;
  chunk_count: number;
  index: RagIndex;
};

export type RagSearchRequest = {
  query: string;
  topK?: number;
  filters?: {
    source_types?: RagSourceType[];
    collections?: RagCollection[];
    task_id?: string;
    run_id?: string;
    approval_id?: string;
    review_id?: string;
    review_loop_id?: string;
    severity?: string;
    date?: string;
  };
};

type RagConfig = {
  enabled?: boolean;
  storage?: {
    base_dir?: string;
  };
  security?: {
    exclude_paths?: string[];
  };
};

type ProjectConfig = {
  paths?: {
    protected?: string[];
  };
};

type PoliciesConfig = {
  security?: {
    protected_paths?: string[];
  };
};

type CandidateSource = {
  sourceType: RagSourceType;
  absolutePath: string;
};

const maxChunkChars = 1_200;

export async function buildRagIndex(
  projectRoot: string,
  options: { now?: () => Date } = {}
): Promise<BuildRagIndexResult> {
  const now = (options.now?.() ?? new Date()).toISOString();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = ragIndexPath(projectRoot, config);
  const candidates = await collectCandidateSources(projectRoot);
  const excludePatterns = await loadExcludePatterns(projectRoot, config);
  const sources: RagIndexSource[] = [];
  const chunks: RagIndexChunk[] = [];

  for (const candidate of candidates) {
    const relativePath = toProjectPath(projectRoot, candidate.absolutePath);
    if (isExcludedPath(relativePath, excludePatterns)) {
      continue;
    }

    const rawContent = await readFile(candidate.absolutePath, "utf8");
    const content = sanitizeIndexContent(rawContent);
    if (content.trim().length === 0) {
      continue;
    }
    if (candidate.sourceType === "failure" && !isFailureMemory(content, relativePath)) {
      continue;
    }

    const contentHash = sha256(content);
    const fileStat = await stat(candidate.absolutePath);
    const metadata = inferMetadata({
      sourceType: candidate.sourceType,
      relativePath,
      content,
      updatedAt: fileStat.mtime
    });
    const source: RagIndexSource = {
      source_id: `${candidate.sourceType}:${relativePath}:${contentHash.slice(7, 19)}`,
      source_type: candidate.sourceType,
      path: relativePath,
      content_hash: contentHash,
      bytes: Buffer.byteLength(content, "utf8"),
      updated_at: fileStat.mtime.toISOString(),
      metadata
    };
    sources.push(source);

    chunks.push(
      ...chunkContent(content).map((text, index) => ({
        chunk_id: `${source.source_id}#${index + 1}`,
        source_id: source.source_id,
        source_type: source.source_type,
        path: source.path,
        content_hash: source.content_hash,
        metadata: source.metadata,
        text
      }))
    );
  }

  const index: RagIndex = {
    schema_version: "0.1",
    kind: "rag_lexical_index",
    created_at: now,
    updated_at: now,
    source_count: sources.length,
    chunk_count: chunks.length,
    sources,
    chunks
  };

  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeJsonFileAtomic(indexPath, index);

  return {
    schema_version: "0.1",
    index_path: toProjectPath(projectRoot, indexPath),
    source_count: sources.length,
    chunk_count: chunks.length,
    index
  };
}

export async function searchRagIndex(
  projectRoot: string,
  request: RagSearchRequest
): Promise<RagSearchResult[]> {
  const queryTerms = tokenize(request.query);
  if (queryTerms.length === 0) {
    return [];
  }

  const index = await loadOrBuildIndex(projectRoot);
  const topK = request.topK ?? 5;

  return index.chunks
    .filter((chunk) => matchesSearchFilters(chunk, request.filters))
    .map((chunk) => ({ chunk, score: scoreChunk(chunk.text, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({
      chunk_id: chunk.chunk_id,
      source_id: chunk.source_id,
      source_type: chunk.source_type,
      path: chunk.path,
      content_hash: chunk.content_hash,
      metadata: chunk.metadata,
      score,
      text: chunk.text
    }));
}

export async function isRagEnabled(projectRoot: string): Promise<boolean> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  return config.enabled === true;
}

async function loadOrBuildIndex(projectRoot: string): Promise<RagIndex> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = ragIndexPath(projectRoot, config);

  try {
    await access(indexPath);
    return readJsonFile<RagIndex>(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return (await buildRagIndex(projectRoot)).index;
}

async function collectCandidateSources(
  projectRoot: string
): Promise<CandidateSource[]> {
  const candidates: CandidateSource[] = [];

  for (const relativePath of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
    const absolutePath = resolveInside(projectRoot, relativePath);
    if (await exists(absolutePath)) {
      candidates.push({ sourceType: "rule", absolutePath });
    }
  }

  candidates.push(
    ...(await collectFiles(projectRoot, ".kairon/rules", "rule", (filePath) =>
      filePath.endsWith(".md")
    )),
    ...(await collectFiles(projectRoot, ".kairon/tasks", "task_state", (filePath) =>
      filePath.endsWith(".json")
    )),
    ...(await collectFiles(projectRoot, ".kairon/messages", "task_state", (filePath) =>
      filePath.endsWith(".jsonl")
    )),
    ...(await collectFiles(projectRoot, ".kairon/events", "decision", (filePath) =>
      filePath.endsWith(".jsonl")
    )),
    ...(await collectFiles(projectRoot, ".kairon/approvals", "approval", (filePath) =>
      filePath.endsWith(".json")
    )),
    ...(await collectFiles(projectRoot, ".kairon/reviews/loops", "review", (filePath) =>
      filePath.endsWith(".json")
    )),
    ...(await collectFiles(
      projectRoot,
      ".kairon/reviews/results",
      "review",
      (filePath) => filePath.endsWith(".json")
    )),
    ...(await collectFiles(projectRoot, ".kairon/runs", "failure", (filePath) =>
      /\/(runner|outbox)\.json$/.test(filePath)
    )),
    ...(await collectFiles(projectRoot, ".kairon/recovery", "failure", (filePath) =>
      filePath.endsWith(".json")
    )),
    ...(await collectFiles(
      projectRoot,
      ".kairon/reports/daily",
      "daily_report",
      (filePath) => filePath.endsWith(".json")
    )),
    ...(await collectFiles(projectRoot, ".kairon/sessions", "handoff", (filePath) =>
      /(^|\/)handoff\.(json|md)$/.test(filePath)
    )),
    ...(await collectFiles(projectRoot, "src", "code_index", (filePath) =>
      /\.(cjs|js|mjs|ts|tsx)$/.test(filePath)
    )),
    ...(await collectFiles(projectRoot, "docs", "document", (filePath) =>
      filePath.endsWith(".md")
    )),
    ...(await collectFiles(projectRoot, "Doc", "document", (filePath) =>
      filePath.endsWith(".md")
    ))
  );

  return dedupeCandidates(candidates);
}

async function collectFiles(
  projectRoot: string,
  relativeDir: string,
  sourceType: RagSourceType,
  include: (relativePath: string) => boolean
): Promise<CandidateSource[]> {
  const absoluteDir = resolveInside(projectRoot, relativeDir);
  if (!(await exists(absoluteDir))) {
    return [];
  }

  const output: CandidateSource[] = [];
  for (const absolutePath of await walkFiles(absoluteDir)) {
    const relativePath = toProjectPath(projectRoot, absolutePath);
    if (include(relativePath)) {
      output.push({ sourceType, absolutePath });
    }
  }

  return output;
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function dedupeCandidates(candidates: CandidateSource[]): CandidateSource[] {
  const seen = new Set<string>();
  const output: CandidateSource[] = [];

  for (const candidate of candidates) {
    const key = candidate.absolutePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(candidate);
  }

  return output;
}

async function loadExcludePatterns(
  projectRoot: string,
  ragConfig: RagConfig
): Promise<string[]> {
  const project = await loadConfigFile<ProjectConfig>(projectRoot, "project.json");
  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  return [
    ...(ragConfig.security?.exclude_paths ?? []),
    ...(project.paths?.protected ?? []),
    ...(policies.security?.protected_paths ?? [])
  ];
}

function chunkContent(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChunkChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";

  for (const part of normalized.split(/\n{2,}/)) {
    if (part.length > maxChunkChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...splitLongText(part));
      continue;
    }

    const next = current.length === 0 ? part : `${current}\n\n${part}`;
    if (next.length > maxChunkChars) {
      chunks.push(current.trim());
      current = part;
      continue;
    }

    current = next;
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function splitLongText(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxChunkChars) {
    chunks.push(text.slice(start, start + maxChunkChars).trim());
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function scoreChunk(text: string, queryTerms: string[]): number {
  const chunkTerms = tokenize(text);
  const termCounts = new Map<string, number>();
  for (const term of chunkTerms) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    score += termCounts.get(term) ?? 0;
  }

  const normalizedText = text.toLowerCase();
  const uniqueQueryTerms = [...new Set(queryTerms)];
  for (const term of uniqueQueryTerms) {
    if (term.length >= 4 && normalizedText.includes(term)) {
      score += 0.5;
    }
  }

  return score;
}

function matchesSearchFilters(
  chunk: RagIndexChunk,
  filters: RagSearchRequest["filters"] | undefined
): boolean {
  if (filters === undefined) {
    return true;
  }

  const metadata = chunk.metadata;
  return (
    (filters.source_types === undefined ||
      filters.source_types.includes(chunk.source_type)) &&
    (filters.collections === undefined ||
      filters.collections.includes(metadata.collection)) &&
    (filters.task_id === undefined || metadata.task_id === filters.task_id) &&
    (filters.run_id === undefined || metadata.run_id === filters.run_id) &&
    (filters.approval_id === undefined ||
      metadata.approval_id === filters.approval_id) &&
    (filters.review_id === undefined || metadata.review_id === filters.review_id) &&
    (filters.review_loop_id === undefined ||
      metadata.review_loop_id === filters.review_loop_id) &&
    (filters.severity === undefined || metadata.severity === filters.severity) &&
    (filters.date === undefined || metadata.date === filters.date)
  );
}

function tokenize(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)]
    .map((match) => match[0])
    .filter((term) => term.length > 1);
}

function isExcludedPath(relativePath: string, patterns: string[]): boolean {
  const normalized = toPosixPath(relativePath).toLowerCase();
  const baseName = path.posix.basename(normalized);

  if (baseName.startsWith(".env")) {
    return true;
  }

  if (
    normalized.endsWith(".pem") ||
    normalized.includes("secret") ||
    normalized.includes("token")
  ) {
    return true;
  }

  return patterns.some((pattern) => matchesPattern(normalized, pattern.toLowerCase()));
}

function inferMetadata(input: {
  sourceType: RagSourceType;
  relativePath: string;
  content: string;
  updatedAt: Date;
}): RagChunkMetadata {
  const parsed = parseJsonObject(input.content);
  const content = input.content;
  const pathDate = extractDate(input.relativePath);
  const metadata: RagChunkMetadata = {
    collection: collectionForSourceType(input.sourceType),
    source_type: input.sourceType,
    task_id:
      firstString(parsed, ["task_id", "taskId"]) ??
      (input.sourceType === "task_state"
        ? firstMatchingString(parsed, ["id"], /^TASK-\d+$/)
        : undefined) ??
      matchId(content, /TASK-\d+/),
    run_id: firstString(parsed, ["run_id", "runId"]) ?? matchId(content, /RUN-\d+/),
    approval_id:
      firstString(parsed, ["approval_id", "approvalId"]) ??
      (input.sourceType === "approval"
        ? firstMatchingString(parsed, ["id"], /^APR-[A-Z0-9-]+$/)
        : undefined) ??
      matchId(content, /APR-[A-Z0-9-]+/),
    review_id:
      firstString(parsed, ["review_id", "reviewId"]) ??
      (input.sourceType === "review"
        ? firstMatchingString(parsed, ["id"], /^REV-[A-Z0-9-]+$/)
        : undefined) ??
      matchId(content, /REV-[A-Z0-9-]+/),
    review_loop_id:
      firstString(parsed, ["loop_id", "review_loop_id", "reviewLoopId"]) ??
      matchId(content, /REV-\d+/),
    recovery_id:
      firstString(parsed, ["recovery_id", "recoveryId"]) ??
      (input.sourceType === "failure"
        ? firstMatchingString(parsed, ["id"], /^REC-[A-Z0-9-]+$/)
        : undefined) ??
      matchId(content, /REC-[A-Z0-9-]+/),
    severity: highestSeverity(parsed) ?? matchSeverity(content),
    status: firstString(parsed, ["status", "decision", "action"]),
    date:
      dateFromString(
        firstString(parsed, [
          "created_at",
          "updated_at",
          "decided_at",
          "finished_at",
          "date"
        ])
      ) ??
      pathDate ??
      input.updatedAt.toISOString().slice(0, 10),
    agent: firstString(parsed, ["agent", "implementer", "reviewer"]),
    persona: firstString(parsed, ["persona"])
  };

  return compactMetadata(metadata);
}

function collectionForSourceType(sourceType: RagSourceType): RagCollection {
  switch (sourceType) {
    case "rule":
      return "project_rules";
    case "task_state":
    case "handoff":
      return "task_state";
    case "code_index":
      return "code_index";
    case "decision":
      return "decisions";
    case "review":
      return "reviews";
    case "approval":
      return "approvals";
    case "failure":
      return "failures";
    case "daily_report":
      return "daily_reports";
    case "document":
      return "documents";
  }
}

function compactMetadata(metadata: RagChunkMetadata): RagChunkMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined && value !== "")
  ) as RagChunkMetadata;
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  for (const candidate of Object.values(record)) {
    const found = firstString(candidate, keys);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function firstMatchingString(
  value: unknown,
  keys: string[],
  pattern: RegExp
): string | undefined {
  const candidate = firstString(value, keys);
  return candidate !== undefined && pattern.test(candidate) ? candidate : undefined;
}

function highestSeverity(value: unknown): string | undefined {
  const rank = new Map([
    ["critical", 5],
    ["high", 4],
    ["medium", 3],
    ["low", 2],
    ["info", 1]
  ]);
  const severities = collectStrings(value, "severity")
    .map((severity) => severity.toLowerCase())
    .filter((severity) => rank.has(severity));

  return severities.sort((left, right) => rank.get(right)! - rank.get(left)!)[0];
}

function collectStrings(value: unknown, key: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, key));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const direct = typeof record[key] === "string" ? [record[key] as string] : [];
  return [...direct, ...Object.values(record).flatMap((item) => collectStrings(item, key))];
}

function matchId(content: string, pattern: RegExp): string | undefined {
  return content.match(pattern)?.[0];
}

function matchSeverity(content: string): string | undefined {
  return content.match(/\b(critical|high|medium|low|info)\b/i)?.[0].toLowerCase();
}

function extractDate(value: string): string | undefined {
  return value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}

function dateFromString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : extractDate(value);
}

function sanitizeIndexContent(content: string): string {
  return content
    .replace(
      /"([^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"[^"]*"/giu,
      (_match, key: string) => `"${key}":"[redacted]"`
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    );
}

function isFailureMemory(content: string, relativePath: string): boolean {
  if (relativePath.startsWith(".kairon/recovery/")) {
    return true;
  }

  const parsed = parseJsonObject(content);
  const status = firstString(parsed, ["status", "last_run_status"])?.toLowerCase();
  if (
    status !== undefined &&
    [
      "failed",
      "setup_required",
      "permission_required",
      "rate_limited",
      "usage_limited",
      "timeout"
    ].includes(status)
  ) {
    return true;
  }

  return /\b(error|failure_reason|failed|setup_required|rate_limited|usage_limited)\b/i.test(
    content
  );
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosixPath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    return relativePath.startsWith(normalizedPattern.slice(0, -3));
  }

  if (normalizedPattern.startsWith("**/*")) {
    return relativePath.includes(normalizedPattern.slice(4));
  }

  if (!normalizedPattern.includes("*")) {
    return relativePath === normalizedPattern;
  }

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__KAIRON_GLOBSTAR__")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped.replace(/__KAIRON_GLOBSTAR__/g, ".*")}$`).test(
    relativePath
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function ragIndexPath(projectRoot: string, config: RagConfig): string {
  const baseDir = config.storage?.base_dir ?? ".kairon/rag";
  return resolveInside(projectRoot, baseDir, "index.json");
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(getKaironPaths(projectRoot).root, filePath));
}
