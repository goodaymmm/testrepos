import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  BranchPrefixError,
  GitWorkspaceManager,
  PathOverlapError,
  ProtectedBranchError,
  assertBranchAllowed
} from "../src/git/workspace-manager.js";
import { createTempProject } from "./test-utils.js";

const policy = {
  default_base_branch: "main",
  remote: "origin",
  worktree_root: ".kairon/worktrees",
  allow_auto_commit: true,
  allow_auto_push: false,
  require_review_before_commit: true,
  branch_template: "auto/{task_id}/{agent}",
  auto_branch_prefixes: ["auto/"],
  protected_branches: ["main", "master", "release/*"],
  require_approval_for: ["merge", "deploy", "protected_branch_push"],
  require_clean_base_worktree: true,
  max_parallel_writers_per_path: 1,
  rollback_strategy: {
    pre_commit: "discard_worktree_with_artifact",
    committed_unpushed: "reset_branch_to_parent",
    pushed_unmerged: "revert_commit",
    merged: "revert_commit"
  }
};

describe("GitWorkspaceManager", () => {
  it("generates branch and worktree metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const workspace = await new GitWorkspaceManager(root).allocate({
      taskId: "TASK-0001",
      agent: "codex",
      baseSha: "abc123",
      writePaths: ["src/**"]
    });

    expect(workspace).toMatchObject({
      task_id: "TASK-0001",
      branch: "auto/TASK-0001/codex",
      base_branch: "main",
      base_sha: "abc123",
      worktree_path: ".kairon/worktrees/TASK-0001-codex",
      write_paths: ["src/**"]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "git", "branches", "TASK-0001.json"))
    ).resolves.toMatchObject({
      branch: "auto/TASK-0001/codex"
    });
  });

  it("rejects protected branches", () => {
    expect(() => assertBranchAllowed("main", policy)).toThrow(ProtectedBranchError);
    expect(() => assertBranchAllowed("release/2026-05", policy)).toThrow(
      ProtectedBranchError
    );
  });

  it("rejects disallowed branch prefixes", () => {
    expect(() => assertBranchAllowed("feature/TASK-0001", policy)).toThrow(
      BranchPrefixError
    );
  });

  it("blocks overlapping path write locks", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const manager = new GitWorkspaceManager(root);

    await manager.allocate({
      taskId: "TASK-0001",
      agent: "codex",
      writePaths: ["src/**"]
    });

    await expect(
      manager.allocate({
        taskId: "TASK-0002",
        agent: "claude",
        writePaths: ["src/features/approval.ts"]
      })
    ).rejects.toThrow(PathOverlapError);
  });
});
