import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ApprovalNotFoundError,
  ApprovalQueue,
  type ApprovalRecord
} from "../../approvals/approval-queue.js";
import {
  resolveSecret,
  type ResolvedSecret,
  type SecretResolver
} from "../../core/secrets/secret-resolver.js";
import {
  GitPrCandidateNotFoundError,
  listPrCandidateArtifacts,
  readPrCandidateArtifact,
  type GitPrCandidateArtifact
} from "../../git/pr-artifact.js";
import {
  createGitHubPullRequest,
  type GitHubPullRequestClient
} from "../../github/pull-request-client.js";

export type GitPrCreateCommandOptions = {
  dryRun?: boolean;
  execute?: boolean;
  approvalId?: string;
  repository?: string;
  draft?: boolean;
  tokenEnv?: string;
};

export type GitPrCreateCommandDeps = {
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  pullRequestClient?: GitHubPullRequestClient;
};

type GitPrPayload = {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};

const githubTokenEnvNames = ["GH_TOKEN", "GITHUB_TOKEN"];

export async function listGitPrCandidatesCommand(
  projectRoot: string
): Promise<string> {
  const candidates = await listPrCandidateArtifacts(projectRoot);
  if (candidates.length === 0) {
    return "No git PR candidates found.";
  }

  return [
    "Kairon git PR candidates:",
    ...candidates.map((candidate) =>
      [
        `id=${candidate.transaction_id}`,
        `status=${candidate.status}`,
        `base=${candidate.base_branch}`,
        `head=${candidate.head_branch}`,
        `remote=${candidate.remote}`,
        candidate.remote_ref === null ? null : `remote_ref=${candidate.remote_ref}`,
        candidate.commit_sha === undefined ? null : `commit=${candidate.commit_sha}`,
        `title=${sanitizeInline(candidate.suggested_pr.title)}`
      ]
        .filter((part): part is string => part !== null)
        .join(" ")
    )
  ].join("\n");
}

export async function showGitPrCandidateCommand(
  projectRoot: string,
  candidateId: string
): Promise<string> {
  try {
    const candidate = await readPrCandidateArtifact(projectRoot, candidateId);
    return formatGitPrCandidateDetail(candidate);
  } catch (error) {
    if (error instanceof GitPrCandidateNotFoundError) {
      return [
        "Kairon git PR candidate not found.",
        `candidate_id=${error.candidateId}`,
        "reason=not_found"
      ].join("\n");
    }

    throw error;
  }
}

export async function createGitPrCommand(
  projectRoot: string,
  candidateId: string,
  options: GitPrCreateCommandOptions = {},
  deps: GitPrCreateCommandDeps = {}
): Promise<string> {
  const candidate = await readPrCandidateArtifact(projectRoot, candidateId);
  const payload = await buildGitPrPayload(projectRoot, candidate, options);

  if (options.execute === true && options.dryRun === true) {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "conflicting_options",
      message: "Use either --dry-run or --execute, not both."
    });
  }

  if (options.execute !== true) {
    return formatGitPrDryRun(candidate, payload, options);
  }

  if (candidate.status !== "ready_for_pr") {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "candidate_status_not_ready",
      message: candidate.suggested_pr.create_hint
    });
  }

  if (options.approvalId === undefined || options.approvalId.trim().length === 0) {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "approval_required",
      message: "--approval-id is required for --execute."
    });
  }

  const approval = await readApprovalForGitPr(projectRoot, options.approvalId);
  if (approval === null) {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "approval_not_found",
      approvalId: options.approvalId,
      message: `Approval ${options.approvalId} was not found.`
    });
  }

  if (!isApproved(approval)) {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "approval_not_approved",
      approvalId: options.approvalId,
      message: `Approval ${options.approvalId} is not decided with approve.`
    });
  }

  const token = await resolveGitHubToken({
    env: deps.env ?? process.env,
    resolver: deps.resolver,
    tokenEnv: options.tokenEnv
  });
  if (token.status !== "present") {
    return [
      "Kairon git PR create setup required.",
      `candidate_id=${candidate.transaction_id}`,
      `repository=${payload.repository}`,
      "reason=missing_github_token",
      `token_env=${options.tokenEnv ?? githubTokenEnvNames.join(",")}`
    ].join("\n");
  }

  const client = deps.pullRequestClient ?? createGitHubPullRequest;
  const result = await client({
    repository: payload.repository,
    base: payload.base,
    head: payload.head,
    title: payload.title,
    body: payload.body,
    draft: payload.draft,
    token: token.value
  });

  return [
    "Kairon git PR created.",
    `candidate_id=${candidate.transaction_id}`,
    `repository=${payload.repository}`,
    `base=${payload.base}`,
    `head=${payload.head}`,
    `approval_id=${options.approvalId}`,
    `url=${result.url}`,
    `number=${result.number}`,
    result.state === undefined ? null : `state=${result.state}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatGitPrCandidateDetail(candidate: GitPrCandidateArtifact): string {
  const detail = {
    schema_version: candidate.schema_version,
    artifact_kind: candidate.artifact_kind,
    transaction_id: candidate.transaction_id,
    status: candidate.status,
    task_id: candidate.task_id,
    run_id: candidate.run_id,
    review_loop_id: candidate.review_loop_id,
    base_branch: candidate.base_branch,
    head_branch: candidate.head_branch,
    remote: candidate.remote,
    remote_ref: candidate.remote_ref,
    commit_sha: candidate.commit_sha,
    diff_sha256: candidate.diff_sha256,
    diff_summary: candidate.diff_summary,
    approvals: candidate.approvals,
    suggested_pr: candidate.suggested_pr,
    rollback: candidate.rollback,
    source_transaction_path: candidate.source_transaction_path,
    artifact_path: candidate.artifact_path,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at
  };

  return [
    "Kairon git PR candidate:",
    `id=${candidate.transaction_id}`,
    `status=${candidate.status}`,
    `base=${candidate.base_branch}`,
    `head=${candidate.head_branch}`,
    `remote=${candidate.remote}`,
    candidate.remote_ref === null ? null : `remote_ref=${candidate.remote_ref}`,
    candidate.commit_sha === undefined ? null : `commit=${candidate.commit_sha}`,
    `artifact=${candidate.artifact_path}`,
    `detail=${JSON.stringify(detail, null, 2)}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function buildGitPrPayload(
  projectRoot: string,
  candidate: GitPrCandidateArtifact,
  options: GitPrCreateCommandOptions
): Promise<GitPrPayload> {
  const repository =
    options.repository ?? (await resolveRepositoryFromRemote(projectRoot, candidate.remote));

  return {
    repository,
    base: candidate.base_branch,
    head: candidate.remote_ref ?? candidate.head_branch,
    title: candidate.suggested_pr.title,
    body: buildJapanesePrBody(candidate),
    draft: options.draft === true
  };
}

function formatGitPrDryRun(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  options: GitPrCreateCommandOptions
): string {
  return [
    "Kairon git PR create dry-run.",
    `candidate_id=${candidate.transaction_id}`,
    `candidate_status=${candidate.status}`,
    `repository=${payload.repository}`,
    `base=${payload.base}`,
    `head=${payload.head}`,
    `draft=${payload.draft}`,
    `approval_id=${options.approvalId ?? "missing"}`,
    `ready=${candidate.status === "ready_for_pr"}`,
    `title=${payload.title}`,
    "body=",
    payload.body
  ].join("\n");
}

function formatGitPrCreateBlocked(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  options: { reason: string; message: string; approvalId?: string }
): string {
  return [
    "Kairon git PR create blocked.",
    `candidate_id=${candidate.transaction_id}`,
    `candidate_status=${candidate.status}`,
    `repository=${payload.repository}`,
    `base=${payload.base}`,
    `head=${payload.head}`,
    `reason=${options.reason}`,
    options.approvalId === undefined ? null : `approval_id=${options.approvalId}`,
    `message=${sanitizeInline(options.message)}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildJapanesePrBody(candidate: GitPrCandidateArtifact): string {
  return [
    "## 目的",
    `- Kairon task \`${candidate.task_id}\` の自動変更をPull Requestとして確認します。`,
    "",
    "## 変更内容",
    ...changedFileLines(candidate),
    "",
    "## 検証",
    `- Review loop: \`${candidate.review_loop_id}\``,
    `- Run: \`${candidate.run_id}\``,
    `- Transaction: \`${candidate.transaction_id}\``,
    `- Diff SHA256: \`${candidate.diff_sha256}\``,
    `- Files: ${candidate.diff_summary.files}, additions: ${candidate.diff_summary.additions}, deletions: ${candidate.diff_summary.deletions}`,
    "",
    "## 承認",
    ...approvalLines(candidate),
    "",
    "## 残課題",
    ...residualLines(candidate),
    "",
    "## Rollback",
    `- ${candidate.rollback.command_hint}`
  ].join("\n");
}

function changedFileLines(candidate: GitPrCandidateArtifact): string[] {
  if (candidate.changed_files.length === 0) {
    return ["- 変更ファイルはありません。"];
  }

  return candidate.changed_files.map(
    (file) =>
      `- \`${file.path}\` ${file.status} (+${file.additions}/-${file.deletions})`
  );
}

function approvalLines(candidate: GitPrCandidateArtifact): string[] {
  if (candidate.approvals.length === 0) {
    return ["- PR作成時は `--execute` と承認済み `--approval-id` を要求します。"];
  }

  return candidate.approvals.map(
    (approval) =>
      `- ${approval.type}: \`${approval.approval_id}\` status=${approval.status}${
        approval.reason === undefined ? "" : ` reason=${approval.reason}`
      }`
  );
}

function residualLines(candidate: GitPrCandidateArtifact): string[] {
  if (candidate.status === "ready_for_pr") {
    return ["- なし。"];
  }

  return [`- ${candidate.suggested_pr.create_hint}`];
}

async function resolveRepositoryFromRemote(
  projectRoot: string,
  remoteName: string
): Promise<string> {
  const gitConfigPath = path.join(projectRoot, ".git", "config");
  const gitConfig = await readFile(gitConfigPath, "utf8");
  const url = remoteUrlFromConfig(gitConfig, remoteName);
  if (url === undefined) {
    throw new Error(`Git remote not found in .git/config: ${remoteName}`);
  }

  const repository = parseGitHubRepositoryFromRemoteUrl(url);
  if (repository === undefined) {
    throw new Error(`Git remote is not a GitHub repository: ${remoteName}`);
  }

  return repository;
}

function remoteUrlFromConfig(config: string, remoteName: string): string | undefined {
  const lines = config.split(/\r?\n/u);
  let inRemoteSection = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/u);
    if (section !== null) {
      inRemoteSection = section[1] === remoteName;
      continue;
    }

    if (!inRemoteSection) {
      continue;
    }

    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/u);
    if (url !== null) {
      return url[1];
    }
  }

  return undefined;
}

function parseGitHubRepositoryFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (https !== null) {
    return `${https[1]}/${https[2]}`;
  }

  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (ssh !== null) {
    return `${ssh[1]}/${ssh[2]}`;
  }

  return undefined;
}

async function readApprovalForGitPr(
  projectRoot: string,
  approvalId: string
): Promise<ApprovalRecord | null> {
  try {
    return await new ApprovalQueue(projectRoot).show(approvalId);
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return null;
    }

    throw error;
  }
}

function isApproved(approval: ApprovalRecord): boolean {
  return approval.status === "decided" && approval.decision === "approve";
}

async function resolveGitHubToken(input: {
  env: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  tokenEnv?: string;
}): Promise<ResolvedSecret> {
  if (input.tokenEnv !== undefined) {
    return resolveSecret({
      env: input.env,
      envName: input.tokenEnv,
      resolver: input.resolver
    });
  }

  return resolveSecret({
    env: input.env,
    references: githubTokenEnvNames.map((name) => ({ provider: "env", name })),
    resolver: input.resolver
  });
}

function sanitizeInline(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 237)}...`;
}
