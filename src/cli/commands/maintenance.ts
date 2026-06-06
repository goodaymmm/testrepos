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
    `handoffs=${result.handoff_paths.length}`,
    `expired_test_queue_items=${result.expired_test_queue_item_ids.length}`,
    `recovery_artifact=${result.recovery.artifact_path}`,
    `recovery_requeued=${result.recovery.summary.requeued_items}`,
    `recovery_approvals=${result.recovery.summary.approvals_requested}`,
    ...ragLines
  ]
    .join("\n");
}
