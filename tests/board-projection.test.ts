import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBoardProjection, exportBoardProjection } from "../src/board/projection.js";
import { exportBoard } from "../src/cli/commands/board.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("board projection", () => {
  it("exports a read-only sanitized board projection", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await seedBoardArtifacts(root);

    await new WorkQueue(root).enqueue({
      type: "agent.run",
      task_id: "TASK-0001",
      priority: 80,
      payload: {
        api_token: "SHOULD_NOT_LEAK",
        safe: "shown"
      }
    });

    const projection = await createBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      recentLimit: 5
    });

    expect(projection).toMatchObject({
      schema_version: "0.1",
      kind: "board_projection",
      generated_at: "2026-06-01T00:00:00.000Z",
      queue: {
        ready: 1
      },
      tasks: {
        total: 1,
        by_status: {
          ready: 1
        }
      },
      runs: {
        total: 1
      },
      approvals: {
        pending: 1
      },
      reviews: {
        loops_total: 1,
        results_total: 1
      },
      cleanup: {
        proposals_total: 1
      }
    });
    expect(projection.queue.recent[0]).toMatchObject({
      id: "JOB-0001",
      type: "agent.run",
      task_id: "TASK-0001"
    });
    expect(projection.queue.recent[0]).not.toHaveProperty("payload");
    expect(projection.runs.recent[0]).toMatchObject({
      run_id: "RUN-0001",
      outbox_status: "completed",
      outbox_event_count: 1
    });
    expect(projection.runs.recent[0]).not.toHaveProperty("stdout");
    expect(projection.approvals.recent[0]).toMatchObject({
      id: "APR-0001",
      status: "pending",
      title: "Deploy approval"
    });
    expect(projection.approvals.recent[0]).not.toHaveProperty("diff");

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("FULL_DIFF_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("FULL_STDOUT_SHOULD_NOT_APPEAR");

    const result = await exportBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z")
    });
    expect(result.projection_path).toBe(".kairon/board/projection.json");
    await expect(
      readJsonFile(path.join(root, ".kairon", "board", "projection.json"))
    ).resolves.toMatchObject({
      kind: "board_projection",
      queue: {
        ready: 1
      }
    });
  });

  it("formats the CLI export result", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const output = await exportBoard(root, { recent: "3" });

    expect(output).toContain("Kairon board projection exported.");
    expect(output).toContain("projection=.kairon/board/projection.json");
  });
});

async function seedBoardArtifacts(root: string): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"),
    {
      schema_version: "0.1",
      id: "TASK-0001",
      title: "Board smoke",
      status: "ready",
      version: 1,
      persona: "implementer",
      capabilities: ["coding"],
      tags: ["operation-test"],
      approval_required: false,
      code_producing: true,
      commit_requested: false,
      priority: 80,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:01:00.000Z"
    }
  );

  const runDir = path.join(root, ".kairon", "runs", "RUN-0001");
  await mkdir(runDir, { recursive: true });
  await writeJsonFileAtomic(path.join(runDir, "runner.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    agent: "codex",
    persona: "implementer",
    status: "completed",
    command: "codex",
    command_available: true,
    exit_code: 0,
    timed_out: false,
    stdout_log: ".kairon/runs/RUN-0001/stdout.log",
    stderr_log: ".kairon/runs/RUN-0001/stderr.log",
    created_at: "2026-06-01T00:02:00.000Z",
    finished_at: "2026-06-01T00:03:00.000Z"
  });
  await writeJsonFileAtomic(path.join(runDir, "outbox.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    status: "completed",
    events: [
      {
        type: "message.created",
        payload: {
          stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR"
        }
      }
    ]
  });

  await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
    schema_version: "0.1",
    id: "APR-0001",
    status: "pending",
    type: "deploy",
    title: "Deploy approval",
    actions: ["approve", "reject", "request_changes", "snooze"],
    api_token: "SHOULD_NOT_LEAK",
    diff: "FULL_DIFF_SHOULD_NOT_APPEAR",
    stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR",
    created_at: "2026-06-01T00:04:00.000Z",
    updated_at: "2026-06-01T00:04:00.000Z"
  });

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"),
    {
      schema_version: "0.1",
      loop_id: "REV-0001",
      task_id: "TASK-0001",
      status: "running",
      iteration: 1,
      max_iterations: 3,
      implementer: "codex",
      reviewers: ["claude"],
      code_producing: true,
      created_at: "2026-06-01T00:05:00.000Z",
      updated_at: "2026-06-01T00:05:00.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "reviews", "results", "REV-RESULT-0001.json"),
    {
      schema_version: "0.1",
      review_id: "REV-RESULT-0001",
      run_id: "RUN-0001",
      reviewer: "claude",
      status: "approved",
      score: 1,
      tests_passed: true,
      secret_scan_passed: true,
      findings: [{ severity: "low", body: "FULL_DIFF_SHOULD_NOT_APPEAR" }],
      created_at: "2026-06-01T00:06:00.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "cleanup", "proposals", "2026-06-01.json"),
    {
      schema_version: "0.1",
      date: "2026-06-01",
      proposal_path: ".kairon/cleanup/proposals/2026-06-01.json",
      direct_delete: false,
      candidates: [{ id: "CLEAN-001", path: "dist" }],
      created_at: "2026-06-01T00:07:00.000Z"
    }
  );
}
