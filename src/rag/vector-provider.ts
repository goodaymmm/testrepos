import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import {
  buildRagIndex,
  matchesRagSearchFilters,
  tokenizeRagText,
  type RagIndex,
  type RagIndexChunk,
  type RagSearchRequest,
  type RagSearchResult
} from "./lexical-index.js";
import {
  calculateRagChunkTextChecksum,
  calculateRagSourceManifestChecksum
} from "./manifest.js";

export type RagVectorProviderKind = "local_hash" | "local_onnx";
export type RagVectorProviderCapability = "ready" | "setup_required";

export type RagVectorProviderStatus = {
  schema_version: "0.1";
  capability: RagVectorProviderCapability;
  provider: RagVectorProviderKind;
  local_only: true;
  external_network: false;
  enabled: boolean;
  model_id: string;
  dimension: number;
  reason?: string;
  setup_hint?: string;
};

export type RagEmbeddingProvider = {
  readonly status: RagVectorProviderStatus;
  embed(texts: string[]): Promise<number[][]>;
};

export type RagVectorEntry = {
  chunk_id: string;
  source_id: string;
  source_type: RagIndexChunk["source_type"];
  path: string;
  content_hash: string;
  metadata: RagIndexChunk["metadata"];
  embedding_cache_key: string;
  embedding_checksum: string;
  vector: number[];
};

export type RagVectorIndex = {
  schema_version: "0.1";
  kind: "rag_vector_index";
  provider: RagVectorProviderKind;
  model_id: string;
  dimension: number;
  created_at: string;
  updated_at: string;
  source_manifest_checksum: string;
  lexical_index_checksum: string;
  entry_count: number;
  entries: RagVectorEntry[];
};

export type RagVectorManifest = {
  schema_version: "0.1";
  kind: "rag_vector_manifest";
  provider: RagVectorProviderKind;
  model_id: string;
  dimension: number;
  entry_count: number;
  index_checksum: string;
  source_manifest_checksum: string;
  lexical_index_checksum: string;
  generated_at: string;
};

export type RagVectorBuildArtifact = {
  schema_version: "0.1";
  artifact_kind: "rag_vector_build";
  build_id: string;
  status: "ready" | "setup_required" | "executed";
  provider: RagVectorProviderStatus;
  index_path: string;
  manifest_path: string;
  source_manifest_checksum?: string;
  lexical_index_checksum?: string;
  candidate_index_checksum?: string;
  entry_count: number;
  reused_entry_count: number;
  embedded_entry_count: number;
  planned_at: string;
  executed_at?: string;
};

export type RagVectorSearchResult = {
  status: "ready" | "setup_required" | "stale" | "failed";
  reason?: string;
  provider: RagVectorProviderStatus;
  results: RagSearchResult[];
  manifest?: RagVectorManifest;
};

export type RagVectorIntegrityIssue =
  | "vector_manifest_unreadable"
  | "vector_index_unreadable"
  | "vector_dimension_mismatch"
  | "vector_index_checksum_mismatch"
  | "vector_source_manifest_mismatch"
  | "vector_lexical_index_mismatch"
  | "vector_entry_count_mismatch"
  | "vector_chunk_mismatch";

type RagConfig = {
  storage?: { base_dir?: string };
  vector?: {
    enabled?: boolean;
    provider?: RagVectorProviderKind;
    model_id?: string;
    dimension?: number;
  };
};

type CandidateBuild = {
  index: RagVectorIndex;
  manifest: RagVectorManifest;
  reused: number;
  embedded: number;
};

const defaultModelId = "kairon-local-hash-v1";
const defaultDimension = 256;
const buildIdPattern = /^RAG-VECTOR-BUILD-\d{8}T\d{9}Z-[0-9a-f]{8}$/u;

export async function getRagVectorProviderStatus(
  projectRoot: string
): Promise<RagVectorProviderStatus> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  return providerStatus(config);
}

export async function createRagEmbeddingProvider(
  projectRoot: string
): Promise<RagEmbeddingProvider> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const status = providerStatus(config);
  if (status.capability !== "ready") {
    return {
      status,
      async embed(): Promise<number[][]> {
        throw new Error(status.reason ?? "RAG vector provider setup is required.");
      }
    };
  }

  return {
    status,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => embedWithFeatureHash(text, status.dimension));
    }
  };
}

export async function planRagVectorBuild(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<RagVectorBuildArtifact> {
  const now = options.now ?? new Date();
  const provider = await createRagEmbeddingProvider(projectRoot);
  const paths = await resolveVectorPaths(projectRoot);
  const buildId = createBuildId(now);

  if (provider.status.capability !== "ready") {
    const artifact: RagVectorBuildArtifact = {
      schema_version: "0.1",
      artifact_kind: "rag_vector_build",
      build_id: buildId,
      status: "setup_required",
      provider: provider.status,
      index_path: toProjectPath(projectRoot, paths.index),
      manifest_path: toProjectPath(projectRoot, paths.manifest),
      entry_count: 0,
      reused_entry_count: 0,
      embedded_entry_count: 0,
      planned_at: now.toISOString()
    };
    await writeJsonFileAtomic(vectorBuildPath(paths, buildId), artifact);
    return artifact;
  }

  const lexical = await loadOrBuildLexicalIndex(projectRoot);
  const existing = await readJsonIfPresent<RagVectorIndex>(paths.index);
  const candidate = await buildVectorCandidate(lexical, provider, existing, now);
  const artifact: RagVectorBuildArtifact = {
    schema_version: "0.1",
    artifact_kind: "rag_vector_build",
    build_id: buildId,
    status: "ready",
    provider: provider.status,
    index_path: toProjectPath(projectRoot, paths.index),
    manifest_path: toProjectPath(projectRoot, paths.manifest),
    source_manifest_checksum: candidate.manifest.source_manifest_checksum,
    lexical_index_checksum: candidate.manifest.lexical_index_checksum,
    candidate_index_checksum: candidate.manifest.index_checksum,
    entry_count: candidate.index.entry_count,
    reused_entry_count: candidate.reused,
    embedded_entry_count: candidate.embedded,
    planned_at: now.toISOString()
  };
  await writeJsonFileAtomic(vectorBuildPath(paths, buildId), artifact);
  return artifact;
}

export async function executeRagVectorBuild(
  projectRoot: string,
  buildId: string,
  options: { now?: Date } = {}
): Promise<RagVectorBuildArtifact> {
  assertBuildId(buildId);
  const now = options.now ?? new Date();
  const paths = await resolveVectorPaths(projectRoot);
  const artifactPath = vectorBuildPath(paths, buildId);
  const planned = await readJsonFile<RagVectorBuildArtifact>(artifactPath);
  if (planned.status !== "ready") {
    throw new Error(
      `RAG vector build ${buildId} is not ready. Current status: ${planned.status}`
    );
  }

  const provider = await createRagEmbeddingProvider(projectRoot);
  if (provider.status.capability !== "ready") {
    throw new Error("RAG vector provider setup changed after the build plan.");
  }

  return withResourceLock(
    projectRoot,
    paths.index,
    { owner: "rag-vector-build", ttlMs: 120_000 },
    async (lock) => {
      const lexical = await loadOrBuildLexicalIndex(projectRoot);
      const existing = await readJsonIfPresent<RagVectorIndex>(paths.index);
      const candidate = await buildVectorCandidate(lexical, provider, existing, now);
      if (
        candidate.manifest.index_checksum !== planned.candidate_index_checksum ||
        candidate.manifest.source_manifest_checksum !==
          planned.source_manifest_checksum ||
        candidate.manifest.lexical_index_checksum !== planned.lexical_index_checksum
      ) {
        throw new Error(
          "RAG vector build inputs changed after planning. Run --dry-run again."
        );
      }

      await writeJsonFileFenced(lock, paths.index, candidate.index);
      await writeJsonFileFenced(lock, paths.manifest, candidate.manifest);
      const executed: RagVectorBuildArtifact = {
        ...planned,
        status: "executed",
        reused_entry_count: candidate.reused,
        embedded_entry_count: candidate.embedded,
        executed_at: now.toISOString()
      };
      await writeJsonFileFenced(lock, artifactPath, executed);
      return executed;
    }
  );
}

export async function searchRagVectorIndex(
  projectRoot: string,
  request: RagSearchRequest
): Promise<RagVectorSearchResult> {
  const provider = await createRagEmbeddingProvider(projectRoot);
  if (provider.status.capability !== "ready") {
    return {
      status: "setup_required",
      reason: provider.status.reason,
      provider: provider.status,
      results: []
    };
  }

  const paths = await resolveVectorPaths(projectRoot);
  let index: RagVectorIndex;
  let manifest: RagVectorManifest;
  let lexical: RagIndex;
  try {
    [index, manifest, lexical] = await Promise.all([
      readJsonFile<RagVectorIndex>(paths.index),
      readJsonFile<RagVectorManifest>(paths.manifest),
      loadOrBuildLexicalIndex(projectRoot)
    ]);
  } catch (error) {
    return {
      status: isMissing(error) ? "setup_required" : "failed",
      reason: isMissing(error)
        ? "vector index is not built"
        : `vector index could not be read: ${String(error)}`,
      provider: provider.status,
      results: []
    };
  }

  const drift = vectorDriftReason(index, manifest, lexical);
  if (drift !== undefined) {
    return {
      status: "stale",
      reason: drift,
      provider: provider.status,
      manifest,
      results: []
    };
  }

  const [queryVector] = await provider.embed([request.query]);
  const topK = request.topK ?? 5;
  const results = index.entries
    .filter((entry) => matchesRagSearchFilters(entry, request.filters))
    .map((entry) => ({ entry, score: cosineSimilarity(queryVector, entry.vector) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.chunk_id.localeCompare(right.entry.chunk_id)
    )
    .slice(0, topK)
    .map(({ entry, score }): RagSearchResult => ({
      chunk_id: entry.chunk_id,
      source_id: entry.source_id,
      source_type: entry.source_type,
      path: entry.path,
      content_hash: entry.content_hash,
      metadata: entry.metadata,
      score,
      text: lexical.chunks.find((chunk) => chunk.chunk_id === entry.chunk_id)?.text ?? "",
      ...(request.explain === true
        ? {
            explain: {
              lexical_score: 0,
              vector_score: score,
              matched_terms: [],
              term_hits: {},
              phrase_bonus: 0,
              stale_source: false,
              warnings: []
            }
          }
        : {})
    }));

  return {
    status: "ready",
    provider: provider.status,
    manifest,
    results
  };
}

export async function inspectRagVectorIntegrity(
  projectRoot: string,
  lexical: RagIndex
): Promise<RagVectorIntegrityIssue[]> {
  const paths = await resolveVectorPaths(projectRoot);
  const indexExists = await fileExists(paths.index);
  const manifestExists = await fileExists(paths.manifest);
  if (!indexExists && !manifestExists) {
    return [];
  }
  if (!manifestExists) {
    return ["vector_manifest_unreadable"];
  }
  if (!indexExists) {
    return ["vector_index_unreadable"];
  }

  let index: RagVectorIndex;
  let manifest: RagVectorManifest;
  try {
    [index, manifest] = await Promise.all([
      readJsonFile<RagVectorIndex>(paths.index),
      readJsonFile<RagVectorManifest>(paths.manifest)
    ]);
  } catch {
    return ["vector_index_unreadable"];
  }

  const issues: RagVectorIntegrityIssue[] = [];
  if (
    index.dimension !== manifest.dimension ||
    index.entries.some((entry) => entry.vector.length !== manifest.dimension)
  ) {
    issues.push("vector_dimension_mismatch");
  }
  if (calculateVectorIndexChecksum(index) !== manifest.index_checksum) {
    issues.push("vector_index_checksum_mismatch");
  }
  if (index.entry_count !== index.entries.length || manifest.entry_count !== index.entries.length) {
    issues.push("vector_entry_count_mismatch");
  }
  if (
    manifest.source_manifest_checksum !==
    calculateRagSourceManifestChecksum(lexical.sources)
  ) {
    issues.push("vector_source_manifest_mismatch");
  }
  if (manifest.lexical_index_checksum !== lexical.manifest?.index_checksum) {
    issues.push("vector_lexical_index_mismatch");
  }
  const lexicalChunks = new Map(lexical.chunks.map((chunk) => [chunk.chunk_id, chunk]));
  if (
    index.entries.some((entry) => {
      const chunk = lexicalChunks.get(entry.chunk_id);
      return (
        chunk === undefined ||
        entry.content_hash !== chunk.content_hash ||
        entry.embedding_cache_key !== embeddingCacheKey(chunk, index.model_id, index.dimension)
      );
    })
  ) {
    issues.push("vector_chunk_mismatch");
  }
  return [...new Set(issues)];
}

export async function readRagVectorManifest(
  projectRoot: string
): Promise<RagVectorManifest | undefined> {
  const paths = await resolveVectorPaths(projectRoot);
  return readJsonIfPresent<RagVectorManifest>(paths.manifest);
}

async function buildVectorCandidate(
  lexical: RagIndex,
  provider: RagEmbeddingProvider,
  existing: RagVectorIndex | undefined,
  now: Date
): Promise<CandidateBuild> {
  const reusable = new Map(
    existing?.provider === provider.status.provider &&
      existing.model_id === provider.status.model_id &&
      existing.dimension === provider.status.dimension
      ? existing.entries.map((entry) => [entry.embedding_cache_key, entry])
      : []
  );
  const entries: RagVectorEntry[] = [];
  const pending: Array<{ chunk: RagIndexChunk; key: string }> = [];
  let reused = 0;

  for (const chunk of [...lexical.chunks].sort((left, right) =>
    left.chunk_id.localeCompare(right.chunk_id)
  )) {
    const key = embeddingCacheKey(
      chunk,
      provider.status.model_id,
      provider.status.dimension
    );
    const cached = reusable.get(key);
    if (
      cached !== undefined &&
      cached.vector.length === provider.status.dimension &&
      cached.embedding_checksum === digest(cached.vector)
    ) {
      entries.push({ ...cached, metadata: chunk.metadata });
      reused += 1;
    } else {
      pending.push({ chunk, key });
    }
  }

  const vectors = await provider.embed(pending.map(({ chunk }) => chunk.text));
  for (let index = 0; index < pending.length; index += 1) {
    const { chunk, key } = pending[index];
    const vector = vectors[index];
    if (vector === undefined || vector.length !== provider.status.dimension) {
      throw new Error("RAG vector provider returned an invalid dimension.");
    }
    entries.push({
      chunk_id: chunk.chunk_id,
      source_id: chunk.source_id,
      source_type: chunk.source_type,
      path: chunk.path,
      content_hash: chunk.content_hash,
      metadata: chunk.metadata,
      embedding_cache_key: key,
      embedding_checksum: digest(vector),
      vector
    });
  }
  entries.sort((left, right) => left.chunk_id.localeCompare(right.chunk_id));

  const generatedAt = now.toISOString();
  const sourceManifestChecksum = calculateRagSourceManifestChecksum(lexical.sources);
  const lexicalIndexChecksum = lexical.manifest?.index_checksum;
  if (lexicalIndexChecksum === undefined) {
    throw new Error("RAG lexical index manifest is required for vector build.");
  }
  const vectorIndex: RagVectorIndex = {
    schema_version: "0.1",
    kind: "rag_vector_index",
    provider: provider.status.provider,
    model_id: provider.status.model_id,
    dimension: provider.status.dimension,
    created_at: existing?.created_at ?? generatedAt,
    updated_at: generatedAt,
    source_manifest_checksum: sourceManifestChecksum,
    lexical_index_checksum: lexicalIndexChecksum,
    entry_count: entries.length,
    entries
  };
  const manifest: RagVectorManifest = {
    schema_version: "0.1",
    kind: "rag_vector_manifest",
    provider: provider.status.provider,
    model_id: provider.status.model_id,
    dimension: provider.status.dimension,
    entry_count: entries.length,
    index_checksum: calculateVectorIndexChecksum(vectorIndex),
    source_manifest_checksum: sourceManifestChecksum,
    lexical_index_checksum: lexicalIndexChecksum,
    generated_at: generatedAt
  };
  return {
    index: vectorIndex,
    manifest,
    reused,
    embedded: pending.length
  };
}

function providerStatus(config: RagConfig): RagVectorProviderStatus {
  const enabled = config.vector?.enabled === true;
  const provider = config.vector?.provider ?? "local_hash";
  const modelId = config.vector?.model_id?.trim() || defaultModelId;
  const dimension = config.vector?.dimension ?? defaultDimension;
  const common = {
    schema_version: "0.1" as const,
    provider,
    local_only: true as const,
    external_network: false as const,
    enabled,
    model_id: modelId,
    dimension
  };

  if (!enabled) {
    return {
      ...common,
      capability: "setup_required",
      reason: "local vector retrieval is disabled",
      setup_hint: "Set rag.json vector.enabled=true after reviewing local resource use."
    };
  }
  if (!Number.isInteger(dimension) || dimension < 8 || dimension > 4096) {
    return {
      ...common,
      capability: "setup_required",
      reason: "local vector dimension is invalid",
      setup_hint: "Set rag.json vector.dimension to an integer from 8 through 4096."
    };
  }
  if (provider === "local_onnx") {
    return {
      ...common,
      capability: "setup_required",
      reason: "local ONNX runtime is not installed",
      setup_hint: "Use provider=local_hash or install a supported local ONNX adapter."
    };
  }
  return {
    ...common,
    capability: "ready"
  };
}

function embedWithFeatureHash(text: string, dimension: number): number[] {
  const vector = Array<number>(dimension).fill(0);
  const tokens = tokenizeRagText(text);
  const features = [
    ...tokens.map((token) => `token:${token}`),
    ...tokens.slice(0, -1).map((token, index) => `bigram:${token}:${tokens[index + 1]}`)
  ];
  for (const feature of features) {
    const hash = createHash("sha256").update(feature).digest();
    const slot = hash.readUInt32BE(0) % dimension;
    const sign = (hash[4] ?? 0) % 2 === 0 ? 1 : -1;
    vector[slot] = (vector[slot] ?? 0) + sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    return 0;
  }
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function embeddingCacheKey(
  chunk: RagIndexChunk,
  modelId: string,
  dimension: number
): string {
  return digest({
    model_id: modelId,
    dimension,
    chunk_id: chunk.chunk_id,
    text_checksum: calculateRagChunkTextChecksum(chunk.text)
  });
}

function calculateVectorIndexChecksum(index: RagVectorIndex): string {
  return digest({
    provider: index.provider,
    model_id: index.model_id,
    dimension: index.dimension,
    source_manifest_checksum: index.source_manifest_checksum,
    lexical_index_checksum: index.lexical_index_checksum,
    entries: [...index.entries]
      .sort((left, right) => left.chunk_id.localeCompare(right.chunk_id))
      .map((entry) => ({
        chunk_id: entry.chunk_id,
        source_id: entry.source_id,
        content_hash: entry.content_hash,
        embedding_cache_key: entry.embedding_cache_key,
        embedding_checksum: entry.embedding_checksum,
        vector_checksum: digest(entry.vector)
      }))
  });
}

function vectorDriftReason(
  index: RagVectorIndex,
  manifest: RagVectorManifest,
  lexical: RagIndex
): string | undefined {
  if (index.dimension !== manifest.dimension) {
    return "vector dimension differs from manifest";
  }
  if (calculateVectorIndexChecksum(index) !== manifest.index_checksum) {
    return "vector index checksum differs from manifest";
  }
  if (
    manifest.source_manifest_checksum !==
    calculateRagSourceManifestChecksum(lexical.sources)
  ) {
    return "vector source manifest is stale";
  }
  if (manifest.lexical_index_checksum !== lexical.manifest?.index_checksum) {
    return "vector index does not match the lexical index";
  }
  return undefined;
}

async function loadOrBuildLexicalIndex(projectRoot: string): Promise<RagIndex> {
  const paths = await resolveVectorPaths(projectRoot);
  try {
    return await readJsonFile<RagIndex>(paths.lexical);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return (await buildRagIndex(projectRoot)).index;
  }
}

async function resolveVectorPaths(projectRoot: string): Promise<{
  base: string;
  lexical: string;
  index: string;
  manifest: string;
  builds: string;
}> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const base = resolveInside(projectRoot, config.storage?.base_dir ?? ".kairon/rag");
  return {
    base,
    lexical: resolveInside(base, "index.json"),
    index: resolveInside(base, "vector", "index.json"),
    manifest: resolveInside(base, "vector", "manifest.json"),
    builds: resolveInside(base, "vector", "builds")
  };
}

function vectorBuildPath(
  paths: { builds: string },
  buildId: string
): string {
  assertBuildId(buildId);
  return resolveInside(paths.builds, `${buildId}.json`);
}

function createBuildId(now: Date): string {
  const compact = now
    .toISOString()
    .replace(/[-:.]/gu, "")
    .replace("Z", "");
  const stamp = `${compact.slice(0, 18)}Z`;
  return `RAG-VECTOR-BUILD-${stamp}-${randomUUID().replace(/-/gu, "").slice(0, 8)}`;
}

function assertBuildId(value: string): void {
  if (!buildIdPattern.test(value)) {
    throw new Error(`Invalid RAG vector build id: ${value}`);
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

async function readJsonIfPresent<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return String(error).includes("ENOENT");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
