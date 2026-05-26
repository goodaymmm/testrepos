import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { AgentId } from "../agents/types.js";

export type GitPolicy = {
  default_base_branch: string;
  remote: string;
  worktree_root: string;
  allow_auto_commit: boolean;
  allow_auto_push: boolean;
  require_review_before_commit: boolean;
  branch_template: string;
  auto_branch_prefixes: string[];
  protected_branches: string[];
  require_approval_for: string[];
  require_clean_base_worktree: boolean;
  max_parallel_writers_per_path: number;
  rollback_strategy: {
    pre_commit: string;
    committed_unpushed: string;
    pushed_unmerged: string;
    merged: string;
  };
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
  path_lock: string;
  write_paths: string[];
  created_at: string;
};

export type PathWriteLock = {
  schema_version: string;
  lock_id: string;
  type: "path_write";
  task_id: string;
  branch: string;
  agent: AgentId;
  paths: string[];
  status: "active";
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

export class PathOverlapError extends Error {
  constructor(
    readonly paths: string[],
    readonly blockedBy: string[]
  ) {
    super(
      `Path write lock overlap detected for ${paths.join(", ")}; blocked by ${blockedBy.join(", ")}`
    );
    this.name = "PathOverlapError";
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
    const writePaths = normalizeWritePaths(request.writePaths ?? []);
    const activePathLocks = (await this.readActivePathLocks()).filter(
      (lock) => lock.task_id !== request.taskId
    );
    const overlaps = findPathLockOverlaps(writePaths, activePathLocks);

    if (overlaps.length >= policy.max_parallel_writers_per_path) {
      throw new PathOverlapError(
        writePaths,
        overlaps.map((lock) => lock.task_id)
      );
    }

    const writerLock = resolveInside(
      paths.kaironDir,
      "git",
      "locks",
      `${branchToFileSlug(branch)}.json`
    );
    const pathLock = resolveInside(
      paths.kaironDir,
      "git",
      "locks",
      `${pathLockSlug(request.taskId)}.json`
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
      path_lock: toProjectPath(paths.root, pathLock),
      write_paths: writePaths,
      created_at: new Date().toISOString()
    };

    await mkdir(path.dirname(worktreePath), { recursive: true });
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
    await writeJsonFileAtomic(pathLock, {
      schema_version: "0.1",
      lock_id: path.basename(pathLock, ".json"),
      type: "path_write",
      task_id: request.taskId,
      branch,
      agent: request.agent,
      paths: writePaths,
      status: "active",
      created_at: workspace.created_at
    } satisfies PathWriteLock);

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

  private async readActivePathLocks(): Promise<PathWriteLock[]> {
    const locksDir = resolveInside(getKaironPaths(this.projectRoot).kaironDir, "git", "locks");
    let entries: string[];

    try {
      entries = await readdir(locksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const locks: PathWriteLock[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      try {
        const lock = await readJsonFile<Partial<PathWriteLock>>(
          resolveInside(locksDir, entry)
        );
        if (
          lock.type === "path_write" &&
          lock.status === "active" &&
          Array.isArray(lock.paths) &&
          typeof lock.task_id === "string" &&
          typeof lock.branch === "string" &&
          typeof lock.agent === "string"
        ) {
          locks.push(lock as PathWriteLock);
        }
      } catch {
        // Ignore stale or malformed lock files; doctor can report them later.
      }
    }

    return locks;
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

export function findPathLockOverlaps(
  writePaths: string[],
  activeLocks: PathWriteLock[]
): PathWriteLock[] {
  if (writePaths.length === 0) {
    return [];
  }

  return activeLocks.filter((lock) =>
    writePaths.some((writePath) =>
      lock.paths.some((lockedPath) => pathPatternsOverlap(writePath, lockedPath))
    )
  );
}

export function pathPatternsOverlap(left: string, right: string): boolean {
  const a = normalizePathPattern(left);
  const b = normalizePathPattern(right);

  if (a === b) {
    return true;
  }

  if (isTreePattern(a) && pathWithinTree(b, treePrefix(a))) {
    return true;
  }

  if (isTreePattern(b) && pathWithinTree(a, treePrefix(b))) {
    return true;
  }

  const aLiteralPrefix = literalPrefix(a);
  const bLiteralPrefix = literalPrefix(b);

  return (
    aLiteralPrefix.length > 0 &&
    bLiteralPrefix.length > 0 &&
    (aLiteralPrefix.startsWith(bLiteralPrefix) ||
      bLiteralPrefix.startsWith(aLiteralPrefix))
  );
}

function branchToFileSlug(branch: string): string {
  return `branch-${toFileNameSlug(branch)}`;
}

function pathLockSlug(taskId: string): string {
  return `path-${toFileNameSlug(taskId)}`;
}

function toFileNameSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function normalizeWritePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePathPattern).filter((value) => value.length > 0))];
}

function normalizePathPattern(value: string): string {
  return toPosixPath(value).replace(/^\.\//, "").replace(/\/+$/g, "");
}

function isTreePattern(value: string): boolean {
  return value.endsWith("/**");
}

function treePrefix(value: string): string {
  return value.slice(0, -3);
}

function pathWithinTree(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function literalPrefix(value: string): string {
  const wildcardIndex = value.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? value : value.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
