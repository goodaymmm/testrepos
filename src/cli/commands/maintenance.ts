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
            "rag_status=skipped",
            "rag_index=skipped",
            `rag_skip_reason=${result.rag_index_skipped.reason}`
          ]
      : [
          "rag_status=updated",
          `rag_index=${result.rag_index.index_path}`,
          `rag_refresh_mode=${result.rag_index.refresh_mode}`,
          `rag_sources=${result.rag_index.source_count}`,
          `rag_chunks=${result.rag_index.chunk_count}`,
          `rag_scanned_sources=${result.rag_index.scanned_source_count}`,
          `rag_added_sources=${result.rag_index.added_source_count}`,
          `rag_updated_sources=${result.rag_index.updated_source_count}`,
          `rag_unchanged_sources=${result.rag_index.unchanged_source_count}`,
          `rag_skipped_sources=${result.rag_index.skipped_source_count}`,
          `rag_skipped_protected=${result.rag_index.skipped_protected_count}`,
          `rag_skipped_generated=${result.rag_index.skipped_generated_count}`,
          `rag_skipped_missing=${result.rag_index.skipped_missing_count}`,
          `rag_skipped_archived=${result.rag_index.skipped_archived_count}`,
          ...formatReasonCounts(
            "rag_skipped_reason",
            result.rag_index.skipped_reason_counts
          ),
          `rag_pruned_sources=${result.rag_index.pruned_source_count}`,
          `rag_pruned_missing_sources=${result.rag_index.pruned_missing_source_count}`,
          `rag_pruned_excluded_sources=${result.rag_index.pruned_excluded_source_count}`,
          `rag_pruned_protected_sources=${result.rag_index.pruned_protected_source_count}`,
          `rag_pruned_generated_sources=${result.rag_index.pruned_generated_source_count}`,
          `rag_pruned_archived_sources=${result.rag_index.pruned_archived_source_count}`,
          `rag_pruned_ephemeral_sources=${result.rag_index.pruned_ephemeral_source_count}`,
          ...formatReasonCounts(
            "rag_pruned_reason",
            result.rag_index.pruned_reason_counts
          )
        ];

  return [
    `Kairon maintenance completed for ${result.date}.`,
    `daily_report=${result.daily_report_path}`,
    `cleanup_proposal=${result.cleanup_proposal_path}`,
    `cleanup_candidates=${result.cleanup_proposal.candidates.length}`,
    `cleanup_retention_candidates=${result.cleanup_proposal.retention_summary?.candidates ?? 0}`,
    `cleanup_retention_candidate_bytes=${result.cleanup_proposal.retention_summary?.candidate_bytes ?? 0}`,
    `next_day_plan=${result.next_day_plan_path}`,
    `next_day_action_items=${result.next_day_plan.summary.action_items}`,
    `handoffs=${result.handoff_paths.length}`,
    `expired_test_queue_items=${result.expired_test_queue_item_ids.length}`,
    `summary_failed_runs=${result.daily_report.summary.failed_runs}`,
    `summary_setup_required_runs=${result.daily_report.summary.setup_required_runs}`,
    `summary_pending_approvals=${result.daily_report.summary.pending_approvals}`,
    `summary_failed_notifications=${result.daily_report.summary.failed_notifications}`,
    `recovery_artifact=${result.recovery.artifact_path}`,
    `recovery_scanned_queue_items=${result.recovery.summary.scanned_queue_items}`,
    `recovery_scanned_runs=${result.recovery.summary.scanned_runs}`,
    `recovery_scanned_git_transactions=${result.recovery.summary.scanned_git_transactions}`,
    `recovery_stale_locks_cleared=${result.recovery.summary.stale_locks_cleared}`,
    `recovery_resource_locks_cleared=${result.recovery.summary.resource_locks_cleared}`,
    `recovery_gateway_artifacts_recovered=${result.recovery.summary.gateway_artifacts_recovered}`,
    `recovery_requeued=${result.recovery.summary.requeued_items}`,
    `recovery_approvals=${result.recovery.summary.approvals_requested}`,
    `recovery_existing_approvals=${result.recovery.summary.approvals_existing}`,
    `recovery_git_transaction_issues=${result.recovery.summary.git_transaction_issues}`,
    ...ragLines,
    "next_status_command=kairon status",
    `next_cleanup_command=kairon cleanup show ${result.date}`,
    "next_recovery_command=kairon recovery list",
    "next_board_command=kairon board export"
  ]
    .join("\n");
}

function formatReasonCounts(
  prefix: string,
  values: Record<string, number>
): string[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${prefix}.${reason}=${count}`);
}
