import { runDailyMaintenance } from "../../maintenance/run.js";

export type RunMaintenanceOptions = {
  buildRag?: boolean;
};

export async function runMaintenance(
  projectRoot: string,
  options: RunMaintenanceOptions = {}
): Promise<string> {
  const result = await runDailyMaintenance(projectRoot, {
    forceRagIndex: options.buildRag === true
  });
  const ragLines =
    result.rag_index === undefined
      ? result.rag_index_skipped === undefined
        ? []
        : [
            "rag_index=skipped",
            `rag_skip_reason=${result.rag_index_skipped.reason}`
          ]
      : [
          `rag_index=${result.rag_index.index_path}`,
          `rag_chunks=${result.rag_index.chunk_count}`
        ];

  return [
    `Kairon maintenance completed for ${result.date}.`,
    `daily_report=${result.daily_report_path}`,
    `cleanup_proposal=${result.cleanup_proposal_path}`,
    `next_day_plan=${result.next_day_plan_path}`,
    `next_day_action_items=${result.next_day_plan.summary.action_items}`,
    `handoffs=${result.handoff_paths.length}`,
    `expired_test_queue_items=${result.expired_test_queue_item_ids.length}`,
    `summary_failed_runs=${result.daily_report.summary.failed_runs}`,
    `summary_setup_required_runs=${result.daily_report.summary.setup_required_runs}`,
    `summary_pending_approvals=${result.daily_report.summary.pending_approvals}`,
    `summary_failed_notifications=${result.daily_report.summary.failed_notifications}`,
    `recovery_artifact=${result.recovery.artifact_path}`,
    `recovery_requeued=${result.recovery.summary.requeued_items}`,
    `recovery_approvals=${result.recovery.summary.approvals_requested}`,
    ...ragLines
  ]
    .join("\n");
}
