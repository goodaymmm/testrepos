import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createDiffSnapshot } from "../src/git/diff-snapshot.js";
import {
  GitTransactionExecutor,
  ReviewRequiredError
} from "../src/git/transaction-executor.js";
import { ReviewLoopManager } from "../src/review/review-loop-manager.js";
import { createTempProject } from "./test-utils.js";

describe("GitTransactionExecutor", () => {
  it("commits an approved diff and records rollback metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await createReviewedDiff(root, "approved");
    const invocations: CliInvocation[] = [];

    const result = await new GitTransactionExecutor(root, {
      commandRunner: gitRunner(invocations),
      now: () => new Date("2026-05-26T07:00:00.000Z")
    }).executeCommit({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      reviewLoopId: "REV-0001",
      agent: "codex",
      writePaths: ["src/**"],
      commitMessage: "TASK-0001 Test commit"
    });

    expect(result).toMatchObject({
      transaction_id: "GTX-0001",
      task_id: "TASK-0001",
      run_id: "RUN-0001",
      review_loop_id: "REV-0001",
      branch: "auto/TASK-0001/codex",
      status: "committed",
      base_sha: "base-sha",
      parent_sha: "parent-sha",
      commit_sha: "commit-sha",
      changed_files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 0
        }
      ],
      push: {
        requested: false,
        allowed: false,
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
        task_id: "TASK-0001",
        run_id: "RUN-0001",
        review_loop_id: "REV-0001",
        base_branch: "main",
        head_branch: "auto/TASK-0001/codex",
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex",
        commit_sha: "commit-sha",
        diff_sha256: expect.stringMatching(/^sha256:/),
        rollback_strategy: "reset_branch_to_parent",
        rollback_hint: "git reset --hard parent-sha"
      }
    });
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ["rev-parse", "main"],
      [
        "worktree",
        "add",
        "-B",
        "auto/TASK-0001/codex",
        path.join(root, ".kairon", "worktrees", "TASK-0001-codex"),
        "main"
      ],
      ["add", "--all"],
      ["commit", "-m", "TASK-0001 Test commit"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "HEAD^"]
    ]);
    await expect(
      readJsonFile(path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"))
    ).resolves.toMatchObject({
      transaction_id: "GTX-0001",
      commit_sha: "commit-sha",
      rollback: { strategy: "reset_branch_to_parent" }
    });
  });

  it("creates a push approval when auto push is disabled", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await createReviewedDiff(root, "approved");
    const invocations: CliInvocation[] = [];

    const result = await new GitTransactionExecutor(root, {
      commandRunner: gitRunner(invocations)
    }).executeCommit({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      reviewLoopId: "REV-0001",
      agent: "codex",
      writePaths: ["src/**"],
      pushRequested: true
    });

    expect(result).toMatchObject({
      status: "approval_required",
      push: {
        requested: true,
        allowed: false,
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex",
        pushed: false,
        approval_id: "APR-0001",
        reason: "auto push is disabled by policy"
      },
      pr: {
        status: "push_approval_required",
        approval_id: "APR-0001",
        base_branch: "main",
        head_branch: "auto/TASK-0001/codex",
        remote_ref: "auto/TASK-0001/codex",
        commit_sha: "commit-sha",
        rollback_hint: "git reset --hard parent-sha"
      }
    });
    expect(invocations.some((invocation) => invocation.args[0] === "push")).toBe(false);
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      type: "git_push",
      status: "pending",
      title: "Git push approval for TASK-0001",
      transaction_id: "GTX-0001",
      task_id: "TASK-0001",
      run_id: "RUN-0001",
      review_loop_id: "REV-0001",
      expected_head_sha: "commit-sha",
      rollback_strategy: "reset_branch_to_parent",
      rollback_command_hint: "git reset --hard parent-sha",
      pr: {
        status: "push_approval_required",
        approval_id: "APR-0001"
      }
    });
  });

  it("resumes approved push transactions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await createReviewedDiff(root, "approved");
    const invocations: CliInvocation[] = [];
    const executor = new GitTransactionExecutor(root, {
      commandRunner: gitRunner(invocations)
    });
    const pending = await executor.executeCommit({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      reviewLoopId: "REV-0001",
      agent: "codex",
      writePaths: ["src/**"],
      pushRequested: true
    });

    const pushed = await executor.resumeApprovedPush({
      transactionId: pending.transaction_id,
      approvalId: "APR-0001",
      expectedHeadSha: pending.commit_sha
    });

    expect(pushed).toMatchObject({
      status: "pushed",
      push: {
        requested: true,
        allowed: true,
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex",
        pushed: true
      },
      rollback: {
        strategy: "revert_commit",
        parent_sha: "parent-sha"
      },
      pr: {
        status: "ready_for_pr",
        base_branch: "main",
        head_branch: "auto/TASK-0001/codex",
        remote_ref: "auto/TASK-0001/codex",
        approval_id: "APR-0001",
        rollback_strategy: "revert_commit",
        rollback_hint: "git revert parent-sha..HEAD"
      }
    });
    expect(invocations.map((invocation) => invocation.args)).toContainEqual([
      "push",
      "origin",
      "auto/TASK-0001/codex:auto/TASK-0001/codex"
    ]);
    await expect(
      readJsonFile(path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"))
    ).resolves.toMatchObject({
      status: "pushed",
      push: { pushed: true },
      pr: { status: "ready_for_pr" }
    });
  });

  it("creates a protected branch push approval instead of pushing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await createReviewedDiff(root, "approved");
    const invocations: CliInvocation[] = [];

    const result = await new GitTransactionExecutor(root, {
      commandRunner: gitRunner(invocations)
    }).executeCommit({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      reviewLoopId: "REV-0001",
      agent: "codex",
      writePaths: ["src/**"],
      pushRequested: true,
      pushTargetBranch: "main"
    });

    expect(result).toMatchObject({
      status: "approval_required",
      push: {
        remote_ref: "main",
        approval_id: "APR-0001",
        reason: "protected_branch_push requires approval"
      },
      pr: {
        status: "protected_push_approval_required",
        remote_ref: "main",
        approval_id: "APR-0001"
      }
    });
    expect(invocations.some((invocation) => invocation.args[0] === "push")).toBe(false);
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      type: "git_protected_branch_push",
      title: "Git protected branch push approval for TASK-0001",
      remote_ref: "main",
      pr: {
        status: "protected_push_approval_required",
        remote_ref: "main"
      }
    });
  });

  it("blocks commits until review is approved", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await createReviewedDiff(root, "running");
    const invocations: CliInvocation[] = [];

    await expect(
      new GitTransactionExecutor(root, {
        commandRunner: gitRunner(invocations)
      }).executeCommit({
        taskId: "TASK-0001",
        runId: "RUN-0001",
        reviewLoopId: "REV-0001",
        agent: "codex",
        writePaths: ["src/**"]
      })
    ).rejects.toThrow(ReviewRequiredError);
    expect(invocations).toEqual([]);
  });
});

async function createReviewedDiff(
  root: string,
  reviewStatus: "approved" | "running"
): Promise<void> {
  await createDiffSnapshot(root, {
    taskId: "TASK-0001",
    runId: "RUN-0001",
    branch: "auto/TASK-0001/codex",
    diff: "diff --git a/src/example.ts b/src/example.ts\n+export const value = 1;\n",
    changedFiles: [
      {
        path: "src/example.ts",
        status: "modified",
        additions: 1,
        deletions: 0
      }
    ]
  });
  const manager = new ReviewLoopManager(root);
  const loop = await manager.start({
    taskId: "TASK-0001",
    runId: "RUN-0001",
    implementer: "codex",
    codeProducing: true
  });
  await manager.saveLoopState({
    ...loop,
    status: reviewStatus,
    updated_at: "2026-05-26T00:00:00.000Z"
  });
}

function gitRunner(
  invocations: CliInvocation[]
): (invocation: CliInvocation) => Promise<CommandRunResult> {
  return async (invocation) => {
    invocations.push(invocation);

    if (invocation.args.join(" ") === "rev-parse main") {
      return commandResult(invocation, { stdout: "base-sha\n" });
    }

    if (invocation.args.join(" ") === "rev-parse HEAD") {
      return commandResult(invocation, { stdout: "commit-sha\n" });
    }

    if (invocation.args.join(" ") === "rev-parse HEAD^") {
      return commandResult(invocation, { stdout: "parent-sha\n" });
    }

    return commandResult(invocation);
  };
}

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-05-26T00:00:00.000Z",
    finishedAt: "2026-05-26T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}
