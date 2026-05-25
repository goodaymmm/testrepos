import { describe, expect, it } from "vitest";
import path from "node:path";
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

    const report = await createDailyReport(root, { date: "2026-05-25" });

    expect(report.runs).toMatchObject({
      total: 1,
      by_status: { completed: 1 }
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
    await expect(
      readJsonFile(path.join(root, ".kairon", "reports", "daily", "2026-05-25.json"))
    ).resolves.toMatchObject({
      date: "2026-05-25",
      runs: { total: 1 }
    });
  });
});
