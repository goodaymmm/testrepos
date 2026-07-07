import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";

export type StateIntegritySeverity = "error" | "warning";

export type StateIntegrityIssue = {
  severity: StateIntegritySeverity;
  code:
    | "json_parse_error"
    | "jsonl_parse_error"
    | "missing_schema_version"
    | "missing_reference"
    | "id_mismatch"
    | "orphan_artifact";
  path: string;
  message: string;
  reference?: string;
};

export type StateIntegrityCheckResult = {
  schema_version: "0.1";
  status: "ok" | "issues_found";
  checked_at: string;
  summary: {
    files_checked: number;
    json_files: number;
    jsonl_files: number;
    errors: number;
    warnings: number;
  };
  issues: StateIntegrityIssue[];
};

export type StateIntegrityCheckOptions = {
  now?: () => Date;
};

type ParsedStateFile = {
  path: string;
  absolute_path: string;
  kind: "json" | "jsonl";
  records: Array<Record<string, unknown>>;
};

export async function checkStateIntegrity(
  projectRoot: string,
  options: StateIntegrityCheckOptions = {}
): Promise<StateIntegrityCheckResult> {
  const now = options.now?.() ?? new Date();
  const stateFiles = await listStateDataFiles(projectRoot);
  const issues: StateIntegrityIssue[] = [];
  const parsedFiles: ParsedStateFile[] = [];

  for (const file of stateFiles) {
    const parsed = await parseStateFile(projectRoot, file);
    if (parsed.issue !== undefined) {
      issues.push(parsed.issue);
      continue;
    }
    parsedFiles.push(parsed.file);
    collectSchemaIssues(parsed.file, issues);
  }

  collectReferenceIssues(parsedFiles, issues);
  collectOrphanIssues(parsedFiles, issues);

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return {
    schema_version: "0.1",
    status: issues.length === 0 ? "ok" : "issues_found",
    checked_at: now.toISOString(),
    summary: {
      files_checked: stateFiles.length,
      json_files: stateFiles.filter((file) => file.endsWith(".json")).length,
      jsonl_files: stateFiles.filter((file) => file.endsWith(".jsonl")).length,
      errors,
      warnings
    },
    issues: issues.sort(compareIssues)
  };
}

export function formatStateIntegrityCheck(
  result: StateIntegrityCheckResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines = [
    "Kairon state integrity check.",
    `status=${result.status}`,
    `files.checked=${result.summary.files_checked}`,
    `files.json=${result.summary.json_files}`,
    `files.jsonl=${result.summary.jsonl_files}`,
    `issues.errors=${result.summary.errors}`,
    `issues.warnings=${result.summary.warnings}`
  ];

  if (result.issues.length === 0) {
    lines.push("issues=none");
  } else {
    for (const issue of result.issues) {
      lines.push(
        `${issue.severity.toUpperCase()} ${issue.code} path=${issue.path} message=${issue.message}${
          issue.reference === undefined ? "" : ` reference=${issue.reference}`
        }`
      );
    }
  }

  return lines.join("\n");
}

async function listStateDataFiles(projectRoot: string): Promise<string[]> {
  const kaironDir = getKaironPaths(projectRoot).kaironDir;
  const files: string[] = [];
  await walk(kaironDir, files);
  return files
    .filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
    .filter((file) => !ignoredStatePath(relativeProjectPath(projectRoot, file)))
    .sort();
}

async function walk(directoryPath: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

async function parseStateFile(
  projectRoot: string,
  absolutePath: string
): Promise<{ file: ParsedStateFile; issue?: undefined } | { issue: StateIntegrityIssue }> {
  const relativePath = relativeProjectPath(projectRoot, absolutePath);
  const text = await readFile(absolutePath, "utf8");

  if (absolutePath.endsWith(".jsonl")) {
    const records: Array<Record<string, unknown>> = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.length === 0) {
        continue;
      }
      try {
        records.push(toRecord(JSON.parse(stripUtf8Bom(line))));
      } catch (error) {
        return {
          issue: {
            severity: "error",
            code: "jsonl_parse_error",
            path: relativePath,
            message: `Failed to parse JSONL line ${index + 1}: ${shortError(error)}`
          }
        };
      }
    }
    return {
      file: {
        path: relativePath,
        absolute_path: absolutePath,
        kind: "jsonl",
        records
      }
    };
  }

  try {
    return {
      file: {
        path: relativePath,
        absolute_path: absolutePath,
        kind: "json",
        records: [toRecord(JSON.parse(stripUtf8Bom(text)))]
      }
    };
  } catch (error) {
    return {
      issue: {
        severity: "error",
        code: "json_parse_error",
        path: relativePath,
        message: `Failed to parse JSON: ${shortError(error)}`
      }
    };
  }
}

function collectSchemaIssues(
  file: ParsedStateFile,
  issues: StateIntegrityIssue[]
): void {
  for (const [index, record] of file.records.entries()) {
    if (record.schema_version === undefined) {
      issues.push({
        severity: "warning",
        code: "missing_schema_version",
        path: file.kind === "jsonl" ? `${file.path}:${index + 1}` : file.path,
        message: "State record does not declare schema_version."
      });
    }
  }
}

function collectReferenceIssues(files: ParsedStateFile[], issues: StateIntegrityIssue[]): void {
  const taskIds = new Set<string>();
  const runIds = new Set<string>();
  const approvalIds = new Set<string>();

  for (const file of files) {
    for (const record of file.records) {
      const taskPathId = idFromTaskPath(file.path);
      if (isTaskFile(file.path) && taskPathId !== undefined) {
        taskIds.add(taskPathId);
        checkIdMatch(file.path, readString(record.id), taskPathId, "task", issues);
      }

      const runPathId = idFromRunPath(file.path);
      if (isRunStateFile(file.path) && runPathId !== undefined) {
        runIds.add(runPathId);
        checkIdMatch(file.path, readString(record.run_id), runPathId, "run", issues);
      }

      const approvalPathId = idFromApprovalPath(file.path);
      if (isApprovalFile(file.path) && approvalPathId !== undefined) {
        approvalIds.add(approvalPathId);
        checkIdMatch(file.path, readString(record.id), approvalPathId, "approval", issues);
      }
    }
  }

  for (const file of files) {
    for (const record of file.records) {
      checkReference(file.path, "task", readString(record.task_id), taskIds, issues);
      checkReference(file.path, "run", readString(record.run_id), runIds, issues);
      checkReference(
        file.path,
        "approval",
        readString(record.approval_id),
        approvalIds,
        issues
      );

      const history = Array.isArray(record.history) ? record.history : [];
      for (const [index, item] of history.entries()) {
        const runId = readString(toRecord(item).run_id);
        checkReference(
          `${file.path}:history[${index}]`,
          "run",
          runId,
          runIds,
          issues
        );
      }
    }
  }
}

function collectOrphanIssues(files: ParsedStateFile[], issues: StateIntegrityIssue[]): void {
  const paths = new Set(files.map((file) => file.path));
  const taskDirs = new Set(
    files
      .map((file) => /^\.kairon\/tasks\/([^/]+)\//u.exec(file.path)?.[1])
      .filter((id): id is string => id !== undefined)
  );
  for (const taskId of taskDirs) {
    const taskPath = `.kairon/tasks/${taskId}/task.json`;
    if (!paths.has(taskPath)) {
      issues.push({
        severity: "warning",
        code: "orphan_artifact",
        path: `.kairon/tasks/${taskId}`,
        message: "Task directory does not contain task.json."
      });
    }
  }

  const runDirs = new Set(
    files
      .map((file) => /^\.kairon\/runs\/([^/]+)\//u.exec(file.path)?.[1])
      .filter((id): id is string => id !== undefined)
  );
  for (const runId of runDirs) {
    const runner = `.kairon/runs/${runId}/runner.json`;
    const outbox = `.kairon/runs/${runId}/outbox.json`;
    if (!paths.has(runner) && !paths.has(outbox)) {
      issues.push({
        severity: "warning",
        code: "orphan_artifact",
        path: `.kairon/runs/${runId}`,
        message: "Run directory has no runner.json or outbox.json."
      });
    }
  }
}

function checkReference(
  sourcePath: string,
  kind: "task" | "run" | "approval",
  id: string | undefined,
  knownIds: Set<string>,
  issues: StateIntegrityIssue[]
): void {
  if (id === undefined || knownIds.has(id)) {
    return;
  }

  issues.push({
    severity: "error",
    code: "missing_reference",
    path: sourcePath,
    message: `Missing ${kind} reference: ${id}`,
    reference: `${kind}:${id}`
  });
}

function checkIdMatch(
  filePath: string,
  recordId: string | undefined,
  pathId: string | undefined,
  kind: string,
  issues: StateIntegrityIssue[]
): void {
  if (recordId === undefined || pathId === undefined || recordId === pathId) {
    return;
  }

  issues.push({
    severity: "error",
    code: "id_mismatch",
    path: filePath,
    message: `${kind} id ${recordId} does not match path id ${pathId}.`
  });
}

function isTaskFile(filePath: string): boolean {
  return /^\.kairon\/tasks\/[^/]+\/task\.json$/u.test(filePath);
}

function isRunStateFile(filePath: string): boolean {
  return /^\.kairon\/runs\/[^/]+\/(runner|outbox)\.json$/u.test(filePath);
}

function isApprovalFile(filePath: string): boolean {
  return /^\.kairon\/approvals\/[^/]+\.json$/u.test(filePath);
}

function idFromTaskPath(filePath: string): string | undefined {
  return /^\.kairon\/tasks\/([^/]+)\/task\.json$/u.exec(filePath)?.[1];
}

function idFromRunPath(filePath: string): string | undefined {
  return /^\.kairon\/runs\/([^/]+)\/(?:runner|outbox)\.json$/u.exec(filePath)?.[1];
}

function idFromApprovalPath(filePath: string): string | undefined {
  return /^\.kairon\/approvals\/([^/]+)\.json$/u.exec(filePath)?.[1];
}

function ignoredStatePath(filePath: string): boolean {
  return (
    filePath.startsWith(".kairon/tmp/") ||
    filePath.startsWith(".kairon/worktrees/") ||
    filePath.includes("/.resource-locks/")
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shortError(error: unknown): string {
  return String(error)
    .replace(/\s+/gu, " ")
    .replace(/ at position \d+(?: \(line \d+ column \d+\))?/u, "")
    .split("\n")[0]
    .slice(0, 240);
}

function compareIssues(left: StateIntegrityIssue, right: StateIntegrityIssue): number {
  const severityOrder = { error: 0, warning: 1 };
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code)
  );
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function relativeProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
