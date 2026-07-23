import { describe, expect, it } from "vitest";
import { rankHybridRagResults } from "../src/rag/hybrid-ranker.js";
import type { RagSearchResult } from "../src/rag/lexical-index.js";

describe("RAG hybrid ranker", () => {
  it("normalizes lexical and vector scores before combining them", () => {
    const lexical = [
      result("a", "source-a", 100),
      result("b", "source-b", 50)
    ];
    const vector = [
      result("a", "source-a", 0.2),
      result("b", "source-b", 0.9)
    ];

    const ranked = rankHybridRagResults(lexical, vector, {
      topK: 2,
      weights: {
        lexical: 0.3,
        vector: 0.7,
        freshness: 0,
        source_diversity_penalty: 0
      }
    });

    expect(ranked.map((entry) => entry.chunk_id)).toEqual(["b", "a"]);
    expect(ranked[0]?.explain).toMatchObject({
      retrieval_mode: "hybrid",
      normalized_lexical_score: 0.5,
      normalized_vector_score: 1
    });
  });

  it("deduplicates chunks and applies source diversity to repeated sources", () => {
    const lexical = [
      result("a1", "source-a", 10),
      result("a2", "source-a", 9),
      result("b1", "source-b", 8)
    ];
    const vector = lexical.map((entry) => ({ ...entry }));

    const ranked = rankHybridRagResults(lexical, vector, {
      topK: 3,
      weights: {
        lexical: 0.5,
        vector: 0.5,
        freshness: 0,
        source_diversity_penalty: 0.2
      }
    });

    expect(ranked.map((entry) => entry.chunk_id)).toEqual(["a1", "b1", "a2"]);
    expect(ranked[2]?.explain?.source_diversity_penalty).toBe(0.2);
  });
});

function result(
  chunkId: string,
  sourceId: string,
  score: number
): RagSearchResult {
  return {
    chunk_id: chunkId,
    source_id: sourceId,
    source_type: "document",
    path: `docs/${chunkId}.md`,
    content_hash: `sha256:${chunkId}`,
    metadata: {
      collection: "documents",
      source_type: "document"
    },
    score,
    text: chunkId,
    explain: {
      lexical_score: score,
      matched_terms: [chunkId],
      term_hits: { [chunkId]: 1 },
      phrase_bonus: 0,
      source_age_days: 0,
      stale_source: false,
      warnings: []
    }
  };
}
