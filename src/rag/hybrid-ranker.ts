import type { RagSearchResult } from "./lexical-index.js";

export type RagHybridWeights = {
  lexical: number;
  vector: number;
  freshness: number;
  source_diversity_penalty: number;
};

export type RagHybridRankOptions = {
  topK?: number;
  weights?: Partial<RagHybridWeights>;
};

type HybridCandidate = {
  base: RagSearchResult;
  lexical?: RagSearchResult;
  vector?: RagSearchResult;
  normalizedLexical: number;
  normalizedVector: number;
  freshness: number;
  baseScore: number;
};

const defaultWeights: RagHybridWeights = {
  lexical: 0.45,
  vector: 0.45,
  freshness: 0.1,
  source_diversity_penalty: 0.08
};

export function rankHybridRagResults(
  lexicalResults: RagSearchResult[],
  vectorResults: RagSearchResult[],
  options: RagHybridRankOptions = {}
): RagSearchResult[] {
  const weights = normalizeWeights({ ...defaultWeights, ...options.weights });
  const lexicalByChunk = new Map(
    lexicalResults.map((result) => [result.chunk_id, result])
  );
  const vectorByChunk = new Map(
    vectorResults.map((result) => [result.chunk_id, result])
  );
  const chunkIds = [...new Set([...lexicalByChunk.keys(), ...vectorByChunk.keys()])];
  const lexicalMax = positiveMax(lexicalResults.map((result) => result.score));
  const vectorMax = positiveMax(vectorResults.map((result) => result.score));
  const candidates = chunkIds.map((chunkId): HybridCandidate => {
    const lexical = lexicalByChunk.get(chunkId);
    const vector = vectorByChunk.get(chunkId);
    const base = lexical ?? vector;
    if (base === undefined) {
      throw new Error(`Hybrid RAG candidate is missing: ${chunkId}`);
    }
    const normalizedLexical = normalizeScore(lexical?.score, lexicalMax);
    const normalizedVector = normalizeScore(vector?.score, vectorMax);
    const freshness = freshnessScore(lexical ?? vector);
    return {
      base,
      lexical,
      vector,
      normalizedLexical,
      normalizedVector,
      freshness,
      baseScore:
        normalizedLexical * weights.lexical +
        normalizedVector * weights.vector +
        freshness * weights.freshness
    };
  });

  const selected: RagSearchResult[] = [];
  const sourceCounts = new Map<string, number>();
  const remaining = [...candidates];
  const topK = options.topK ?? 5;

  while (remaining.length > 0 && selected.length < topK) {
    const ranked = remaining
      .map((candidate) => {
        const repeated = sourceCounts.get(candidate.base.source_id) ?? 0;
        const penalty = repeated * weights.source_diversity_penalty;
        return {
          candidate,
          penalty,
          score: Math.max(0, candidate.baseScore - penalty)
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.base.chunk_id.localeCompare(right.candidate.base.chunk_id)
      );
    const next = ranked[0];
    if (next === undefined) {
      break;
    }
    const { candidate, penalty, score } = next;
    selected.push({
      ...candidate.base,
      score,
      explain: {
        lexical_score: candidate.lexical?.score ?? 0,
        vector_score: candidate.vector?.score ?? 0,
        hybrid_score: score,
        normalized_lexical_score: candidate.normalizedLexical,
        normalized_vector_score: candidate.normalizedVector,
        freshness_score: candidate.freshness,
        source_diversity_penalty: penalty,
        retrieval_mode: "hybrid",
        matched_terms: candidate.lexical?.explain?.matched_terms ?? [],
        term_hits: candidate.lexical?.explain?.term_hits ?? {},
        phrase_bonus: candidate.lexical?.explain?.phrase_bonus ?? 0,
        source_last_modified_at:
          candidate.lexical?.explain?.source_last_modified_at,
        source_first_indexed_at:
          candidate.lexical?.explain?.source_first_indexed_at,
        source_last_seen_at: candidate.lexical?.explain?.source_last_seen_at,
        source_current_modified_at:
          candidate.lexical?.explain?.source_current_modified_at,
        source_age_days: candidate.lexical?.explain?.source_age_days,
        indexed_age_days: candidate.lexical?.explain?.indexed_age_days,
        stale_source: candidate.lexical?.explain?.stale_source ?? false,
        warnings: candidate.lexical?.explain?.warnings ?? []
      }
    });
    sourceCounts.set(
      candidate.base.source_id,
      (sourceCounts.get(candidate.base.source_id) ?? 0) + 1
    );
    remaining.splice(remaining.indexOf(candidate), 1);
  }

  return selected;
}

function normalizeWeights(weights: RagHybridWeights): RagHybridWeights {
  const positiveTotal =
    Math.max(0, weights.lexical) +
    Math.max(0, weights.vector) +
    Math.max(0, weights.freshness);
  if (positiveTotal === 0) {
    throw new Error("RAG hybrid weights must contain a positive ranking weight.");
  }
  return {
    lexical: Math.max(0, weights.lexical) / positiveTotal,
    vector: Math.max(0, weights.vector) / positiveTotal,
    freshness: Math.max(0, weights.freshness) / positiveTotal,
    source_diversity_penalty: Math.max(0, weights.source_diversity_penalty)
  };
}

function positiveMax(values: number[]): number {
  return Math.max(0, ...values);
}

function normalizeScore(value: number | undefined, maximum: number): number {
  return value === undefined || maximum <= 0 ? 0 : Math.max(0, value / maximum);
}

function freshnessScore(result: RagSearchResult | undefined): number {
  const age = result?.explain?.source_age_days;
  if (age === undefined) {
    return 1;
  }
  return 1 / (1 + Math.max(0, age) / 30);
}
