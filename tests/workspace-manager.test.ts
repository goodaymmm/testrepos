import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  BranchPrefixError,
  GitWorkspaceManager,
  ProtectedBranchError,
  assertBranchAllowed
} from "../src/git/workspace-manager.js";
import { createTempProject } from "./test-utils.js";

const policy = {
  default_base_branch: "main",
  worktree_root: ".kairon/worktrees",
  branch_template: "auto/{task_id}/{agent}",
  auto_branch_prefixes: ["auto/"],
  protected_branches: ["main", "master", "release/*"]
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
});
