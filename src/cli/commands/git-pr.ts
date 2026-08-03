import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ApprovalNotFoundError,
  ApprovalQueue,
  type ApprovalRecord
} from "../../approvals/approval-queue.js";
import {
  ApprovalFollowUpNotFoundError,
  authorizeGitPrWithFollowUp,
  showApprovalFollowUp,
  type ApprovalFollowUpArtifact
} from "../../approvals/follow-up-runner.js";
import {
  resolveSecret,
  type ResolvedSecret,
  type SecretResolver
} from "../../core/secrets/secret-resolver.js";
import {
  withResourceLock,
  writeJsonFileFenced
} from "../../core/fs/resource-lock.js";
import {
  GitPrCandidateNotFoundError,
  listPrCandidateArtifacts,
  prCandidateArtifactPath,
  readPrCandidateArtifact,
  type GitPrCandidateArtifact,
  type GitPrCandidateLiveExecution
} from "../../git/pr-artifact.js";
import {
  createGitHubPullRequest,
  GitHubPullRequestClientError,
  inspectGitHubPullRequestRefs,
  type GitHubPullRequestClient,
  type GitHubPullRequestRefClient
} from "../../github/pull-request-client.js";

export type GitPrCreateCommandOptions = {
  dryRun?: boolean;
  execute?: boolean;
  approvalId?: string;
  followUpId?: string;
  confirm?: string;
  repository?: string;
  draft?: boolean;
  tokenEnv?: string;
};

export type GitPrCreateCommandDeps = {
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  pullRequestClient?: GitHubPullRequestClient;
  pullRequestRefClient?: GitHubPullRequestRefClient;
  now?: () => Date;
};

type GitPrPayload = {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};

type GitPrAuthorization = {
  approvalId: string;
  followUpId?: string;
  approval: ApprovalRecord;
  followUp?: ApprovalFollowUpArtifact;
};

type GitPrAuthorizationResolution =
  | { ok: true; value: GitPrAuthorization }
  | {
      ok: false;
      reason: string;
      message: string;
      approvalId?: string;
      followUpId?: string;
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

  if (options.confirm !== candidate.transaction_id) {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "confirmation_required",
      message: `--confirm must exactly match ${candidate.transaction_id}.`
    });
  }

  if (candidate.status !== "ready_for_pr") {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "candidate_status_not_ready",
      message: candidate.suggested_pr.create_hint
    });
  }

  const authorization = await resolveGitPrAuthorization(
    projectRoot,
    candidate,
    options
  );
  if (!authorization.ok) {
    return formatGitPrCreateBlocked(candidate, payload, authorization);
  }

  const candidatePath = prCandidateArtifactPath(
    projectRoot,
    candidate.transaction_id
  );
  return withResourceLock(
    projectRoot,
    candidatePath,
    { owner: "git-pr-live-execute", ttlMs: 120_000 },
    async (lock) => {
      const current = await readPrCandidateArtifact(
        projectRoot,
        candidate.transaction_id
      );
      const currentPayload = await buildGitPrPayload(projectRoot, current, options);
      if (!sameCandidateRevision(candidate, current)) {
        return formatGitPrCreateBlocked(current, currentPayload, {
          reason: "candidate_artifact_drift",
          approvalId: authorization.value.approvalId,
          followUpId: authorization.value.followUpId,
          message: "The PR candidate changed after authorization checks. Run dry-run again."
        });
      }
      if (current.live_execution !== undefined) {
        if (!sameLiveExecutionRequest(current.live_execution, currentPayload)) {
          return formatGitPrCreateBlocked(current, currentPayload, {
            reason: "live_execution_request_mismatch",
            approvalId: authorization.value.approvalId,
            followUpId: authorization.value.followUpId,
            message: "This candidate was already executed with a different repository or draft setting."
          });
        }
        return formatGitPrCreated(
          current,
          current.live_execution,
          true
        );
      }
      if (current.commit_sha === undefined) {
        return formatGitPrCreateBlocked(current, currentPayload, {
          reason: "missing_candidate_commit",
          approvalId: authorization.value.approvalId,
          followUpId: authorization.value.followUpId,
          message: "The PR candidate does not contain the expected head commit SHA."
        });
      }

      const token = await resolveGitHubToken({
        env: deps.env ?? process.env,
        resolver: deps.resolver,
        tokenEnv: options.tokenEnv
      });
      if (token.status !== "present") {
        return formatGitPrSetupRequired(current, currentPayload, {
          reason: "missing_github_token",
          tokenEnv: options.tokenEnv ?? githubTokenEnvNames.join(",")
        });
      }

      const refClient =
        deps.pullRequestRefClient ?? inspectGitHubPullRequestRefs;
      let refs;
      try {
        refs = await refClient({
          repository: currentPayload.repository,
          base: currentPayload.base,
          head: currentPayload.head,
          token: token.value
        });
      } catch (error) {
        return formatGitPrClientError(current, currentPayload, error);
      }

      if (
        current.base_sha !== undefined &&
        refs.baseSha !== current.base_sha
      ) {
        return formatGitPrCreateBlocked(current, currentPayload, {
          reason: "base_branch_drift",
          approvalId: authorization.value.approvalId,
          followUpId: authorization.value.followUpId,
          message: `Expected base ${shortSha(current.base_sha)}, observed ${shortSha(refs.baseSha)}.`
        });
      }
      if (refs.headSha !== current.commit_sha) {
        return formatGitPrCreateBlocked(current, currentPayload, {
          reason: "head_commit_drift",
          approvalId: authorization.value.approvalId,
          followUpId: authorization.value.followUpId,
          message: `Expected head ${shortSha(current.commit_sha)}, observed ${shortSha(refs.headSha)}.`
        });
      }

      const client = deps.pullRequestClient ?? createGitHubPullRequest;
      let result;
      try {
        result = await client({
          repository: currentPayload.repository,
          base: currentPayload.base,
          head: currentPayload.head,
          title: currentPayload.title,
          body: currentPayload.body,
          draft: currentPayload.draft,
          token: token.value
        });
      } catch (error) {
        return formatGitPrClientError(current, currentPayload, error);
      }

      const createdAt = (deps.now?.() ?? new Date()).toISOString();
      const liveExecution: GitPrCandidateLiveExecution = {
        status: "created",
        repository: currentPayload.repository,
        base_branch: currentPayload.base,
        head_branch: currentPayload.head,
        expected_base_sha: current.base_sha,
        observed_base_sha: refs.baseSha,
        expected_head_sha: current.commit_sha,
        observed_head_sha: refs.headSha,
        approval_id: authorization.value.approvalId,
        follow_up_id: authorization.value.followUpId,
        draft: currentPayload.draft,
        pull_request_number: result.number,
        pull_request_url: result.url,
        pull_request_state: result.state,
        created_at: createdAt
      };
      await writeJsonFileFenced(lock, candidatePath, {
        ...current,
        live_execution: liveExecution,
        updated_at: createdAt
      });
      return formatGitPrCreated(
        current,
        liveExecution,
        false
      );
    }
  );
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
    base_sha: candidate.base_sha,
    head_branch: candidate.head_branch,
    remote: candidate.remote,
    remote_ref: candidate.remote_ref,
    commit_sha: candidate.commit_sha,
    diff_sha256: candidate.diff_sha256,
    diff_summary: candidate.diff_summary,
    approvals: candidate.approvals,
    suggested_pr: candidate.suggested_pr,
    rollback: candidate.rollback,
    live_execution: candidate.live_execution,
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
    "confirmation_required=true",
    `confirm=${options.confirm ?? "missing"}`,
    `approval_id=${options.approvalId ?? "missing"}`,
    `follow_up_id=${options.followUpId ?? "missing"}`,
    `ready=${candidate.status === "ready_for_pr"}`,
    `title=${payload.title}`,
    "body=",
    payload.body
  ].join("\n");
}

function formatGitPrCreateBlocked(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  options: {
    reason: string;
    message: string;
    approvalId?: string;
    followUpId?: string;
  }
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
    options.followUpId === undefined ? null : `follow_up_id=${options.followUpId}`,
    `message=${sanitizeInline(options.message)}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatGitPrSetupRequired(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  options: { reason: string; tokenEnv?: string; httpStatus?: number }
): string {
  return [
    "Kairon git PR create setup required.",
    `candidate_id=${candidate.transaction_id}`,
    `repository=${payload.repository}`,
    `base=${payload.base}`,
    `head=${payload.head}`,
    `reason=${options.reason}`,
    options.tokenEnv === undefined ? null : `token_env=${options.tokenEnv}`,
    options.httpStatus === undefined
      ? null
      : `http_status=${options.httpStatus}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatGitPrCreateFailed(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  options: { reason: string; httpStatus?: number }
): string {
  return [
    "Kairon git PR create failed.",
    `candidate_id=${candidate.transaction_id}`,
    `repository=${payload.repository}`,
    `base=${payload.base}`,
    `head=${payload.head}`,
    `reason=${options.reason}`,
    options.httpStatus === undefined
      ? null
      : `http_status=${options.httpStatus}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatGitPrClientError(
  candidate: GitPrCandidateArtifact,
  payload: GitPrPayload,
  error: unknown
): string {
  if (!(error instanceof GitHubPullRequestClientError)) {
    return formatGitPrCreateFailed(candidate, payload, {
      reason: "github_client_error"
    });
  }

  if (
    ["auth_error", "permission_error", "not_found"].includes(error.kind)
  ) {
    return formatGitPrSetupRequired(candidate, payload, {
      reason: `github_${error.kind}`,
      httpStatus: error.httpStatus
    });
  }
  if (error.kind === "validation_error") {
    return formatGitPrCreateBlocked(candidate, payload, {
      reason: "github_validation_error",
      message: "GitHub rejected the PR payload. Check for an existing PR and branch validity."
    });
  }
  return formatGitPrCreateFailed(candidate, payload, {
    reason: `github_${error.kind}`,
    httpStatus: error.httpStatus
  });
}

function formatGitPrCreated(
  candidate: GitPrCandidateArtifact,
  execution: GitPrCandidateLiveExecution,
  idempotent: boolean
): string {
  return [
    "Kairon git PR created.",
    `candidate_id=${candidate.transaction_id}`,
    `repository=${execution.repository}`,
    `base=${execution.base_branch}`,
    `head=${execution.head_branch}`,
    `approval_id=${execution.approval_id}`,
    execution.follow_up_id === undefined
      ? null
      : `follow_up_id=${execution.follow_up_id}`,
    `url=${execution.pull_request_url}`,
    `number=${execution.pull_request_number}`,
    execution.pull_request_state === undefined
      ? null
      : `state=${execution.pull_request_state}`,
    `idempotent=${idempotent}`,
    `artifact=${candidate.artifact_path}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function resolveGitPrAuthorization(
  projectRoot: string,
  candidate: GitPrCandidateArtifact,
  options: GitPrCreateCommandOptions
): Promise<GitPrAuthorizationResolution> {
  let followUp: ApprovalFollowUpArtifact | undefined;
  let approvalId = options.approvalId?.trim();

  if (options.followUpId !== undefined) {
    try {
      followUp = await showApprovalFollowUp(projectRoot, options.followUpId);
    } catch (error) {
      if (error instanceof ApprovalFollowUpNotFoundError) {
        return {
          ok: false,
          reason: "follow_up_not_found",
          followUpId: options.followUpId,
          message: `Approval follow-up ${options.followUpId} was not found.`
        };
      }
      throw error;
    }

    const gate = authorizeGitPrWithFollowUp(
      followUp,
      candidate.transaction_id
    );
    if (!gate.ok) {
      return {
        ok: false,
        reason: gate.reason,
        followUpId: followUp.id,
        message: "The approval follow-up is not ready to authorize this PR candidate."
      };
    }
    if (approvalId !== undefined && approvalId !== gate.approval_id) {
      return {
        ok: false,
        reason: "approval_follow_up_mismatch",
        approvalId,
        followUpId: followUp.id,
        message: "--approval-id does not match the follow-up source approval."
      };
    }
    approvalId = gate.approval_id;
  }

  if (approvalId === undefined || approvalId.length === 0) {
    return {
      ok: false,
      reason: "approval_required",
      message: "--approval-id or --follow-up-id is required for --execute."
    };
  }

  const approval = await readApprovalForGitPr(projectRoot, approvalId);
  if (approval === null) {
    return {
      ok: false,
      reason: "approval_not_found",
      approvalId,
      followUpId: followUp?.id,
      message: `Approval ${approvalId} was not found.`
    };
  }
  if (!isApproved(approval)) {
    return {
      ok: false,
      reason: "approval_not_approved",
      approvalId,
      followUpId: followUp?.id,
      message: `Approval ${approvalId} is not decided with approve.`
    };
  }

  const linkedCandidateId = readString(
    approval.transaction_id ?? approval.candidate_id
  );
  const candidateApprovalIds = candidate.approvals.map(
    (item) => item.approval_id
  );
  if (
    (linkedCandidateId !== undefined &&
      linkedCandidateId !== candidate.transaction_id) ||
    (candidateApprovalIds.length > 0 &&
      !candidateApprovalIds.includes(approvalId))
  ) {
    return {
      ok: false,
      reason: "approval_candidate_mismatch",
      approvalId,
      followUpId: followUp?.id,
      message: "The approval is not linked to this PR candidate."
    };
  }

  return {
    ok: true,
    value: {
      approvalId,
      followUpId: followUp?.id,
      approval,
      followUp
    }
  };
}

function sameCandidateRevision(
  expected: GitPrCandidateArtifact,
  actual: GitPrCandidateArtifact
): boolean {
  return (
    expected.transaction_id === actual.transaction_id &&
    expected.status === actual.status &&
    expected.base_branch === actual.base_branch &&
    expected.base_sha === actual.base_sha &&
    expected.head_branch === actual.head_branch &&
    expected.remote === actual.remote &&
    expected.remote_ref === actual.remote_ref &&
    expected.commit_sha === actual.commit_sha &&
    expected.diff_sha256 === actual.diff_sha256
  );
}

function sameLiveExecutionRequest(
  execution: GitPrCandidateLiveExecution,
  payload: GitPrPayload
): boolean {
  return (
    execution.repository === payload.repository &&
    execution.base_branch === payload.base &&
    execution.head_branch === payload.head &&
    execution.draft === payload.draft
  );
}

function shortSha(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
