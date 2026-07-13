import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { ChangedFile } from "./diff-snapshot.js";
import type {
  GitTransactionPrStatus,
  GitTransactionRecord
} from "./transaction-executor.js";

export type GitPrCandidateApproval = {
  approval_id: string;
  type: "git_push" | "git_protected_branch_push";
  status: "required" | "approved";
  reason?: string;
};

export type GitPrCandidateLiveExecution = {
  status: "created";
  repository: string;
  base_branch: string;
  head_branch: string;
  expected_base_sha?: string;
  observed_base_sha: string;
  expected_head_sha: string;
  observed_head_sha: string;
  approval_id: string;
  follow_up_id?: string;
  draft: boolean;
  pull_request_number: number;
  pull_request_url: string;
  pull_request_state?: string;
  created_at: string;
};

export type GitPrCandidateArtifact = {
  schema_version: string;
  artifact_kind: "git_pr_candidate";
  transaction_id: string;
  status: GitTransactionPrStatus;
  task_id: string;
  run_id: string;
  review_loop_id: string;
  base_branch: string;
  base_sha?: string;
  head_branch: string;
  remote: string;
  remote_ref: string | null;
  commit_sha?: string;
  diff_sha256: string;
  changed_files: ChangedFile[];
  diff_summary: {
    files: number;
    additions: number;
    deletions: number;
    paths: string[];
  };
  approvals: GitPrCandidateApproval[];
  suggested_pr: {
    title: string;
    body: string;
    create_hint: string;
  };
  rollback: {
    strategy?: string;
    command_hint: string;
  };
  live_execution?: GitPrCandidateLiveExecution;
  source_transaction_path: string;
  artifact_path: string;
  created_at: string;
  updated_at: string;
};

export async function writePrCandidateArtifact(
  projectRoot: string,
  record: GitTransactionRecord,
  options: { now?: Date } = {}
): Promise<GitPrCandidateArtifact> {
  const artifact = buildPrCandidateArtifact(projectRoot, record, options);
  const existing = await readExistingPrCandidateArtifact(
    prCandidateArtifactPath(projectRoot, record.transaction_id)
  );
  if (canPreserveLiveExecution(existing, artifact)) {
    artifact.live_execution = existing.live_execution;
  }
  await writeJsonFileAtomic(
    prCandidateArtifactPath(projectRoot, record.transaction_id),
    artifact
  );
  return artifact;
}

export async function listPrCandidateArtifacts(
  projectRoot: string
): Promise<GitPrCandidateArtifact[]> {
  const artifactsDir = prCandidateArtifactsDir(projectRoot);
  let entries: string[];

  try {
    entries = await readdir(artifactsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        readJsonFile<GitPrCandidateArtifact>(resolveInside(artifactsDir, entry))
      )
  );

  return artifacts
    .filter((artifact) => artifact.artifact_kind === "git_pr_candidate")
    .sort(comparePrCandidateArtifacts);
}

export async function readPrCandidateArtifact(
  projectRoot: string,
  candidateId: string
): Promise<GitPrCandidateArtifact> {
  const normalized = normalizePrCandidateId(candidateId);

  try {
    const artifact = await readJsonFile<GitPrCandidateArtifact>(
      prCandidateArtifactPath(projectRoot, normalized)
    );
    if (artifact.artifact_kind !== "git_pr_candidate") {
      throw new Error(`Invalid PR candidate artifact kind: ${artifact.artifact_kind}`);
    }

    return artifact;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      throw new GitPrCandidateNotFoundError(normalized);
    }

    throw error;
  }
}

export function prCandidateArtifactsDir(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "git", "pr-candidates");
}

export function prCandidateArtifactPath(
  projectRoot: string,
  transactionId: string
): string {
  return resolveInside(prCandidateArtifactsDir(projectRoot), `${transactionId}.json`);
}

export class GitPrCandidateNotFoundError extends Error {
  constructor(readonly candidateId: string) {
    super(`Git PR candidate not found: ${candidateId}`);
    this.name = "GitPrCandidateNotFoundError";
  }
}

function normalizePrCandidateId(candidateId: string): string {
  const trimmed = candidateId.trim().replace(/\.json$/u, "");
  if (!/^[A-Za-z0-9._-]+$/u.test(trimmed)) {
    throw new Error(`Invalid git PR candidate id: ${candidateId}`);
  }

  return trimmed;
}

function comparePrCandidateArtifacts(
  left: GitPrCandidateArtifact,
  right: GitPrCandidateArtifact
): number {
  return (
    Date.parse(right.updated_at || right.created_at) -
    Date.parse(left.updated_at || left.created_at)
  );
}

function buildPrCandidateArtifact(
  projectRoot: string,
  record: GitTransactionRecord,
  options: { now?: Date }
): GitPrCandidateArtifact {
  if (record.pr === undefined) {
    throw new Error(`Git transaction ${record.transaction_id} has no PR metadata.`);
  }

  const changedFiles = normalizeChangedFiles(record.changed_files ?? []);
  const diffSummary = summarizeChangedFiles(changedFiles);
  const artifactPath = prCandidateArtifactPath(projectRoot, record.transaction_id);

  return {
    schema_version: "0.1",
    artifact_kind: "git_pr_candidate",
    transaction_id: record.transaction_id,
    status: record.pr.status,
    task_id: record.task_id,
    run_id: record.run_id,
    review_loop_id: record.review_loop_id,
    base_branch: record.pr.base_branch,
    base_sha: record.base_sha,
    head_branch: record.pr.head_branch,
    remote: record.pr.remote,
    remote_ref: record.pr.remote_ref,
    commit_sha: record.pr.commit_sha,
    diff_sha256: record.pr.diff_sha256,
    changed_files: changedFiles,
    diff_summary: diffSummary,
    approvals: buildApprovals(record),
    suggested_pr: {
      title: record.pr.title,
      body: buildPrBody(record, diffSummary),
      create_hint: record.pr.create_hint
    },
    rollback: {
      strategy: record.pr.rollback_strategy,
      command_hint: record.pr.rollback_hint
    },
    source_transaction_path: record.transaction_path,
    artifact_path: toProjectPath(projectRoot, artifactPath),
    created_at: record.created_at,
    updated_at: options.now?.toISOString() ?? record.updated_at
  };
}

async function readExistingPrCandidateArtifact(
  artifactPath: string
): Promise<GitPrCandidateArtifact | null> {
  try {
    return await readJsonFile<GitPrCandidateArtifact>(artifactPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function canPreserveLiveExecution(
  existing: GitPrCandidateArtifact | null,
  next: GitPrCandidateArtifact
): existing is GitPrCandidateArtifact & {
  live_execution: GitPrCandidateLiveExecution;
} {
  return (
    existing?.live_execution !== undefined &&
    existing.transaction_id === next.transaction_id &&
    existing.base_branch === next.base_branch &&
    existing.base_sha === next.base_sha &&
    existing.head_branch === next.head_branch &&
    existing.remote_ref === next.remote_ref &&
    existing.commit_sha === next.commit_sha &&
    existing.diff_sha256 === next.diff_sha256
  );
}

function normalizeChangedFiles(changedFiles: ChangedFile[]): ChangedFile[] {
  return changedFiles.map((file) => ({
    ...file,
    path: toPosixPath(file.path),
    previous_path:
      file.previous_path === undefined ? undefined : toPosixPath(file.previous_path)
  }));
}

function summarizeChangedFiles(changedFiles: ChangedFile[]): {
  files: number;
  additions: number;
  deletions: number;
  paths: string[];
} {
  return {
    files: changedFiles.length,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    paths: changedFiles.map((file) => file.path)
  };
}

function buildApprovals(record: GitTransactionRecord): GitPrCandidateApproval[] {
  const approvalId = record.pr?.approval_id ?? record.push.approval_id;
  if (approvalId === undefined) {
    return [];
  }

  return [
    {
      approval_id: approvalId,
      type: isProtectedBranchPush(record)
        ? "git_protected_branch_push"
        : "git_push",
      status:
        record.pr?.status === "ready_for_pr" || record.push.pushed
          ? "approved"
          : "required",
      reason: record.push.reason
    }
  ];
}

function isProtectedBranchPush(record: GitTransactionRecord): boolean {
  return (
    record.pr?.status === "protected_push_approval_required" ||
    record.push.reason === "protected_branch_push requires approval"
  );
}

function buildPrBody(
  record: GitTransactionRecord,
  diffSummary: GitPrCandidateArtifact["diff_summary"]
): string {
  return [
    "## Purpose",
    `- Prepare the automated change for Kairon task \`${record.task_id}\` as a pull request.`,
    "",
    "## Changes",
    ...changedFileLines(record.changed_files ?? []),
    "",
    "## Validation",
    `- Review loop: \`${record.review_loop_id}\``,
    `- Diff SHA256: \`${record.diff_sha256}\``,
    `- Transaction: \`${record.transaction_id}\``,
    `- Files: ${diffSummary.files}, additions: ${diffSummary.additions}, deletions: ${diffSummary.deletions}`,
    ...record.checks.map((check) =>
      `- ${check.name}: ${check.status}${check.detail === undefined ? "" : ` (${check.detail})`}`
    ),
    "",
    "## Residuals",
    ...residualLines(record),
    "",
    "## Rollback",
    `- ${record.pr?.rollback_hint ?? record.rollback.command_hint}`
  ].join("\n");
}

function changedFileLines(changedFiles: ChangedFile[]): string[] {
  if (changedFiles.length === 0) {
    return ["- No changed files."];
  }

  return changedFiles.map(
    (file) =>
      `- \`${toPosixPath(file.path)}\` ${file.status} (+${file.additions}/-${file.deletions})`
  );
}

function residualLines(record: GitTransactionRecord): string[] {
  const pr = record.pr;
  if (pr === undefined) {
    return ["- PR metadata is missing."];
  }

  if (pr.status === "ready_for_pr") {
    return ["- None."];
  }

  if (pr.status === "local_commit_ready") {
    return [
      `- Push \`${pr.head_branch}\` to \`${pr.remote}/${pr.remote_ref ?? pr.head_branch}\` before creating the PR.`
    ];
  }

  if (
    pr.status === "push_approval_required" ||
    pr.status === "protected_push_approval_required"
  ) {
    return [
      `- Push after approval \`${pr.approval_id ?? record.push.approval_id ?? "unknown"}\` is granted.`
    ];
  }

  if (pr.status === "failed") {
    return ["- Do not create a PR until transaction recovery is complete."];
  }

  return ["- Create the PR after the git transaction is complete."];
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
