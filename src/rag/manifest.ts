import { createHash } from "node:crypto";
import type { RagIndex, RagIndexChunk, RagIndexSource } from "./lexical-index.js";

export type RagIndexManifest = {
  algorithm: "sha256";
  index_checksum: string;
  source_manifest_checksum: string;
  generated_at: string;
};

export function createRagIndexManifest(
  index: Pick<RagIndex, "sources" | "chunks">,
  generatedAt: string
): RagIndexManifest {
  return {
    algorithm: "sha256",
    index_checksum: calculateRagIndexChecksum(index),
    source_manifest_checksum: calculateRagSourceManifestChecksum(index.sources),
    generated_at: generatedAt
  };
}

export function calculateRagIndexChecksum(
  index: Pick<RagIndex, "sources" | "chunks">
): string {
  return digest({
    sources: [...index.sources].sort(compareSources).map(stableSource),
    chunks: [...index.chunks].sort(compareChunks).map(stableChunk)
  });
}

export function calculateRagSourceManifestChecksum(
  sources: RagIndexSource[]
): string {
  return digest([...sources].sort(compareSources).map(stableSource));
}

export function calculateRagChunkTextChecksum(text: string): string {
  return digest(text);
}

function stableSource(source: RagIndexSource): Record<string, unknown> {
  return {
    source_id: source.source_id,
    source_type: source.source_type,
    path: source.path,
    content_hash: source.content_hash,
    bytes: source.bytes,
    source_category: source.source_category,
    metadata: source.metadata
  };
}

function stableChunk(chunk: RagIndexChunk): Record<string, unknown> {
  return {
    chunk_id: chunk.chunk_id,
    source_id: chunk.source_id,
    source_type: chunk.source_type,
    path: chunk.path,
    content_hash: chunk.content_hash,
    metadata: chunk.metadata,
    text: chunk.text
  };
}

function compareSources(left: RagIndexSource, right: RagIndexSource): number {
  return left.source_id.localeCompare(right.source_id);
}

function compareChunks(left: RagIndexChunk, right: RagIndexChunk): number {
  return left.chunk_id.localeCompare(right.chunk_id);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}
