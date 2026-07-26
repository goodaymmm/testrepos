import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop, type RuntimeTickResult } from "../src/runtime/runtime-loop.js";
import { runWorkflowRuntimeCandidate } from "../src/experimental/workflow-runtime.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
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

  it("initializes same-day sessions before processing runtime work", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "maintenance.run",
      schedule_mode: "active_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      commandAvailability: async (command) => command !== "agy",
      handlers: {
        items: {
          "maintenance.run": async () => ({ maintained: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      action: "processed-item",
      queue_result: {
        item_id: item.id
      },
      sessions: {
        date: "2026-05-25",
        initialized: 3,
        ready: 2,
        setup_required: 1,
        agents: expect.arrayContaining([
          expect.objectContaining({
            agent: "gemini",
            status: "setup_required",
            dispatcher_status: "missing_cli"
          })
        ])
      }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "last-tick.json"))
    ).resolves.toMatchObject({
      sessions: {
        date: "2026-05-25",
        initialized: 3,
        setup_required: 1
      }
    });
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
          pr: {
            status: "local_commit_ready",
            transaction_id: "GTX-0001",
            task_id: request.taskId,
            run_id: request.runId,
            review_loop_id: request.reviewLoopId,
            base_branch: "main",
            head_branch: "auto/TASK-0001/codex",
            remote: "origin",
            remote_ref: "auto/TASK-0001/codex",
            commit_sha: "commit-sha",
            diff_sha256: "diff-sha",
            rollback_strategy: "reset_branch_to_parent",
            title: "TASK-0001 automated change",
            body_hint: "Kairon task: TASK-0001",
            create_hint: "Push auto/TASK-0001/codex to origin/auto/TASK-0001/codex, then open a PR against main.",
            rollback_hint: "git reset --hard parent-sha"
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
          commit_sha: "commit-sha",
          pr: {
            status: "local_commit_ready",
            head_branch: "auto/TASK-0001/codex"
          }
        }
      }
    ]);
  });

  it("processes git.transaction resume_push items with the default runtime handler", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "git.transaction",
      schedule_mode: "active_work",
      payload: {
        action: "resume_push",
        transaction_id: "GTX-0001",
        approval_id: "APR-0001",
        expected_head_sha: "commit-sha",
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex"
      }
    });
    let capturedRequest: unknown;

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      gitTransactionRunner: async (request) => {
        capturedRequest = request;
        return {
          schema_version: "0.1",
          transaction_id:
            "action" in request && request.action === "resume_push"
              ? request.transactionId
              : "GTX-UNKNOWN",
          task_id: "TASK-0001",
          run_id: "RUN-0001",
          review_loop_id: "REV-0001",
          branch: "auto/TASK-0001/codex",
          worktree_path: ".kairon/worktrees/TASK-0001-codex",
          status: "pushed",
          base_branch: "main",
          base_sha: "base-sha",
          parent_sha: "parent-sha",
          commit_sha: "commit-sha",
          diff_sha256: "diff-sha",
          checks: [{ name: "push_head", status: "passed" }],
          push: {
            requested: true,
            allowed: true,
            remote: "origin",
            remote_ref: "auto/TASK-0001/codex",
            pushed: true
          },
          rollback: {
            strategy: "revert_commit",
            parent_sha: "parent-sha",
            command_hint: "git revert parent-sha..HEAD"
          },
          pr: {
            status: "ready_for_pr",
            transaction_id: "GTX-0001",
            task_id: "TASK-0001",
            run_id: "RUN-0001",
            review_loop_id: "REV-0001",
            base_branch: "main",
            head_branch: "auto/TASK-0001/codex",
            remote: "origin",
            remote_ref: "auto/TASK-0001/codex",
            commit_sha: "commit-sha",
            diff_sha256: "diff-sha",
            rollback_strategy: "revert_commit",
            title: "TASK-0001 automated change",
            body_hint: "Kairon task: TASK-0001",
            create_hint: "Create a PR from auto/TASK-0001/codex to main after confirming origin/auto/TASK-0001/codex is pushed.",
            rollback_hint: "git revert parent-sha..HEAD"
          },
          workspace: {
            schema_version: "0.1",
            task_id: "TASK-0001",
            branch: "auto/TASK-0001/codex",
            agent: "codex",
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
      action: "resume_push",
      transactionId: "GTX-0001",
      approvalId: "APR-0001",
      expectedHeadSha: "commit-sha",
      remote: "origin",
      remoteRef: "auto/TASK-0001/codex"
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
          status: "pushed",
          push: {
            pushed: true
          },
          pr: {
            status: "ready_for_pr"
          }
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

  it("processes approval commands before maintenance work", async () => {
    const root = await createInitializedProject();
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-MAINTENANCE.json"),
      {
        schema_version: "0.1",
        id: "APR-MAINTENANCE",
        status: "pending",
        actions: ["approve"],
        title: "Maintenance approval"
      }
    );
    await new CommandInbox(root).enqueue({
      type: "approval.decide",
      source: "local",
      approval_id: "APR-MAINTENANCE",
      decision: "approve"
    });
    const loop = new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T02:00:00.000Z")
    });

    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "processed-command",
      queue_result: {
        status: "processed-command",
        command_type: "approval.decide"
      }
    });
    await expect(
      readJsonFile(
        path.join(root, ".kairon", "approvals", "APR-MAINTENANCE.json")
      )
    ).resolves.toMatchObject({
      status: "decided",
      decision: "approve"
    });
    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "maintenance-run"
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

  it("records one bounded self-healing result in the runtime tick", async () => {
    const root = await createInitializedProject();
    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z"),
      selfHealingRunner: async () => ({
        status: "completed",
        run_id: "SHR-0123456789abcdef0123",
        runbook_id: "workflow_checkpoint_index_rebuild"
      })
    }).runTick();

    expect(result.self_healing).toEqual({
      status: "completed",
      run_id: "SHR-0123456789abcdef0123",
      runbook_id: "workflow_checkpoint_index_rebuild"
    });
    await expect(
      readJsonFile<RuntimeTickResult>(
        path.join(root, ".kairon", "runtime", "last-tick.json")
      )
    ).resolves.toMatchObject({
      self_healing: result.self_healing
    });
  });

  it("dispatches connected workflow items only while the feature flag is enabled", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const task = await new TaskRunner(root, {
      now: () => new Date("2026-07-14T07:00:00.000Z")
    }).createTask({
      title: "T138 runtime queue connection",
      persona: "researcher",
      priority: 80,
      scheduleMode: "active_work"
    });
    const artifact = await runWorkflowRuntimeCandidate(
      root,
      {
        candidate: true,
        connectQueue: true,
        workflowId: "EXP-WF-RUNTIME-0138",
        taskId: task.task_id
      },
      {
        env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "1" },
        now: () => new Date("2026-07-14T07:01:00.000Z")
      }
    );
    const fallback = await queue.enqueue({
      type: "maintenance.run",
      priority: 10,
      schedule_mode: "active_work"
    });

    const disabledResult = await new RuntimeLoop(root, {
      env: {},
      now: () => new Date("2026-07-14T08:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => {
            throw new Error("disabled workflow item must not run");
          },
          "maintenance.run": async () => ({ fallback: true })
        }
      }
    }).runTick();

    expect(disabledResult.queue_result).toMatchObject({
      status: "processed-item",
      item_id: fallback.id
    });
    await expect(queue.list("ready")).resolves.toMatchObject([
      { id: artifact.queue_item_id, attempts: 0 }
    ]);

    const enabledResult = await new RuntimeLoop(root, {
      env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "true" },
      now: () => new Date("2026-07-14T08:01:00.000Z"),
      handlers: {
        items: {
          "agent.run": async (item) => ({ workflow_id: item.metadata?.workflow_runtime?.workflow_id })
        }
      }
    }).runTick();

    expect(enabledResult.queue_result).toMatchObject({
      status: "processed-item",
      item_id: artifact.queue_item_id
    });
    await expect(queue.list("completed")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: artifact.queue_item_id,
          result: { workflow_id: "EXP-WF-RUNTIME-0138" }
        })
      ])
    );
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
