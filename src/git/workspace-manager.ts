import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { AgentId } from "../agents/types.js";

export type GitPolicy = {
  default_base_branch: string;
  worktree_root: string;
  branch_template: string;
  auto_branch_prefixes: string[];
  protected_branches: string[];
};

export type PoliciesConfig = {
  git: GitPolicy;
};

export type AllocateWorkspaceRequest = {
  taskId: string;
  agent: AgentId;
  branch?: string;
  baseBranch?: string;
  baseSha?: string;
  writePaths?: string[];
};

export type GitWorkspace = {
  schema_version: string;
  task_id: string;
  branch: string;
  agent: AgentId;
  base_branch: string;
  base_sha?: string;
  worktree_path: string;
  status: "active";
  writer_lock: string;
  write_paths: string[];
  created_at: string;
};

export class ProtectedBranchError extends Error {
  constructor(branch: string) {
    super(`Protected branch cannot be used for Kairon workspace: ${branch}`);
    this.name = "ProtectedBranchError";
  }
}

export class BranchPrefixError extends Error {
  constructor(branch: string) {
    super(`Branch prefix is not allowed for Kairon workspace: ${branch}`);
    this.name = "BranchPrefixError";
  }
}

export class GitWorkspaceManager {
  constructor(private readonly projectRoot: string) {}

  async allocate(request: AllocateWorkspaceRequest): Promise<GitWorkspace> {
    const policy = await this.loadGitPolicy();
    const branch =
      request.branch ?? this.generateBranchName(request.taskId, request.agent, policy);

    assertBranchAllowed(branch, policy);

    const paths = getKaironPaths(this.projectRoot);
    const worktreePath = this.generateWorktreePath(request.taskId, request.agent, policy);
    const writerLock = resolveInside(
      paths.kaironDir,
      "git",
      "locks",
      `${branchToFileSlug(branch)}.json`
    );
    const workspace: GitWorkspace = {
      schema_version: "0.1",
      task_id: request.taskId,
      branch,
      agent: request.agent,
      base_branch: request.baseBranch ?? policy.default_base_branch,
      base_sha: request.baseSha,
      worktree_path: toProjectPath(paths.root, worktreePath),
      status: "active",
      writer_lock: toProjectPath(paths.root, writerLock),
      write_paths: request.writePaths ?? [],
      created_at: new Date().toISOString()
    };

    await mkdir(worktreePath, { recursive: true });
    await writeJsonFileAtomic(
      resolveInside(paths.kaironDir, "git", "branches", `${request.taskId}.json`),
      workspace
    );
    await writeJsonFileAtomic(writerLock, {
      schema_version: "0.1",
      task_id: request.taskId,
      branch,
      agent: request.agent,
      created_at: workspace.created_at
    });

    return workspace;
  }

  generateBranchName(taskId: string, agent: AgentId, policy: GitPolicy): string {
    return policy.branch_template
      .replaceAll("{task_id}", taskId)
      .replaceAll("{agent}", agent);
  }

  generateWorktreePath(taskId: string, agent: AgentId, policy: GitPolicy): string {
    const worktreeRoot = resolveInside(
      getKaironPaths(this.projectRoot).root,
      policy.worktree_root
    );

    return resolveInside(
      worktreeRoot,
      `${toFileNameSlug(taskId)}-${agent}`
    );
  }

  private async loadGitPolicy(): Promise<GitPolicy> {
    const config = await loadConfigFile<PoliciesConfig>(
      this.projectRoot,
      "policies.json"
    );
    return config.git;
  }
}

export function assertBranchAllowed(branch: string, policy: GitPolicy): void {
  if (policy.protected_branches.some((pattern) => branchMatches(branch, pattern))) {
    throw new ProtectedBranchError(branch);
  }

  if (!policy.auto_branch_prefixes.some((prefix) => branch.startsWith(prefix))) {
    throw new BranchPrefixError(branch);
  }
}

export function branchMatches(branch: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => escapeRegExp(part))
      .join(".*")}$`
  );
  return regex.test(branch);
}

function branchToFileSlug(branch: string): string {
  return `branch-${toFileNameSlug(branch)}`;
}

function toFileNameSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
