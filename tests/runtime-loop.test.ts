import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop, type RuntimeTickResult } from "../src/runtime/runtime-loop.js";
import {
  getScheduleStatus,
  type ScheduleConfig
} from "../src/runtime/schedule-engine.js";
import { createTempProject } from "./test-utils.js";

const schedule: ScheduleConfig = {
  schema_version: "0.1",
  timezone: "UTC",
  active_work_time: [{ start: "07:00", end: "18:00" }],
  standby_work_time: [{ start: "18:00", end: "01:00" }],
  maintenance_time: [{ start: "01:00", end: "07:00" }]
};

describe("RuntimeLoop", () => {
  it("processes ready queue items during active work", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      schedule_mode: "active_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ ran: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: item.id
      }
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: item.id, result: { ran: true } }
    ]);
  });

  it("does not let stale operation-test queue items affect the runtime tick", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const stale = await queue.enqueue({
      type: "agent.run",
      priority: 100,
      test_scope: {
        kind: "operation_test",
        tags: ["operation-test"],
        expires_at: "2026-05-25T07:59:00.000Z"
      }
    });
    const normal = await queue.enqueue({
      type: "maintenance.run",
      priority: 10,
      schedule_mode: "active_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => {
            throw new Error("stale test item should not run");
          },
          "maintenance.run": async () => ({ maintained: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: normal.id
      }
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: stale.id, error: { code: "stale_test_queue_item" } }
    ]);
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: normal.id, result: { maintained: true } }
    ]);
  });

  it("keeps active work blocked during standby and processes standby-safe items", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const activeItem = await queue.enqueue({ type: "agent.run" });
    const standbyItem = await queue.enqueue({
      type: "maintenance.run",
      priority: 40,
      schedule_mode: "standby_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z"),
      handlers: {
        items: {
          "maintenance.run": async () => ({ maintained: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      mode: "standby_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: standbyItem.id
      }
    });
    await expect(queue.list("ready")).resolves.toMatchObject([
      { id: activeItem.id }
    ]);
  });

  it("processes review.run items with the default runtime handler", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "review.run",
      schedule_mode: "active_work",
      payload: {
        loop_id: "REV-0001",
        timeout_ms: 12_000
      }
    });
    let capturedRequest: unknown;

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      reviewLoopRunner: async (request) => {
        capturedRequest = request;
        return {
          schema_version: "0.1",
          loop_id: request.loopId,
          status: "approved",
          iteration: 1,
          review_run_ids: ["RUN-0002"],
          review_result_ids: ["REV-0002"],
          iteration_path: ".kairon/reviews/loops/REV-0001-iteration-1.json",
          decision: {
            status: "passed",
            reasons: [],
            blocking_findings: [],
            review_ids: ["REV-0002"]
          },
          next_action: {
            action: "approve",
            review_ids: ["REV-0002"]
          }
        };
      }
    }).runTick();

    expect(capturedRequest).toEqual({
      loopId: "REV-0001",
      date: "2026-05-25",
      timeoutMs: 12_000
    });
    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: item.id,
        item_type: "review.run"
      }
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      {
        id: item.id,
        result: {
          loop_id: "REV-0001",
          status: "approved",
          decision: "passed",
          next_action: "approve",
          review_run_ids: ["RUN-0002"],
          review_result_ids: ["REV-0002"]
        }
      }
    ]);
  });

  it("records review.run handler failures on malformed queue payloads", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "review.run",
      schedule_mode: "active_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z")
    }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: item.id,
        item_type: "review.run"
      }
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      {
        id: item.id,
        error: {
          message: "Error: review.run payload is missing loop_id.",
          code: "handler.review.run.failed"
        }
      }
    ]);
  });

  it("processes git.transaction items with the default runtime handler", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "git.transaction",
      task_id: "TASK-0001",
      schedule_mode: "active_work",
      payload: {
        run_id: "RUN-0001",
        agent: "codex",
        review_loop_id: "REV-0001",
        write_paths: ["src/**"],
        commit_message: "TASK-0001 test commit",
        push_requested: true,
        push_target_branch: "auto/TASK-0001/codex"
      }
    });
    let capturedRequest: unknown;

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      gitTransactionRunner: async (request) => {
        capturedRequest = request;
        return {
          schema_version: "0.1",
          transaction_id: "GTX-0001",
          task_id: request.taskId,
          run_id: request.runId,
          review_loop_id: request.reviewLoopId,
          branch: "auto/TASK-0001/codex",
          worktree_path: ".kairon/worktrees/TASK-0001-codex",
          status: "committed",
          base_branch: "main",
          base_sha: "base-sha",
          parent_sha: "parent-sha",
          commit_sha: "commit-sha",
          diff_sha256: "diff-sha",
          checks: [{ name: "review", status: "passed" }],
          push: {
            requested: true,
            allowed: false,
            remote: "origin",
            remote_ref: "auto/TASK-0001/codex",
            pushed: false
          },
          rollback: {
            strategy: "reset_branch_to_parent",
            parent_sha: "parent-sha",
            command_hint: "git reset --hard parent-sha"
          },
          workspace: {
            schema_version: "0.1",
            task_id: request.taskId,
            branch: "auto/TASK-0001/codex",
            agent: request.agent,
            base_branch: "main",
            base_sha: "base-sha",
            worktree_path: ".kairon/worktrees/TASK-0001-codex",
            status: "active",
            writer_lock: ".kairon/git/locks/branch-auto-TASK-0001-codex.json",
            path_lock: ".kairon/git/locks/path-TASK-0001.json",
            write_paths: ["src/**"],
            created_at: "2026-05-25T08:00:00.000Z"
          },
          transaction_path: ".kairon/git/transactions/GTX-0001.json",
          created_at: "2026-05-25T08:00:00.000Z",
          updated_at: "2026-05-25T08:00:00.000Z"
        };
      }
    }).runTick();

    expect(capturedRequest).toEqual({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      agent: "codex",
      reviewLoopId: "REV-0001",
      branch: undefined,
      baseBranch: undefined,
      baseSha: undefined,
      writePaths: ["src/**"],
      commitMessage: "TASK-0001 test commit",
      pushRequested: true,
      pushTargetBranch: "auto/TASK-0001/codex"
    });
    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: item.id,
        item_type: "git.transaction"
      }
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      {
        id: item.id,
        result: {
          transaction_id: "GTX-0001",
          task_id: "TASK-0001",
          run_id: "RUN-0001",
          review_loop_id: "REV-0001",
          status: "committed",
          branch: "auto/TASK-0001/codex",
          commit_sha: "commit-sha"
        }
      }
    ]);
  });

  it("allows approved work during standby", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      payload: { approved: true }
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ ran_after_approval: true })
        }
      }
    }).runTick();

    expect(result.queue_result).toMatchObject({
      status: "processed-item",
      item_id: item.id
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: item.id, result: { ran_after_approval: true } }
    ]);
  });

  it("runs maintenance once per local maintenance date", async () => {
    const root = await createInitializedProject();
    const loop = new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T02:00:00.000Z")
    });

    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "maintenance-run",
      maintenance: {
        date: "2026-05-25",
        handoff_count: 3
      }
    });
    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "maintenance-skipped",
      maintenance: {
        date: "2026-05-25"
      }
    });
  });

  it("applies leave commands before processing queue items", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    await queue.enqueue({ type: "agent.run" });
    await new CommandInbox(root).enqueue({
      type: "schedule.close_active_work",
      date: "2026-05-25",
      reason: "test"
    });

    const now = new Date("2026-05-25T08:00:00.000Z");
    const result = await new RuntimeLoop(root, { now: () => now }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-command"
    });
    await expect(getScheduleStatus(root, now)).resolves.toMatchObject({
      mode: "standby_work",
      activeWorkClosed: true
    });
    await expect(queue.list("ready")).resolves.toHaveLength(1);
  });

  it("records the last tick under the runtime directory", async () => {
    const root = await createInitializedProject();
    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z")
    }).runTick();

    await expect(
      readJsonFile<RuntimeTickResult>(
        path.join(root, ".kairon", "runtime", "last-tick.json")
      )
    ).resolves.toMatchObject({
      mode: result.mode,
      action: result.action
    });
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "config", "schedule.json"),
    schedule
  );
  return root;
}
