import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type ApprovalAction,
  type ApprovalRecord,
  ApprovalQueue
} from "../approvals/approval-queue.js";
import {
  listApprovalFollowUps,
  type ApprovalFollowUpArtifact
} from "../approvals/follow-up-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { type QueueItem, WorkQueue } from "../queue/work-queue.js";
import { getRuntimeStatus, type RuntimeStatus } from "../runtime/status.js";
import type { TaskRecord } from "../tasks/task-runner.js";
import type {
  WorkflowControlEvent,
  WorkflowRunArtifact
} from "../workflow/types.js";
import {
  sanitizeBoardProjection,
  type BoardSecretScanSummary
} from "./secret-scan.js";

export type BoardProjection = {
  schema_version: "0.1";
  kind: "board_projection";
  generated_at: string;
  meta: {
    secret_scan: BoardSecretScanSummary;
  };
  runtime: RuntimeStatus;
  queue: {
    ready: number;
    claimed: number;
    failed: number;
    recent: BoardQueueItemSummary[];
  };
  operations: BoardOperationsSummary;
  tasks: {
    total: number;
    by_status: Record<string, number>;
    recent: BoardTaskSummary[];
  };
  runs: {
    total: number;
    recent: BoardRunSummary[];
  };
  workflows: {
    total: number;
    by_status: Record<string, number>;
    attention: number;
    recent: BoardWorkflowSummary[];
  };
  approvals: {
    pending: number;
    recent: BoardApprovalSummary[];
  };
  follow_ups: {
    pending: number;
    running: number;
    snoozed: number;
    recent: BoardApprovalFollowUpSummary[];
  };
  reviews: {
    loops_total: number;
    recent_loops: BoardReviewLoopSummary[];
    results_total: number;
    recent_results: BoardReviewResultSummary[];
  };
  git: {
    transactions_total: number;
    transactions_requiring_approval: number;
    transactions_ready_for_pr: number;
    recent_transactions: BoardGitTransactionSummary[];
  };
  cleanup: {
    proposals_total: number;
    recent: BoardCleanupProposalSummary[];
  };
  maintenance: {
    daily_reports_total: number;
    latest_daily_report?: BoardDailyReportSummary;
  };
  discord: {
    gateway?: RuntimeStatus["discordGateway"];
    notifications: BoardDiscordAuditSummary;
    decisions: BoardDiscordDecisionAuditSummary;
  };
};

export type BoardProjectionOptions = {
  recentLimit?: number;
  now?: () => Date;
};

export type BoardExportOptions = BoardProjectionOptions & {
  outputPath?: string;
};

export type BoardExportResult = {
  schema_version: "0.1";
  projection_path: string;
  generated_at: string;
  queue_ready: number;
  approvals_pending: number;
  operations_attention: number;
  recent_runs: number;
  secret_scan_status: BoardSecretScanSummary["status"];
  secret_scan_redactions: number;
};

export type BoardOperationsSummary = {
  pending_approvals: number;
  pending_follow_ups: number;
  failed_runs: number;
  setup_required_runs: number;
  recovery_targets: number;
  git_transactions_requiring_approval: number;
  workflow_attention: number;
  attention_total: number;
  priority: BoardOperationPriorityItem[];
};

export type BoardOperationPriorityItem = {
  kind:
    | "approval"
    | "follow_up"
    | "run"
    | "recovery"
    | "git_transaction"
    | "workflow";
  id: string;
  label: string;
  status: string;
  severity: "high" | "medium";
  anchor: string;
  detail?: string;
};

export type BoardQueueItemSummary = {
  id: string;
  type: string;
  status: string;
  priority: number;
  task_id?: string;
  schedule_mode?: string;
  attempts: number;
  created_at?: string;
  updated_at?: string;
  claimed_by?: string;
  error?: { message: string; code?: string };
  result?: Record<string, unknown>;
  test_scope?: {
    kind: string;
    tags: string[];
    expires_at: string;
  };
};

export type BoardTaskSummary = {
  id: string;
  status: string;
  title: string;
  persona?: string;
  priority?: number;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  last_run_id?: string;
  last_run_status?: string;
};

export type BoardRunSummary = {
  run_id: string;
  task_id?: string;
  agent?: string;
  persona?: string;
  status?: string;
  command?: string;
  command_available?: boolean;
  exit_code?: number;
  timed_out?: boolean;
  created_at?: string;
  finished_at?: string;
  outbox_status?: string;
  outbox_event_count?: number;
};

export type BoardWorkflowSummary = {
  workflow_id: string;
  status: string;
  task_id: string;
  current_node?: string;
  progress_completed: number;
  progress_total: number;
  blocker?: string;
  approval_id?: string;
  retry_count: number;
  control_mode: string;
  last_event?: {
    event_id: string;
    action: string;
    status_after: string;
    node_id?: string;
    created_at: string;
  };
  timeline: Array<{
    event_id: string;
    action: string;
    status_after: string;
    node_id?: string;
    created_at: string;
  }>;
  updated_at: string;
};

export type BoardApprovalSummary = {
  id: string;
  status: string;
  type?: string;
  title?: string;
  risk_level?: string;
  task_id?: string;
  run_id?: string;
  actions?: ApprovalAction[];
  decision?: string;
  reason?: string;
  dry_run?: boolean;
  execution_allowed?: boolean;
  approval_required_for?: string;
  operation?: string;
  source_branch?: string;
  target_branch?: string;
  environment?: string;
  commit_range?: string;
  rollback_hint?: string;
  artifact_path?: string;
  checks_summary?: BoardApprovalCheckSummary[];
  required_approvals?: BoardApprovalRequiredApprovalSummary[];
  related_artifacts?: BoardApprovalRelatedArtifact[];
  local_command_hint?: string;
  confirmation_status?: string;
  confirmation_required_by?: string;
  confirmation_action?: string;
  confirmation_reason?: string;
  snooze_until?: string;
  created_at?: string;
  updated_at?: string;
};

export type BoardApprovalCheckSummary = {
  name: string;
  status: string;
  detail?: string;
};

export type BoardApprovalRequiredApprovalSummary = {
  type?: string;
  required_by?: string;
  present?: boolean;
};

export type BoardApprovalRelatedArtifact = {
  kind: string;
  id?: string;
  path?: string;
  anchor?: string;
  status?: string;
};

export type BoardApprovalFollowUpSummary = {
  id: string;
  approval_id: string;
  approval_type?: string;
  decision: string;
  action_type: string;
  status: string;
  risk_level: string;
  task_id?: string;
  run_id?: string;
  transaction_id?: string;
  queue_item_type?: string;
  queue_item_id?: string;
  attempts?: number;
  last_execution_status?: string;
  execution_performed?: boolean;
  command_hint?: string;
  due_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type BoardReviewLoopSummary = {
  loop_id: string;
  task_id?: string;
  status?: string;
  iteration?: number;
  max_iterations?: number;
  implementer?: string;
  reviewers?: string[];
  integration?: string;
  code_producing?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type BoardReviewResultSummary = {
  review_id: string;
  run_id?: string;
  reviewer?: string;
  status?: string;
  score?: number;
  tests_passed?: boolean;
  secret_scan_passed?: boolean;
  finding_count?: number;
  highest_severity?: string;
  created_at?: string;
};

export type BoardGitTransactionSummary = {
  transaction_id: string;
  task_id?: string;
  run_id?: string;
  review_loop_id?: string;
  branch?: string;
  status?: string;
  remote?: string;
  remote_ref?: string | null;
  approval_id?: string;
  reason?: string;
  commit_sha?: string;
  diff_sha256?: string;
  pr_status?: string;
  pr_base?: string;
  pr_head?: string;
  pr_create_hint?: string;
  rollback_strategy?: string;
  rollback_hint?: string;
  transaction_path?: string;
  created_at?: string;
  updated_at?: string;
};

export type BoardCleanupProposalSummary = {
  date: string;
  proposal_path?: string;
  direct_delete?: boolean;
  candidate_count: number;
  created_at?: string;
};

export type BoardDailyReportSummary = {
  date: string;
  report_path?: string;
  completed_runs?: number;
  failed_runs?: number;
  setup_required_runs?: number;
  pending_approvals?: number;
  failed_notifications?: number;
  git_transactions_ready_for_pr?: number;
  git_transactions_requiring_approval?: number;
  created_at?: string;
};

export type BoardDiscordAuditSummary = {
  total: number;
  by_status: Record<string, number>;
  recent: BoardDiscordNotificationAuditSummary[];
};

export type BoardDiscordNotificationAuditSummary = {
  approval_id?: string;
  status?: string;
  decision_status?: "received" | "missing";
  message_id?: string;
  board_anchor?: string;
  board_url?: string;
  reason?: string;
  next_action?: string;
  recorded_at?: string;
  sent_at?: string;
  updated_at?: string;
};

export type BoardDiscordDecisionAuditSummary = {
  total: number;
  status: "present" | "missing";
  next_action?: string;
  by_status: Record<string, number>;
  by_decision: Record<string, number>;
  recent: BoardDiscordDecisionAuditRecordSummary[];
};

export type BoardDiscordDecisionAuditRecordSummary = {
  approval_id?: string;
  decision?: string;
  status?: string;
  duplicate?: boolean;
  actor_hash?: string;
  message_id?: string;
  command_status?: string;
  message_update_status?: string;
  message_update_reason?: string;
  recorded_at?: string;
};

type ReviewLoopArtifact = {
  loop_id?: string;
  task_id?: string;
  status?: string;
  iteration?: number;
  max_iterations?: number;
  implementer?: string;
  reviewers?: string[];
  integration?: string;
  code_producing?: boolean;
  created_at?: string;
  updated_at?: string;
};

type ReviewResultArtifact = {
  review_id?: string;
  run_id?: string;
  reviewer?: string;
  status?: string;
  score?: number;
  tests_passed?: boolean;
  secret_scan_passed?: boolean;
  findings?: Array<{ severity?: string }>;
  created_at?: string;
};

type CleanupProposalArtifact = {
  date?: string;
  proposal_path?: string;
  direct_delete?: boolean;
  candidates?: unknown[];
  created_at?: string;
};

type DailyReportArtifact = {
  date?: string;
  report_path?: string;
  summary?: {
    completed_runs?: number;
    failed_runs?: number;
    setup_required_runs?: number;
    pending_approvals?: number;
    failed_notifications?: number;
    git_transactions_ready_for_pr?: number;
    git_transactions_requiring_approval?: number;
  };
  created_at?: string;
};

type GitTransactionArtifact = {
  transaction_id?: string;
  task_id?: string;
  run_id?: string;
  review_loop_id?: string;
  branch?: string;
  status?: string;
  push?: {
    remote?: string;
    remote_ref?: string | null;
    approval_id?: string;
    reason?: string;
  };
  commit_sha?: string;
  diff_sha256?: string;
  rollback?: {
    strategy?: string;
    command_hint?: string;
  };
  pr?: {
    status?: string;
    base_branch?: string;
    head_branch?: string;
    remote?: string;
    remote_ref?: string | null;
    approval_id?: string;
    create_hint?: string;
    rollback_strategy?: string;
    rollback_hint?: string;
  };
  transaction_path?: string;
  created_at?: string;
  updated_at?: string;
};

type DiscordNotificationAuditRecord = {
  approval_id?: string;
  status?: string;
  message_id?: string;
  board_anchor?: string;
  board_url?: string;
  reason?: string;
  recorded_at?: string;
  sent_at?: string;
  updated_at?: string;
};

type DiscordDecisionAuditRecord = {
  approval_id?: string;
  decision?: string;
  status?: string;
  duplicate?: boolean;
  actor_hash?: string;
  message_id?: string;
  command_status?: string;
  message_update_status?: string;
  message_update_reason?: string;
  recorded_at?: string;
};

const defaultRecentLimit = 10;
const secretKeyPattern = /(secret|token|password|api[_-]?key|authorization|cookie|credential)/i;
const discordDecisionAuditNextAction =
  "click Discord approval button and rerun DiscordDecisionAuditLive";

export async function createBoardProjection(
  projectRoot: string,
  options: BoardProjectionOptions = {}
): Promise<BoardProjection> {
  const recentLimit = options.recentLimit ?? defaultRecentLimit;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const [
    runtime,
    queueItems,
    tasks,
    runs,
    workflows,
    approvals,
    followUps,
    reviewLoops,
    reviewResults,
    gitTransactions,
    cleanupProposals,
    dailyReports,
    discordAudits
  ] = await Promise.all([
      getRuntimeStatus(projectRoot),
      new WorkQueue(projectRoot).list(),
      readTasks(projectRoot),
      readRuns(projectRoot),
      readWorkflows(projectRoot),
      new ApprovalQueue(projectRoot).list({ status: "all" }),
      listApprovalFollowUps(projectRoot),
      readReviewLoops(projectRoot),
      readReviewResults(projectRoot),
      readGitTransactions(projectRoot),
      readCleanupProposals(projectRoot),
      readDailyReports(projectRoot),
      readDiscordAudits(projectRoot)
    ]);
  const runSummaries = runs.sort(compareRunSummariesDesc);
  const workflowSummaries = workflows
    .map(({ artifact, events }) => summarizeWorkflow(artifact, events))
    .sort(compareByUpdatedDesc);
  const followUpSummaries = followUps
    .sort(compareByUpdatedDesc)
    .map(summarizeApprovalFollowUp);
  const gitTransactionSummaries = gitTransactions
    .sort(compareByUpdatedDesc)
    .map(summarizeGitTransaction);
  const approvalSummaries = approvals
    .sort(compareByUpdatedDesc)
    .map((approval) =>
      summarizeApproval(approval, {
        followUps: followUpSummaries,
        gitTransactions: gitTransactionSummaries
      })
    );

  const candidate: Omit<BoardProjection, "meta"> = {
    schema_version: "0.1",
    kind: "board_projection",
    generated_at: generatedAt,
    runtime,
    queue: {
      ready: queueItems.filter((item) => item.status === "ready").length,
      claimed: queueItems.filter((item) => item.status === "claimed").length,
      failed: queueItems.filter((item) => item.status === "failed").length,
      recent: queueItems
        .sort(compareByUpdatedDesc)
        .slice(0, recentLimit)
        .map(summarizeQueueItem)
    },
    operations: summarizeOperations({
      approvals: approvalSummaries,
      followUps: followUpSummaries,
      runs: runSummaries,
      recoveryTargets: runtime.recovery.targets,
      gitTransactions: gitTransactionSummaries,
      workflows: workflowSummaries,
      recentLimit
    }),
    tasks: {
      total: tasks.length,
      by_status: countBy(tasks, (task) => task.status),
      recent: tasks
        .sort(compareByUpdatedDesc)
        .slice(0, recentLimit)
        .map(summarizeTask)
    },
    runs: {
      total: runs.length,
      recent: runSummaries.slice(0, recentLimit)
    },
    workflows: {
      total: workflowSummaries.length,
      by_status: countBy(workflowSummaries, (workflow) => workflow.status),
      attention: workflowSummaries.filter(isWorkflowAttention).length,
      recent: workflowSummaries.slice(0, recentLimit)
    },
    approvals: {
      pending: approvalSummaries.filter(isOpenApprovalSummary).length,
      recent: approvalSummaries.slice(0, recentLimit)
    },
    follow_ups: {
      pending: followUpSummaries.filter((followUp) => followUp.status === "pending").length,
      running: followUpSummaries.filter((followUp) => followUp.status === "running").length,
      snoozed: followUpSummaries.filter((followUp) => followUp.status === "snoozed").length,
      recent: followUpSummaries.slice(0, recentLimit)
    },
    reviews: {
      loops_total: reviewLoops.length,
      recent_loops: reviewLoops
        .sort(compareByUpdatedDesc)
        .slice(0, recentLimit)
        .map(summarizeReviewLoop),
      results_total: reviewResults.length,
      recent_results: reviewResults
        .sort(compareByCreatedDesc)
        .slice(0, recentLimit)
        .map(summarizeReviewResult)
    },
    git: {
      transactions_total: gitTransactions.length,
      transactions_requiring_approval: gitTransactions.filter(
        (transaction) => transaction.status === "approval_required"
      ).length,
      transactions_ready_for_pr: gitTransactions.filter(
        (transaction) => transaction.pr?.status === "ready_for_pr"
      ).length,
      recent_transactions: gitTransactionSummaries.slice(0, recentLimit)
    },
    cleanup: {
      proposals_total: cleanupProposals.length,
      recent: cleanupProposals
        .sort(compareByCreatedDesc)
        .slice(0, recentLimit)
        .map(summarizeCleanupProposal)
    },
    maintenance: {
      daily_reports_total: dailyReports.length,
      latest_daily_report: dailyReports
        .sort(compareDailyReportsDesc)
        .slice(0, 1)
        .map(summarizeDailyReport)[0]
    },
    discord: {
      gateway: runtime.discordGateway,
      notifications: summarizeDiscordNotificationAudits(
        discordAudits.notifications,
        discordAudits.decisions,
        recentLimit
      ),
      decisions: summarizeDiscordDecisionAudits(discordAudits.decisions, recentLimit)
    }
  };
  const sanitized = sanitizeBoardProjection(candidate);

  return {
    ...sanitized.projection,
    meta: {
      secret_scan: sanitized.summary
    }
  };
}

export async function exportBoardProjection(
  projectRoot: string,
  options: BoardExportOptions = {}
): Promise<BoardExportResult> {
  const paths = getKaironPaths(projectRoot);
  const outputPath =
    options.outputPath === undefined
      ? resolveInside(paths.kaironDir, "board", "projection.json")
      : resolveInside(paths.root, options.outputPath);
  const projection = await createBoardProjection(projectRoot, options);
  await writeJsonFileAtomic(outputPath, projection);

  return {
    schema_version: "0.1",
    projection_path: toProjectPath(paths.root, outputPath),
    generated_at: projection.generated_at,
    queue_ready: projection.queue.ready,
    approvals_pending: projection.approvals.pending,
    operations_attention: projection.operations.attention_total,
    recent_runs: projection.runs.recent.length,
    secret_scan_status: projection.meta.secret_scan.status,
    secret_scan_redactions:
      projection.meta.secret_scan.redacted_fields +
      projection.meta.secret_scan.redacted_values
  };
}

export function formatBoardExportResult(result: BoardExportResult): string {
  return [
    "Kairon board projection exported.",
    `projection=${result.projection_path}`,
    `generated_at=${result.generated_at}`,
    `queue.ready=${result.queue_ready}`,
    `approvals.pending=${result.approvals_pending}`,
    `operations.attention=${result.operations_attention}`,
    `runs.recent=${result.recent_runs}`,
    `secret_scan.status=${result.secret_scan_status}`,
    `secret_scan.redactions=${result.secret_scan_redactions}`
  ].join("\n");
}

async function readTasks(projectRoot: string): Promise<TaskRecord[]> {
  const tasksDir = getKaironPaths(projectRoot).tasksDir;
  const entries = await readDirectoryEntries(tasksDir);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readOptionalJson<TaskRecord>(path.join(tasksDir, entry.name, "task.json")))
  );

  return tasks.filter((task): task is TaskRecord => task !== null);
}

async function readRuns(projectRoot: string): Promise<BoardRunSummary[]> {
  const runsDir = getKaironPaths(projectRoot).runsDir;
  const entries = await readDirectoryEntries(runsDir);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => summarizeRunDirectory(path.join(runsDir, entry.name), entry.name))
  );

  return runs.filter((run): run is BoardRunSummary => run !== null);
}

async function readWorkflows(projectRoot: string): Promise<Array<{
  artifact: WorkflowRunArtifact;
  events: WorkflowControlEvent[];
}>> {
  const workflowsDir = resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows"
  );
  const runsDir = resolveInside(workflowsDir, "runs");
  const eventsDir = resolveInside(workflowsDir, "events");
  const entries = await readDirectoryEntries(runsDir);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const artifact = await readOptionalJson<WorkflowRunArtifact>(
          path.join(runsDir, entry.name)
        );
        if (artifact === null) {
          return null;
        }
        return {
          artifact,
          events: await readOptionalJsonLines<WorkflowControlEvent>(
            path.join(eventsDir, `${artifact.workflow_id}.jsonl`)
          )
        };
      })
  );
  return records.filter(
    (record): record is { artifact: WorkflowRunArtifact; events: WorkflowControlEvent[] } =>
      record !== null
  );
}

function summarizeWorkflow(
  artifact: WorkflowRunArtifact,
  events: WorkflowControlEvent[]
): BoardWorkflowSummary {
  const currentNode = artifact.nodes.find((node) =>
    ["running", "dispatched", "waiting_approval", "failed", "pending"].includes(
      node.status
    )
  );
  const timeline = events.slice(-5).map((event) =>
    compact({
      event_id: event.event_id,
      action: event.action,
      status_after: event.status_after,
      node_id: event.node_id,
      created_at: event.created_at
    })
  );
  return compact({
    workflow_id: artifact.workflow_id,
    status: artifact.status,
    task_id: artifact.task_id,
    current_node: currentNode?.id,
    progress_completed: artifact.nodes.filter((node) =>
      ["completed", "skipped"].includes(node.status)
    ).length,
    progress_total: artifact.nodes.length,
    blocker:
      currentNode?.blocker ??
      artifact.nodes.find((node) => node.blocker !== undefined)?.blocker ??
      artifact.control?.reason,
    approval_id: currentNode?.approval_id ?? artifact.approval_id,
    retry_count: artifact.nodes.reduce(
      (total, node) => total + Math.max(node.attempt - 1, 0),
      0
    ),
    control_mode: artifact.control?.mode ?? "active",
    last_event: timeline.at(-1),
    timeline,
    updated_at: artifact.updated_at
  });
}

async function readReviewLoops(projectRoot: string): Promise<ReviewLoopArtifact[]> {
  const loopsDir = resolveInside(getKaironPaths(projectRoot).kaironDir, "reviews", "loops");
  const entries = await readDirectoryEntries(loopsDir);
  const loops = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes("-iteration-"))
      .map((entry) => readOptionalJson<ReviewLoopArtifact>(path.join(loopsDir, entry.name)))
  );

  return loops.filter((loop): loop is ReviewLoopArtifact => loop !== null);
}

async function readReviewResults(projectRoot: string): Promise<ReviewResultArtifact[]> {
  const resultsDir = resolveInside(getKaironPaths(projectRoot).kaironDir, "reviews", "results");
  const entries = await readDirectoryEntries(resultsDir);
  const results = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readOptionalJson<ReviewResultArtifact>(path.join(resultsDir, entry.name)))
  );

  return results.filter((result): result is ReviewResultArtifact => result !== null);
}

async function readGitTransactions(projectRoot: string): Promise<GitTransactionArtifact[]> {
  const transactionsDir = resolveInside(getKaironPaths(projectRoot).kaironDir, "git", "transactions");
  const entries = await readDirectoryEntries(transactionsDir);
  const transactions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readOptionalJson<GitTransactionArtifact>(path.join(transactionsDir, entry.name)))
  );

  return transactions.filter(
    (transaction): transaction is GitTransactionArtifact => transaction !== null
  );
}

async function readCleanupProposals(projectRoot: string): Promise<CleanupProposalArtifact[]> {
  const proposalsDir = resolveInside(getKaironPaths(projectRoot).cleanupDir, "proposals");
  const entries = await readDirectoryEntries(proposalsDir);
  const proposals = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readOptionalJson<CleanupProposalArtifact>(path.join(proposalsDir, entry.name)))
  );

  return proposals.filter((proposal): proposal is CleanupProposalArtifact => proposal !== null);
}

async function readDailyReports(projectRoot: string): Promise<DailyReportArtifact[]> {
  const dailyDir = resolveInside(getKaironPaths(projectRoot).reportsDir, "daily");
  const entries = await readDirectoryEntries(dailyDir);
  const reports = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readOptionalJson<DailyReportArtifact>(path.join(dailyDir, entry.name)))
  );

  return reports.filter((report): report is DailyReportArtifact => report !== null);
}

async function readDiscordAudits(projectRoot: string): Promise<{
  notifications: DiscordNotificationAuditRecord[];
  decisions: DiscordDecisionAuditRecord[];
}> {
  const discordDir = resolveInside(getKaironPaths(projectRoot).runtimeDir, "discord");
  const [notifications, decisions] = await Promise.all([
    readOptionalJsonLines<DiscordNotificationAuditRecord>(
      path.join(discordDir, "approval-notifications.jsonl")
    ),
    readOptionalJsonLines<DiscordDecisionAuditRecord>(
      path.join(discordDir, "decision-interactions.jsonl")
    )
  ]);

  return { notifications, decisions };
}

async function summarizeRunDirectory(
  runDir: string,
  directoryName: string
): Promise<BoardRunSummary | null> {
  const runner = await readOptionalJson<Record<string, unknown>>(path.join(runDir, "runner.json"));
  const outbox = await readOptionalJson<Record<string, unknown>>(path.join(runDir, "outbox.json"));

  if (runner === null && outbox === null) {
    return null;
  }

  return {
    run_id: readString(runner?.run_id) ?? readString(outbox?.run_id) ?? directoryName,
    task_id: readString(runner?.task_id) ?? readString(outbox?.task_id),
    agent: readString(runner?.agent) ?? readString(outbox?.agent),
    persona: readString(runner?.persona) ?? readString(outbox?.persona),
    status: readString(runner?.status) ?? readString(outbox?.status),
    command: readString(runner?.command),
    command_available: readBoolean(runner?.command_available),
    exit_code: readNumber(runner?.exit_code),
    timed_out: readBoolean(runner?.timed_out),
    created_at: readString(runner?.created_at),
    finished_at: readString(runner?.finished_at),
    outbox_status: readString(outbox?.status),
    outbox_event_count: Array.isArray(outbox?.events) ? outbox.events.length : undefined
  };
}

function summarizeQueueItem(item: QueueItem): BoardQueueItemSummary {
  return compact({
    id: item.id,
    type: item.type,
    status: item.status,
    priority: item.priority,
    task_id: item.task_id,
    schedule_mode: item.schedule_mode,
    attempts: item.attempts,
    created_at: item.created_at,
    updated_at: item.updated_at,
    claimed_by: item.claimed_by,
    error:
      item.error === undefined
        ? undefined
        : compact({
            message: sanitizeInline(item.error.message),
            code: item.error.code
          }),
    result: sanitizeMetadata(item.result),
    test_scope: item.test_scope
  });
}

function summarizeTask(task: TaskRecord): BoardTaskSummary {
  return compact({
    id: task.id,
    status: task.status,
    title: sanitizeInline(task.title),
    persona: task.persona,
    priority: task.priority,
    tags: task.tags,
    created_at: task.created_at,
    updated_at: task.updated_at,
    last_run_id: task.last_run_id,
    last_run_status: task.last_run_status
  });
}

function summarizeApproval(
  approval: ApprovalRecord,
  context: {
    followUps: BoardApprovalFollowUpSummary[];
    gitTransactions: BoardGitTransactionSummary[];
  }
): BoardApprovalSummary {
  const title = readString(approval.title);
  const reason = readString(approval.reason);
  const confirmation = readRecord(approval.confirmation);
  const riskLevel = approvalRiskLevel(approval);
  const rollbackHint = readString(approval.rollback_hint);
  const artifactPath = readString(approval.artifact_path);

  return compact({
    id: approval.id,
    status: approval.status,
    type: readString(approval.type),
    title: title === undefined ? undefined : sanitizeInline(title),
    risk_level: riskLevel,
    task_id: readString(approval.task_id),
    run_id: readString(approval.run_id),
    actions: approval.actions ?? approval.allowed_actions,
    decision: readString(approval.decision),
    reason: reason === undefined ? undefined : sanitizeInline(reason),
    dry_run: readBoolean(approval.dry_run),
    execution_allowed: readBoolean(approval.execution_allowed),
    approval_required_for: readString(approval.approval_required_for),
    operation: readString(approval.operation),
    source_branch: readString(approval.source_branch),
    target_branch: readString(approval.target_branch),
    environment: readString(approval.environment),
    commit_range: readString(approval.commit_range),
    rollback_hint:
      rollbackHint === undefined ? undefined : sanitizeInline(rollbackHint),
    artifact_path: artifactPath === undefined ? undefined : sanitizeInline(artifactPath),
    checks_summary: summarizeApprovalChecks(approval.checks_summary),
    required_approvals: summarizeRequiredApprovals(approval.required_approvals),
    related_artifacts: approvalRelatedArtifacts(approval, context),
    local_command_hint: approvalLocalCommandHint(approval, confirmation, riskLevel),
    confirmation_status: readString(confirmation?.status),
    confirmation_required_by: readString(confirmation?.required_by),
    confirmation_action: readString(confirmation?.action),
    confirmation_reason: readString(confirmation?.reason),
    snooze_until: readString(approval.snooze_until),
    created_at: readString(approval.created_at),
    updated_at: readString(approval.updated_at)
  });
}

function approvalRiskLevel(approval: ApprovalRecord): string | undefined {
  const explicit = readString(approval.risk_level);
  if (explicit !== undefined) {
    return explicit;
  }

  const type = readString(approval.type) ?? readString(approval.approval_required_for);
  if (
    type !== undefined &&
    /(deploy|merge|protected_branch_push|git_protected_branch_push|force_push|branch_delete)/.test(type)
  ) {
    return "high";
  }

  return undefined;
}

function summarizeApprovalChecks(value: unknown): BoardApprovalCheckSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const checks = value
    .slice(0, 8)
    .map((item) => {
      const record = readRecord(item);
      const name = readString(record?.name);
      const status = readString(record?.status);
      if (name === undefined || status === undefined) {
        return undefined;
      }

      const detail = readString(record?.detail);
      const summary: BoardApprovalCheckSummary = {
        name: sanitizeInline(name),
        status: sanitizeInline(status)
      };
      if (detail !== undefined) {
        summary.detail = sanitizeInline(detail);
      }
      return summary;
    })
    .filter((item): item is BoardApprovalCheckSummary => item !== undefined);

  return checks.length === 0 ? undefined : checks;
}

function summarizeRequiredApprovals(
  value: unknown
): BoardApprovalRequiredApprovalSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const required = value
    .slice(0, 8)
    .map((item) => {
      const record = readRecord(item);
      if (record === undefined) {
        return undefined;
      }

      const summary: BoardApprovalRequiredApprovalSummary = {};
      const type = sanitizeOptionalInline(readString(record.type));
      const requiredBy = sanitizeOptionalInline(readString(record.required_by));
      const present = readBoolean(record.present);
      if (type !== undefined) {
        summary.type = type;
      }
      if (requiredBy !== undefined) {
        summary.required_by = requiredBy;
      }
      if (present !== undefined) {
        summary.present = present;
      }
      return Object.keys(summary).length === 0 ? undefined : summary;
    })
    .filter((item): item is BoardApprovalRequiredApprovalSummary => item !== undefined);

  return required.length === 0 ? undefined : required;
}

function approvalRelatedArtifacts(
  approval: ApprovalRecord,
  context: {
    followUps: BoardApprovalFollowUpSummary[];
    gitTransactions: BoardGitTransactionSummary[];
  }
): BoardApprovalRelatedArtifact[] | undefined {
  const artifacts: BoardApprovalRelatedArtifact[] = [
    {
      kind: "approval",
      id: approval.id,
      path: `.kairon/approvals/${approval.id}.json`,
      anchor: `#approval-${approval.id}`,
      status: approval.status
    }
  ];
  const artifactPath = readString(approval.artifact_path);
  if (artifactPath !== undefined) {
    artifacts.push({
      kind: "approval_artifact",
      path: sanitizeInline(artifactPath),
      status: approval.status
    });
  }

  const taskId = readString(approval.task_id);
  if (taskId !== undefined) {
    artifacts.push({
      kind: "task",
      id: taskId,
      path: `.kairon/tasks/${taskId}/task.json`
    });
  }

  const runId = readString(approval.run_id);
  if (runId !== undefined) {
    artifacts.push({
      kind: "run",
      id: runId,
      path: `.kairon/runs/${runId}/runner.json`,
      anchor: `#run-${runId}`
    });
  }

  for (const transaction of context.gitTransactions.filter(
    (transaction) => transaction.approval_id === approval.id
  )) {
    artifacts.push({
      kind: "git_transaction",
      id: transaction.transaction_id,
      path: `.kairon/git/transactions/${transaction.transaction_id}.json`,
      anchor: `#git-transaction-${transaction.transaction_id}`,
      status: transaction.status
    });
  }

  for (const followUp of context.followUps.filter(
    (followUp) => followUp.approval_id === approval.id
  )) {
    artifacts.push({
      kind: "follow_up",
      id: followUp.id,
      path: `.kairon/follow-ups/${followUp.id}.json`,
      anchor: `#follow-up-${followUp.id}`,
      status: followUp.status
    });
  }

  return artifacts.length === 0 ? undefined : artifacts;
}

function approvalLocalCommandHint(
  approval: ApprovalRecord,
  confirmation: Record<string, unknown> | undefined,
  riskLevel: string | undefined
): string | undefined {
  if (!isOpenApprovalSummary({ id: approval.id, status: approval.status })) {
    return undefined;
  }

  const actions = approval.actions ?? approval.allowed_actions ?? [];
  const confirmationAction = readString(confirmation?.action);
  const action =
    confirmationAction ??
    (actions.includes("approve")
      ? "approve"
      : actions.find((candidate) => candidate !== "snooze"));

  if (approval.status === "confirmation_required" && action !== undefined) {
    return sanitizeInline(
      `Review this Board detail, then run: kairon approval decide ${approval.id} --action ${action} --reason "<reason>"`
    );
  }

  if (riskLevel === "high" || riskLevel === "critical") {
    return sanitizeInline(
      action === undefined
        ? `Inspect locally before deciding: kairon approval show ${approval.id}`
        : `Inspect locally first: kairon approval show ${approval.id}; then decide with kairon approval decide ${approval.id} --action ${action} --reason "<reason>"`
    );
  }

  return sanitizeInline(`Inspect approval detail: kairon approval show ${approval.id}`);
}

function summarizeApprovalFollowUp(
  followUp: ApprovalFollowUpArtifact
): BoardApprovalFollowUpSummary {
  return compact({
    id: followUp.id,
    approval_id: followUp.approval_id,
    approval_type: followUp.approval_type,
    decision: followUp.decision,
    action_type: followUp.action_type,
    status: followUp.status,
    risk_level: followUp.risk_level,
    task_id: followUp.task_id,
    run_id: followUp.run_id,
    transaction_id: followUp.transaction_id,
    queue_item_type: followUp.queue_item_type,
    queue_item_id: followUp.queue_item_id,
    attempts: followUp.attempts,
    last_execution_status: followUp.last_execution?.status,
    execution_performed: followUp.last_execution?.execution_performed,
    command_hint: sanitizeInline(followUp.command_hint),
    due_at: followUp.due_at,
    created_at: followUp.created_at,
    updated_at: followUp.updated_at
  });
}

function summarizeReviewLoop(loop: ReviewLoopArtifact): BoardReviewLoopSummary {
  return compact({
    loop_id: loop.loop_id ?? "unknown",
    task_id: loop.task_id,
    status: loop.status,
    iteration: loop.iteration,
    max_iterations: loop.max_iterations,
    implementer: loop.implementer,
    reviewers: loop.reviewers,
    integration: loop.integration,
    code_producing: loop.code_producing,
    created_at: loop.created_at,
    updated_at: loop.updated_at
  });
}

function summarizeReviewResult(result: ReviewResultArtifact): BoardReviewResultSummary {
  const severities = (result.findings ?? [])
    .map((finding) => finding.severity)
    .filter((severity): severity is string => severity !== undefined);

  return compact({
    review_id: result.review_id ?? "unknown",
    run_id: result.run_id,
    reviewer: result.reviewer,
    status: result.status,
    score: result.score,
    tests_passed: result.tests_passed,
    secret_scan_passed: result.secret_scan_passed,
    finding_count: result.findings?.length,
    highest_severity: highestSeverity(severities),
    created_at: result.created_at
  });
}

function summarizeGitTransaction(
  transaction: GitTransactionArtifact
): BoardGitTransactionSummary {
  const reason = transaction.push?.reason;
  const prCreateHint = transaction.pr?.create_hint;
  const rollbackHint =
    transaction.pr?.rollback_hint ?? transaction.rollback?.command_hint;

  return compact({
    transaction_id: transaction.transaction_id ?? "unknown",
    task_id: transaction.task_id,
    run_id: transaction.run_id,
    review_loop_id: transaction.review_loop_id,
    branch: transaction.branch,
    status: transaction.status,
    remote: transaction.push?.remote,
    remote_ref: transaction.push?.remote_ref,
    approval_id: transaction.push?.approval_id,
    reason: reason === undefined ? undefined : sanitizeInline(reason),
    commit_sha: transaction.commit_sha,
    diff_sha256: transaction.diff_sha256,
    pr_status: transaction.pr?.status,
    pr_base: transaction.pr?.base_branch,
    pr_head: transaction.pr?.head_branch,
    pr_create_hint:
      prCreateHint === undefined ? undefined : sanitizeInline(prCreateHint),
    rollback_strategy:
      transaction.pr?.rollback_strategy ?? transaction.rollback?.strategy,
    rollback_hint:
      rollbackHint === undefined ? undefined : sanitizeInline(rollbackHint),
    transaction_path: transaction.transaction_path,
    created_at: transaction.created_at,
    updated_at: transaction.updated_at
  });
}

function summarizeOperations(input: {
  approvals: BoardApprovalSummary[];
  followUps: BoardApprovalFollowUpSummary[];
  runs: BoardRunSummary[];
  recoveryTargets: number;
  gitTransactions: BoardGitTransactionSummary[];
  workflows: BoardWorkflowSummary[];
  recentLimit: number;
}): BoardOperationsSummary {
  const pendingApprovals = input.approvals.filter(isOpenApprovalSummary);
  const pendingFollowUps = input.followUps.filter((followUp) =>
    ["pending", "running"].includes(followUp.status)
  );
  const failedRuns = input.runs.filter((run) => run.status === "failed" || run.outbox_status === "failed");
  const setupRequiredRuns = input.runs.filter((run) =>
    ["setup_required", "permission_required", "rate_limited", "usage_limited", "timeout", "no_output"].includes(
      run.status ?? run.outbox_status ?? ""
    )
  );
  const approvalRequiredTransactions = input.gitTransactions.filter(
    (transaction) => transaction.status === "approval_required"
  );
  const workflowAttention = input.workflows.filter(isWorkflowAttention);
  const priority: BoardOperationPriorityItem[] = [
    ...pendingApprovals.map((approval) =>
      compact({
        kind: "approval" as const,
        id: approval.id,
        label: approval.title ?? approval.type ?? "Approval pending",
        status: approval.status,
        severity: "high" as const,
        anchor: `#approval-${approval.id}`,
        detail: approval.local_command_hint ?? approval.reason
      })
    ),
    ...pendingFollowUps.map((followUp) =>
      compact({
        kind: "follow_up" as const,
        id: followUp.id,
        label: followUp.action_type,
        status: followUp.status,
        severity: followUp.risk_level === "high" ? ("high" as const) : ("medium" as const),
        anchor: `#follow-up-${followUp.id}`,
        detail: followUp.command_hint
      })
    ),
    ...failedRuns.map((run) =>
      compact({
        kind: "run" as const,
        id: run.run_id,
        label: run.task_id ?? run.agent ?? "Run failed",
        status: run.status ?? run.outbox_status ?? "failed",
        severity: "high" as const,
        anchor: `#run-${run.run_id}`,
        detail: run.command
      })
    ),
    ...setupRequiredRuns.map((run) =>
      compact({
        kind: "run" as const,
        id: run.run_id,
        label: run.task_id ?? run.agent ?? "Run setup required",
        status: run.status ?? run.outbox_status ?? "setup_required",
        severity: "medium" as const,
        anchor: `#run-${run.run_id}`,
        detail: run.command
      })
    ),
    ...approvalRequiredTransactions.map((transaction) =>
      compact({
        kind: "git_transaction" as const,
        id: transaction.transaction_id,
        label: transaction.task_id ?? transaction.branch ?? "Git transaction",
        status: transaction.status ?? "approval_required",
        severity: "high" as const,
        anchor: `#git-transaction-${transaction.transaction_id}`,
        detail: transaction.approval_id ?? transaction.reason
      })
    ),
    ...workflowAttention.map((workflow) =>
      compact({
        kind: "workflow" as const,
        id: workflow.workflow_id,
        label: workflow.current_node ?? workflow.task_id,
        status: workflow.status,
        severity: workflow.status === "failed" ? ("high" as const) : ("medium" as const),
        anchor: `#workflow-${workflow.workflow_id}`,
        detail: workflow.blocker ?? workflow.last_event?.action
      })
    ),
    ...(input.recoveryTargets > 0
      ? [
          {
            kind: "recovery" as const,
            id: "recovery",
            label: "Runtime recovery targets",
            status: String(input.recoveryTargets),
            severity: "high" as const,
            anchor: "#recovery",
            detail: "Run kairon recovery inspect"
          }
        ]
      : [])
  ];

  return {
    pending_approvals: pendingApprovals.length,
    pending_follow_ups: pendingFollowUps.length,
    failed_runs: failedRuns.length,
    setup_required_runs: setupRequiredRuns.length,
    recovery_targets: input.recoveryTargets,
    git_transactions_requiring_approval: approvalRequiredTransactions.length,
    workflow_attention: workflowAttention.length,
    attention_total:
      pendingApprovals.length +
      pendingFollowUps.length +
      failedRuns.length +
      setupRequiredRuns.length +
      input.recoveryTargets +
      approvalRequiredTransactions.length +
      workflowAttention.length,
    priority: priority.slice(0, input.recentLimit)
  };
}

function isWorkflowAttention(workflow: BoardWorkflowSummary): boolean {
  return (
    workflow.status === "failed" ||
    workflow.status === "paused" ||
    workflow.control_mode === "cancellation_requested"
  );
}

function isOpenApprovalSummary(approval: BoardApprovalSummary): boolean {
  return ["pending", "snoozed", "confirmation_required"].includes(approval.status);
}

function summarizeCleanupProposal(
  proposal: CleanupProposalArtifact
): BoardCleanupProposalSummary {
  return compact({
    date: proposal.date ?? "unknown",
    proposal_path: proposal.proposal_path,
    direct_delete: proposal.direct_delete,
    candidate_count: proposal.candidates?.length ?? 0,
    created_at: proposal.created_at
  });
}

function summarizeDailyReport(report: DailyReportArtifact): BoardDailyReportSummary {
  return compact({
    date: report.date ?? "unknown",
    report_path: report.report_path,
    completed_runs: report.summary?.completed_runs,
    failed_runs: report.summary?.failed_runs,
    setup_required_runs: report.summary?.setup_required_runs,
    pending_approvals: report.summary?.pending_approvals,
    failed_notifications: report.summary?.failed_notifications,
    git_transactions_ready_for_pr: report.summary?.git_transactions_ready_for_pr,
    git_transactions_requiring_approval:
      report.summary?.git_transactions_requiring_approval,
    created_at: report.created_at
  });
}

function summarizeDiscordNotificationAudits(
  records: DiscordNotificationAuditRecord[],
  decisions: DiscordDecisionAuditRecord[],
  recentLimit: number
): BoardDiscordAuditSummary {
  const decidedApprovalIds = new Set(
    decisions
      .map((record) => record.approval_id)
      .filter((approvalId): approvalId is string => approvalId !== undefined && approvalId.length > 0)
  );

  return {
    total: records.length,
    by_status: countBy(records, (record) => record.status ?? "unknown"),
    recent: records
      .sort(compareDiscordNotificationAuditsDesc)
      .slice(0, recentLimit)
      .map((record) =>
        compact({
          approval_id: record.approval_id,
          status: record.status,
          decision_status:
            record.approval_id === undefined
              ? undefined
              : decidedApprovalIds.has(record.approval_id)
                ? "received"
                : "missing",
          message_id: record.message_id,
          board_anchor: record.board_anchor,
          board_url: sanitizeLocalBoardUrl(record.board_url),
          reason: record.reason === undefined ? undefined : sanitizeInline(record.reason),
          next_action:
            record.approval_id === undefined || decidedApprovalIds.has(record.approval_id)
              ? undefined
              : discordDecisionAuditNextAction,
          recorded_at: record.recorded_at,
          sent_at: record.sent_at,
          updated_at: record.updated_at
        })
      )
  };
}

function summarizeDiscordDecisionAudits(
  records: DiscordDecisionAuditRecord[],
  recentLimit: number
): BoardDiscordDecisionAuditSummary {
  const hasRecords = records.length > 0;
  return {
    total: records.length,
    status: hasRecords ? "present" : "missing",
    next_action: hasRecords ? undefined : discordDecisionAuditNextAction,
    by_status: countBy(records, (record) => record.status ?? "unknown"),
    by_decision: countBy(records, (record) => record.decision ?? "unknown"),
    recent: records
      .sort(compareDiscordDecisionAuditsDesc)
      .slice(0, recentLimit)
      .map((record) =>
        compact({
          approval_id: record.approval_id,
          decision: record.decision,
          status: record.status,
          duplicate: record.duplicate,
          actor_hash: record.actor_hash,
          message_id: record.message_id,
          command_status: record.command_status,
          message_update_status: record.message_update_status,
          message_update_reason:
            record.message_update_reason === undefined
              ? undefined
              : sanitizeInline(record.message_update_reason),
          recorded_at: record.recorded_at
        })
      )
  };
}

async function readOptionalJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return readJsonLines<T>(filePath);
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  return readJsonFile<T>(filePath);
}

function compareByUpdatedDesc<T extends { updated_at?: string; created_at?: string }>(
  left: T,
  right: T
): number {
  return timestamp(right.updated_at ?? right.created_at) - timestamp(left.updated_at ?? left.created_at);
}

function compareByCreatedDesc<T extends { created_at?: string }>(
  left: T,
  right: T
): number {
  return timestamp(right.created_at) - timestamp(left.created_at);
}

function compareDailyReportsDesc(left: DailyReportArtifact, right: DailyReportArtifact): number {
  return timestamp(right.created_at ?? right.date) - timestamp(left.created_at ?? left.date);
}

function compareDiscordNotificationAuditsDesc(
  left: DiscordNotificationAuditRecord,
  right: DiscordNotificationAuditRecord
): number {
  return (
    timestamp(right.recorded_at ?? right.updated_at ?? right.sent_at) -
    timestamp(left.recorded_at ?? left.updated_at ?? left.sent_at)
  );
}

function compareDiscordDecisionAuditsDesc(
  left: DiscordDecisionAuditRecord,
  right: DiscordDecisionAuditRecord
): number {
  return timestamp(right.recorded_at) - timestamp(left.recorded_at);
}

function compareRunSummariesDesc(left: BoardRunSummary, right: BoardRunSummary): number {
  return timestamp(right.finished_at ?? right.created_at) - timestamp(left.finished_at ?? left.created_at);
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const nextKey = key(value);
    counts[nextKey] = (counts[nextKey] ?? 0) + 1;
    return counts;
  }, {});
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const safe = Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (secretKeyPattern.test(key)) {
        return [key, "[redacted]"];
      }

      return [key, sanitizeMetadataValue(raw)];
    })
  );

  return compact(safe);
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => {
        if (secretKeyPattern.test(key)) {
          return [key, "[redacted]"];
        }

        return [key, sanitizeMetadataValue(raw)];
      })
    );
  }

  return typeof value === "string" ? sanitizeInline(value) : value;
}

function sanitizeInline(value: string): string {
  const collapsed = value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 237)}...`;
}

function sanitizeLocalBoardUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) {
      return undefined;
    }

    url.username = "";
    url.password = "";
    url.search = "";
    return sanitizeInline(url.toString());
  } catch {
    return undefined;
  }
}

function highestSeverity(severities: string[]): string | undefined {
  const order = ["critical", "high", "medium", "low", "info"];
  return order.find((severity) =>
    severities.some((candidate) => candidate.toLowerCase() === severity)
  );
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, raw]) => raw !== undefined)
  ) as T;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeOptionalInline(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeInline(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
