import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { AgentId } from "../agents/types.js";
import { listProviderPolicyHealth } from "../agents/provider-policy.js";
import { inspectCorrelationIntegrity } from "../correlation/store.js";
import { getRagStats, verifyRagIndex } from "../rag/integrity.js";

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

export type DailyApprovalSummary = {
  id: string;
  status: string;
  type?: string;
  title?: string;
  task_id?: string;
  run_id?: string;
  actions?: string[];
  decision?: string;
  reason?: string;
  snooze_until?: string;
  created_at?: string;
  updated_at?: string;
  decided_at?: string;
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
    correlation_issues: number;
    rag_integrity_issues: number;
    providers_unavailable: number;
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
    items: DailyApprovalSummary[];
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
  correlations: {
    total: number;
    healthy: number;
    missing_artifacts: number;
    stale_messages: number;
    orphan_follow_ups: number;
    duplicate_members: number;
  };
  rag: {
    integrity_status: string;
    integrity_issues: number;
    index_exists: boolean;
    duplicate_chunk_count: number;
    duplicate_ratio: number;
    estimated_total_tokens: number;
    largest_chunk_estimated_tokens: number;
    context_budget_tokens: number;
    chunks_exceeding_context_budget: number;
    rebuild_due: boolean;
    retention_candidate_count: number;
  };
  providers: {
    total: number;
    ready: number;
    cooldown: number;
    daily_limit_reached: number;
    suspended: number;
    items: Array<{
      agent: AgentId;
      status: string;
      available: boolean;
      failure_category: string | null;
      next_retry_at: string | null;
      daily_run_count: number;
      daily_run_limit: number;
      active_runs: number;
      max_concurrent: number;
      unattended_allowed: boolean;
    }>;
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
  const [runs, approvals, reviews, git, recovery, notifications, correlations, ragIntegrity, ragStats, providerHealth] = await Promise.all([
    collectRuns(projectRoot, request.date),
    collectApprovals(projectRoot, request.date),
    collectReviews(projectRoot, request.date),
    collectGit(projectRoot, request.date),
    collectRecovery(projectRoot, request.date),
    collectNotifications(projectRoot, request.date),
    inspectCorrelationIntegrity(projectRoot),
    verifyRagIndex(projectRoot, { writeArtifact: false }),
    getRagStats(projectRoot),
    listProviderPolicyHealth(projectRoot, { persist: false })
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
      recovery_approvals_requested: sumRecoveryApprovalsRequested(recovery),
      correlation_issues:
        correlations.missing_artifacts +
        correlations.stale_messages +
        correlations.orphan_follow_ups +
        correlations.duplicate_members,
      rag_integrity_issues: ragIntegrity.issue_count,
      providers_unavailable: providerHealth.filter((entry) => !entry.available).length
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
    correlations: {
      total: correlations.total,
      healthy: correlations.healthy,
      missing_artifacts: correlations.missing_artifacts,
      stale_messages: correlations.stale_messages,
      orphan_follow_ups: correlations.orphan_follow_ups,
      duplicate_members: correlations.duplicate_members
    },
    rag: {
      integrity_status: ragIntegrity.status,
      integrity_issues: ragIntegrity.issue_count,
      index_exists: ragStats.exists,
      duplicate_chunk_count: ragStats.duplicate_chunk_count,
      duplicate_ratio: ragStats.duplicate_ratio,
      estimated_total_tokens: ragStats.estimated_total_tokens,
      largest_chunk_estimated_tokens: ragStats.largest_chunk_estimated_tokens,
      context_budget_tokens: ragStats.context_budget_tokens,
      chunks_exceeding_context_budget: ragStats.chunks_exceeding_context_budget,
      rebuild_due: ragStats.rebuild_due,
      retention_candidate_count: ragStats.retention_candidate_count
    },
    providers: {
      total: providerHealth.length,
      ready: providerHealth.filter((entry) => entry.status === "ready").length,
      cooldown: providerHealth.filter((entry) => entry.status === "cooldown").length,
      daily_limit_reached: providerHealth.filter(
        (entry) => entry.status === "daily_limit_reached"
      ).length,
      suspended: providerHealth.filter((entry) => entry.status === "suspended").length,
      items: providerHealth.map((entry) => ({
        agent: entry.agent,
        status: entry.status,
        available: entry.available,
        failure_category: entry.failure_category,
        next_retry_at: entry.next_retry_at,
        daily_run_count: entry.daily_run_count,
        daily_run_limit: entry.policy.daily_run_limit,
        active_runs: entry.active_run_ids.length,
        max_concurrent: entry.policy.max_concurrent,
        unattended_allowed: entry.policy.unattended_allowed
      }))
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
): Promise<DailyApprovalSummary[]> {
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
    .map(summarizeApprovalForDailyReport)
    .sort(compareDailyApprovalByUpdatedAt);
}

function summarizeApprovalForDailyReport(
  approval: Record<string, unknown>
): DailyApprovalSummary {
  const title = optionalString(approval.title);
  const reason = optionalString(approval.reason);

  return compact({
    id: String(approval.id ?? approval.approval_id ?? "unknown"),
    status: String(approval.status ?? "unknown"),
    type: optionalString(approval.type),
    title: title === undefined ? undefined : sanitizeInlineText(title),
    task_id: optionalString(approval.task_id),
    run_id: optionalString(approval.run_id),
    actions: optionalStringArray(approval.actions ?? approval.allowed_actions),
    decision: optionalString(approval.decision),
    reason: reason === undefined ? undefined : sanitizeInlineText(reason),
    snooze_until: optionalString(approval.snooze_until),
    created_at: optionalString(approval.created_at),
    updated_at: optionalString(approval.updated_at),
    decided_at: optionalString(approval.decided_at)
  });
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

function compareDailyApprovalByUpdatedAt(
  left: DailyApprovalSummary,
  right: DailyApprovalSummary
): number {
  return String(left.updated_at ?? left.created_at ?? "").localeCompare(
    String(right.updated_at ?? right.created_at ?? "")
  );
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

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === 0 ? undefined : strings;
}

function sanitizeInlineText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const redacted = collapsed
    .replace(
      /(api[_-]?key|api[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*["']?[^"',;\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");

  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
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
