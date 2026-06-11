import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { runMaintenance } from "../src/cli/commands/maintenance.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runDailyMaintenance } from "../src/maintenance/run.js";
import { WorkQueue } from "../src/queue/work-queue.js";
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
    expect(output).toContain("summary_failed_runs=");
    expect(output).toContain("rag_index=skipped");
    expect(output).toContain("rag_skip_reason=disabled");
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
      chunk_count: expect.any(Number)
    });
    expect(result.rag_index_skipped).toBeUndefined();
    await expect(
      readJsonFile(path.join(root, ".kairon", "rag", "index.json"))
    ).resolves.toMatchObject({
      kind: "rag_lexical_index",
      sources: expect.arrayContaining([
        expect.objectContaining({ path: "docs/forced-maintenance-rag.md" })
      ])
    });

    const output = await runMaintenance(root, { buildRag: true });
    expect(output).toContain("rag_index=.kairon/rag/index.json");
    expect(output).toContain("rag_chunks=");
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
      chunk_count: expect.any(Number)
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
});
