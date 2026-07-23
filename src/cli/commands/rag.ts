import {
  buildRagIndex,
  compactRagIndex,
  getRagIndexStatus,
  type BuildRagIndexOptions,
  type RagCollection,
  type RagSearchExplain,
  type RagSearchRequest,
  type RagSourceType
} from "../../rag/lexical-index.js";
import {
  executeRagRebuild,
  getRagStats,
  planRagRebuild,
  verifyRagIndex
} from "../../rag/integrity.js";
import { evaluateRagRetrieval } from "../../rag/evaluation.js";
import {
  retrieveRag,
  type RagRetrievalMode
} from "../../rag/retriever.js";
import {
  executeRagVectorBuild,
  getRagVectorProviderStatus,
  planRagVectorBuild
} from "../../rag/vector-provider.js";

export type RagRefreshCommandOptions = {
  since?: string;
  type?: string;
  limit?: string;
  prune?: boolean;
  compact?: boolean;
  maxArtifactAgeDays?: string;
};

export type RagCompactCommandOptions = {
  maxArtifactAgeDays?: string;
};

export type RagQueryCommandOptions = {
  mode?: string;
  type?: string;
  collection?: string;
  limit?: string;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  reviewId?: string;
  reviewLoopId?: string;
  date?: string;
  severity?: string;
  explain?: boolean;
};

export type RagRebuildCommandOptions = {
  dryRun?: boolean;
  compare?: boolean;
  execute?: boolean;
  confirm?: string;
};

export type RagVectorBuildCommandOptions = {
  dryRun?: boolean;
  execute?: boolean;
  confirm?: string;
};

const sourceTypes: RagSourceType[] = [
  "rule",
  "task_state",
  "handoff",
  "document",
  "decision",
  "review",
  "approval",
  "failure",
  "daily_report",
  "code_index"
];

const collections: RagCollection[] = [
  "project_rules",
  "task_state",
  "code_index",
  "decisions",
  "reviews",
  "approvals",
  "failures",
  "daily_reports",
  "documents"
];

export async function refreshRagIndexCommand(
  projectRoot: string,
  options: RagRefreshCommandOptions = {}
): Promise<string> {
  const buildOptions: BuildRagIndexOptions = {
    since: parseSince(options.since),
    sourceTypes: parseEnumList(options.type, sourceTypes, "source type"),
    limit: parseOptionalLimit(options.limit),
    prune: options.prune === true || options.compact === true,
    compact: options.compact === true,
    maxArtifactAgeDays: parseOptionalPositiveInteger(
      options.maxArtifactAgeDays,
      "RAG max artifact age days"
    )
  };
  const result = await buildRagIndex(projectRoot, buildOptions);
  return [
    "Kairon RAG index refreshed.",
    `index=${result.index_path}`,
    `mode=${result.refresh_mode}`,
    `sources=${result.source_count}`,
    `chunks=${result.chunk_count}`,
    `scanned_sources=${result.scanned_source_count}`,
    `added_sources=${result.added_source_count}`,
    `updated_sources=${result.updated_source_count}`,
    `unchanged_sources=${result.unchanged_source_count}`,
    `skipped_sources=${result.skipped_source_count}`,
    `skipped_protected=${result.skipped_protected_count}`,
    `skipped_generated=${result.skipped_generated_count}`,
    `skipped_missing=${result.skipped_missing_count}`,
    `skipped_archived=${result.skipped_archived_count}`,
    ...formatReasonCounts("skipped_reason", result.skipped_reason_counts),
    `pruned_sources=${result.pruned_source_count}`,
    `pruned_missing_sources=${result.pruned_missing_source_count}`,
    `pruned_excluded_sources=${result.pruned_excluded_source_count}`,
    `pruned_protected_sources=${result.pruned_protected_source_count}`,
    `pruned_generated_sources=${result.pruned_generated_source_count}`,
    `pruned_archived_sources=${result.pruned_archived_source_count}`,
    `pruned_ephemeral_sources=${result.pruned_ephemeral_source_count}`,
    ...formatReasonCounts("pruned_reason", result.pruned_reason_counts),
    `updated_at=${result.index.updated_at}`
  ].join("\n");
}

export async function compactRagIndexCommand(
  projectRoot: string,
  options: RagCompactCommandOptions = {}
): Promise<string> {
  const result = await compactRagIndex(projectRoot, {
    maxArtifactAgeDays: parseOptionalPositiveInteger(
      options.maxArtifactAgeDays,
      "RAG max artifact age days"
    )
  });
  return [
    "Kairon RAG index compacted.",
    `index=${result.index_path}`,
    `exists=${result.index_exists}`,
    `sources=${result.source_count}`,
    `chunks=${result.chunk_count}`,
    `removed_sources=${result.removed_source_count}`,
    `removed_missing_sources=${result.removed_missing_source_count}`,
    `removed_excluded_sources=${result.removed_excluded_source_count}`,
    `removed_protected_sources=${result.removed_protected_source_count}`,
    `removed_generated_sources=${result.removed_generated_source_count}`,
    `removed_archived_sources=${result.removed_archived_source_count}`,
    `removed_ephemeral_sources=${result.removed_ephemeral_source_count}`,
    `compacted_at=${result.compacted_at}`
  ].join("\n");
}

export async function statusRagIndexCommand(projectRoot: string): Promise<string> {
  const status = await getRagIndexStatus(projectRoot);
  return [
    "Kairon RAG status.",
    `enabled=${status.enabled}`,
    `index=${status.index_path}`,
    `exists=${status.exists}`,
    `sources=${status.source_count}`,
    `chunks=${status.chunk_count}`,
    `freshness=${status.freshness_status}`,
    `pending_added_sources=${status.pending_added_source_count}`,
    `pending_changed_sources=${status.pending_changed_source_count}`,
    `pending_missing_sources=${status.pending_missing_source_count}`,
    `skipped_sources=${status.skipped_source_count}`,
    `skipped_protected=${status.skipped_protected_count}`,
    `skipped_generated=${status.skipped_generated_count}`,
    `skipped_missing=${status.skipped_missing_count}`,
    `skipped_archived=${status.skipped_archived_count}`,
    ...(status.index_size_bytes === undefined
      ? []
      : [`index_size_bytes=${status.index_size_bytes}`]),
    ...(status.last_refresh_at === undefined
      ? []
      : [`last_refresh_at=${status.last_refresh_at}`]),
    ...(status.last_refresh_mode === undefined
      ? []
      : [`last_refresh_mode=${status.last_refresh_mode}`]),
    ...(status.last_refresh_added_sources === undefined
      ? []
      : [`last_refresh_added_sources=${status.last_refresh_added_sources}`]),
    ...(status.last_refresh_updated_sources === undefined
      ? []
      : [`last_refresh_updated_sources=${status.last_refresh_updated_sources}`]),
    ...(status.last_refresh_unchanged_sources === undefined
      ? []
      : [`last_refresh_unchanged_sources=${status.last_refresh_unchanged_sources}`]),
    ...(status.last_refresh_skipped_reasons === undefined
      ? []
      : formatReasonCounts(
          "last_refresh_skipped_reason",
          status.last_refresh_skipped_reasons
        )),
    ...(status.last_refresh_pruned_reasons === undefined
      ? []
      : formatReasonCounts(
          "last_refresh_pruned_reason",
          status.last_refresh_pruned_reasons
        )),
    ...(status.last_compacted_at === undefined
      ? []
      : [`last_compacted_at=${status.last_compacted_at}`]),
    ...(status.last_compaction_removed_sources === undefined
      ? []
      : [`last_compaction_removed_sources=${status.last_compaction_removed_sources}`]),
    ...(status.created_at === undefined ? [] : [`created_at=${status.created_at}`]),
    ...(status.updated_at === undefined ? [] : [`updated_at=${status.updated_at}`])
  ].join("\n");
}

export async function queryRagIndexCommand(
  projectRoot: string,
  query: string,
  options: RagQueryCommandOptions
): Promise<string> {
  const mode = parseRetrievalMode(options.mode);
  const request: RagSearchRequest & { mode?: RagRetrievalMode } = {
    query,
    topK: parseLimit(options.limit),
    explain: options.explain === true,
    filters: buildFilters(options),
    mode
  };
  const retrieval = await retrieveRag(projectRoot, request);
  const results = retrieval.results;
  const lines = [
    "Kairon RAG query completed.",
    `requested_mode=${retrieval.requested_mode}`,
    `effective_mode=${retrieval.effective_mode}`,
    `status=${retrieval.status}`,
    ...(retrieval.fallback_reason === undefined
      ? []
      : [`fallback_reason=${retrieval.fallback_reason}`]),
    `matches=${results.length}`
  ];

  for (const [index, result] of results.entries()) {
    lines.push(
      `[${index + 1}] score=${formatScore(result.score)}`,
      `path=${result.path}`,
      `source_type=${result.source_type}`,
      `collection=${result.metadata.collection}`,
      `hash=${result.content_hash}`,
      ...formatMetadata(result.metadata),
      ...formatExplain(result.explain),
      `text=${formatExcerpt(result.text)}`
    );
  }

  return lines.join("\n");
}

export async function statusRagProviderCommand(
  projectRoot: string
): Promise<string> {
  const result = await getRagVectorProviderStatus(projectRoot);
  return [
    "Kairon RAG provider status.",
    `status=${result.capability === "ready" ? "READY" : "SETUP_REQUIRED"}`,
    `provider=${result.provider}`,
    `enabled=${result.enabled}`,
    `local_only=${result.local_only}`,
    `external_network=${result.external_network}`,
    `model_id=${result.model_id}`,
    `dimension=${result.dimension}`,
    ...(result.reason === undefined ? [] : [`reason=${result.reason}`]),
    ...(result.setup_hint === undefined
      ? []
      : [`setup_hint=${result.setup_hint}`])
  ].join("\n");
}

export async function buildRagVectorCommand(
  projectRoot: string,
  options: RagVectorBuildCommandOptions
): Promise<string> {
  if (options.execute === true) {
    if (options.dryRun === true) {
      throw new Error("RAG vector build cannot combine --dry-run and --execute.");
    }
    if (options.confirm === undefined) {
      throw new Error(
        "RAG vector build --execute requires --confirm <build-id>."
      );
    }
    return formatVectorBuild(
      await executeRagVectorBuild(projectRoot, options.confirm),
      "executed"
    );
  }
  if (options.dryRun !== true) {
    throw new Error("RAG vector build requires --dry-run or --execute.");
  }
  return formatVectorBuild(await planRagVectorBuild(projectRoot), "planned");
}

export async function evaluateRagCommand(
  projectRoot: string,
  profile = "default"
): Promise<string> {
  const result = await evaluateRagRetrieval(projectRoot, profile);
  return [
    "Kairon RAG evaluation completed.",
    `evaluation_id=${result.evaluation_id}`,
    `profile=${result.profile}`,
    `status=${result.status}`,
    `queries=${result.query_count}`,
    `passed=${result.passed_query_count}`,
    `unpassed=${result.unpassed_query_count}`,
    `setup_required=${result.setup_required_query_count}`,
    `mean_precision_at_k=${result.mean_precision_at_k.toFixed(4)}`,
    `artifact=${result.artifact_path}`,
    ...result.results.flatMap((query) => [
      `query.${query.id}.status=${query.status}`,
      `query.${query.id}.required_hit=${query.required_hit}`,
      `query.${query.id}.forbidden_hits=${query.forbidden_hit_count}`,
      `query.${query.id}.precision_at_k=${query.precision_at_k.toFixed(4)}`,
      `query.${query.id}.retrieval_status=${query.retrieval_status}`
    ])
  ].join("\n");
}

export async function verifyRagIndexCommand(projectRoot: string): Promise<string> {
  const result = await verifyRagIndex(projectRoot);
  return [
    "Kairon RAG integrity verified.",
    `status=${result.status}`,
    `index=${result.index_path}`,
    `sources=${result.source_count}`,
    `chunks=${result.chunk_count}`,
    `issues=${result.issue_count}`,
    ...(result.index_checksum === undefined
      ? []
      : [`index_checksum=${result.index_checksum}`]),
    ...(result.source_manifest_checksum === undefined
      ? []
      : [`source_manifest_checksum=${result.source_manifest_checksum}`]),
    ...result.issues.map(
      (issue) =>
        `issue=${issue.code}:${issue.member_id ?? "none"}:${issue.path ?? "none"}`
    ),
    `checked_at=${result.checked_at}`
  ].join("\n");
}

export async function statsRagIndexCommand(projectRoot: string): Promise<string> {
  const result = await getRagStats(projectRoot);
  return [
    "Kairon RAG statistics.",
    `index=${result.index_path}`,
    `exists=${result.exists}`,
    `sources=${result.source_count}`,
    `chunks=${result.chunk_count}`,
    `duplicate_chunks=${result.duplicate_chunk_count}`,
    `duplicate_ratio=${result.duplicate_ratio.toFixed(4)}`,
    `total_characters=${result.total_characters}`,
    `estimated_total_tokens=${result.estimated_total_tokens}`,
    `largest_chunk_estimated_tokens=${result.largest_chunk_estimated_tokens}`,
    `context_budget_tokens=${result.context_budget_tokens}`,
    `chunks_exceeding_context_budget=${result.chunks_exceeding_context_budget}`,
    `rebuild_interval_days=${result.rebuild_interval_days}`,
    `rebuild_due=${result.rebuild_due}`,
    `retention_candidates=${result.retention_candidate_count}`,
    `checked_at=${result.checked_at}`
  ].join("\n");
}

export async function rebuildRagIndexCommand(
  projectRoot: string,
  options: RagRebuildCommandOptions
): Promise<string> {
  if (options.execute === true) {
    if (options.dryRun === true) {
      throw new Error("RAG rebuild cannot combine --dry-run and --execute.");
    }
    if (options.confirm === undefined) {
      throw new Error("RAG rebuild --execute requires --confirm <rebuild-id>.");
    }
    const result = await executeRagRebuild(projectRoot, options.confirm, {
      confirm: options.confirm
    });
    return formatRagRebuild(result, "executed");
  }
  if (options.dryRun !== true) {
    throw new Error("RAG rebuild requires --dry-run or --execute.");
  }
  const result = await planRagRebuild(projectRoot);
  return formatRagRebuild(result, options.compare === true ? "compared" : "planned");
}

function formatRagRebuild(
  result: Awaited<ReturnType<typeof planRagRebuild>>,
  action: "planned" | "compared" | "executed"
): string {
  return [
    `Kairon RAG rebuild ${action}.`,
    `rebuild_id=${result.rebuild_id}`,
    `status=${result.status}`,
    `index=${result.index_path}`,
    `current_checksum=${result.current.checksum ?? "none"}`,
    `candidate_checksum=${result.candidate.checksum}`,
    `current_sources=${result.current.source_count}`,
    `candidate_sources=${result.candidate.source_count}`,
    `current_chunks=${result.current.chunk_count}`,
    `candidate_chunks=${result.candidate.chunk_count}`,
    `comparison=${result.comparison.status}`,
    `source_delta=${result.comparison.source_delta}`,
    `chunk_delta=${result.comparison.chunk_delta}`,
    `query_regressions=${result.comparison.query_samples.filter((sample) => sample.regression).length}`,
    `reasons=${result.comparison.reasons.join(",") || "none"}`,
    ...(result.executed_at === undefined ? [] : [`executed_at=${result.executed_at}`])
  ].join("\n");
}

function formatVectorBuild(
  result: Awaited<ReturnType<typeof planRagVectorBuild>>,
  action: "planned" | "executed"
): string {
  return [
    `Kairon RAG vector build ${action}.`,
    `build_id=${result.build_id}`,
    `status=${result.status === "setup_required" ? "SETUP_REQUIRED" : result.status}`,
    `provider=${result.provider.provider}`,
    `model_id=${result.provider.model_id}`,
    `dimension=${result.provider.dimension}`,
    `local_only=${result.provider.local_only}`,
    `index=${result.index_path}`,
    `manifest=${result.manifest_path}`,
    `entries=${result.entry_count}`,
    `reused_entries=${result.reused_entry_count}`,
    `embedded_entries=${result.embedded_entry_count}`,
    ...(result.source_manifest_checksum === undefined
      ? []
      : [`source_manifest_checksum=${result.source_manifest_checksum}`]),
    ...(result.lexical_index_checksum === undefined
      ? []
      : [`lexical_index_checksum=${result.lexical_index_checksum}`]),
    ...(result.candidate_index_checksum === undefined
      ? []
      : [`candidate_index_checksum=${result.candidate_index_checksum}`]),
    ...(result.provider.reason === undefined
      ? []
      : [`reason=${result.provider.reason}`]),
    ...(result.executed_at === undefined
      ? []
      : [`executed_at=${result.executed_at}`])
  ].join("\n");
}

function buildFilters(options: RagQueryCommandOptions): RagSearchRequest["filters"] {
  const filters: NonNullable<RagSearchRequest["filters"]> = {};
  const sourceTypeFilter = parseEnumList(options.type, sourceTypes, "source type");
  const collectionFilter = parseEnumList(options.collection, collections, "collection");

  if (sourceTypeFilter !== undefined) {
    filters.source_types = sourceTypeFilter;
  }
  if (collectionFilter !== undefined) {
    filters.collections = collectionFilter;
  }
  if (options.taskId !== undefined) {
    filters.task_id = options.taskId;
  }
  if (options.runId !== undefined) {
    filters.run_id = options.runId;
  }
  if (options.approvalId !== undefined) {
    filters.approval_id = options.approvalId;
  }
  if (options.reviewId !== undefined) {
    filters.review_id = options.reviewId;
  }
  if (options.reviewLoopId !== undefined) {
    filters.review_loop_id = options.reviewLoopId;
  }
  if (options.date !== undefined) {
    filters.date = options.date;
  }
  if (options.severity !== undefined) {
    filters.severity = options.severity.toLowerCase();
  }

  return Object.keys(filters).length === 0 ? undefined : filters;
}

function parseLimit(value: string | undefined): number {
  return parseOptionalLimit(value) ?? 5;
}

function parseRetrievalMode(value: string | undefined): RagRetrievalMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!["lexical", "vector", "hybrid"].includes(value)) {
    throw new Error(
      `Invalid RAG retrieval mode: ${value}. Allowed values: lexical,vector,hybrid`
    );
  }
  return value as RagRetrievalMode;
}

function parseOptionalLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid RAG limit: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid RAG since timestamp: ${value}`);
  }

  return parsed;
}

function parseEnumList<T extends string>(
  value: string | undefined,
  allowed: T[],
  label: string
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const items = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    return undefined;
  }

  for (const item of items) {
    if (!allowed.includes(item as T)) {
      throw new Error(
        `Invalid RAG ${label}: ${item}. Allowed values: ${allowed.join(",")}`
      );
    }
  }

  return items as T[];
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatReasonCounts(
  prefix: string,
  values: Record<string, number>
): string[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${prefix}.${reason}=${count}`);
}

function formatMetadata(metadata: Record<string, unknown>): string[] {
  return [
    "task_id",
    "run_id",
    "approval_id",
    "review_id",
    "review_loop_id",
    "date",
    "severity",
    "status",
    "agent",
    "persona"
  ].flatMap((key) => {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0
      ? [`metadata.${key}=${value}`]
      : [];
  });
}

function formatExplain(explain: RagSearchExplain | undefined): string[] {
  if (explain === undefined) {
    return [];
  }

  return [
    `explain.lexical_score=${formatScore(explain.lexical_score)}`,
    ...(explain.vector_score === undefined
      ? []
      : [`explain.vector_score=${formatScore(explain.vector_score)}`]),
    ...(explain.hybrid_score === undefined
      ? []
      : [`explain.hybrid_score=${formatScore(explain.hybrid_score)}`]),
    ...(explain.normalized_lexical_score === undefined
      ? []
      : [
          `explain.normalized_lexical_score=${formatScore(
            explain.normalized_lexical_score
          )}`
        ]),
    ...(explain.normalized_vector_score === undefined
      ? []
      : [
          `explain.normalized_vector_score=${formatScore(
            explain.normalized_vector_score
          )}`
        ]),
    ...(explain.freshness_score === undefined
      ? []
      : [`explain.freshness_score=${formatScore(explain.freshness_score)}`]),
    ...(explain.source_diversity_penalty === undefined
      ? []
      : [
          `explain.source_diversity_penalty=${formatScore(
            explain.source_diversity_penalty
          )}`
        ]),
    ...(explain.retrieval_mode === undefined
      ? []
      : [`explain.retrieval_mode=${explain.retrieval_mode}`]),
    `explain.matched_terms=${explain.matched_terms.join(",")}`,
    `explain.term_hits=${formatTermHits(explain.term_hits)}`,
    `explain.phrase_bonus=${formatScore(explain.phrase_bonus)}`,
    ...(explain.source_last_modified_at === undefined
      ? []
      : [`freshness.source_last_modified_at=${explain.source_last_modified_at}`]),
    ...(explain.source_current_modified_at === undefined
      ? []
      : [`freshness.source_current_modified_at=${explain.source_current_modified_at}`]),
    ...(explain.source_first_indexed_at === undefined
      ? []
      : [`freshness.source_first_indexed_at=${explain.source_first_indexed_at}`]),
    ...(explain.source_last_seen_at === undefined
      ? []
      : [`freshness.source_last_seen_at=${explain.source_last_seen_at}`]),
    ...(explain.source_age_days === undefined
      ? []
      : [`freshness.source_age_days=${formatScore(explain.source_age_days)}`]),
    ...(explain.indexed_age_days === undefined
      ? []
      : [`freshness.indexed_age_days=${formatScore(explain.indexed_age_days)}`]),
    `freshness.stale_source=${explain.stale_source}`,
    ...explain.warnings.map((warning) => `warning=${warning}`)
  ];
}

function formatTermHits(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return entries.length === 0
    ? "none"
    : entries.map(([term, count]) => `${term}:${count}`).join(",");
}

function formatExcerpt(text: string): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /"([^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"[^"]*"/giu,
      (_match, key: string) => `"${key}":"[redacted]"`
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    );
}
