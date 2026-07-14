import {
  buildRagIndex,
  compactRagIndex,
  getRagIndexStatus,
  type BuildRagIndexOptions,
  type RagCollection,
  type RagSearchExplain,
  type RagSearchRequest,
  searchRagIndex,
  type RagSourceType
} from "../../rag/lexical-index.js";

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
  const request: RagSearchRequest = {
    query,
    topK: parseLimit(options.limit),
    explain: options.explain === true,
    filters: buildFilters(options)
  };
  const results = await searchRagIndex(projectRoot, request);
  const lines = ["Kairon RAG query completed.", `matches=${results.length}`];

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
