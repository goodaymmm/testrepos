import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner,
  type CommandRunResult
} from "../agents/command-runner.js";
import type { AgentId } from "../agents/types.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { StateApplier } from "../state/state-applier.js";
import {
  compareSnapshotToStoredDiff,
  readDiffSnapshot,
  type DiffSnapshot
} from "./diff-snapshot.js";
import {
  branchMatches,
  GitWorkspaceManager,
  type GitPolicy,
  type GitWorkspace
} from "./workspace-manager.js";
import {
  ReviewLoopManager,
  type ReviewLoopState
} from "../review/review-loop-manager.js";

export type GitTransactionStatus =
  | "planned"
  | "prepared"
  | "checked"
  | "reviewed"
  | "committing"
  | "committed"
  | "approval_required"
  | "pushing"
  | "pushed"
  | "failed";

export type GitTransactionCheck = {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
};

export type GitTransactionPush = {
  requested: boolean;
  allowed: boolean;
  remote: string;
  remote_ref: string | null;
  pushed: boolean;
  approval_id?: string;
  reason?: string;
};

export type GitRollbackMetadata = {
  strategy: string;
  parent_sha?: string;
  command_hint: string;
};

export type GitTransactionRecord = {
  schema_version: string;
  transaction_id: string;
  task_id: string;
  run_id: string;
  review_loop_id: string;
  branch: string;
  worktree_path: string;
  status: GitTransactionStatus;
  base_branch: string;
  base_sha?: string;
  parent_sha?: string;
  commit_sha?: string;
  diff_sha256: string;
  checks: GitTransactionCheck[];
  push: GitTransactionPush;
  rollback: GitRollbackMetadata;
  workspace: GitWorkspace;
  transaction_path: string;
  created_at: string;
  updated_at: string;
};

export type ExecuteGitTransactionRequest = {
  taskId: string;
  runId: string;
  agent: AgentId;
  reviewLoopId: string;
  branch?: string;
  baseBranch?: string;
  baseSha?: string;
  writePaths?: string[];
  commitMessage?: string;
  pushRequested?: boolean;
  pushTargetBranch?: string;
};

export type ResumeGitTransactionPushRequest = {
  transactionId: string;
  approvalId?: string;
  expectedHeadSha?: string;
  remote?: string;
  remoteRef?: string;
};

type PoliciesConfig = {
  git: GitPolicy;
};

export class ReviewRequiredError extends Error {
  constructor(reviewLoopId: string, status: ReviewLoopState["status"]) {
    super(`Review loop ${reviewLoopId} must be approved before commit. Current status: ${status}`);
    this.name = "ReviewRequiredError";
  }
}

export class DiffChangedAfterReviewError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`Diff changed after review. Expected ${expected}, got ${actual}`);
    this.name = "DiffChangedAfterReviewError";
  }
}

export class GitPolicyBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GitPolicyBlockedError";
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly result: CommandRunResult,
    readonly stage: string
  ) {
    super(`Git command failed during ${stage}: ${result.stderr || result.stdout}`);
    this.name = "GitCommandError";
  }
}

export class GitTransactionExecutor {
  constructor(
    private readonly projectRoot: string,
    private readonly options: {
      commandRunner?: CommandRunner;
      now?: () => Date;
    } = {}
  ) {}

  async executeCommit(
    request: ExecuteGitTransactionRequest
  ): Promise<GitTransactionRecord> {
    const policy = await this.loadGitPolicy();
    if (!policy.allow_auto_commit) {
      throw new GitPolicyBlockedError("Automatic commit is disabled by policy.");
    }

    const snapshot = await readDiffSnapshot(this.projectRoot, request.runId);
    assertSnapshotMatchesRequest(snapshot, request);
    const review = await new ReviewLoopManager(this.projectRoot).loadLoopState(
      request.reviewLoopId
    );
    assertReviewApproved(review);
    await assertDiffUnchanged(this.projectRoot, snapshot);

    const workspace = await new GitWorkspaceManager(this.projectRoot).allocate({
      taskId: request.taskId,
      agent: request.agent,
      branch: request.branch,
      baseBranch: request.baseBranch,
      baseSha: request.baseSha ?? snapshot.base_sha,
      writePaths: request.writePaths
    });
    const transactionId = await nextId(this.projectRoot, "git_transaction");
    const now = this.now().toISOString();
    const transactionPath = transactionRecordPath(this.projectRoot, transactionId);
    const baseRef = request.baseSha ?? snapshot.base_sha ?? workspace.base_branch;
    const absoluteWorktree = resolveInside(this.projectRoot, workspace.worktree_path);
    const commandRunner = this.options.commandRunner ?? spawnCommandRunner;
    let record = createInitialRecord({
      projectRoot: this.projectRoot,
      transactionId,
      request,
      workspace,
      snapshot,
      policy,
      transactionPath,
      now
    });

    try {
      record = updateRecord(record, "prepared", now, { checks: preparedChecks() });
      await writeTransactionRecord(this.projectRoot, record);

      const baseSha = await runGit(commandRunner, this.projectRoot, [
        "rev-parse",
        baseRef
      ], "resolve base");
      record = updateRecord(record, "checked", this.now().toISOString(), {
        base_sha: firstLine(baseSha),
        checks: [...record.checks, { name: "base_ref", status: "passed" }]
      });
      await writeTransactionRecord(this.projectRoot, record);

      record = updateRecord(record, "reviewed", this.now().toISOString(), {
        checks: [
          ...record.checks,
          { name: "review", status: "passed", detail: review.loop_id },
          { name: "diff_snapshot", status: "passed", detail: snapshot.diff_sha256 }
        ]
      });
      await writeTransactionRecord(this.projectRoot, record);

      await runGit(commandRunner, this.projectRoot, [
        "worktree",
        "add",
        "-B",
        workspace.branch,
        absoluteWorktree,
        baseRef
      ], "prepare worktree");
      await runGit(commandRunner, absoluteWorktree, ["add", "--all"], "stage changes");

      record = updateRecord(record, "committing", this.now().toISOString());
      await writeTransactionRecord(this.projectRoot, record);

      await runGit(commandRunner, absoluteWorktree, [
        "commit",
        "-m",
        request.commitMessage ?? defaultCommitMessage(request, snapshot, review)
      ], "commit");
      const commitSha = firstLine(
        await runGit(commandRunner, absoluteWorktree, ["rev-parse", "HEAD"], "read commit")
      );
      const parentSha = firstLine(
        await runGit(
          commandRunner,
          absoluteWorktree,
          ["rev-parse", "HEAD^"],
          "read parent"
        )
      );

      record = updateRecord(record, "committed", this.now().toISOString(), {
        commit_sha: commitSha,
        parent_sha: parentSha,
        rollback: rollbackMetadata(policy, "committed_unpushed", parentSha)
      });

      const pushDecision = await maybePushOrRequestApproval(this.projectRoot, {
        commandRunner,
        policy,
        request,
        record,
        worktreePath: absoluteWorktree,
        now: this.now()
      });
      record = updateRecord(
        {
          ...record,
          push: pushDecision.push,
          rollback: pushDecision.rollback ?? record.rollback
        },
        pushDecision.status,
        this.now().toISOString()
      );
      await writeTransactionRecord(this.projectRoot, record);
      return record;
    } catch (error) {
      const failed = updateRecord(record, "failed", this.now().toISOString(), {
        checks: [
          ...record.checks,
          {
            name: "git_transaction",
            status: "failed",
            detail: String(error)
          }
        ]
      });
      await writeTransactionRecord(this.projectRoot, failed);
      throw error;
    }
  }

  async resumeApprovedPush(
    request: ResumeGitTransactionPushRequest
  ): Promise<GitTransactionRecord> {
    const policy = await this.loadGitPolicy();
    const commandRunner = this.options.commandRunner ?? spawnCommandRunner;
    let record = await readTransactionRecord(this.projectRoot, request.transactionId);

    if (record.status === "pushed") {
      return record;
    }

    if (record.status !== "approval_required") {
      throw new GitPolicyBlockedError(
        `Git transaction ${record.transaction_id} is not waiting for push approval. Current status: ${record.status}.`
      );
    }

    if (
      request.approvalId !== undefined &&
      record.push.approval_id !== undefined &&
      request.approvalId !== record.push.approval_id
    ) {
      throw new GitPolicyBlockedError(
        `Git transaction ${record.transaction_id} approval id does not match.`
      );
    }

    const remote = request.remote ?? record.push.remote;
    const remoteRef = request.remoteRef ?? record.push.remote_ref ?? record.branch;
    const expectedHeadSha = request.expectedHeadSha ?? record.commit_sha;
    const worktreePath = resolveInside(this.projectRoot, record.worktree_path);

    try {
      const headSha = firstLine(
        await runGit(commandRunner, worktreePath, ["rev-parse", "HEAD"], "read push head")
      );
      if (expectedHeadSha !== undefined && headSha !== expectedHeadSha) {
        throw new GitPolicyBlockedError(
          `Git transaction head moved before approved push. Expected ${expectedHeadSha}, got ${headSha}.`
        );
      }

      const remoteHead = firstRemoteSha(
        await runGit(commandRunner, worktreePath, ["ls-remote", remote, remoteRef], "read remote ref")
      );
      if (
        remoteHead !== undefined &&
        record.base_sha !== undefined &&
        remoteHead !== record.base_sha
      ) {
        throw new GitPolicyBlockedError(
          `Remote ref ${remote}/${remoteRef} moved before approved push. Expected ${record.base_sha}, got ${remoteHead}.`
        );
      }

      record = updateRecord(record, "pushing", this.now().toISOString(), {
        push: {
          ...record.push,
          allowed: true,
          remote,
          remote_ref: remoteRef
        },
        checks: [
          ...record.checks,
          { name: "push_head", status: "passed", detail: headSha },
          {
            name: "remote_ref",
            status: "passed",
            detail: remoteHead ?? "unborn"
          }
        ]
      });
      await writeTransactionRecord(this.projectRoot, record);

      await runGit(
        commandRunner,
        worktreePath,
        ["push", remote, `${record.branch}:${remoteRef}`],
        "push"
      );

      record = updateRecord(record, "pushed", this.now().toISOString(), {
        push: {
          ...record.push,
          requested: true,
          allowed: true,
          remote,
          remote_ref: remoteRef,
          pushed: true
        },
        rollback: rollbackMetadata(policy, "pushed_unmerged", record.parent_sha)
      });
      await writeTransactionRecord(this.projectRoot, record);
      return record;
    } catch (error) {
      const failed = updateRecord(record, "failed", this.now().toISOString(), {
        checks: [
          ...record.checks,
          {
            name: "git_push_resume",
            status: "failed",
            detail: String(error)
          }
        ]
      });
      await writeTransactionRecord(this.projectRoot, failed);
      throw error;
    }
  }

  private async loadGitPolicy(): Promise<GitPolicy> {
    const config = await loadConfigFile<PoliciesConfig>(this.projectRoot, "policies.json");
    return config.git;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

async function maybePushOrRequestApproval(
  projectRoot: string,
  input: {
    commandRunner: CommandRunner;
    policy: GitPolicy;
    request: ExecuteGitTransactionRequest;
    record: GitTransactionRecord;
    worktreePath: string;
    now: Date;
  }
): Promise<{
  status: GitTransactionStatus;
  push: GitTransactionPush;
  rollback?: GitRollbackMetadata;
}> {
  if (input.request.pushRequested !== true) {
    return {
      status: "committed",
      push: input.record.push
    };
  }

  const remoteRef = input.request.pushTargetBranch ?? input.record.branch;
  const protectedTarget = input.policy.protected_branches.some((pattern) =>
    branchMatches(remoteRef, pattern)
  );

  if (protectedTarget) {
    return {
      status: "approval_required",
      push: await requestPushApproval(projectRoot, {
        record: input.record,
        policy: input.policy,
        remoteRef,
        type: "git_protected_branch_push",
        reason: "protected_branch_push requires approval"
      })
    };
  }

  if (!input.policy.allow_auto_push) {
    return {
      status: "approval_required",
      push: await requestPushApproval(projectRoot, {
        record: input.record,
        policy: input.policy,
        remoteRef,
        type: "git_push",
        reason: "auto push is disabled by policy"
      })
    };
  }

  await runGit(
    input.commandRunner,
    input.worktreePath,
    ["push", input.policy.remote, `${input.record.branch}:${remoteRef}`],
    "push"
  );

  return {
    status: "pushed",
    push: {
      requested: true,
      allowed: true,
      remote: input.policy.remote,
      remote_ref: remoteRef,
      pushed: true
    },
    rollback: rollbackMetadata(
      input.policy,
      "pushed_unmerged",
      input.record.parent_sha
    )
  };
}

async function requestPushApproval(
  projectRoot: string,
  input: {
    record: GitTransactionRecord;
    policy: GitPolicy;
    remoteRef: string;
    type: "git_push" | "git_protected_branch_push";
    reason: string;
  }
): Promise<GitTransactionPush> {
  const approvalId = await nextId(projectRoot, "approval");
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    task_id: input.record.task_id,
    run_id: input.record.run_id,
    actor: "git-transaction-executor",
    payload: {
      approval: {
        id: approvalId,
        type: input.type,
        title: `Git push approval for ${input.record.task_id}`,
        task_id: input.record.task_id,
        run_id: input.record.run_id,
        review_loop_id: input.record.review_loop_id,
        transaction_id: input.record.transaction_id,
        branch: input.record.branch,
        commit_sha: input.record.commit_sha,
        expected_head_sha: input.record.commit_sha,
        remote: input.policy.remote,
        remote_ref: input.remoteRef,
        reason: input.reason
      }
    }
  });

  return {
    requested: true,
    allowed: false,
    remote: input.policy.remote,
    remote_ref: input.remoteRef,
    pushed: false,
    approval_id: approvalId,
    reason: input.reason
  };
}

function createInitialRecord(input: {
  projectRoot: string;
  transactionId: string;
  request: ExecuteGitTransactionRequest;
  workspace: GitWorkspace;
  snapshot: DiffSnapshot;
  policy: GitPolicy;
  transactionPath: string;
  now: string;
}): GitTransactionRecord {
  return {
    schema_version: "0.1",
    transaction_id: input.transactionId,
    task_id: input.request.taskId,
    run_id: input.request.runId,
    review_loop_id: input.request.reviewLoopId,
    branch: input.workspace.branch,
    worktree_path: input.workspace.worktree_path,
    status: "planned",
    base_branch: input.workspace.base_branch,
    base_sha: input.workspace.base_sha,
    diff_sha256: input.snapshot.diff_sha256,
    checks: [],
    push: {
      requested: input.request.pushRequested ?? false,
      allowed: false,
      remote: input.policy.remote,
      remote_ref: input.request.pushTargetBranch ?? null,
      pushed: false
    },
    rollback: rollbackMetadata(input.policy, "pre_commit", input.workspace.base_sha),
    workspace: input.workspace,
    transaction_path: toProjectPath(input.projectRoot, input.transactionPath),
    created_at: input.now,
    updated_at: input.now
  };
}

function updateRecord(
  record: GitTransactionRecord,
  status: GitTransactionStatus,
  updatedAt: string,
  patch: Partial<GitTransactionRecord> = {}
): GitTransactionRecord {
  return {
    ...record,
    ...patch,
    status,
    updated_at: updatedAt
  };
}

function preparedChecks(): GitTransactionCheck[] {
  return [{ name: "workspace", status: "passed" }];
}

function rollbackMetadata(
  policy: GitPolicy,
  state: keyof GitPolicy["rollback_strategy"],
  parentSha: string | undefined
): GitRollbackMetadata {
  const strategy = policy.rollback_strategy[state];
  const command_hint =
    parentSha === undefined
      ? "Regenerate or discard the task worktree after saving artifacts."
      : state === "committed_unpushed"
        ? `git reset --hard ${parentSha}`
        : `git revert ${parentSha}..HEAD`;

  return {
    strategy,
    parent_sha: parentSha,
    command_hint
  };
}

async function assertDiffUnchanged(
  projectRoot: string,
  snapshot: DiffSnapshot
): Promise<void> {
  const state = await compareSnapshotToStoredDiff(projectRoot, snapshot);
  if (state.status === "changed") {
    throw new DiffChangedAfterReviewError(
      state.expected_diff_sha256,
      state.actual_diff_sha256
    );
  }
}

function assertReviewApproved(review: ReviewLoopState): void {
  if (review.status !== "approved") {
    throw new ReviewRequiredError(review.loop_id, review.status);
  }
}

function assertSnapshotMatchesRequest(
  snapshot: DiffSnapshot,
  request: ExecuteGitTransactionRequest
): void {
  if (snapshot.task_id !== request.taskId || snapshot.run_id !== request.runId) {
    throw new Error("Diff snapshot does not match transaction request.");
  }
}

async function runGit(
  commandRunner: CommandRunner,
  cwd: string,
  args: string[],
  stage: string
): Promise<string> {
  const result = await commandRunner({
    command: "git",
    args,
    cwd
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new GitCommandError(result, stage);
  }

  return result.stdout.trim();
}

function transactionRecordPath(projectRoot: string, transactionId: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "git",
    "transactions",
    `${transactionId}.json`
  );
}

async function writeTransactionRecord(
  projectRoot: string,
  record: GitTransactionRecord
): Promise<void> {
  await writeJsonFileAtomic(
    resolveInside(projectRoot, record.transaction_path),
    record
  );
}

async function readTransactionRecord(
  projectRoot: string,
  transactionId: string
): Promise<GitTransactionRecord> {
  return readJsonFile<GitTransactionRecord>(
    transactionRecordPath(projectRoot, transactionId)
  );
}

function defaultCommitMessage(
  request: ExecuteGitTransactionRequest,
  snapshot: DiffSnapshot,
  review: ReviewLoopState
): string {
  return [
    `${request.taskId} Kairon automated commit`,
    "",
    `Kairon-Task: ${request.taskId}`,
    `Kairon-Run: ${request.runId}`,
    `Kairon-Review: ${review.loop_id}`,
    `Kairon-Diff-SHA256: ${snapshot.diff_sha256}`
  ].join("\n");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function firstRemoteSha(value: string): string | undefined {
  const first = firstLine(value);
  if (first.length === 0) {
    return undefined;
  }

  return first.split(/\s+/)[0];
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
