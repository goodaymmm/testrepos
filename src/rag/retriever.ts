import { loadConfigFile } from "../core/config/load-config.js";
import {
  searchRagIndex,
  type RagSearchRequest,
  type RagSearchResult
} from "./lexical-index.js";
import { rankHybridRagResults, type RagHybridWeights } from "./hybrid-ranker.js";
import {
  searchRagVectorIndex,
  type RagVectorProviderStatus
} from "./vector-provider.js";

export type RagRetrievalMode = "lexical" | "vector" | "hybrid";
export type RagRetrievalStatus = "ready" | "degraded";

export type RagRetrievalRequest = RagSearchRequest & {
  mode?: RagRetrievalMode;
};

export type RagRetrievalResponse = {
  schema_version: "0.1";
  requested_mode: RagRetrievalMode;
  effective_mode: RagRetrievalMode;
  status: RagRetrievalStatus;
  fallback_reason?: string;
  vector_provider?: RagVectorProviderStatus;
  results: RagSearchResult[];
};

type RagConfig = {
  retrieval?: {
    default_mode?: RagRetrievalMode;
    hybrid?: Partial<RagHybridWeights>;
  };
};

export async function retrieveRag(
  projectRoot: string,
  request: RagRetrievalRequest
): Promise<RagRetrievalResponse> {
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const mode = request.mode ?? config.retrieval?.default_mode ?? "lexical";
  const topK = request.topK ?? 5;

  if (mode === "lexical") {
    const results = await searchRagIndex(projectRoot, request);
    return {
      schema_version: "0.1",
      requested_mode: mode,
      effective_mode: "lexical",
      status: "ready",
      results: markRetrievalMode(results, "lexical", request.explain === true)
    };
  }

  const vector = await searchRagVectorIndex(projectRoot, request);
  if (mode === "vector" && vector.status === "ready") {
    return {
      schema_version: "0.1",
      requested_mode: mode,
      effective_mode: "vector",
      status: "ready",
      vector_provider: vector.provider,
      results: markRetrievalMode(vector.results, "vector", request.explain === true)
    };
  }

  if (vector.status !== "ready") {
    const lexical = await searchRagIndex(projectRoot, request);
    return {
      schema_version: "0.1",
      requested_mode: mode,
      effective_mode: "lexical",
      status: "degraded",
      fallback_reason: vector.reason ?? `vector status is ${vector.status}`,
      vector_provider: vector.provider,
      results: lexical.map((result) => ({
        ...result,
        ...(request.explain === true
          ? {
              explain: {
                lexical_score: result.explain?.lexical_score ?? result.score,
                matched_terms: result.explain?.matched_terms ?? [],
                term_hits: result.explain?.term_hits ?? {},
                phrase_bonus: result.explain?.phrase_bonus ?? 0,
                source_last_modified_at:
                  result.explain?.source_last_modified_at,
                source_first_indexed_at:
                  result.explain?.source_first_indexed_at,
                source_last_seen_at: result.explain?.source_last_seen_at,
                source_current_modified_at:
                  result.explain?.source_current_modified_at,
                source_age_days: result.explain?.source_age_days,
                indexed_age_days: result.explain?.indexed_age_days,
                stale_source: result.explain?.stale_source ?? false,
                warnings: [
                  ...(result.explain?.warnings ?? []),
                  `vector_fallback:${sanitizeReason(
                    vector.reason ?? vector.status
                  )}`
                ],
                retrieval_mode: "lexical" as const
              }
            }
          : {})
      }))
    };
  }

  const candidateK = Math.max(topK * 4, 20);
  const lexical = await searchRagIndex(projectRoot, {
    ...request,
    topK: candidateK,
    explain: true
  });
  const vectorCandidates =
    vector.results.length >= candidateK
      ? vector.results
      : (
          await searchRagVectorIndex(projectRoot, {
            ...request,
            topK: candidateK,
            explain: true
          })
        ).results;
  const results = rankHybridRagResults(lexical, vectorCandidates, {
    topK,
    weights: config.retrieval?.hybrid
  });
  return {
    schema_version: "0.1",
    requested_mode: mode,
    effective_mode: "hybrid",
    status: "ready",
    vector_provider: vector.provider,
    results: request.explain === true
      ? results
      : results.map(({ explain: _explain, ...result }) => result)
  };
}

function markRetrievalMode(
  results: RagSearchResult[],
  mode: "lexical" | "vector",
  explain: boolean
): RagSearchResult[] {
  if (!explain) {
    return results;
  }
  return results.map((result) => ({
    ...result,
    explain: {
      lexical_score: result.explain?.lexical_score ?? (mode === "lexical" ? result.score : 0),
      vector_score:
        result.explain?.vector_score ?? (mode === "vector" ? result.score : undefined),
      matched_terms: result.explain?.matched_terms ?? [],
      term_hits: result.explain?.term_hits ?? {},
      phrase_bonus: result.explain?.phrase_bonus ?? 0,
      source_last_modified_at: result.explain?.source_last_modified_at,
      source_first_indexed_at: result.explain?.source_first_indexed_at,
      source_last_seen_at: result.explain?.source_last_seen_at,
      source_current_modified_at: result.explain?.source_current_modified_at,
      source_age_days: result.explain?.source_age_days,
      indexed_age_days: result.explain?.indexed_age_days,
      stale_source: result.explain?.stale_source ?? false,
      warnings: result.explain?.warnings ?? [],
      retrieval_mode: mode
    }
  }));
}

function sanitizeReason(value: string): string {
  return value.replace(/\s+/gu, "_").toLowerCase().slice(0, 120);
}
