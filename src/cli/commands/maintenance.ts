import { runDailyMaintenance } from "../../maintenance/run.js";

export async function runMaintenance(projectRoot: string): Promise<string> {
  const result = await runDailyMaintenance(projectRoot);
  return [
    `Kairon maintenance completed for ${result.date}.`,
    `daily_report=${result.daily_report_path}`,
    `cleanup_proposal=${result.cleanup_proposal_path}`,
    `handoffs=${result.handoff_paths.length}`,
    `expired_test_queue_items=${result.expired_test_queue_item_ids.length}`
  ].join("\n");
}
