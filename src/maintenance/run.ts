import { loadConfigFile } from "../core/config/load-config.js";
import { WorkQueue } from "../queue/work-queue.js";
import {
  buildRagIndex,
  isRagEnabled,
  type BuildRagIndexResult
} from "../rag/lexical-index.js";
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
    | "source_count"
    | "chunk_count"
    | "skipped_source_count"
    | "skipped_protected_count"
    | "pruned_source_count"
  >;
  rag_index_skipped?: RagIndexSkipped;
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
  const cleanupProposal = await createCleanupProposals(projectRoot, { date });
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
  const ragEnabled = await isRagEnabled(projectRoot);
  const shouldBuildRag = request.forceRagIndex === true || ragEnabled;
  const ragIndex = shouldBuildRag
    ? await buildRagIndex(projectRoot, { now: () => now })
    : undefined;

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
            source_count: ragIndex.source_count,
            chunk_count: ragIndex.chunk_count,
            skipped_source_count: ragIndex.skipped_source_count,
            skipped_protected_count: ragIndex.skipped_protected_count,
            pruned_source_count: ragIndex.pruned_source_count
          },
    rag_index_skipped:
      ragIndex === undefined
        ? {
            reason: "disabled"
          }
        : undefined
  };
}

async function resolveDate(projectRoot: string, now: Date): Promise<string> {
  const config = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  return getLocalDateKey(now, config.timezone);
}
