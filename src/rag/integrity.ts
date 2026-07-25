import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import { withResourceLock, writeJsonFileFenced } from "../core/fs/resource-lock.js";
import {
  buildRagIndex,
  searchRagIndexData,
  type RagIndex
} from "./lexical-index.js";
import {
  calculateRagChunkTextChecksum,
  calculateRagIndexChecksum,
  calculateRagSourceManifestChecksum
} from "./manifest.js";
import { inspectRagVectorIntegrity } from "./vector-provider.js";

export type RagIntegrityStatus = "PASS" | "UNPASSED" | "SETUP_REQUIRED";

export type RagIntegrityIssueCode =
  | "index_unreadable"
  | "manifest_missing"
  | "index_checksum_mismatch"
  | "source_manifest_checksum_mismatch"
  | "source_count_mismatch"
  | "chunk_count_mismatch"
  | "duplicate_source_id"
  | "duplicate_chunk_id"
  | "orphan_chunk"
  | "source_without_chunks"
  | "chunk_source_hash_mismatch"
  | "source_drift"
  | "vector_manifest_unreadable"
  | "vector_index_unreadable"
  | "vector_dimension_mismatch"
  | "vector_index_checksum_mismatch"
  | "vector_source_manifest_mismatch"
  | "vector_lexical_index_mismatch"
  | "vector_entry_count_mismatch"
  | "vector_chunk_mismatch";

export type RagIntegrityIssue = {
  code: RagIntegrityIssueCode;
  member_id?: string;
  path?: string;
};

export type RagIntegrityArtifact = {
  schema_version: "0.1";
  artifact_kind: "rag_integrity";
  status: RagIntegrityStatus;
  index_path: string;
  index_checksum?: string;
  source_manifest_checksum?: string;
  source_count: number;
  chunk_count: number;
  issue_count: number;
  issues: RagIntegrityIssue[];
  checked_at: string;
};

export type RagStats = {
  schema_version: "0.1";
  index_path: string;
  exists: boolean;
  source_count: number;
  chunk_count: number;
  duplicate_chunk_count: number;
  duplicate_ratio: number;
  total_characters: number;
  estimated_total_tokens: number;
  largest_chunk_estimated_tokens: number;
  context_budget_tokens: number;
  chunks_exceeding_context_budget: number;
  rebuild_interval_days: number;
  rebuild_due: boolean;
  retention_candidate_count: number;
  checked_at: string;
};

export type RagRebuildQueryComparison = {
  query: string;
  current_matches: number;
  candidate_matches: number;
  current_top_path?: string;
  candidate_top_path?: string;
  regression: boolean;
};

export type RagRebuildArtifact = {
  schema_version: "0.1";
  artifact_kind: "rag_rebuild";
  rebuild_id: string;
  status: "ready" | "blocked" | "executed";
  index_path: string;
  current: {
    exists: boolean;
    checksum?: string;
    source_count: number;
    chunk_count: number;
  };
  candidate: {
    checksum: string;
    source_manifest_checksum: string;
    source_count: number;
    chunk_count: number;
  };
  comparison: {
    status: "passed" | "failed";
    source_delta: number;
    chunk_delta: number;
    query_samples: RagRebuildQueryComparison[];
    reasons: string[];
  };
  created_at: string;
  executed_at?: string;
};

export type PlanRagRebuildOptions = {
  now?: Date;
  rebuildId?: string;
};

export type ExecuteRagRebuildOptions = {
  confirm: string;
  now?: Date;
};

type RagConfig = {
  storage?: { base_dir?: string };
  integrity?: {
    query_samples?: string[];
    context_budget_tokens?: number;
    max_duplicate_ratio?: number;
  };
  rebuild?: {
    interval_days?: number;
    retention_days?: number;
    max_artifacts?: number;
  };
};

const defaultQuerySamples = ["approval routing", "runtime recovery", "review findings"];
const defaultContextBudgetTokens = 12_000;
const defaultRebuildIntervalDays = 30;
const defaultRetentionDays = 90;
const defaultMaxArtifacts = 20;
const rebuildIdPattern = /^RAG-REBUILD-\d{8}T\d{9}Z$/u;

export async function verifyRagIndex(
  projectRoot: string,
  options: { now?: Date; writeArtifact?: boolean } = {}
): Promise<RagIntegrityArtifact> {
  const now = options.now ?? new Date();
  const indexPath = await resolveRagIndexPath(projectRoot);
  let artifact: RagIntegrityArtifact;

  try {
    const index = await readJsonFile<RagIndex>(indexPath);
    artifact = await inspectRagIndex(projectRoot, index, {
      now,
      indexPath,
      checkSourceDrift: true
    });
    const vectorIssues = await inspectRagVectorIntegrity(projectRoot, index);
    if (vectorIssues.length > 0) {
      artifact = {
        ...artifact,
        status: "UNPASSED",
        issue_count: artifact.issue_count + vectorIssues.length,
        issues: [
          ...artifact.issues,
          ...vectorIssues.map((code) => ({ code }))
        ]
      };
    }
  } catch (error) {
    const missing = isMissing(error);
    artifact = {
      schema_version: "0.1",
      artifact_kind: "rag_integrity",
      status: missing ? "SETUP_REQUIRED" : "UNPASSED",
      index_path: toProjectPath(projectRoot, indexPath),
      source_count: 0,
      chunk_count: 0,
      issue_count: missing ? 0 : 1,
      issues: missing ? [] : [{ code: "index_unreadable" }],
      checked_at: now.toISOString()
    };
  }

  if (options.writeArtifact !== false) {
    await writeJsonFileAtomic(ragIntegrityPath(projectRoot), artifact);
  }
  return artifact;
}

export async function inspectRagIndex(
  projectRoot: string,
  index: RagIndex,
  options: {
    now?: Date;
    indexPath?: string;
    checkSourceDrift?: boolean;
  } = {}
): Promise<RagIntegrityArtifact> {
  const now = options.now ?? new Date();
  const indexPath = options.indexPath ?? (await resolveRagIndexPath(projectRoot));
  const issues: RagIntegrityIssue[] = [];
  const sourceIds = new Set<string>();
  const chunkIds = new Set<string>();
  const chunksBySource = new Map<string, number>();

  if (index.source_count !== index.sources.length) {
    issues.push({ code: "source_count_mismatch" });
  }
  if (index.chunk_count !== index.chunks.length) {
    issues.push({ code: "chunk_count_mismatch" });
  }

  for (const source of index.sources) {
    if (sourceIds.has(source.source_id)) {
      issues.push({ code: "duplicate_source_id", member_id: source.source_id });
    }
    sourceIds.add(source.source_id);
    if (options.checkSourceDrift === true && (await sourceHasDrifted(projectRoot, source))) {
      issues.push({ code: "source_drift", member_id: source.source_id, path: source.path });
    }
  }
  for (const chunk of index.chunks) {
    if (chunkIds.has(chunk.chunk_id)) {
      issues.push({ code: "duplicate_chunk_id", member_id: chunk.chunk_id });
    }
    chunkIds.add(chunk.chunk_id);
    if (!sourceIds.has(chunk.source_id)) {
      issues.push({ code: "orphan_chunk", member_id: chunk.chunk_id, path: chunk.path });
      continue;
    }
    const source = index.sources.find((entry) => entry.source_id === chunk.source_id);
    if (source?.content_hash !== chunk.content_hash) {
      issues.push({
        code: "chunk_source_hash_mismatch",
        member_id: chunk.chunk_id,
        path: chunk.path
      });
    }
    chunksBySource.set(chunk.source_id, (chunksBySource.get(chunk.source_id) ?? 0) + 1);
  }
  for (const source of index.sources) {
    if ((chunksBySource.get(source.source_id) ?? 0) === 0) {
      issues.push({ code: "source_without_chunks", member_id: source.source_id, path: source.path });
    }
  }

  const indexChecksum = calculateRagIndexChecksum(index);
  const sourceChecksum = calculateRagSourceManifestChecksum(index.sources);
  if (index.manifest === undefined) {
    issues.push({ code: "manifest_missing" });
  } else {
    if (index.manifest.index_checksum !== indexChecksum) {
      issues.push({ code: "index_checksum_mismatch" });
    }
    if (index.manifest.source_manifest_checksum !== sourceChecksum) {
      issues.push({ code: "source_manifest_checksum_mismatch" });
    }
  }

  return {
    schema_version: "0.1",
    artifact_kind: "rag_integrity",
    status: issues.length === 0 ? "PASS" : "UNPASSED",
    index_path: toProjectPath(projectRoot, indexPath),
    index_checksum: indexChecksum,
    source_manifest_checksum: sourceChecksum,
    source_count: index.sources.length,
    chunk_count: index.chunks.length,
    issue_count: issues.length,
    issues,
    checked_at: now.toISOString()
  };
}

export async function getRagStats(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<RagStats> {
  const now = options.now ?? new Date();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = await resolveRagIndexPath(projectRoot);
  const contextBudget = config.integrity?.context_budget_tokens ?? defaultContextBudgetTokens;
  const intervalDays = config.rebuild?.interval_days ?? defaultRebuildIntervalDays;
  let index: RagIndex | undefined;
  try {
    index = await readJsonFile<RagIndex>(indexPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const chunks = index?.chunks ?? [];
  const contentCounts = new Map<string, number>();
  let totalCharacters = 0;
  let largestTokens = 0;
  let chunksOverBudget = 0;
  for (const chunk of chunks) {
    const checksum = calculateRagChunkTextChecksum(chunk.text);
    contentCounts.set(checksum, (contentCounts.get(checksum) ?? 0) + 1);
    totalCharacters += chunk.text.length;
    const estimated = estimateTokens(chunk.text.length);
    largestTokens = Math.max(largestTokens, estimated);
    if (estimated > contextBudget) chunksOverBudget += 1;
  }
  const duplicateCount = [...contentCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  const lastFullRebuildAt = index?.created_at;
  const rebuildDue = lastFullRebuildAt === undefined
    ? index !== undefined
    : now.getTime() - Date.parse(lastFullRebuildAt) >= intervalDays * 86_400_000;

  return {
    schema_version: "0.1",
    index_path: toProjectPath(projectRoot, indexPath),
    exists: index !== undefined,
    source_count: index?.sources.length ?? 0,
    chunk_count: chunks.length,
    duplicate_chunk_count: duplicateCount,
    duplicate_ratio: chunks.length === 0 ? 0 : duplicateCount / chunks.length,
    total_characters: totalCharacters,
    estimated_total_tokens: estimateTokens(totalCharacters),
    largest_chunk_estimated_tokens: largestTokens,
    context_budget_tokens: contextBudget,
    chunks_exceeding_context_budget: chunksOverBudget,
    rebuild_interval_days: intervalDays,
    rebuild_due: rebuildDue,
    retention_candidate_count: await countRetentionCandidates(projectRoot, config, now),
    checked_at: now.toISOString()
  };
}

export async function planRagRebuild(
  projectRoot: string,
  options: PlanRagRebuildOptions = {}
): Promise<RagRebuildArtifact> {
  const now = options.now ?? new Date();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const indexPath = await resolveRagIndexPath(projectRoot);
  const current = await readIndexIfPresent(indexPath);
  const candidateResult = await buildRagIndex(projectRoot, {
    now: () => now,
    fullRebuild: true,
    writeIndex: false
  });
  const candidate = candidateResult.index;
  const candidateIntegrity = await inspectRagIndex(projectRoot, candidate, {
    now,
    indexPath,
    checkSourceDrift: false
  });
  const querySamples = await compareQuerySamples(
    current,
    candidate,
    config.integrity?.query_samples ?? defaultQuerySamples
  );
  const reasons: string[] = [];
  if (candidateIntegrity.status !== "PASS") reasons.push("candidate_integrity_failed");
  if (current !== undefined && current.sources.length > 0 && candidate.sources.length === 0) {
    reasons.push("candidate_sources_empty");
  }
  if (querySamples.some((sample) => sample.regression)) {
    reasons.push("query_sample_regression");
  }
  const rebuildId = options.rebuildId ?? createRebuildId(now);
  assertRebuildId(rebuildId);
  const artifact: RagRebuildArtifact = {
    schema_version: "0.1",
    artifact_kind: "rag_rebuild",
    rebuild_id: rebuildId,
    status: reasons.length === 0 ? "ready" : "blocked",
    index_path: toProjectPath(projectRoot, indexPath),
    current: {
      exists: current !== undefined,
      checksum: current === undefined ? undefined : calculateRagIndexChecksum(current),
      source_count: current?.sources.length ?? 0,
      chunk_count: current?.chunks.length ?? 0
    },
    candidate: {
      checksum: calculateRagIndexChecksum(candidate),
      source_manifest_checksum: calculateRagSourceManifestChecksum(candidate.sources),
      source_count: candidate.sources.length,
      chunk_count: candidate.chunks.length
    },
    comparison: {
      status: reasons.length === 0 ? "passed" : "failed",
      source_delta: candidate.sources.length - (current?.sources.length ?? 0),
      chunk_delta: candidate.chunks.length - (current?.chunks.length ?? 0),
      query_samples: querySamples,
      reasons
    },
    created_at: now.toISOString()
  };
  await writeJsonFileAtomic(ragRebuildPath(projectRoot, rebuildId), artifact);
  return artifact;
}

export async function executeRagRebuild(
  projectRoot: string,
  rebuildId: string,
  options: ExecuteRagRebuildOptions
): Promise<RagRebuildArtifact> {
  assertRebuildId(rebuildId);
  if (options.confirm !== rebuildId) {
    throw new Error(`RAG rebuild confirmation must exactly match ${rebuildId}.`);
  }
  const now = options.now ?? new Date();
  const artifactPath = ragRebuildPath(projectRoot, rebuildId);
  const planned = await readJsonFile<RagRebuildArtifact>(artifactPath);
  if (planned.status !== "ready") {
    throw new Error(`RAG rebuild is not ready: ${rebuildId} (${planned.status}).`);
  }
  const candidateResult = await buildRagIndex(projectRoot, {
    now: () => now,
    fullRebuild: true,
    writeIndex: false
  });
  const candidate = candidateResult.index;
  const candidateChecksum = calculateRagIndexChecksum(candidate);
  if (candidateChecksum !== planned.candidate.checksum) {
    throw new Error("RAG rebuild candidate changed after planning. Create a new rebuild plan.");
  }
  const integrity = await inspectRagIndex(projectRoot, candidate, {
    now,
    checkSourceDrift: false
  });
  if (integrity.status !== "PASS") {
    throw new Error("RAG rebuild candidate failed integrity verification.");
  }

  const indexPath = await resolveRagIndexPath(projectRoot);
  await withResourceLock(
    projectRoot,
    indexPath,
    { owner: "rag-index-rebuild", ttlMs: 120_000 },
    async (lock) => {
      const current = await readIndexIfPresent(indexPath);
      const currentChecksum = current === undefined ? undefined : calculateRagIndexChecksum(current);
      if (currentChecksum !== planned.current.checksum) {
        throw new Error("RAG index changed after planning. Create a new rebuild plan.");
      }
      await writeJsonFileFenced(lock, indexPath, candidate);
    }
  );

  const executed: RagRebuildArtifact = {
    ...planned,
    status: "executed",
    executed_at: now.toISOString()
  };
  await writeJsonFileAtomic(artifactPath, executed);
  await writeJsonFileAtomic(ragIntegrityPath(projectRoot), integrity);
  return executed;
}

export async function readRagRebuild(
  projectRoot: string,
  rebuildId: string
): Promise<RagRebuildArtifact> {
  assertRebuildId(rebuildId);
  return readJsonFile<RagRebuildArtifact>(ragRebuildPath(projectRoot, rebuildId));
}

export function ragIntegrityPath(projectRoot: string): string {
  return resolveInside(projectRoot, ".kairon", "rag", "integrity", "latest.json");
}

export function ragRebuildPath(projectRoot: string, rebuildId: string): string {
  assertRebuildId(rebuildId);
  return resolveInside(projectRoot, ".kairon", "rag", "rebuilds", `${rebuildId}.json`);
}

async function compareQuerySamples(
  current: RagIndex | undefined,
  candidate: RagIndex,
  queries: string[]
): Promise<RagRebuildQueryComparison[]> {
  const normalized = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 20);
  return Promise.all(
    normalized.map(async (query) => {
      const currentMatches = current === undefined
        ? []
        : await searchRagIndexData(current, { query, topK: 5 });
      const candidateMatches = await searchRagIndexData(candidate, { query, topK: 5 });
      return {
        query: sanitizeQueryForArtifact(query),
        current_matches: currentMatches.length,
        candidate_matches: candidateMatches.length,
        current_top_path: currentMatches[0]?.path,
        candidate_top_path: candidateMatches[0]?.path,
        regression: currentMatches.length > 0 && candidateMatches.length === 0
      };
    })
  );
}

async function sourceHasDrifted(
  projectRoot: string,
  source: RagIndex["sources"][number]
): Promise<boolean> {
  try {
    const file = await stat(resolveInside(projectRoot, source.path));
    return (
      source.file_mtime_ms === undefined ||
      source.file_size_bytes === undefined ||
      source.file_mtime_ms !== file.mtimeMs ||
      source.file_size_bytes !== file.size
    );
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

async function countRetentionCandidates(
  projectRoot: string,
  config: RagConfig,
  now: Date
): Promise<number> {
  const directory = resolveInside(projectRoot, ".kairon", "rag", "rebuilds");
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const files = await Promise.all(
    entries.map(async (entry) => ({ entry, file: await stat(resolveInside(directory, entry)) }))
  );
  files.sort((left, right) => right.file.mtimeMs - left.file.mtimeMs);
  const maxArtifacts = config.rebuild?.max_artifacts ?? defaultMaxArtifacts;
  const maxAgeMs = (config.rebuild?.retention_days ?? defaultRetentionDays) * 86_400_000;
  return files.filter(
    (item, index) => index >= maxArtifacts || now.getTime() - item.file.mtimeMs >= maxAgeMs
  ).length;
}

async function resolveRagIndexPath(projectRoot: string): Promise<string> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  return resolveInside(projectRoot, config.storage?.base_dir ?? ".kairon/rag", "index.json");
}

async function readIndexIfPresent(indexPath: string): Promise<RagIndex | undefined> {
  try {
    await access(indexPath);
    return await readJsonFile<RagIndex>(indexPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function createRebuildId(now: Date): string {
  return `RAG-REBUILD-${now.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z")}`;
}

function assertRebuildId(value: string): void {
  if (!rebuildIdPattern.test(value)) {
    throw new Error(`Invalid RAG rebuild id: ${value}`);
  }
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function sanitizeQueryForArtifact(value: string): string {
  const redacted = value
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]"
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/gu,
      "[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= 200 ? redacted : `${redacted.slice(0, 197)}...`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
