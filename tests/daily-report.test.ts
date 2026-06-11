import { describe, expect, it } from "vitest";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic, readJsonFile } from "../src/core/fs/json-file.js";
import { createDailyReport } from "../src/maintenance/daily-report.js";
import { createTempProject } from "./test-utils.js";

describe("createDailyReport", () => {
  it("aggregates runs, approvals, reviews, and git artifacts by date", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0001", "runner.json"), {
      schema_version: "0.1",
      kind: "job",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      agent: "codex",
      persona: "implementer",
      status: "completed",
      command: "codex",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json",
      stdout_log: ".kairon/runs/RUN-0001/stdout.log",
      stderr_log: ".kairon/runs/RUN-0001/stderr.log",
      created_at: "2026-05-25T01:00:00.000Z",
      finished_at: "2026-05-25T01:01:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0002", "runner.json"), {
      schema_version: "0.1",
      kind: "job",
      run_id: "RUN-0002",
      task_id: "TASK-0002",
      agent: "claude",
      persona: "reviewer",
      status: "failed",
      created_at: "2026-05-25T01:10:00.000Z",
      finished_at: "2026-05-25T01:11:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0003", "runner.json"), {
      schema_version: "0.1",
      kind: "job",
      run_id: "RUN-0003",
      task_id: "TASK-0003",
      agent: "gemini",
      persona: "qa",
      status: "setup_required",
      created_at: "2026-05-25T01:20:00.000Z",
      finished_at: "2026-05-25T01:21:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
      schema_version: "0.1",
      id: "APR-0001",
      status: "pending",
      type: "merge",
      created_at: "2026-05-25T02:00:00.000Z",
      updated_at: "2026-05-25T02:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"), {
      schema_version: "0.1",
      loop_id: "REV-0001",
      status: "running",
      created_at: "2026-05-25T03:00:00.000Z",
      updated_at: "2026-05-25T03:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "reviews", "results", "REV-RESULT-1.json"), {
      schema_version: "0.1",
      review_id: "REV-RESULT-1",
      status: "passed",
      created_at: "2026-05-25T04:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "git", "branches", "TASK-0001.json"), {
      schema_version: "0.1",
      task_id: "TASK-0001",
      branch: "codex/t10",
      created_at: "2026-05-25T05:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"), {
      schema_version: "0.1",
      id: "GTX-0001",
      status: "completed",
      created_at: "2026-05-25T06:00:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "recovery", "REC-20260525070000000.json"), {
      schema_version: "0.1",
      recovery_id: "REC-20260525070000000",
      created_at: "2026-05-25T07:00:00.000Z",
      summary: {
        requeued_items: 1,
        approvals_requested: 2
      }
    });
    await writeFile(
      path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl"),
      JSON.stringify({
        status: "failed",
        approval_id: "APR-0001",
        created_at: "2026-05-25T08:00:00.000Z"
      }) + "\n",
      "utf8"
    );
    await writeJsonFileAtomic(path.join(root, ".kairon", "runtime", "discord", "gateway.json"), {
      schema_version: "0.1",
      status: "setup_required",
      error_code: "discord_missing_access",
      updated_at: "2026-05-25T08:01:00.000Z"
    });

    const report = await createDailyReport(root, { date: "2026-05-25" });

    expect(report.runs).toMatchObject({
      total: 3,
      by_status: { completed: 1, failed: 1, setup_required: 1 }
    });
    expect(report.summary).toMatchObject({
      completed_runs: 1,
      failed_runs: 1,
      setup_required_runs: 1,
      pending_approvals: 1,
      failed_notifications: 1,
      recovery_approvals_requested: 2,
      git_transactions_by_status: { completed: 1 },
      review_loops_by_status: { running: 1 }
    });
    expect(report.approvals).toMatchObject({
      total: 1,
      pending: 1
    });
    expect(report.reviews).toMatchObject({
      loops_total: 1,
      results_total: 1
    });
    expect(report.git).toMatchObject({
      branches_total: 1,
      transactions_total: 1
    });
    expect(report.recovery).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ recovery_id: "REC-20260525070000000" })]
    });
    expect(report.notifications.discord).toMatchObject({
      audit_total: 1,
      failed: 1,
      gateway_status: "setup_required",
      last_error_code: "discord_missing_access"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "reports", "daily", "2026-05-25.json"))
    ).resolves.toMatchObject({
      date: "2026-05-25",
      runs: { total: 3 },
      recovery: { total: 1 },
      summary: { failed_runs: 1 }
    });
  });
});
