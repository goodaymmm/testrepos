import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import { retrieveRag, type RagRetrievalMode } from "./retriever.js";

export type RagEvaluationStatus = "PASS" | "UNPASSED" | "SETUP_REQUIRED";

export type RagEvaluationQuery = {
  id: string;
  query: string;
  expected_paths: string[];
  forbidden_paths?: string[];
};

export type RagEvaluationProfile = {
  mode: RagRetrievalMode;
  top_k: number;
  minimum_precision_at_k: number;
  queries: RagEvaluationQuery[];
};

export type RagEvaluationQueryResult = {
  id: string;
  status: RagEvaluationStatus;
  result_count: number;
  expected_hit_count: number;
  forbidden_hit_count: number;
  required_hit: boolean;
  precision_at_k: number;
  matched_expected_paths: string[];
  matched_forbidden_paths: string[];
  result_paths: string[];
  retrieval_status: "ready" | "degraded";
  effective_mode: RagRetrievalMode;
  fallback_reason?: string;
};

export type RagEvaluationArtifact = {
  schema_version: "0.1";
  artifact_kind: "rag_evaluation";
  evaluation_id: string;
  profile: string;
  requested_mode?: RagRetrievalMode;
  status: RagEvaluationStatus;
  query_count: number;
  passed_query_count: number;
  unpassed_query_count: number;
  setup_required_query_count: number;
  mean_precision_at_k: number;
  results: RagEvaluationQueryResult[];
  evaluated_at: string;
  artifact_path: string;
};

type RagConfig = {
  storage?: { base_dir?: string };
  evaluation?: {
    profiles?: Record<string, RagEvaluationProfile>;
  };
};

export async function evaluateRagRetrieval(
  projectRoot: string,
  profileName = "default",
  options: { now?: Date } = {}
): Promise<RagEvaluationArtifact> {
  const now = options.now ?? new Date();
  const config = await loadConfigFile<RagConfig>(projectRoot, "rag.json");
  const profile = config.evaluation?.profiles?.[profileName];
  const evaluationId = createEvaluationId(now);
  const artifactPath = resolveInside(
    projectRoot,
    config.storage?.base_dir ?? ".kairon/rag",
    "evaluations",
    `${evaluationId}.json`
  );

  if (profile === undefined || profile.queries.length === 0) {
    const artifact: RagEvaluationArtifact = {
      schema_version: "0.1",
      artifact_kind: "rag_evaluation",
      evaluation_id: evaluationId,
      profile: profileName,
      status: "SETUP_REQUIRED",
      query_count: 0,
      passed_query_count: 0,
      unpassed_query_count: 0,
      setup_required_query_count: 0,
      mean_precision_at_k: 0,
      results: [],
      evaluated_at: now.toISOString(),
      artifact_path: toProjectPath(projectRoot, artifactPath)
    };
    await writeJsonFileAtomic(artifactPath, artifact);
    return artifact;
  }

  const results: RagEvaluationQueryResult[] = [];
  for (const query of profile.queries) {
    const retrieval = await retrieveRag(projectRoot, {
      query: query.query,
      mode: profile.mode,
      topK: profile.top_k,
      explain: false,
      now: () => now
    });
    const resultPaths = retrieval.results.map((result) => result.path);
    const matchedExpected = resultPaths.filter((candidate) =>
      query.expected_paths.some((pattern) => matchesPath(candidate, pattern))
    );
    const matchedForbidden = resultPaths.filter((candidate) =>
      (query.forbidden_paths ?? []).some((pattern) =>
        matchesPath(candidate, pattern)
      )
    );
    const precision =
      resultPaths.length === 0
        ? 0
        : matchedExpected.length / Math.min(profile.top_k, resultPaths.length);
    const setupRequired =
      retrieval.status === "degraded" && profile.mode !== "lexical";
    const passed =
      matchedExpected.length > 0 &&
      matchedForbidden.length === 0 &&
      precision >= profile.minimum_precision_at_k;
    results.push({
      id: query.id,
      status: setupRequired ? "SETUP_REQUIRED" : passed ? "PASS" : "UNPASSED",
      result_count: resultPaths.length,
      expected_hit_count: matchedExpected.length,
      forbidden_hit_count: matchedForbidden.length,
      required_hit: matchedExpected.length > 0,
      precision_at_k: round(precision),
      matched_expected_paths: [...new Set(matchedExpected)].sort(),
      matched_forbidden_paths: [...new Set(matchedForbidden)].sort(),
      result_paths: resultPaths,
      retrieval_status: retrieval.status,
      effective_mode: retrieval.effective_mode,
      fallback_reason: retrieval.fallback_reason
    });
  }

  const setupCount = results.filter(
    (result) => result.status === "SETUP_REQUIRED"
  ).length;
  const unpassedCount = results.filter(
    (result) => result.status === "UNPASSED"
  ).length;
  const passCount = results.filter((result) => result.status === "PASS").length;
  const artifact: RagEvaluationArtifact = {
    schema_version: "0.1",
    artifact_kind: "rag_evaluation",
    evaluation_id: evaluationId,
    profile: profileName,
    requested_mode: profile.mode,
    status:
      setupCount > 0
        ? "SETUP_REQUIRED"
        : unpassedCount > 0
          ? "UNPASSED"
          : "PASS",
    query_count: results.length,
    passed_query_count: passCount,
    unpassed_query_count: unpassedCount,
    setup_required_query_count: setupCount,
    mean_precision_at_k: round(
      results.reduce((sum, result) => sum + result.precision_at_k, 0) /
        results.length
    ),
    results,
    evaluated_at: now.toISOString(),
    artifact_path: toProjectPath(projectRoot, artifactPath)
  };
  await writeJsonFileAtomic(artifactPath, artifact);
  return artifact;
}

function createEvaluationId(now: Date): string {
  const compact = now.toISOString().replace(/[-:.]/gu, "").replace("Z", "");
  const stamp = `${compact.slice(0, 18)}Z`;
  const suffix = randomUUID().replace(/-/gu, "").slice(0, 8);
  return `RAG-EVAL-${stamp}-${suffix}`;
}

function matchesPath(candidate: string, pattern: string): boolean {
  const normalizedCandidate = toPosixPath(candidate);
  const normalizedPattern = toPosixPath(pattern);
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const regex = escaped
    .replace(/\*\*/gu, "\u0000")
    .replace(/\*/gu, "[^/]*")
    .replace(/\u0000/gu, ".*");
  return new RegExp(`^${regex}$`, "u").test(normalizedCandidate);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
