import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { runMaintenance } from "../src/cli/commands/maintenance.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runDailyMaintenance } from "../src/maintenance/run.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { buildRagIndex } from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";

describe("runDailyMaintenance", () => {
  it("writes cleanup proposal, daily report, and handoffs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const result = await runDailyMaintenance(root, { date: "2026-05-25" });

    expect(result).toMatchObject({
      date: "2026-05-25",
      daily_report_path: ".kairon/reports/daily/2026-05-25.json",
      cleanup_proposal_path: ".kairon/cleanup/proposals/2026-05-25.json",
      next_day_plan_path: ".kairon/reports/next-day/2026-05-25.json"
    });
    expect(result.handoff_paths).toHaveLength(3);
    expect(result.next_day_plan).toMatchObject({
      date: "2026-05-25",
      plan_for_date: "2026-05-26",
      daily_report_path: ".kairon/reports/daily/2026-05-25.json",
      cleanup_proposal_path: ".kairon/cleanup/proposals/2026-05-25.json"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "handoff.json"))
    ).resolves.toMatchObject({
      agent: "codex"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "reports", "next-day", "2026-05-25.json"))
    ).resolves.toMatchObject({
      plan_for_date: "2026-05-26"
    });
  });

  it("expires stale test queue items during daily maintenance", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const stale = await queue.enqueue({
      type: "agent.run",
      test_scope: {
        kind: "manual_test",
        tags: ["manual-test"],
        expires_at: "2026-05-25T01:00:00.000Z"
      }
    });

    await expect(
      runDailyMaintenance(root, {
        date: "2026-05-25",
        now: new Date("2026-05-25T02:00:00.000Z")
      })
    ).resolves.toMatchObject({
      expired_test_queue_item_ids: [stale.id],
      recovery: {
        artifact_path: expect.stringMatching(/^\.kairon\/recovery\/REC-/)
      }
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: stale.id, error: { code: "stale_test_queue_item" } }
    ]);
  });

  it("exposes maintenance run through the CLI command handler", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const output = await runMaintenance(root);
    expect(output).toContain("Kairon maintenance completed");
    expect(output).toContain("next_day_plan=.kairon/reports/next-day/");
    expect(output).toContain("next_day_action_items=");
    expect(output).toContain("cleanup_candidates=");
    expect(output).toContain("cleanup_retention_candidates=");
    expect(output).toContain("cleanup_retention_candidate_bytes=");
    expect(output).toContain("summary_failed_runs=");
    expect(output).toContain("recovery_scanned_queue_items=");
    expect(output).toContain("recovery_scanned_runs=");
    expect(output).toContain("recovery_scanned_git_transactions=");
    expect(output).toContain("recovery_stale_locks_cleared=");
    expect(output).toContain("recovery_gateway_artifacts_recovered=");
    expect(output).toContain("recovery_existing_approvals=");
    expect(output).toContain("recovery_git_transaction_issues=");
    expect(output).toContain("rag_status=skipped");
    expect(output).toContain("rag_index=skipped");
    expect(output).toContain("rag_skip_reason=disabled");
    expect(output).toContain("next_status_command=kairon status");
    expect(output).toContain("next_cleanup_command=kairon cleanup show ");
    expect(output).toContain("next_recovery_command=kairon recovery list");
    expect(output).toContain("next_board_command=kairon board export");
  });

  it("creates next-day action items from unresolved maintenance state", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0001", "runner.json"), {
      schema_version: "0.1",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      status: "failed",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json",
      created_at: "2026-05-25T01:00:00.000Z",
      finished_at: "2026-05-25T01:01:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
      schema_version: "0.1",
      id: "APR-0001",
      status: "pending",
      type: "runtime_recovery",
      created_at: "2026-05-25T02:00:00.000Z",
      updated_at: "2026-05-25T02:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"), {
      schema_version: "0.1",
      loop_id: "REV-0001",
      task_id: "TASK-0001",
      status: "changes_requested",
      created_at: "2026-05-25T03:00:00.000Z",
      updated_at: "2026-05-25T03:00:00.000Z"
    });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "bundle.js"), "built\n", "utf8");

    const result = await runDailyMaintenance(root, { date: "2026-05-25" });

    expect(result.next_day_plan.summary).toMatchObject({
      failed_runs: 1,
      pending_approvals: 1,
      review_followups: 1,
      cleanup_candidates: expect.any(Number)
    });
    expect(result.next_day_plan.action_items.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        "failed_run",
        "pending_approval",
        "review_followup",
        "cleanup_triage"
      ])
    );
  });

  it("forces the RAG index refresh during maintenance when requested", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "forced-maintenance-rag.md"),
      "Forced maintenance should refresh local RAG memory.",
      "utf8"
    );

    const result = await runDailyMaintenance(root, {
      date: "2026-05-25",
      forceRagIndex: true
    });

    expect(result.rag_index).toMatchObject({
      index_path: ".kairon/rag/index.json",
      refresh_mode: "full",
      chunk_count: expect.any(Number),
      scanned_source_count: expect.any(Number),
      added_source_count: expect.any(Number),
      updated_source_count: 0,
      unchanged_source_count: 0,
      skipped_protected_count: expect.any(Number),
      skipped_generated_count: expect.any(Number),
      skipped_reason_counts: expect.objectContaining({
        protected: expect.any(Number),
        generated: expect.any(Number)
      }),
      pruned_source_count: expect.any(Number),
      pruned_reason_counts: expect.objectContaining({
        missing: expect.any(Number),
        archived: expect.any(Number)
      }),
      pruned_ephemeral_source_count: expect.any(Number)
    });
    expect(result.rag_index_skipped).toBeUndefined();
    expect(result.rag_integrity).toMatchObject({
      status: "PASS",
      issue_count: 0,
      index_checksum: expect.stringMatching(/^sha256:/u)
    });
    expect(result.rag_stats).toMatchObject({
      duplicate_chunk_count: expect.any(Number),
      estimated_total_tokens: expect.any(Number),
      context_budget_tokens: 12000,
      rebuild_due: false
    });
    expect(result.daily_report.rag).toMatchObject({
      integrity_status: "PASS",
      integrity_issues: 0,
      index_exists: true,
      context_budget_tokens: 12000
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "rag", "index.json"))
    ).resolves.toMatchObject({
      kind: "rag_lexical_index",
      sources: expect.arrayContaining([
        expect.objectContaining({ path: "docs/forced-maintenance-rag.md" })
      ])
    });

    const output = await runMaintenance(root, { buildRag: true });
    expect(output).toContain("rag_status=updated");
    expect(output).toContain("rag_index=.kairon/rag/index.json");
    expect(output).toContain("rag_refresh_mode=incremental");
    expect(output).toContain("rag_sources=");
    expect(output).toContain("rag_chunks=");
    expect(output).toContain("rag_scanned_sources=");
    expect(output).toContain("rag_added_sources=");
    expect(output).toContain("rag_updated_sources=");
    expect(output).toContain("rag_unchanged_sources=");
    expect(output).toContain("rag_skipped_sources=");
    expect(output).toContain("rag_skipped_protected=");
    expect(output).toContain("rag_skipped_generated=");
    expect(output).toContain("rag_skipped_reason.protected=");
    expect(output).toContain("rag_pruned_sources=");
    expect(output).toContain("rag_pruned_reason.missing=");
    expect(output).toContain("rag_pruned_ephemeral_sources=");
    expect(output).toContain("rag_integrity=PASS");
    expect(output).toContain("rag_integrity_issues=0");
    expect(output).toContain("rag_duplicate_ratio=");
    expect(output).toContain("rag_context_budget_tokens=12000");
    expect(output).toContain("rag_rebuild_due=false");
  });

  it("refreshes the RAG index during maintenance when enabled", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "config", "rag.json"), {
      schema_version: "0.1",
      enabled: true,
      storage: {
        base_dir: ".kairon/rag",
        lexical: "local"
      },
      security: {
        exclude_paths: [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
      }
    });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "maintenance-rag.md"),
      "Maintenance should refresh local RAG memory.",
      "utf8"
    );

    const result = await runDailyMaintenance(root, { date: "2026-05-25" });

    expect(result.rag_index).toMatchObject({
      index_path: ".kairon/rag/index.json",
      chunk_count: expect.any(Number),
      skipped_protected_count: expect.any(Number),
      pruned_source_count: expect.any(Number),
      pruned_ephemeral_source_count: expect.any(Number)
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "rag", "index.json"))
    ).resolves.toMatchObject({
      kind: "rag_lexical_index",
      sources: expect.arrayContaining([
        expect.objectContaining({ path: "docs/maintenance-rag.md" })
      ])
    });
    const output = await runMaintenance(root);
    expect(output).toContain("recovery_artifact=.kairon/recovery/REC-");
    expect(output).toContain("rag_index=.kairon/rag/index.json");
  });

  it("creates a compared rebuild candidate when the full index is due", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(root, ".kairon", "config", "rag.json");
    const config = await readJsonFile<Record<string, any>>(configPath);
    config.enabled = true;
    config.rebuild.interval_days = 1;
    await writeJsonFileAtomic(configPath, config);
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "due.md"), "RAG rebuild due evidence.", "utf8");
    await buildRagIndex(root, {
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    const result = await runDailyMaintenance(root, {
      date: "2026-07-12",
      now: new Date("2026-07-12T00:00:00.000Z")
    });

    expect(result.rag_stats?.rebuild_due).toBe(true);
    expect(result.rag_rebuild_candidate).toMatchObject({
      rebuild_id: "RAG-REBUILD-20260712T000000000Z",
      status: "ready",
      comparison_status: "passed"
    });
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "rag",
          "rebuilds",
          "RAG-REBUILD-20260712T000000000Z.json"
        )
      )
    ).resolves.toMatchObject({ status: "ready" });
  });
});
