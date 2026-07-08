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

export type RagSourceCategory =
  | "project_rule"
  | "project_document"
  | "code"
  | "operational_state"
  | "operational_artifact";

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
  first_indexed_at: string;
  last_seen_at: string;
  last_modified_at: string;
  source_category: RagSourceCategory;
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
  last_compacted_at?: string;
  compaction?: RagCompactionSummary;
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
  explain?: RagSearchExplain;
};

export type RagSearchExplain = {
  lexical_score: number;
  matched_terms: string[];
  term_hits: Record<string, number>;
  phrase_bonus: number;
  source_last_modified_at?: string;
  source_first_indexed_at?: string;
  source_last_seen_at?: string;
  source_current_modified_at?: string;
  source_age_days?: number;
  indexed_age_days?: number;
  stale_source: boolean;
  warnings: string[];
};

export type BuildRagIndexResult = {
  schema_version: string;
  index_path: string;
  source_count: number;
  chunk_count: number;
  refresh_mode: "full" | "scoped";
  skipped_source_count: number;
  skipped_protected_count: number;
  pruned_source_count: number;
  pruned_missing_source_count: number;
  pruned_excluded_source_count: number;
  pruned_archived_source_count: number;
  pruned_ephemeral_source_count: number;
  index: RagIndex;
};

export type BuildRagIndexOptions = {
  now?: () => Date;
  since?: Date | string;
  sourceTypes?: RagSourceType[];
  limit?: number;
  prune?: boolean;
  compact?: boolean;
  maxArtifactAgeDays?: number;
};

export type CompactRagIndexOptions = {
  now?: () => Date;
  maxArtifactAgeDays?: number;
  pruneMissing?: boolean;
  pruneExcluded?: boolean;
  pruneArchived?: boolean;
  pruneEphemeral?: boolean;
};

export type RagCompactionSummary = {
  compacted_at: string;
  removed_source_count: number;
  removed_missing_source_count: number;
  removed_excluded_source_count: number;
  removed_archived_source_count: number;
  removed_ephemeral_source_count: number;
};

export type CompactRagIndexResult = RagCompactionSummary & {
  schema_version: string;
  index_path: string;
  index_exists: boolean;
  source_count: number;
  chunk_count: number;
  index?: RagIndex;
};

export type RagSearchRequest = {
  query: string;
  topK?: number;
  explain?: boolean;
  now?: () => Date;
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

export type RagIndexStatus = {
  schema_version: string;
  enabled: boolean;
  index_path: string;
  exists: boolean;
  source_count: number;
  chunk_count: number;
  index_size_bytes?: number;
  last_refresh_at?: string;
  last_compacted_at?: string;
  last_compaction_removed_sources?: number;
  skipped_source_count: number;
  skipped_protected_count: number;
  created_at?: string;
  updated_at?: string;
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

type PreparedCandidateSource = CandidateSource & {
  relativePath: string;
  updatedAt: Date;
  mtimeMs: number;
};

type PreparedCandidateSources = {
  indexable: PreparedCandidateSource[];
  skipped_source_count: number;
  skipped_protected_count: number;
};

type BuiltSource = {
  source: RagIndexSource;
  chunks: RagIndexChunk[];
};

type RagLexicalScore = {
  score: number;
  matchedTerms: string[];
  termHits: Map<string, number>;
  phraseBonus: number;
};

type PrunedSourceReason = "missing" | "excluded" | "archived" | "ephemeral";

type PrunedSource = {
  source_id: string;
  reason: PrunedSourceReason;
};

type PruneOptions = {
  now: Date;
  maxArtifactAgeDays: number;
  pruneMissing: boolean;
  pruneExcluded: boolean;
  pruneArchived: boolean;
  pruneEphemeral: boolean;
};

const maxChunkChars = 1_200;
const defaultEphemeralSourceMaxAgeDays = 30;
const internalReviewScanReplacePattern = /\b(?:secret_scan_passed)\b/giu;
const internalReviewScanTestPattern = /\b(?:secret_scan_passed)\b/iu;
const explicitSecretReferenceReplacePattern =
  /\b(?:GH_TOKEN|GITHUB_TOKEN|KAIRON_DISCORD_BOT_TOKEN)\b/gu;
const explicitSecretReferenceTestPattern =
  /\b(?:GH_TOKEN|GITHUB_TOKEN|KAIRON_DISCORD_BOT_TOKEN)\b/u;

export async function buildRagIndex(
  projectRoot: string,
  options: BuildRagIndexOptions = {}
): Promise<BuildRagIndexResult> {
  const nowDate = options.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = ragIndexPath(projectRoot, config);
  const excludePatterns = await loadExcludePatterns(projectRoot, config);
  const prepared = await prepareCandidateSources(projectRoot, config);
  const selectedCandidates = filterCandidateSources(
    prepared.indexable,
    options,
    nowDate
  );
  const scoped = isScopedRefresh(options);
  const existingIndex = await readExistingIndex(indexPath);
  const existingSources = mapExistingSourcesByIdentity(existingIndex);
  const builtSources: BuiltSource[] = [];

  for (const candidate of selectedCandidates) {
    const built = await buildIndexedSource(projectRoot, candidate, {
      now,
      existingSource: existingSources.get(
        sourceIdentity(candidate.sourceType, candidate.relativePath)
      )
    });
    if (built !== undefined) {
      builtSources.push(built);
    }
  }

  const selectedSourceKeys = new Set(
    selectedCandidates.map((candidate) =>
      sourceIdentity(candidate.sourceType, candidate.relativePath)
    )
  );
  const shouldCompact = options.prune === true || options.compact === true;
  const prunedSources =
    shouldCompact && existingIndex !== undefined
      ? await findPrunedSources(projectRoot, existingIndex, excludePatterns, {
          now: nowDate,
          maxArtifactAgeDays:
            options.maxArtifactAgeDays ?? defaultEphemeralSourceMaxAgeDays,
          pruneMissing: true,
          pruneExcluded: true,
          pruneArchived: true,
          pruneEphemeral: options.compact === true
        })
      : [];
  const prunedSourceIds = new Set(
    prunedSources.map((source) => source.source_id)
  );
  const compaction =
    shouldCompact === true ? buildCompactionSummary(now, prunedSources) : undefined;

  const merged = mergeIndexSources({
    existingIndex,
    builtSources,
    selectedSourceKeys,
    prunedSourceIds,
    scoped
  });

  const index: RagIndex = {
    schema_version: "0.1",
    kind: "rag_lexical_index",
    created_at: scoped && existingIndex !== undefined ? existingIndex.created_at : now,
    updated_at: now,
    source_count: merged.sources.length,
    chunk_count: merged.chunks.length,
    ...(compaction === undefined
      ? {}
      : {
          last_compacted_at: compaction.compacted_at,
          compaction
        }),
    sources: merged.sources,
    chunks: merged.chunks
  };

  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeJsonFileAtomic(indexPath, index);

  return {
    schema_version: "0.1",
    index_path: toProjectPath(projectRoot, indexPath),
    source_count: index.source_count,
    chunk_count: index.chunk_count,
    refresh_mode: scoped ? "scoped" : "full",
    skipped_source_count: prepared.skipped_source_count,
    skipped_protected_count: prepared.skipped_protected_count,
    pruned_source_count: prunedSourceIds.size,
    ...countPrunedSources(prunedSources),
    index
  };
}

export async function compactRagIndex(
  projectRoot: string,
  options: CompactRagIndexOptions = {}
): Promise<CompactRagIndexResult> {
  const nowDate = options.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = ragIndexPath(projectRoot, config);
  const existingIndex = await readExistingIndex(indexPath);

  if (existingIndex === undefined) {
    return {
      schema_version: "0.1",
      index_path: toProjectPath(projectRoot, indexPath),
      index_exists: false,
      source_count: 0,
      chunk_count: 0,
      ...buildCompactionSummary(now, [])
    };
  }

  const excludePatterns = await loadExcludePatterns(projectRoot, config);
  const prunedSources = await findPrunedSources(
    projectRoot,
    existingIndex,
    excludePatterns,
    {
      now: nowDate,
      maxArtifactAgeDays:
        options.maxArtifactAgeDays ?? defaultEphemeralSourceMaxAgeDays,
      pruneMissing: options.pruneMissing !== false,
      pruneExcluded: options.pruneExcluded !== false,
      pruneArchived: options.pruneArchived !== false,
      pruneEphemeral: options.pruneEphemeral !== false
    }
  );
  const prunedSourceIds = new Set(
    prunedSources.map((source) => source.source_id)
  );
  const sources = existingIndex.sources.filter(
    (source) => !prunedSourceIds.has(source.source_id)
  );
  const retainedSourceIds = new Set(sources.map((source) => source.source_id));
  const chunks = existingIndex.chunks.filter((chunk) =>
    retainedSourceIds.has(chunk.source_id)
  );
  const compaction = buildCompactionSummary(now, prunedSources);
  const index: RagIndex = {
    ...existingIndex,
    updated_at: now,
    source_count: sources.length,
    chunk_count: chunks.length,
    last_compacted_at: compaction.compacted_at,
    compaction,
    sources,
    chunks
  };

  await writeJsonFileAtomic(indexPath, index);

  return {
    schema_version: "0.1",
    index_path: toProjectPath(projectRoot, indexPath),
    index_exists: true,
    source_count: index.source_count,
    chunk_count: index.chunk_count,
    ...compaction,
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
  const sourceById = new Map(index.sources.map((source) => [source.source_id, source]));
  const now = request.now?.() ?? new Date();

  const matches = index.chunks
    .filter((chunk) => matchesSearchFilters(chunk, request.filters))
    .map((chunk) => ({ chunk, scoring: scoreChunk(chunk.text, queryTerms) }))
    .filter((entry) => entry.scoring.score > 0)
    .sort((left, right) => right.scoring.score - left.scoring.score)
    .slice(0, topK);

  return Promise.all(
    matches.map(async ({ chunk, scoring }) => {
      const result: RagSearchResult = {
        chunk_id: chunk.chunk_id,
        source_id: chunk.source_id,
        source_type: chunk.source_type,
        path: chunk.path,
        content_hash: chunk.content_hash,
        metadata: chunk.metadata,
        score: scoring.score,
        text: chunk.text
      };

      if (request.explain === true) {
        result.explain = await buildSearchExplain({
          projectRoot,
          source: sourceById.get(chunk.source_id),
          scoring,
          now
        });
      }

      return result;
    })
  );
}

export async function isRagEnabled(projectRoot: string): Promise<boolean> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  return config.enabled === true;
}

export async function getRagIndexStatus(projectRoot: string): Promise<RagIndexStatus> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = ragIndexPath(projectRoot, config);
  const prepared = await prepareCandidateSources(projectRoot, config);

  try {
    await access(indexPath);
    const indexFileStat = await stat(indexPath);
    const index = await readJsonFile<RagIndex>(indexPath);
    return {
      schema_version: "0.1",
      enabled: config.enabled === true,
      index_path: toProjectPath(projectRoot, indexPath),
      exists: true,
      source_count: index.source_count,
      chunk_count: index.chunk_count,
      index_size_bytes: indexFileStat.size,
      last_refresh_at: index.updated_at,
      last_compacted_at: index.last_compacted_at,
      last_compaction_removed_sources: index.compaction?.removed_source_count,
      skipped_source_count: prepared.skipped_source_count,
      skipped_protected_count: prepared.skipped_protected_count,
      created_at: index.created_at,
      updated_at: index.updated_at
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return {
    schema_version: "0.1",
    enabled: config.enabled === true,
    index_path: toProjectPath(projectRoot, indexPath),
    exists: false,
    source_count: 0,
    chunk_count: 0,
    skipped_source_count: prepared.skipped_source_count,
    skipped_protected_count: prepared.skipped_protected_count
  };
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

async function prepareCandidateSources(
  projectRoot: string,
  ragConfig: RagConfig
): Promise<PreparedCandidateSources> {
  const candidates = await collectCandidateSources(projectRoot);
  const excludePatterns = await loadExcludePatterns(projectRoot, ragConfig);
  const indexable: PreparedCandidateSource[] = [];
  let skippedProtectedCount = 0;

  for (const candidate of candidates) {
    const relativePath = toProjectPath(projectRoot, candidate.absolutePath);
    if (isExcludedPath(relativePath, excludePatterns)) {
      skippedProtectedCount += 1;
      continue;
    }

    const fileStat = await stat(candidate.absolutePath);
    indexable.push({
      ...candidate,
      relativePath,
      updatedAt: fileStat.mtime,
      mtimeMs: fileStat.mtimeMs
    });
  }

  indexable.sort(comparePreparedCandidates);

  return {
    indexable,
    skipped_source_count: skippedProtectedCount,
    skipped_protected_count: skippedProtectedCount
  };
}

function filterCandidateSources(
  candidates: PreparedCandidateSource[],
  options: BuildRagIndexOptions,
  now: Date
): PreparedCandidateSource[] {
  const since = normalizeSince(options.since);
  const sourceTypeSet =
    options.sourceTypes === undefined ? undefined : new Set(options.sourceTypes);
  const maxArtifactAgeDays =
    options.maxArtifactAgeDays ?? defaultEphemeralSourceMaxAgeDays;
  const filtered = candidates.filter((candidate) => {
    if (sourceTypeSet !== undefined && !sourceTypeSet.has(candidate.sourceType)) {
      return false;
    }

    if (since !== undefined && candidate.updatedAt < since) {
      return false;
    }

    if (
      options.compact === true &&
      isStaleEphemeralSource(candidate.relativePath, candidate.updatedAt, now, maxArtifactAgeDays)
    ) {
      return false;
    }

    return true;
  });

  if (options.limit === undefined) {
    return filtered;
  }

  return filtered.slice(0, options.limit);
}

async function buildIndexedSource(
  projectRoot: string,
  candidate: PreparedCandidateSource,
  context: {
    now: string;
    existingSource?: RagIndexSource;
  }
): Promise<BuiltSource | undefined> {
  const rawContent = await readFile(candidate.absolutePath, "utf8");
  const content = sanitizeIndexContent(rawContent);
  if (content.trim().length === 0) {
    return undefined;
  }
  if (
    candidate.sourceType === "failure" &&
    !isFailureMemory(content, candidate.relativePath)
  ) {
    return undefined;
  }

  const contentHash = sha256(content);
  const metadata = inferMetadata({
    sourceType: candidate.sourceType,
    relativePath: candidate.relativePath,
    content,
    updatedAt: candidate.updatedAt
  });
  const source: RagIndexSource = {
    source_id: `${candidate.sourceType}:${candidate.relativePath}:${contentHash.slice(7, 19)}`,
    source_type: candidate.sourceType,
    path: candidate.relativePath,
    content_hash: contentHash,
    bytes: Buffer.byteLength(content, "utf8"),
    updated_at: candidate.updatedAt.toISOString(),
    first_indexed_at: context.existingSource?.first_indexed_at ?? context.now,
    last_seen_at: context.now,
    last_modified_at: candidate.updatedAt.toISOString(),
    source_category: sourceCategoryForSourceType(candidate.sourceType),
    metadata
  };

  return {
    source,
    chunks: chunkContent(content).map((text, index) => ({
      chunk_id: `${source.source_id}#${index + 1}`,
      source_id: source.source_id,
      source_type: source.source_type,
      path: source.path,
      content_hash: source.content_hash,
      metadata: source.metadata,
      text
    }))
  };
}

function mergeIndexSources(input: {
  existingIndex: RagIndex | undefined;
  builtSources: BuiltSource[];
  selectedSourceKeys: Set<string>;
  prunedSourceIds: Set<string>;
  scoped: boolean;
}): { sources: RagIndexSource[]; chunks: RagIndexChunk[] } {
  if (!input.scoped || input.existingIndex === undefined) {
    return sortIndexParts({
      sources: input.builtSources.map((item) => item.source),
      chunks: input.builtSources.flatMap((item) => item.chunks)
    });
  }

  const retainedSources = input.existingIndex.sources.filter(
    (source) =>
      !input.prunedSourceIds.has(source.source_id) &&
      !input.selectedSourceKeys.has(sourceIdentity(source.source_type, source.path))
  );
  const retainedSourceIds = new Set(
    retainedSources.map((source) => source.source_id)
  );
  const sources = [
    ...retainedSources,
    ...input.builtSources.map((item) => item.source)
  ];
  const chunks = [
    ...input.existingIndex.chunks.filter((chunk) =>
      retainedSourceIds.has(chunk.source_id)
    ),
    ...input.builtSources.flatMap((item) => item.chunks)
  ];

  return sortIndexParts({ sources, chunks });
}

function sortIndexParts(input: {
  sources: RagIndexSource[];
  chunks: RagIndexChunk[];
}): { sources: RagIndexSource[]; chunks: RagIndexChunk[] } {
  return {
    sources: [...input.sources].sort(compareSources),
    chunks: [...input.chunks].sort(compareChunks)
  };
}

function mapExistingSourcesByIdentity(
  index: RagIndex | undefined
): Map<string, RagIndexSource> {
  const output = new Map<string, RagIndexSource>();
  if (index === undefined) {
    return output;
  }

  for (const source of index.sources) {
    output.set(sourceIdentity(source.source_type, source.path), source);
  }

  return output;
}

async function readExistingIndex(indexPath: string): Promise<RagIndex | undefined> {
  try {
    await access(indexPath);
    return readJsonFile<RagIndex>(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function buildCompactionSummary(
  compactedAt: string,
  prunedSources: PrunedSource[]
): RagCompactionSummary {
  return {
    compacted_at: compactedAt,
    removed_source_count: prunedSources.length,
    ...countRemovedSources(prunedSources)
  };
}

function countPrunedSources(prunedSources: PrunedSource[]): Pick<
  BuildRagIndexResult,
  | "pruned_missing_source_count"
  | "pruned_excluded_source_count"
  | "pruned_archived_source_count"
  | "pruned_ephemeral_source_count"
> {
  const counts = countRemovedSources(prunedSources);
  return {
    pruned_missing_source_count: counts.removed_missing_source_count,
    pruned_excluded_source_count: counts.removed_excluded_source_count,
    pruned_archived_source_count: counts.removed_archived_source_count,
    pruned_ephemeral_source_count: counts.removed_ephemeral_source_count
  };
}

function countRemovedSources(prunedSources: PrunedSource[]): Omit<
  RagCompactionSummary,
  "compacted_at" | "removed_source_count"
> {
  return {
    removed_missing_source_count: prunedSources.filter(
      (source) => source.reason === "missing"
    ).length,
    removed_excluded_source_count: prunedSources.filter(
      (source) => source.reason === "excluded"
    ).length,
    removed_archived_source_count: prunedSources.filter(
      (source) => source.reason === "archived"
    ).length,
    removed_ephemeral_source_count: prunedSources.filter(
      (source) => source.reason === "ephemeral"
    ).length
  };
}

function sourceDate(source: RagIndexSource): Date {
  const parsed = new Date(source.last_modified_at ?? source.updated_at);
  return Number.isNaN(parsed.getTime()) ? new Date(source.updated_at) : parsed;
}

async function findPrunedSources(
  projectRoot: string,
  index: RagIndex,
  excludePatterns: string[],
  options: PruneOptions
): Promise<PrunedSource[]> {
  const pruned: PrunedSource[] = [];
  for (const source of index.sources) {
    const reason = await findPrunedSourceReason(
      projectRoot,
      source,
      excludePatterns,
      options
    );
    if (reason !== undefined) {
      pruned.push({ source_id: source.source_id, reason });
    }
  }

  return pruned;
}

async function findPrunedSourceReason(
  projectRoot: string,
  source: RagIndexSource,
  excludePatterns: string[],
  options: PruneOptions
): Promise<PrunedSourceReason | undefined> {
  if (options.pruneArchived && isArchivedCleanupArtifact(source.path)) {
    return "archived";
  }

  if (options.pruneExcluded && isExcludedPath(source.path, excludePatterns)) {
    return "excluded";
  }

  if (
    options.pruneMissing &&
    !(await exists(resolveInside(projectRoot, source.path)))
  ) {
    return "missing";
  }

  if (
    options.pruneEphemeral &&
    isStaleEphemeralSource(
      source.path,
      sourceDate(source),
      options.now,
      options.maxArtifactAgeDays
    )
  ) {
    return "ephemeral";
  }

  return undefined;
}

function isScopedRefresh(options: BuildRagIndexOptions): boolean {
  return (
    options.since !== undefined ||
    options.sourceTypes !== undefined ||
    options.limit !== undefined
  );
}

function normalizeSince(value: Date | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid RAG since timestamp: ${String(value)}`);
  }

  return parsed;
}

function sourceIdentity(sourceType: RagSourceType, relativePath: string): string {
  return `${sourceType}:${toPosixPath(relativePath).toLowerCase()}`;
}

function comparePreparedCandidates(
  left: PreparedCandidateSource,
  right: PreparedCandidateSource
): number {
  return (
    right.mtimeMs - left.mtimeMs ||
    left.sourceType.localeCompare(right.sourceType) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function compareSources(left: RagIndexSource, right: RagIndexSource): number {
  return (
    left.source_type.localeCompare(right.source_type) ||
    left.path.localeCompare(right.path) ||
    left.source_id.localeCompare(right.source_id)
  );
}

function compareChunks(left: RagIndexChunk, right: RagIndexChunk): number {
  return left.chunk_id.localeCompare(right.chunk_id);
}

function isArchivedCleanupArtifact(relativePath: string): boolean {
  return toPosixPath(relativePath).startsWith(".kairon/cleanup/archived/");
}

function isStaleEphemeralSource(
  relativePath: string,
  sourceUpdatedAt: Date,
  now: Date,
  maxArtifactAgeDays: number
): boolean {
  if (!isEphemeralSourcePath(relativePath)) {
    return false;
  }

  const maxAgeMs = maxArtifactAgeDays * 24 * 60 * 60 * 1000;
  return now.getTime() - sourceUpdatedAt.getTime() > maxAgeMs;
}

function isEphemeralSourcePath(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  return (
    normalized.startsWith(".kairon/runs/") ||
    normalized.startsWith(".kairon/sessions/")
  );
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

function scoreChunk(text: string, queryTerms: string[]): RagLexicalScore {
  const chunkTerms = tokenize(text);
  const termCounts = new Map<string, number>();
  for (const term of chunkTerms) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
  }

  let score = 0;
  const uniqueQueryTerms = [...new Set(queryTerms)];
  const termHits = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    const count = termCounts.get(term) ?? 0;
    if (count > 0) {
      termHits.set(term, count);
      score += count;
    }
  }

  const normalizedText = text.toLowerCase();
  let phraseBonus = 0;
  for (const term of uniqueQueryTerms) {
    if (term.length >= 4 && normalizedText.includes(term)) {
      phraseBonus += 0.5;
    }
  }

  return {
    score: score + phraseBonus,
    matchedTerms: [...termHits.keys()],
    termHits,
    phraseBonus
  };
}

async function buildSearchExplain(input: {
  projectRoot: string;
  source: RagIndexSource | undefined;
  scoring: RagLexicalScore;
  now: Date;
}): Promise<RagSearchExplain> {
  const warnings: string[] = [];
  let sourceCurrentModifiedAt: string | undefined;
  let staleSource = false;

  if (input.source === undefined) {
    warnings.push("source_metadata_missing");
  } else {
    try {
      const sourceStat = await stat(resolveInside(input.projectRoot, input.source.path));
      sourceCurrentModifiedAt = sourceStat.mtime.toISOString();
      const indexedModifiedAt = parseDate(input.source.last_modified_at);
      if (
        indexedModifiedAt !== undefined &&
        sourceStat.mtime.getTime() - indexedModifiedAt.getTime() > 1000
      ) {
        staleSource = true;
        warnings.push("source_modified_after_index");
      }
    } catch (error) {
      staleSource = true;
      warnings.push(
        String(error).includes("ENOENT")
          ? "source_missing_after_index"
          : "source_freshness_unavailable"
      );
    }
  }

  return {
    lexical_score: input.scoring.score,
    matched_terms: input.scoring.matchedTerms,
    term_hits: mapToSortedRecord(input.scoring.termHits),
    phrase_bonus: input.scoring.phraseBonus,
    source_last_modified_at: input.source?.last_modified_at,
    source_first_indexed_at: input.source?.first_indexed_at,
    source_last_seen_at: input.source?.last_seen_at,
    source_current_modified_at: sourceCurrentModifiedAt,
    source_age_days: ageDays(input.source?.last_modified_at, input.now),
    indexed_age_days: ageDays(input.source?.last_seen_at, input.now),
    stale_source: staleSource,
    warnings
  };
}

function mapToSortedRecord(values: Map<string, number>): Record<string, number> {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<Record<string, number>>((record, [key, value]) => {
      record[key] = value;
      return record;
    }, {});
}

function ageDays(isoDate: string | undefined, now: Date): number | undefined {
  const date = parseDate(isoDate);
  if (date === undefined) {
    return undefined;
  }

  const days = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
  return Number(days.toFixed(2));
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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

function sourceCategoryForSourceType(sourceType: RagSourceType): RagSourceCategory {
  switch (sourceType) {
    case "rule":
      return "project_rule";
    case "document":
      return "project_document";
    case "code_index":
      return "code";
    case "failure":
      return "operational_artifact";
    case "task_state":
    case "handoff":
    case "decision":
    case "review":
    case "approval":
    case "daily_report":
      return "operational_state";
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
  const parsed = parseJsonObject(content);
  if (parsed !== undefined) {
    const sanitized = sanitizeJsonValue(parsed);
    return sanitized === undefined ? "" : JSON.stringify(sanitized);
  }

  const lines = content.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const parsedLines = nonEmptyLines.map((line) => parseJsonObject(line));
  if (
    nonEmptyLines.length > 0 &&
    parsedLines.every((line) => line !== undefined)
  ) {
    return parsedLines
      .map((line) => sanitizeJsonValue(line))
      .filter((line) => line !== undefined)
      .map((line) => JSON.stringify(line))
      .join("\n");
  }

  return sanitizeTextContent(content);
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isSensitiveKey(key))
        .map(([key, item]) => [key, sanitizeJsonValue(item)])
        .filter(([, item]) => item !== undefined)
    );
  }

  if (typeof value === "string" && isSensitiveString(value)) {
    return undefined;
  }

  return value;
}

function sanitizeTextContent(content: string): string {
  return content
    .replace(internalReviewScanReplacePattern, "[removed]")
    .replace(explicitSecretReferenceReplacePattern, "[removed]")
    .replace(
      /"[^"]*(?:api[_-]?key|token|secret|password|authorization|credential|cookie)[^"]*"\s*:\s*(?:"[^"]*"|true|false|null|-?\d+(?:\.\d+)?)/giu,
      "[removed]"
    )
    .replace(
      /\b[\w.-]*(?:api[_-]?key|token|secret|password|authorization|credential|cookie)[\w.-]*\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"',}]+)/giu,
      "[removed]"
    )
    .replace(
      /\bSHOULD_(?:NOT|BE)_[A-Z0-9_]+\b/gu,
      "[removed]"
    );
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|authorization|credential|cookie/iu.test(
    key
  );
}

function isSensitiveString(value: string): boolean {
  return (
    /\bSHOULD_(?:NOT|BE)_[A-Z0-9_]+\b/u.test(value) ||
    internalReviewScanTestPattern.test(value) ||
    explicitSecretReferenceTestPattern.test(value) ||
    /\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]/iu.test(
      value
    )
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
