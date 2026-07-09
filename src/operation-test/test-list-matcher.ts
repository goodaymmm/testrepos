import path from "node:path";
import { toPosixPath } from "../core/fs/paths.js";
import type {
  OperationTestStatus,
  OperationTestSummary,
  OperationTestSummaryItem
} from "./result-summary.js";

export type OperationTestListStatus =
  | OperationTestStatus
  | "NOT_RUN"
  | "UNPASSED"
  | "SKIP"
  | "UNKNOWN";

export type OperationTestListCase = {
  id: string;
  task_id?: string;
  current_status: OperationTestListStatus;
  line: number;
  status_column?: number;
  name?: string;
  row: string;
  cells: string[];
};

export type OperationTestListAlias = {
  source_id: string;
  target_id: string;
  line: number;
};

export type OperationTestUpdateCandidateKind =
  | "pass_update"
  | "unpassed"
  | "setup_required"
  | "optional"
  | "already_pass"
  | "unknown_status"
  | "missing_from_list";

export type OperationTestUpdateCandidate = {
  id: string;
  original_id?: string;
  task_id?: string;
  kind: OperationTestUpdateCandidateKind;
  current_status?: OperationTestListStatus;
  suggested_status: OperationTestStatus;
  line?: number;
  source: string;
  details?: string;
  patch_preview?: {
    before: string;
    after: string;
  };
};

export type OperationTestUpdateSuggestions = {
  schema_version: "0.1";
  test_list: string;
  evidence_paths: string[];
  alias_count: number;
  alias_warnings: string[];
  counts: Record<OperationTestUpdateCandidateKind, number> & {
    total: number;
  };
  candidates: OperationTestUpdateCandidate[];
};

export type OperationTestPassApplyResult = {
  schema_version: "0.1";
  updated: number;
  skipped_already_pass: number;
  skipped_non_pass: number;
  applied: Array<{
    id: string;
    line: number;
    before: string;
    after: string;
  }>;
  markdown: string;
};

type SummaryResultById = {
  id: string;
  original_id?: string;
  status: OperationTestStatus;
  source: string;
  details?: string;
};

type AliasIndex = {
  aliasesBySourceId: Map<string, OperationTestListAlias>;
  warnings: string[];
};

const operationTestIdPattern = /\b(?:OT|RET)-[A-Z0-9][A-Z0-9_-]*\b/i;
const taskIdPattern = /\bT\d+[A-Z]?\b/i;
const statusHeaderPattern = /^(status|result|results|判定|結果|現状)$/i;
const looseStatusHeaderPattern = /(status|result|判定|結果|現状)/i;
const separatorCellPattern = /^:?-{3,}:?$/;
const aliasCommentPattern =
  /<!--\s*kairon:alias\s+([A-Za-z0-9_.:-]+)\s*=\s*((?:OT|RET)-[A-Za-z0-9][A-Za-z0-9_-]*)\s*-->/gi;

const statusPriority: Record<OperationTestStatus, number> = {
  FAIL: 4,
  SETUP_REQUIRED: 3,
  PASS: 2,
  OPTIONAL: 1
};

export function parseOperationTestListMarkdown(
  markdown: string
): OperationTestListCase[] {
  const lines = markdown.split(/\r?\n/);
  const cases: OperationTestListCase[] = [];
  let statusHeaderIndex: number | undefined;

  for (const [index, line] of lines.entries()) {
    const cells = parseMarkdownRow(line);
    if (cells === undefined || isSeparatorRow(cells)) {
      continue;
    }

    const idColumn = cells.findIndex((cell) => operationTestIdPattern.test(cell));
    if (idColumn === -1) {
      const headerIndex = findStatusHeaderIndex(cells);
      if (headerIndex !== undefined) {
        statusHeaderIndex = headerIndex;
      }
      continue;
    }

    const id = normalizeOperationTestId(cells[idColumn]);
    if (id === undefined) {
      continue;
    }

    const statusColumn = resolveStatusColumn(cells, statusHeaderIndex);
    const currentStatus =
      statusColumn === undefined
        ? "UNKNOWN"
        : normalizeListStatus(cells[statusColumn]) ?? "UNKNOWN";

    cases.push({
      id,
      task_id: inferTaskId(id, cells),
      current_status: currentStatus,
      line: index + 1,
      status_column: statusColumn,
      name: findName(cells, idColumn),
      row: line,
      cells
    });
  }

  return cases;
}

export function parseOperationTestListAliases(
  markdown: string
): OperationTestListAlias[] {
  const aliases: OperationTestListAlias[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(aliasCommentPattern)) {
      const sourceId = normalizeAliasSourceId(match[1]);
      const targetId = normalizeOperationTestId(match[2]);
      if (sourceId === undefined || targetId === undefined) {
        continue;
      }

      aliases.push({
        source_id: sourceId,
        target_id: targetId,
        line: index + 1
      });
    }
  }

  return aliases;
}

export function createOperationTestUpdateSuggestions(input: {
  projectRoot: string;
  testListPath: string;
  testListMarkdown: string;
  summary: OperationTestSummary;
  patchPreview?: boolean;
}): OperationTestUpdateSuggestions {
  const testList = toDisplayPath(input.projectRoot, input.testListPath);
  const cases = parseOperationTestListMarkdown(input.testListMarkdown);
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const aliases = buildAliasIndex(parseOperationTestListAliases(input.testListMarkdown));
  const summaryResults = summarizeResultsById(
    input.summary.results,
    casesById,
    aliases.aliasesBySourceId
  );
  const candidates = summaryResults.map((result) =>
    toUpdateCandidate(result, casesById.get(result.id), input.patchPreview === true)
  );

  return {
    schema_version: "0.1",
    test_list: testList,
    evidence_paths: input.summary.sources,
    alias_count: aliases.aliasesBySourceId.size,
    alias_warnings: aliases.warnings,
    counts: countCandidates(candidates),
    candidates
  };
}

export function formatOperationTestUpdateSuggestions(
  suggestions: OperationTestUpdateSuggestions,
  options: { patchPreview?: boolean } = {}
): string {
  return [
    "Kairon operation test update suggestions.",
    `test_list=${suggestions.test_list}`,
    `evidence_paths=${formatList(suggestions.evidence_paths)}`,
    `aliases.total=${suggestions.alias_count}`,
    `candidates.total=${suggestions.counts.total}`,
    `candidates.pass_update=${suggestions.counts.pass_update}`,
    `candidates.unpassed=${suggestions.counts.unpassed}`,
    `candidates.setup_required=${suggestions.counts.setup_required}`,
    `candidates.optional=${suggestions.counts.optional}`,
    `candidates.already_pass=${suggestions.counts.already_pass}`,
    `candidates.unknown_status=${suggestions.counts.unknown_status}`,
    `candidates.missing_from_list=${suggestions.counts.missing_from_list}`,
    ...suggestions.alias_warnings.map((warning) => `alias_warning=${warning}`),
    ...suggestions.candidates.map(formatCandidate),
    ...(options.patchPreview === true
      ? formatPatchPreview(suggestions.candidates)
      : [])
  ].join("\n");
}

export function applyOperationTestPassUpdates(input: {
  testListMarkdown: string;
  suggestions: OperationTestUpdateSuggestions;
}): OperationTestPassApplyResult {
  const lines = input.testListMarkdown.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(input.testListMarkdown);
  const casesById = new Map(
    parseOperationTestListMarkdown(input.testListMarkdown).map((testCase) => [
      testCase.id,
      testCase
    ])
  );
  const applied: OperationTestPassApplyResult["applied"] = [];
  let skippedAlreadyPass = 0;
  let skippedNonPass = 0;

  for (const candidate of input.suggestions.candidates) {
    if (candidate.kind === "already_pass") {
      skippedAlreadyPass += 1;
      continue;
    }

    if (candidate.kind !== "pass_update") {
      skippedNonPass += 1;
      continue;
    }

    const testCase = casesById.get(candidate.id);
    if (
      testCase === undefined ||
      testCase.status_column === undefined ||
      testCase.line < 1 ||
      testCase.line > lines.length
    ) {
      skippedNonPass += 1;
      continue;
    }

    const replacement = previewStatusReplacement(testCase, "PASS");
    lines[testCase.line - 1] = replacement.after;
    applied.push({
      id: candidate.id,
      line: testCase.line,
      before: replacement.before,
      after: replacement.after
    });
  }

  return {
    schema_version: "0.1",
    updated: applied.length,
    skipped_already_pass: skippedAlreadyPass,
    skipped_non_pass: skippedNonPass,
    applied,
    markdown: hasTrailingNewline ? lines.join("\n") : trimSplitTerminalLine(lines).join("\n")
  };
}

function parseMarkdownRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => stripMarkdown(cell));
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => separatorCellPattern.test(cell.trim()));
}

function findStatusHeaderIndex(cells: string[]): number | undefined {
  const exactIndex = cells.findIndex((cell) =>
    statusHeaderPattern.test(stripMarkdown(cell))
  );
  if (exactIndex !== -1) {
    return exactIndex;
  }

  const looseIndexes = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => looseStatusHeaderPattern.test(stripMarkdown(cell)));

  if (looseIndexes.length === 0) {
    return undefined;
  }

  return looseIndexes[looseIndexes.length - 1].index;
}

function resolveStatusColumn(
  cells: string[],
  statusHeaderIndex: number | undefined
): number | undefined {
  if (statusHeaderIndex !== undefined && statusHeaderIndex < cells.length) {
    return statusHeaderIndex;
  }

  const statusColumns = cells
    .map((cell, index) => ({ status: normalizeListStatus(cell), index }))
    .filter((item): item is { status: OperationTestListStatus; index: number } =>
      item.status !== undefined
    );

  if (statusColumns.length === 0) {
    return undefined;
  }

  return statusColumns[statusColumns.length - 1].index;
}

function normalizeListStatus(
  value: string | undefined
): OperationTestListStatus | undefined {
  const normalized = stripMarkdown(value ?? "")
    .replace(/\s+/g, "_")
    .toUpperCase();

  if (normalized.length === 0) {
    return undefined;
  }

  if (/^(NOT_RUN|NOTRUN|TODO|未実施|未着手)$/.test(normalized)) {
    return "NOT_RUN";
  }

  if (/^(SKIP|SKIPPED|対象外)$/.test(normalized)) {
    return "SKIP";
  }

  if (
    normalized.includes("未PASS") ||
    normalized.includes("未パス") ||
    normalized.includes("UNPASS") ||
    normalized.includes("NOT_PASS")
  ) {
    return "UNPASSED";
  }

  if (normalized.includes("SETUP_REQUIRED") || normalized.includes("SETUP-REQUIRED")) {
    return "SETUP_REQUIRED";
  }

  if (normalized === "FAIL" || normalized === "FAILED" || normalized === "NG") {
    return "FAIL";
  }

  if (normalized === "OPTIONAL" || normalized === "任意") {
    return "OPTIONAL";
  }

  if (normalized === "PASS" || normalized === "PASSED") {
    return "PASS";
  }

  return undefined;
}

function normalizeOperationTestId(value: string): string | undefined {
  const match = stripMarkdown(value).match(operationTestIdPattern);
  return match?.[0].toUpperCase();
}

function normalizeAliasSourceId(value: string): string | undefined {
  const id = stripMarkdown(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9_]*$/.test(id) ? id : undefined;
}

function inferTaskId(id: string, cells: string[]): string | undefined {
  const idMatch = id.match(taskIdPattern);
  if (idMatch !== null) {
    return idMatch[0].toUpperCase();
  }

  for (const cell of cells) {
    const match = stripMarkdown(cell).match(taskIdPattern);
    if (match !== null) {
      return match[0].toUpperCase();
    }
  }

  return undefined;
}

function findName(cells: string[], idColumn: number): string | undefined {
  const nextCell = cells[idColumn + 1];
  const sanitized = sanitizeText(nextCell);
  return sanitized === undefined || sanitized.length === 0 ? undefined : sanitized;
}

function summarizeResultsById(
  results: OperationTestSummaryItem[],
  casesById: Map<string, OperationTestListCase>,
  aliasesBySourceId: Map<string, OperationTestListAlias>
): SummaryResultById[] {
  const byId = new Map<string, SummaryResultById>();

  for (const result of results) {
    const resolved = resolveSummaryResultId(result, casesById, aliasesBySourceId);
    const existing = byId.get(resolved.id);
    if (
      existing === undefined ||
      statusPriority[result.status] > statusPriority[existing.status]
    ) {
      byId.set(resolved.id, {
        id: resolved.id,
        original_id: resolved.original_id,
        status: result.status,
        source: result.source,
        details: result.details
      });
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildAliasIndex(aliases: OperationTestListAlias[]): AliasIndex {
  const aliasesBySourceId = new Map<string, OperationTestListAlias>();
  const warnings: string[] = [];

  for (const alias of aliases) {
    const existing = aliasesBySourceId.get(alias.source_id);
    if (existing !== undefined && existing.target_id !== alias.target_id) {
      warnings.push(
        sanitizeText(
          `Alias ${alias.source_id} redefined from ${existing.target_id} to ${alias.target_id} at line ${alias.line}; using latest.`
        ) ?? `Alias ${alias.source_id} redefined at line ${alias.line}; using latest.`
      );
    }

    aliasesBySourceId.set(alias.source_id, alias);
  }

  return { aliasesBySourceId, warnings };
}

function resolveSummaryResultId(
  result: OperationTestSummaryItem,
  casesById: Map<string, OperationTestListCase>,
  aliasesBySourceId: Map<string, OperationTestListAlias>
): { id: string; original_id?: string } {
  if (casesById.has(result.id)) {
    return { id: result.id };
  }

  const alias = aliasesBySourceId.get(result.id);
  if (alias === undefined) {
    return { id: result.id };
  }

  return {
    id: alias.target_id,
    original_id: result.id
  };
}

function toUpdateCandidate(
  result: SummaryResultById,
  testCase: OperationTestListCase | undefined,
  patchPreview: boolean
): OperationTestUpdateCandidate {
  if (testCase === undefined) {
    return {
      id: result.id,
      original_id: result.original_id,
      kind: "missing_from_list",
      suggested_status: result.status,
      source: result.source,
      details: sanitizeText(result.details)
    };
  }

  const kind = classifyCandidate(result.status, testCase.current_status);
  const candidate: OperationTestUpdateCandidate = {
    id: result.id,
    original_id: result.original_id,
    task_id: testCase.task_id,
    kind,
    current_status: testCase.current_status,
    suggested_status: result.status,
    line: testCase.line,
    source: result.source,
    details: sanitizeText(result.details)
  };

  if (
    patchPreview &&
    testCase.status_column !== undefined &&
    shouldPreviewStatusReplacement(kind)
  ) {
    candidate.patch_preview = previewStatusReplacement(testCase, result.status);
  }

  return candidate;
}

function classifyCandidate(
  summaryStatus: OperationTestStatus,
  currentStatus: OperationTestListStatus
): OperationTestUpdateCandidateKind {
  if (currentStatus === "UNKNOWN") {
    return "unknown_status";
  }

  if (summaryStatus === "PASS") {
    return currentStatus === "PASS" ? "already_pass" : "pass_update";
  }

  if (summaryStatus === "FAIL") {
    return "unpassed";
  }

  if (summaryStatus === "SETUP_REQUIRED") {
    return "setup_required";
  }

  return "optional";
}

function shouldPreviewStatusReplacement(
  kind: OperationTestUpdateCandidateKind
): boolean {
  return kind === "pass_update";
}

function previewStatusReplacement(
  testCase: OperationTestListCase,
  status: OperationTestStatus
): { before: string; after: string } {
  const cells = splitRawMarkdownRow(testCase.row) ?? [...testCase.cells];
  const statusColumn = testCase.status_column ?? 0;
  cells[statusColumn] = replaceCellValue(cells[statusColumn] ?? "", status);
  return {
    before: sanitizeText(testCase.row) ?? "",
    after: sanitizeText(formatRawMarkdownRow(cells)) ?? ""
  };
}

function countCandidates(
  candidates: OperationTestUpdateCandidate[]
): OperationTestUpdateSuggestions["counts"] {
  const counts: OperationTestUpdateSuggestions["counts"] = {
    pass_update: 0,
    unpassed: 0,
    setup_required: 0,
    optional: 0,
    already_pass: 0,
    unknown_status: 0,
    missing_from_list: 0,
    total: candidates.length
  };

  for (const candidate of candidates) {
    counts[candidate.kind] += 1;
  }

  return counts;
}

function formatCandidate(candidate: OperationTestUpdateCandidate): string {
  return [
    `candidate.id=${candidate.id}`,
    candidate.original_id === undefined
      ? undefined
      : `original_id=${candidate.original_id}`,
    candidate.task_id === undefined ? undefined : `task=${candidate.task_id}`,
    `kind=${candidate.kind}`,
    candidate.current_status === undefined
      ? undefined
      : `current=${candidate.current_status}`,
    `suggested=${candidate.suggested_status}`,
    candidate.line === undefined ? undefined : `line=${candidate.line}`,
    `source=${candidate.source}`,
    candidate.details === undefined ? undefined : `details=${candidate.details}`
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");
}

function formatPatchPreview(
  candidates: OperationTestUpdateCandidate[]
): string[] {
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (candidate.patch_preview === undefined) {
      continue;
    }

    lines.push(
      `patch_preview.id=${candidate.id} line=${candidate.line ?? "(unknown)"}`,
      `patch_preview.before=${candidate.patch_preview.before}`,
      `patch_preview.after=${candidate.patch_preview.after}`
    );
  }

  return lines.length === 0 ? ["patch_preview=(none)"] : lines;
}

function formatList(values: string[]): string {
  return values.length === 0 ? "(none)" : values.join(",");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

function sanitizeText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',;\s]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function toDisplayPath(projectRoot: string, filePath: string): string {
  const absolutePath = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolutePath);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? toPosixPath(absolutePath)
    : toPosixPath(relative);
}

function splitRawMarkdownRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }

  return trimmed.slice(1, -1).split("|");
}

function replaceCellValue(cell: string, value: string): string {
  const leading = cell.match(/^\s*/)?.[0] ?? "";
  const trailing = cell.match(/\s*$/)?.[0] ?? "";
  return `${leading}${value}${trailing}`;
}

function formatRawMarkdownRow(cells: string[]): string {
  return `|${cells.join("|")}|`;
}

function trimSplitTerminalLine(lines: string[]): string[] {
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}
