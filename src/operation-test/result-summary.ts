import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toPosixPath } from "../core/fs/paths.js";

export type OperationTestStatus = "PASS" | "FAIL" | "SETUP_REQUIRED" | "OPTIONAL";

export type OperationTestSummaryItem = {
  id: string;
  status: OperationTestStatus;
  source: string;
  name?: string;
  details?: string;
};

export type OperationTestSummary = {
  schema_version: "0.1";
  sources: string[];
  summary: {
    pass: number;
    fail: number;
    setup_required: number;
    optional: number;
    total: number;
    source_files: number;
  };
  pass_ids: string[];
  fail_ids: string[];
  setup_required_ids: string[];
  optional_ids: string[];
  results: OperationTestSummaryItem[];
  warnings: string[];
};

export type OperationTestSummaryRequest = {
  projectRoot: string;
  logFile?: string;
  resultRoot?: string;
};

type HarnessSummaryJson = {
  results?: unknown;
  kind?: unknown;
  scenarios?: unknown;
};

type CandidateFile = {
  absolutePath: string;
  projectPath: string;
};

const statusValues = ["PASS", "FAIL", "SETUP_REQUIRED", "OPTIONAL"] as const;
const statusSet = new Set<string>(statusValues);
const ignoredResultRootDirectoryNames = new Set([
  ".git",
  ".kairon",
  "backup",
  "node_modules",
  "runs",
  "runtime",
  "sessions",
  "target-kairon-state-backup",
  "terminals",
  "worktrees"
]);
const textStatusLinePattern =
  /^\s*\[([A-Z0-9][A-Z0-9_-]*)\]\s+(PASS|FAIL|SETUP_REQUIRED|OPTIONAL)\b([^\r\n]*)/gm;
const markdownTablePattern =
  /^\|\s*([A-Z0-9][A-Z0-9_-]*)\s*\|[^|\r\n]*\|\s*(PASS|FAIL|SETUP_REQUIRED|OPTIONAL)\s*\|([^|\r\n]*)/gm;
const looseStatusFirstLinePattern =
  /^\s*(PASS|FAIL|SETUP_REQUIRED|OPTIONAL)\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s+([^\r\n]*))?$/gim;
const kaironCliResultLinePattern =
  /^\s*Kairon\s+(.+?)\s+(completed|failed|setup required)\.?\s*$/i;
const statusAssignmentLinePattern = /^\s*status\s*=\s*([A-Za-z_ -]+)\s*$/i;

export async function summarizeOperationTestResults(
  request: OperationTestSummaryRequest
): Promise<OperationTestSummary> {
  const projectRoot = path.resolve(request.projectRoot);
  const sources = await resolveSources(projectRoot, request);
  const warnings: string[] = [];
  const results: OperationTestSummaryItem[] = [];

  for (const source of sources) {
    try {
      const text = await readFile(source.absolutePath, "utf8");
      results.push(...parseSource(projectRoot, source, text));
    } catch (error) {
      warnings.push(
        sanitizeText(
          `Skipped ${source.projectPath}: ${String((error as Error).message ?? error)}`
        ) ?? `Skipped ${source.projectPath}`
      );
    }
  }

  const deduped = dedupeResults(results);
  const passIds = idsForStatus(deduped, "PASS");
  const failIds = idsForStatus(deduped, "FAIL");
  const setupRequiredIds = idsForStatus(deduped, "SETUP_REQUIRED");
  const optionalIds = idsForStatus(deduped, "OPTIONAL");

  return {
    schema_version: "0.1",
    sources: sources.map((source) => source.projectPath),
    summary: {
      pass: passIds.length,
      fail: failIds.length,
      setup_required: setupRequiredIds.length,
      optional: optionalIds.length,
      total: passIds.length + failIds.length + setupRequiredIds.length + optionalIds.length,
      source_files: sources.length
    },
    pass_ids: passIds,
    fail_ids: failIds,
    setup_required_ids: setupRequiredIds,
    optional_ids: optionalIds,
    results: deduped,
    warnings
  };
}

export function formatOperationTestSummary(summary: OperationTestSummary): string {
  return [
    "Kairon operation test summary.",
    `sources=${summary.summary.source_files}`,
    `total=${summary.summary.total}`,
    `pass=${summary.summary.pass}`,
    `fail=${summary.summary.fail}`,
    `setup_required=${summary.summary.setup_required}`,
    `optional=${summary.summary.optional}`,
    `pass_ids=${formatIds(summary.pass_ids)}`,
    `fail_ids=${formatIds(summary.fail_ids)}`,
    `setup_required_ids=${formatIds(summary.setup_required_ids)}`,
    `optional_ids=${formatIds(summary.optional_ids)}`,
    `evidence_paths=${formatIds(summary.sources)}`,
    ...summary.results.map(formatResultLine),
    ...summary.warnings.map((warning) => `warning=${warning}`)
  ].join("\n");
}

function parseSource(
  projectRoot: string,
  source: CandidateFile,
  text: string
): OperationTestSummaryItem[] {
  if (source.absolutePath.endsWith(".json")) {
    const parsed = parseHarnessSummaryJson(projectRoot, source, text);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return parseTextSummary(source, text);
}

function parseHarnessSummaryJson(
  projectRoot: string,
  source: CandidateFile,
  text: string
): OperationTestSummaryItem[] {
  let parsed: HarnessSummaryJson;
  try {
    parsed = JSON.parse(text) as HarnessSummaryJson;
  } catch {
    return [];
  }

  const resultValues = Array.isArray(parsed.results) ? parsed.results : [];
  const scenarioValues =
    parsed.kind === "stable_acceptance_evidence_manifest" &&
    Array.isArray(parsed.scenarios)
      ? parsed.scenarios
      : [];

  return [...resultValues, ...scenarioValues].flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }

    const record = value as Record<string, unknown>;
    const id = asId(record.id) ?? asId(record.test_id);
    const status = asStatus(record.status);
    if (id === undefined || status === undefined) {
      return [];
    }

    return [
      {
        id,
        status,
        source: source.projectPath,
        name: sanitizeText(asString(record.name) ?? asString(record.title)),
        details: summarizeDetails(
          projectRoot,
          source,
          asString(record.details) ?? formatStableScenarioDetails(record)
        )
      }
    ];
  });
}

function parseTextSummary(
  source: CandidateFile,
  text: string
): OperationTestSummaryItem[] {
  const results: OperationTestSummaryItem[] = [];

  for (const match of text.matchAll(textStatusLinePattern)) {
    const id = asId(match[1]);
    const status = asStatus(match[2]);
    if (id === undefined || status === undefined) {
      continue;
    }

    results.push({
      id,
      status,
      source: source.projectPath,
      details: summarizeInlineDetails(match[3])
    });
  }

  for (const match of text.matchAll(markdownTablePattern)) {
    const id = asId(match[1]);
    const status = asStatus(match[2]);
    if (id === undefined || status === undefined) {
      continue;
    }

    results.push({
      id,
      status,
      source: source.projectPath,
      details: summarizeInlineDetails(match[3])
    });
  }

  results.push(...parseLooseCliSummary(source, text));

  return results;
}

function parseLooseCliSummary(
  source: CandidateFile,
  text: string
): OperationTestSummaryItem[] {
  const results: OperationTestSummaryItem[] = [];

  for (const match of text.matchAll(looseStatusFirstLinePattern)) {
    const status = asStatus(match[1]);
    const id = asLooseId(match[2]);
    if (id === undefined || status === undefined) {
      continue;
    }

    results.push({
      id,
      status,
      source: source.projectPath,
      name: summarizeInlineDetails(match[3]),
      details: summarizeInlineDetails(match[3])
    });
  }

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = line.match(kaironCliResultLinePattern);
    if (match === null) {
      continue;
    }

    const phraseStatus = statusFromCliValue(match[2]);
    const assignmentStatus = findNearbyStatusAssignment(lines, index);
    const status = assignmentStatus ?? phraseStatus;
    const id = asLooseId(`Kairon ${match[1]}`);
    if (id === undefined || status === undefined) {
      continue;
    }

    results.push({
      id,
      status,
      source: source.projectPath,
      name: summarizeInlineDetails(`Kairon ${match[1]}`),
      details: summarizeInlineDetails(line)
    });
  }

  return results;
}

function findNearbyStatusAssignment(
  lines: string[],
  lineIndex: number
): OperationTestStatus | undefined {
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = lines[lineIndex + offset];
    if (candidate === undefined) {
      return undefined;
    }

    const match = candidate.match(statusAssignmentLinePattern);
    if (match === null) {
      continue;
    }

    return statusFromCliValue(match[1]);
  }

  return undefined;
}

async function resolveSources(
  projectRoot: string,
  request: OperationTestSummaryRequest
): Promise<CandidateFile[]> {
  const sources: CandidateFile[] = [];

  if (request.logFile !== undefined) {
    sources.push(toCandidateFile(projectRoot, request.logFile));
  }

  if (request.resultRoot !== undefined) {
    sources.push(...(await collectResultRootSources(projectRoot, request.resultRoot)));
  }

  if (sources.length === 0) {
    if (request.resultRoot !== undefined) {
      throw new Error(
        `No summary.json or summary.md files were found under --result-root: ${request.resultRoot}. ` +
          "Pass a transcript as logFile or generate a harness summary first."
      );
    }
    throw new Error("Specify a log file or --result-root.");
  }

  return dedupeSources(sources).sort((left, right) =>
    left.projectPath.localeCompare(right.projectPath)
  );
}

async function collectResultRootSources(
  projectRoot: string,
  resultRoot: string
): Promise<CandidateFile[]> {
  const root = path.resolve(projectRoot, resultRoot);
  const entries = await collectFiles(root);
  return entries
    .filter((filePath) => isResultRootSummarySource(filePath))
    .map((filePath) => toCandidateFile(projectRoot, filePath));
}

async function collectFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const output: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (ignoredResultRootDirectoryNames.has(entry.name.toLowerCase())) {
        continue;
      }

      output.push(...(await collectFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && (await isReasonableTextFile(entryPath))) {
      output.push(entryPath);
    }
  }

  return output;
}

async function isReasonableTextFile(filePath: string): Promise<boolean> {
  const stats = await stat(filePath);
  return stats.size <= 2_000_000;
}

function isResultRootSummarySource(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return (
    name === "summary.json" ||
    name === "summary.md" ||
    name === "evidence-manifest.json"
  );
}

function formatStableScenarioDetails(
  record: Record<string, unknown>
): string | undefined {
  if (record.test_id === undefined) {
    return undefined;
  }
  const values = [
    asString(record.classification),
    asString(record.checkpoint),
    record.carried_from_previous === true ? "carried_from_previous" : undefined
  ].filter((value): value is string => value !== undefined);
  return values.length === 0 ? undefined : values.join(", ");
}

function toCandidateFile(projectRoot: string, filePath: string): CandidateFile {
  const absolutePath = path.resolve(projectRoot, filePath);
  return {
    absolutePath,
    projectPath: toDisplayPath(projectRoot, absolutePath)
  };
}

function toDisplayPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath);
  return sanitizeText(
    relative.startsWith("..") || path.isAbsolute(relative)
      ? toPosixPath(filePath)
      : toPosixPath(relative)
  ) ?? "";
}

function dedupeSources(sources: CandidateFile[]): CandidateFile[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.absolutePath.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function dedupeResults(
  results: OperationTestSummaryItem[]
): OperationTestSummaryItem[] {
  const byStatusAndId = new Map<string, OperationTestSummaryItem>();

  for (const result of results) {
    byStatusAndId.set(`${result.status}:${result.id}`, result);
  }

  return [...byStatusAndId.values()].sort((left, right) =>
    left.id === right.id
      ? left.status.localeCompare(right.status)
      : left.id.localeCompare(right.id)
  );
}

function idsForStatus(
  results: OperationTestSummaryItem[],
  status: OperationTestStatus
): string[] {
  return results
    .filter((result) => result.status === status)
    .map((result) => result.id)
    .sort((left, right) => left.localeCompare(right));
}

function formatIds(ids: string[]): string {
  return ids.length === 0 ? "(none)" : ids.join(",");
}

function formatResultLine(result: OperationTestSummaryItem): string {
  return [
    `result.id=${result.id}`,
    `status=${result.status}`,
    `source=${result.source}`,
    result.name === undefined ? undefined : `name=${result.name}`,
    result.details === undefined ? undefined : `details=${result.details}`
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");
}

function summarizeDetails(
  projectRoot: string,
  source: CandidateFile,
  value: string | undefined
): string | undefined {
  return summarizeInlineDetails(value)?.replaceAll(projectRoot, "<project_root>")
    .replaceAll(source.absolutePath, source.projectPath);
}

function summarizeInlineDetails(value: string | undefined): string | undefined {
  const sanitized = sanitizeText(value);
  if (sanitized === undefined || sanitized.length === 0) {
    return undefined;
  }

  return sanitized.length > 180 ? `${sanitized.slice(0, 177)}...` : sanitized;
}

function sanitizeText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',;\s]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const id = value.trim();
  return /^[A-Z0-9][A-Z0-9_-]*$/.test(id) ? id : undefined;
}

function asLooseId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const id = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return /^[A-Z0-9][A-Z0-9_]*$/.test(id) ? id : undefined;
}

function asStatus(value: unknown): OperationTestStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const status = value.trim().toUpperCase();
  return statusSet.has(status) ? (status as OperationTestStatus) : undefined;
}

function statusFromCliValue(value: string | undefined): OperationTestStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().replace(/[\s-]+/g, "_").toUpperCase();
  if (normalized === "COMPLETED" || normalized === "PASSED") {
    return "PASS";
  }

  if (normalized === "FAILED") {
    return "FAIL";
  }

  return statusSet.has(normalized) ? (normalized as OperationTestStatus) : undefined;
}
