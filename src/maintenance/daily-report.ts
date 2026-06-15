import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
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
  summary: {
    completed_runs: number;
    failed_runs: number;
    setup_required_runs: number;
    pending_approvals: number;
    failed_notifications: number;
    review_loops_by_status: Record<string, number>;
    git_transactions_by_status: Record<string, number>;
    git_transactions_ready_for_pr: number;
    git_transactions_requiring_approval: number;
    recovery_approvals_requested: number;
  };
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
  notifications: {
    discord: {
      audit_total: number;
      failed: number;
      skipped: number;
      sent: number;
      gateway_status?: string;
      last_error_code?: string;
    };
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
  const [runs, approvals, reviews, git, recovery, notifications] = await Promise.all([
    collectRuns(projectRoot, request.date),
    collectApprovals(projectRoot, request.date),
    collectReviews(projectRoot, request.date),
    collectGit(projectRoot, request.date),
    collectRecovery(projectRoot, request.date),
    collectNotifications(projectRoot, request.date)
  ]);
  const runStatusCounts = countBy(runs, (run) => run.status);
  const reviewLoopStatusCounts = countBy(
    reviews.loops,
    (loop) => String(loop.status ?? "unknown")
  );
  const gitTransactionStatusCounts = countBy(
    git.transactions,
    (transaction) => String(transaction.status ?? "unknown")
  );
  const report: DailyReport = {
    schema_version: "0.1",
    date: request.date,
    report_path: toProjectPath(paths.root, reportPath),
    summary: {
      completed_runs: runStatusCounts.completed ?? 0,
      failed_runs: runStatusCounts.failed ?? 0,
      setup_required_runs:
        (runStatusCounts.setup_required ?? 0) +
        (runStatusCounts.permission_required ?? 0) +
        (runStatusCounts.rate_limited ?? 0) +
        (runStatusCounts.usage_limited ?? 0),
      pending_approvals: approvals.filter((approval) => approval.status === "pending").length,
      failed_notifications: notifications.discord.failed,
      review_loops_by_status: reviewLoopStatusCounts,
      git_transactions_by_status: gitTransactionStatusCounts,
      git_transactions_ready_for_pr: git.transactions.filter(
        (transaction) => readNestedString(transaction, ["pr", "status"]) === "ready_for_pr"
      ).length,
      git_transactions_requiring_approval:
        gitTransactionStatusCounts.approval_required ?? 0,
      recovery_approvals_requested: sumRecoveryApprovalsRequested(recovery)
    },
    runs: {
      total: runs.length,
      by_status: runStatusCounts,
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
    notifications,
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

async function collectNotifications(
  projectRoot: string,
  date: string
): Promise<DailyReport["notifications"]> {
  const runtimeDiscordDir = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "discord"
  );
  const auditPath = resolveInside(runtimeDiscordDir, "approval-notifications.jsonl");
  const gatewayPath = resolveInside(runtimeDiscordDir, "gateway.json");
  const [audit, gateway] = await Promise.all([
    readOptionalJsonLines(auditPath),
    readOptionalJson(gatewayPath)
  ]);
  const dailyAudit = audit.filter((record) =>
    matchesDate(
      [
        optionalString(record.created_at),
        optionalString(record.updated_at),
        optionalString(record.notified_at)
      ],
      date
    )
  );
  const byStatus = countBy(dailyAudit, (record) =>
    String(record.status ?? record.result ?? "unknown")
  );

  return {
    discord: {
      audit_total: dailyAudit.length,
      failed: byStatus.failed ?? 0,
      skipped: byStatus.skipped ?? 0,
      sent: (byStatus.sent ?? 0) + (byStatus.updated ?? 0),
      gateway_status: optionalString(gateway?.status),
      last_error_code: optionalString(gateway?.error_code)
    }
  };
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

async function readOptionalJson(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    await access(filePath);
    return await readJsonFile<Record<string, unknown>>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readOptionalJsonLines(
  filePath: string
): Promise<Record<string, unknown>[]> {
  try {
    await access(filePath);
    return await readJsonLines<Record<string, unknown>>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
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

function readNestedString(
  value: Record<string, unknown>,
  path: string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return optionalString(current);
}

function sumRecoveryApprovalsRequested(recovery: Record<string, unknown>[]): number {
  return recovery.reduce((total, item) => {
    const summary = item.summary;
    if (typeof summary !== "object" || summary === null) {
      return total;
    }

    const approvals = (summary as Record<string, unknown>).approvals_requested;
    return total + (typeof approvals === "number" ? approvals : 0);
  }, 0);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
