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
  counts: Record<OperationTestUpdateCandidateKind, number> & {
    total: number;
  };
  candidates: OperationTestUpdateCandidate[];
};

type SummaryResultById = {
  id: string;
  status: OperationTestStatus;
  source: string;
  details?: string;
};

const operationTestIdPattern = /\bOT-[A-Z0-9][A-Z0-9_-]*\b/i;
const taskIdPattern = /\bT\d+[A-Z]?\b/i;
const statusHeaderPattern = /^(status|result|results|判定|結果|現状)$/i;
const looseStatusHeaderPattern = /(status|result|判定|結果|現状)/i;
const separatorCellPattern = /^:?-{3,}:?$/;

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
  const summaryResults = summarizeResultsById(input.summary.results);
  const candidates = summaryResults.map((result) =>
    toUpdateCandidate(result, casesById.get(result.id), input.patchPreview === true)
  );

  return {
    schema_version: "0.1",
    test_list: testList,
    evidence_paths: input.summary.sources,
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
    `candidates.total=${suggestions.counts.total}`,
    `candidates.pass_update=${suggestions.counts.pass_update}`,
    `candidates.unpassed=${suggestions.counts.unpassed}`,
    `candidates.setup_required=${suggestions.counts.setup_required}`,
    `candidates.optional=${suggestions.counts.optional}`,
    `candidates.already_pass=${suggestions.counts.already_pass}`,
    `candidates.unknown_status=${suggestions.counts.unknown_status}`,
    `candidates.missing_from_list=${suggestions.counts.missing_from_list}`,
    ...suggestions.candidates.map(formatCandidate),
    ...(options.patchPreview === true
      ? formatPatchPreview(suggestions.candidates)
      : [])
  ].join("\n");
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
  results: OperationTestSummaryItem[]
): SummaryResultById[] {
  const byId = new Map<string, SummaryResultById>();

  for (const result of results) {
    const existing = byId.get(result.id);
    if (
      existing === undefined ||
      statusPriority[result.status] > statusPriority[existing.status]
    ) {
      byId.set(result.id, {
        id: result.id,
        status: result.status,
        source: result.source,
        details: result.details
      });
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toUpdateCandidate(
  result: SummaryResultById,
  testCase: OperationTestListCase | undefined,
  patchPreview: boolean
): OperationTestUpdateCandidate {
  if (testCase === undefined) {
    return {
      id: result.id,
      kind: "missing_from_list",
      suggested_status: result.status,
      source: result.source,
      details: sanitizeText(result.details)
    };
  }

  const kind = classifyCandidate(result.status, testCase.current_status);
  const candidate: OperationTestUpdateCandidate = {
    id: result.id,
    task_id: testCase.task_id,
    kind,
    current_status: testCase.current_status,
    suggested_status: result.status,
    line: testCase.line,
    source: result.source,
    details: sanitizeText(result.details)
  };

  if (patchPreview && testCase.status_column !== undefined) {
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

function previewStatusReplacement(
  testCase: OperationTestListCase,
  status: OperationTestStatus
): { before: string; after: string } {
  const cells = [...testCase.cells];
  cells[testCase.status_column ?? 0] = status;
  return {
    before: sanitizeText(testCase.row) ?? "",
    after: sanitizeText(`| ${cells.join(" | ")} |`) ?? ""
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
