import { loadConfigFile } from "../core/config/load-config.js";
import { WorkQueue } from "../queue/work-queue.js";
import {
  buildRagIndex,
  isRagEnabled,
  type BuildRagIndexResult
} from "../rag/lexical-index.js";
import {
  getRagStats,
  planRagRebuild,
  verifyRagIndex
} from "../rag/integrity.js";
import {
  runRuntimeRecovery,
  type RuntimeRecoveryResult
} from "../recovery/runtime-recovery.js";
import { getLocalDateKey } from "../runtime/schedule-engine.js";
import {
  createCleanupProposals,
  type CleanupProposal
} from "./cleanup-proposals.js";
import { createDailyReport, type DailyReport } from "./daily-report.js";
import { createDailyHandoffs, type AgentHandoff } from "./handoff.js";
import {
  createNextDayPlan,
  type NextDayPlan
} from "./next-day-plan.js";

export type RunDailyMaintenanceRequest = {
  date?: string;
  now?: Date;
  forceRagIndex?: boolean;
};

export type RagIndexSkipped = {
  reason: "disabled";
};

export type DailyMaintenanceResult = {
  schema_version: string;
  date: string;
  daily_report_path: string;
  cleanup_proposal_path: string;
  next_day_plan_path: string;
  handoff_paths: string[];
  daily_report: DailyReport;
  cleanup_proposal: CleanupProposal;
  next_day_plan: NextDayPlan;
  handoffs: AgentHandoff[];
  expired_test_queue_item_ids: string[];
  recovery: Pick<
    RuntimeRecoveryResult,
    "artifact_path" | "summary" | "recovery_id"
  >;
  rag_index?: Pick<
    BuildRagIndexResult,
    | "index_path"
    | "refresh_mode"
    | "source_count"
    | "chunk_count"
    | "scanned_source_count"
    | "added_source_count"
    | "updated_source_count"
    | "unchanged_source_count"
    | "skipped_source_count"
    | "skipped_protected_count"
    | "skipped_generated_count"
    | "skipped_missing_count"
    | "skipped_archived_count"
    | "skipped_reason_counts"
    | "pruned_source_count"
    | "pruned_missing_source_count"
    | "pruned_excluded_source_count"
    | "pruned_protected_source_count"
    | "pruned_generated_source_count"
    | "pruned_archived_source_count"
    | "pruned_ephemeral_source_count"
    | "pruned_reason_counts"
  >;
  rag_index_skipped?: RagIndexSkipped;
  rag_integrity?: {
    status: string;
    issue_count: number;
    index_checksum?: string;
  };
  rag_stats?: {
    duplicate_chunk_count: number;
    duplicate_ratio: number;
    estimated_total_tokens: number;
    context_budget_tokens: number;
    rebuild_due: boolean;
    retention_candidate_count: number;
  };
  rag_rebuild_candidate?: {
    rebuild_id: string;
    status: string;
    comparison_status: string;
  };
};

type ScheduleConfig = {
  timezone: string;
};

export async function runDailyMaintenance(
  projectRoot: string,
  request: RunDailyMaintenanceRequest = {}
): Promise<DailyMaintenanceResult> {
  const now = request.now ?? new Date();
  const date = request.date ?? (await resolveDate(projectRoot, now));
  const expiredTestItems = await new WorkQueue(projectRoot).expireStaleTestItems(now);
  const recovery = await runRuntimeRecovery(projectRoot, { now });
  const ragEnabled = await isRagEnabled(projectRoot);
  const shouldBuildRag = request.forceRagIndex === true || ragEnabled;
  const ragIndex = shouldBuildRag
    ? await buildRagIndex(projectRoot, {
        now: () => now,
        prune: true,
        compact: true
      })
    : undefined;
  const ragIntegrity = shouldBuildRag
    ? await verifyRagIndex(projectRoot, { now })
    : undefined;
  const ragStats = shouldBuildRag
    ? await getRagStats(projectRoot, { now })
    : undefined;
  const ragRebuildCandidate = ragStats?.rebuild_due === true
    ? await planRagRebuild(projectRoot, { now })
    : undefined;
  const cleanupProposal = await createCleanupProposals(projectRoot, { date, now });
  const dailyReport = await createDailyReport(projectRoot, { date });
  const nextDayPlan = await createNextDayPlan(projectRoot, {
    date,
    dailyReport,
    cleanupProposal
  });
  const handoffs = await createDailyHandoffs(projectRoot, {
    date,
    dailyReport
  });
  return {
    schema_version: "0.1",
    date,
    daily_report_path: dailyReport.report_path,
    cleanup_proposal_path: cleanupProposal.proposal_path,
    next_day_plan_path: nextDayPlan.plan_path,
    handoff_paths: handoffs.map((handoff) => handoff.handoff_path),
    daily_report: dailyReport,
    cleanup_proposal: cleanupProposal,
    next_day_plan: nextDayPlan,
    handoffs,
    expired_test_queue_item_ids: expiredTestItems.map((item) => item.id),
    recovery: {
      recovery_id: recovery.recovery_id,
      artifact_path: recovery.artifact_path,
      summary: recovery.summary
    },
    rag_index:
      ragIndex === undefined
        ? undefined
        : {
            index_path: ragIndex.index_path,
            refresh_mode: ragIndex.refresh_mode,
            source_count: ragIndex.source_count,
            chunk_count: ragIndex.chunk_count,
            scanned_source_count: ragIndex.scanned_source_count,
            added_source_count: ragIndex.added_source_count,
            updated_source_count: ragIndex.updated_source_count,
            unchanged_source_count: ragIndex.unchanged_source_count,
            skipped_source_count: ragIndex.skipped_source_count,
            skipped_protected_count: ragIndex.skipped_protected_count,
            skipped_generated_count: ragIndex.skipped_generated_count,
            skipped_missing_count: ragIndex.skipped_missing_count,
            skipped_archived_count: ragIndex.skipped_archived_count,
            skipped_reason_counts: ragIndex.skipped_reason_counts,
            pruned_source_count: ragIndex.pruned_source_count,
            pruned_missing_source_count: ragIndex.pruned_missing_source_count,
            pruned_excluded_source_count: ragIndex.pruned_excluded_source_count,
            pruned_protected_source_count: ragIndex.pruned_protected_source_count,
            pruned_generated_source_count: ragIndex.pruned_generated_source_count,
            pruned_archived_source_count: ragIndex.pruned_archived_source_count,
            pruned_ephemeral_source_count: ragIndex.pruned_ephemeral_source_count,
            pruned_reason_counts: ragIndex.pruned_reason_counts
          },
    rag_index_skipped:
      ragIndex === undefined
        ? {
            reason: "disabled"
          }
        : undefined,
    rag_integrity:
      ragIntegrity === undefined
        ? undefined
        : {
            status: ragIntegrity.status,
            issue_count: ragIntegrity.issue_count,
            index_checksum: ragIntegrity.index_checksum
          },
    rag_stats:
      ragStats === undefined
        ? undefined
        : {
            duplicate_chunk_count: ragStats.duplicate_chunk_count,
            duplicate_ratio: ragStats.duplicate_ratio,
            estimated_total_tokens: ragStats.estimated_total_tokens,
            context_budget_tokens: ragStats.context_budget_tokens,
            rebuild_due: ragStats.rebuild_due,
            retention_candidate_count: ragStats.retention_candidate_count
          },
    rag_rebuild_candidate:
      ragRebuildCandidate === undefined
        ? undefined
        : {
            rebuild_id: ragRebuildCandidate.rebuild_id,
            status: ragRebuildCandidate.status,
            comparison_status: ragRebuildCandidate.comparison.status
          }
  };
}

async function resolveDate(projectRoot: string, now: Date): Promise<string> {
  const config = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  return getLocalDateKey(now, config.timezone);
}
