import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { AgentId } from "../agents/types.js";

export type DailyRunSummary = {
  run_id: string;
  task_id?: string;
  agent?: AgentId | string;
  persona?: string;
  status: string;
  command?: string;
  outbox_path?: string;
  stdout_log?: string;
  stderr_log?: string;
  created_at?: string;
  finished_at?: string;
};

export type DailyReport = {
  schema_version: string;
  date: string;
  report_path: string;
  runs: {
    total: number;
    by_status: Record<string, number>;
    items: DailyRunSummary[];
  };
  approvals: {
    total: number;
    pending: number;
    decided: number;
    by_status: Record<string, number>;
    items: Record<string, unknown>[];
  };
  reviews: {
    loops_total: number;
    results_total: number;
    loops: Record<string, unknown>[];
    results: Record<string, unknown>[];
  };
  git: {
    branches_total: number;
    transactions_total: number;
    branches: Record<string, unknown>[];
    transactions: Record<string, unknown>[];
  };
  recovery: {
    total: number;
    items: Record<string, unknown>[];
  };
  created_at: string;
};

export type CreateDailyReportRequest = {
  date: string;
};

export async function createDailyReport(
  projectRoot: string,
  request: CreateDailyReportRequest
): Promise<DailyReport> {
  const paths = getKaironPaths(projectRoot);
  const reportPath = resolveInside(paths.reportsDir, "daily", `${request.date}.json`);
  const [runs, approvals, reviews, git, recovery] = await Promise.all([
    collectRuns(projectRoot, request.date),
    collectApprovals(projectRoot, request.date),
    collectReviews(projectRoot, request.date),
    collectGit(projectRoot, request.date),
    collectRecovery(projectRoot, request.date)
  ]);
  const report: DailyReport = {
    schema_version: "0.1",
    date: request.date,
    report_path: toProjectPath(paths.root, reportPath),
    runs: {
      total: runs.length,
      by_status: countBy(runs, (run) => run.status),
      items: runs
    },
    approvals: {
      total: approvals.length,
      pending: approvals.filter((approval) => approval.status === "pending").length,
      decided: approvals.filter((approval) => approval.status === "decided").length,
      by_status: countBy(approvals, (approval) => String(approval.status ?? "unknown")),
      items: approvals
    },
    reviews: {
      loops_total: reviews.loops.length,
      results_total: reviews.results.length,
      loops: reviews.loops,
      results: reviews.results
    },
    git: {
      branches_total: git.branches.length,
      transactions_total: git.transactions.length,
      branches: git.branches,
      transactions: git.transactions
    },
    recovery: {
      total: recovery.length,
      items: recovery
    },
    created_at: new Date().toISOString()
  };

  await writeJsonFileAtomic(reportPath, report);
  return report;
}

export async function readDailyReport(
  projectRoot: string,
  date: string
): Promise<DailyReport> {
  return readJsonFile<DailyReport>(
    resolveInside(getKaironPaths(projectRoot).reportsDir, "daily", `${date}.json`)
  );
}

async function collectRuns(
  projectRoot: string,
  date: string
): Promise<DailyRunSummary[]> {
  const runsDir = getKaironPaths(projectRoot).runsDir;
  const runDirs = await readDirectoryEntries(runsDir);
  const runs = await Promise.all(
    runDirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readRunSummary(projectRoot, entry.name))
  );

  return runs
    .filter((run): run is DailyRunSummary => run !== null)
    .filter((run) => matchesDate([run.created_at, run.finished_at], date))
    .sort(compareByCreatedAt);
}

async function readRunSummary(
  projectRoot: string,
  runId: string
): Promise<DailyRunSummary | null> {
  const runDir = resolveInside(getKaironPaths(projectRoot).runsDir, runId);

  try {
    const runner = await readJsonFile<Record<string, unknown>>(
      resolveInside(runDir, "runner.json")
    );
    return {
      run_id: String(runner.run_id ?? runId),
      task_id: optionalString(runner.task_id),
      agent: optionalString(runner.agent),
      persona: optionalString(runner.persona),
      status: String(runner.status ?? "unknown"),
      command: optionalString(runner.command),
      outbox_path: optionalString(runner.outbox_path),
      stdout_log: optionalString(runner.stdout_log),
      stderr_log: optionalString(runner.stderr_log),
      created_at: optionalString(runner.created_at),
      finished_at: optionalString(runner.finished_at)
    };
  } catch {
    try {
      const outbox = await readJsonFile<Record<string, unknown>>(
        resolveInside(runDir, "outbox.json")
      );
      return {
        run_id: String(outbox.run_id ?? runId),
        task_id: optionalString(outbox.task_id),
        agent: optionalString(outbox.agent),
        persona: optionalString(outbox.persona),
        status: String(outbox.status ?? "unknown")
      };
    } catch {
      return null;
    }
  }
}

async function collectApprovals(
  projectRoot: string,
  date: string
): Promise<Record<string, unknown>[]> {
  const approvalsDir = getKaironPaths(projectRoot).approvalsDir;
  const approvals = await readJsonFilesInDir(approvalsDir);

  return approvals
    .filter((approval) =>
      approval.status === "pending" ||
      matchesDate(
        [
          optionalString(approval.created_at),
          optionalString(approval.updated_at),
          optionalString(approval.decided_at)
        ],
        date
      )
    )
    .sort(compareUnknownByUpdatedAt);
}

async function collectReviews(
  projectRoot: string,
  date: string
): Promise<{
  loops: Record<string, unknown>[];
  results: Record<string, unknown>[];
}> {
  const reviewsDir = resolveInside(getKaironPaths(projectRoot).kaironDir, "reviews");
  const [loops, results] = await Promise.all([
    readJsonFilesInDir(resolveInside(reviewsDir, "loops")),
    readJsonFilesInDir(resolveInside(reviewsDir, "results"))
  ]);

  return {
    loops: loops.filter((loop) =>
      matchesDate([optionalString(loop.created_at), optionalString(loop.updated_at)], date)
    ),
    results: results.filter((result) =>
      matchesDate([optionalString(result.created_at)], date)
    )
  };
}

async function collectGit(
  projectRoot: string,
  date: string
): Promise<{
  branches: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
}> {
  const gitDir = resolveInside(getKaironPaths(projectRoot).kaironDir, "git");
  const [branches, transactions] = await Promise.all([
    readJsonFilesInDir(resolveInside(gitDir, "branches")),
    readJsonFilesInDir(resolveInside(gitDir, "transactions"))
  ]);

  return {
    branches: branches.filter((branch) =>
      matchesDate([optionalString(branch.created_at), optionalString(branch.updated_at)], date)
    ),
    transactions: transactions.filter((transaction) =>
      matchesDate(
        [optionalString(transaction.created_at), optionalString(transaction.updated_at)],
        date
      )
    )
  };
}

async function collectRecovery(
  projectRoot: string,
  date: string
): Promise<Record<string, unknown>[]> {
  const recoveryDir = getKaironPaths(projectRoot).recoveryDir;
  const artifacts = await readJsonFilesInDir(recoveryDir);

  return artifacts
    .filter((artifact) => matchesDate([optionalString(artifact.created_at)], date))
    .sort(compareUnknownByUpdatedAt);
}

async function readJsonFilesInDir(
  dirPath: string
): Promise<Record<string, unknown>[]> {
  const entries = await readDirectoryEntries(dirPath);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJsonFile<Record<string, unknown>>(path.join(dirPath, entry.name)))
  );
  return files;
}

async function readDirectoryEntries(dirPath: string) {
  try {
    await mkdir(dirPath, { recursive: true });
    return readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function matchesDate(values: Array<string | undefined>, date: string): boolean {
  return values.some((value) => value?.startsWith(date));
}

function countBy<T>(
  values: T[],
  key: (value: T) => string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const countKey = key(value);
    counts[countKey] = (counts[countKey] ?? 0) + 1;
  }
  return counts;
}

function compareByCreatedAt(left: DailyRunSummary, right: DailyRunSummary): number {
  return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
}

function compareUnknownByUpdatedAt(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): number {
  return String(left.updated_at ?? left.created_at ?? "").localeCompare(
    String(right.updated_at ?? right.created_at ?? "")
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
