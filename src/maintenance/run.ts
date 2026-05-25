import { loadConfigFile } from "../core/config/load-config.js";
import { getLocalDateKey } from "../runtime/schedule-engine.js";
import {
  createCleanupProposals,
  type CleanupProposal
} from "./cleanup-proposals.js";
import { createDailyReport, type DailyReport } from "./daily-report.js";
import { createDailyHandoffs, type AgentHandoff } from "./handoff.js";

export type RunDailyMaintenanceRequest = {
  date?: string;
  now?: Date;
};

export type DailyMaintenanceResult = {
  schema_version: string;
  date: string;
  daily_report_path: string;
  cleanup_proposal_path: string;
  handoff_paths: string[];
  daily_report: DailyReport;
  cleanup_proposal: CleanupProposal;
  handoffs: AgentHandoff[];
};

type ScheduleConfig = {
  timezone: string;
};

export async function runDailyMaintenance(
  projectRoot: string,
  request: RunDailyMaintenanceRequest = {}
): Promise<DailyMaintenanceResult> {
  const date = request.date ?? (await resolveDate(projectRoot, request.now ?? new Date()));
  const cleanupProposal = await createCleanupProposals(projectRoot, { date });
  const dailyReport = await createDailyReport(projectRoot, { date });
  const handoffs = await createDailyHandoffs(projectRoot, {
    date,
    dailyReport
  });

  return {
    schema_version: "0.1",
    date,
    daily_report_path: dailyReport.report_path,
    cleanup_proposal_path: cleanupProposal.proposal_path,
    handoff_paths: handoffs.map((handoff) => handoff.handoff_path),
    daily_report: dailyReport,
    cleanup_proposal: cleanupProposal,
    handoffs
  };
}

async function resolveDate(projectRoot: string, now: Date): Promise<string> {
  const config = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  return getLocalDateKey(now, config.timezone);
}
