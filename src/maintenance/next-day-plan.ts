import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { CleanupProposal } from "./cleanup-proposals.js";
import type { DailyReport, DailyRunSummary } from "./daily-report.js";

export type NextDayPlanItem = {
  id: string;
  type:
    | "failed_run"
    | "setup_required_agent"
    | "pending_approval"
    | "review_followup"
    | "cleanup_triage"
    | "recovery_followup";
  title: string;
  priority: number;
  source_path?: string;
  references: string[];
};

export type NextDayPlan = {
  schema_version: string;
  date: string;
  plan_for_date: string;
  plan_path: string;
  daily_report_path: string;
  cleanup_proposal_path: string;
  summary: {
    action_items: number;
    failed_runs: number;
    setup_required_runs: number;
    pending_approvals: number;
    review_followups: number;
    cleanup_candidates: number;
    recovery_approvals_requested: number;
  };
  action_items: NextDayPlanItem[];
  bootstrap_sources: string[];
  created_at: string;
};

export type CreateNextDayPlanRequest = {
  date: string;
  dailyReport: DailyReport;
  cleanupProposal: CleanupProposal;
};

export async function createNextDayPlan(
  projectRoot: string,
  request: CreateNextDayPlanRequest
): Promise<NextDayPlan> {
  const paths = getKaironPaths(projectRoot);
  const planPath = resolveInside(
    paths.reportsDir,
    "next-day",
    `${request.date}.json`
  );
  const actionItems = buildActionItems(request.dailyReport, request.cleanupProposal);
  const plan: NextDayPlan = {
    schema_version: "0.1",
    date: request.date,
    plan_for_date: nextDateKey(request.date),
    plan_path: toProjectPath(paths.root, planPath),
    daily_report_path: request.dailyReport.report_path,
    cleanup_proposal_path: request.cleanupProposal.proposal_path,
    summary: {
      action_items: actionItems.length,
      failed_runs: request.dailyReport.summary.failed_runs,
      setup_required_runs: request.dailyReport.summary.setup_required_runs,
      pending_approvals: request.dailyReport.summary.pending_approvals,
      review_followups: actionItems.filter((item) => item.type === "review_followup")
        .length,
      cleanup_candidates: request.cleanupProposal.candidates.length,
      recovery_approvals_requested:
        request.dailyReport.summary.recovery_approvals_requested
    },
    action_items: actionItems,
    bootstrap_sources: [
      request.dailyReport.report_path,
      request.cleanupProposal.proposal_path
    ],
    created_at: new Date().toISOString()
  };

  await mkdir(path.dirname(planPath), { recursive: true });
  await writeJsonFileAtomic(planPath, plan);
  return plan;
}

function buildActionItems(
  report: DailyReport,
  cleanupProposal: CleanupProposal
): NextDayPlanItem[] {
  const items: NextDayPlanItem[] = [];

  for (const run of report.runs.items.filter(isFailedRun)) {
    items.push({
      id: `next-${run.run_id}`,
      type: run.status === "failed" ? "failed_run" : "setup_required_agent",
      title: `Review ${run.status} run ${run.run_id}`,
      priority: run.status === "failed" ? 90 : 80,
      source_path: run.outbox_path,
      references: [run.run_id, run.task_id].filter(isString)
    });
  }

  for (const approval of report.approvals.items.filter(
    (item) => item.status === "pending"
  )) {
    const approvalId = approval.id;
    items.push({
      id: `next-${approvalId}`,
      type: "pending_approval",
      title: `Resolve pending approval ${approvalId}`,
      priority: 100,
      references: [approvalId, optionalString(approval.type)].filter(isString)
    });
  }

  for (const loop of report.reviews.loops.filter((item) =>
    ["running", "changes_requested", "escalated"].includes(String(item.status))
  )) {
    const loopId = String(loop.loop_id ?? "unknown");
    items.push({
      id: `next-${loopId}`,
      type: "review_followup",
      title: `Continue review loop ${loopId}`,
      priority: String(loop.status) === "escalated" ? 95 : 85,
      references: [loopId, optionalString(loop.task_id)].filter(isString)
    });
  }

  if (cleanupProposal.candidates.length > 0) {
    items.push({
      id: `next-cleanup-${cleanupProposal.date.replaceAll("-", "")}`,
      type: "cleanup_triage",
      title: `Review ${cleanupProposal.candidates.length} cleanup candidates`,
      priority: 70,
      source_path: cleanupProposal.proposal_path,
      references: [cleanupProposal.proposal_path]
    });
  }

  if (report.summary.recovery_approvals_requested > 0) {
    items.push({
      id: `next-recovery-${report.date.replaceAll("-", "")}`,
      type: "recovery_followup",
      title: "Review runtime recovery approval requests",
      priority: 95,
      references: report.recovery.items
        .map((item) => optionalString(item.recovery_id))
        .filter(isString)
    });
  }

  return items.sort((left, right) => right.priority - left.priority);
}

function isFailedRun(run: DailyRunSummary): boolean {
  return [
    "failed",
    "setup_required",
    "permission_required",
    "rate_limited",
    "usage_limited",
    "timeout"
  ].includes(run.status);
}

function nextDateKey(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }

  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
