import { ApprovalNotFoundError, ApprovalQueue } from "../approvals/approval-queue.js";
import {
  ApprovalFollowUpNotFoundError,
  authorizeGitPrMergeWithFollowUp,
  showApprovalFollowUp
} from "../approvals/follow-up-runner.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { resolveInside } from "../core/fs/paths.js";
import {
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import {
  resolveSecret,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import {
  buildExecutionPreflight,
  type ExecutionGuardPreflight
} from "../deploy/execution-guard.js";
import type { DryRunArtifact } from "../deploy/dry-run.js";
import {
  GitHubPullRequestClientError
} from "../github/pull-request-client.js";
import {
  inspectGitHubPullRequestForMerge,
  mergeGitHubPullRequest,
  type GitHubPullRequestMergeClient,
  type GitHubPullRequestMergeInspection,
  type GitHubPullRequestMergeInspectionClient
} from "../github/pull-request-merge.js";
import { StateApplier } from "../state/state-applier.js";
import {
  prCandidateArtifactPath,
  readPrCandidateArtifact,
  type GitPrCandidateArtifact,
  type GitPrCandidateMergeAttempt,
  type GitPrCandidateMergeExecution,
  type GitPrMergeMethod
} from "./pr-artifact.js";
import {
  branchMatches,
  type PoliciesConfig
} from "./workspace-manager.js";

export type GitPrMergeOptions = {
  dryRun?: boolean;
  execute?: boolean;
  confirm?: string;
  followUpId?: string;
  repository?: string;
  method?: string;
  tokenEnv?: string;
};

export type GitPrMergeDeps = {
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  inspectionClient?: GitHubPullRequestMergeInspectionClient;
  mergeClient?: GitHubPullRequestMergeClient;
  now?: () => Date;
};

type MergeContext = {
  candidate: GitPrCandidateArtifact;
  repository: string;
  method: GitPrMergeMethod;
  approvalId: string;
  followUpId: string;
  dryRunArtifactPath: string;
  preflight: ExecutionGuardPreflight;
};

const githubTokenEnvNames = ["GH_TOKEN", "GITHUB_TOKEN"];
const defaultMergeMethods: GitPrMergeMethod[] = ["squash"];

export async function mergeGitPrCommand(
  projectRoot: string,
  candidateId: string,
  options: GitPrMergeOptions = {},
  deps: GitPrMergeDeps = {}
): Promise<string> {
  const candidate = await readPrCandidateArtifact(projectRoot, candidateId);
  if (options.execute === true && options.dryRun === true) {
    return formatBlocked(candidate, "conflicting_options");
  }
  if (candidate.live_execution === undefined) {
    return formatBlocked(candidate, "live_pull_request_required");
  }
  const repository = options.repository?.trim() || candidate.live_execution.repository;
  if (repository !== candidate.live_execution.repository) {
    return formatBlocked(candidate, "repository_mismatch");
  }
  const method = parseMergeMethod(options.method);
  if (method === undefined) {
    return formatBlocked(candidate, "merge_method_invalid");
  }
  if (options.execute === true && options.confirm !== candidate.transaction_id) {
    return formatBlocked(candidate, "confirmation_required");
  }

  const prepared = await prepareMergeContext(
    projectRoot,
    candidate,
    repository,
    method,
    options
  );
  if (typeof prepared === "string") {
    return prepared;
  }
  if (candidate.merge_execution?.status === "merged") {
    return sameMergeRequest(candidate.merge_execution, prepared)
      ? formatMerged(candidate, candidate.merge_execution, true)
      : formatBlocked(candidate, "merge_execution_request_mismatch");
  }

  const token = await resolveGitHubToken({
    env: deps.env ?? process.env,
    resolver: deps.resolver,
    tokenEnv: options.tokenEnv
  });
  if (token.status !== "present") {
    return formatSetupRequired(candidate, "missing_github_token");
  }

  const candidatePath = prCandidateArtifactPath(projectRoot, candidate.transaction_id);
  return withResourceLock(
    projectRoot,
    candidatePath,
    { owner: "git-pr-merge", ttlMs: 120_000 },
    async (lock) => {
      const current = await readPrCandidateArtifact(projectRoot, candidate.transaction_id);
      if (!sameCandidateRevision(candidate, current)) {
        return formatBlocked(current, "candidate_revision_drift");
      }
      if (current.merge_execution?.status === "merged") {
        return sameMergeRequest(current.merge_execution, prepared)
          ? formatMerged(current, current.merge_execution, true)
          : formatBlocked(current, "merge_execution_request_mismatch");
      }

      let inspection: GitHubPullRequestMergeInspection;
      try {
        inspection = await (deps.inspectionClient ?? inspectGitHubPullRequestForMerge)({
          repository,
          number: current.live_execution!.pull_request_number,
          token: token.value
        });
      } catch (error) {
        return formatClientFailure(current, error, "inspect");
      }

      const liveFailure = validateLiveInspection(current, inspection);
      if (liveFailure !== undefined) {
        return formatBlocked(current, liveFailure, inspection);
      }
      if (inspection.merged) {
        const execution = await persistMergeResult({
          projectRoot,
          candidate: current,
          candidatePath,
          lock,
          context: prepared,
          inspection,
          status: "merged",
          mergedSha: inspection.mergeCommitSha,
          reconciled: true,
          now: deps.now?.() ?? new Date()
        });
        return formatMerged(current, execution, true);
      }

      if (options.execute !== true) {
        return formatDryRun(current, prepared, inspection);
      }

      const startedAt = deps.now?.() ?? new Date();
      try {
        const result = await (deps.mergeClient ?? mergeGitHubPullRequest)({
          repository,
          number: inspection.number,
          expectedHeadSha: current.commit_sha!,
          method,
          token: token.value
        });
        if (!result.merged || result.sha === undefined) {
          const execution = await persistMergeResult({
            projectRoot,
            candidate: current,
            candidatePath,
            lock,
            context: prepared,
            inspection,
            status: "failed",
            errorCode: "merge_rejected",
            reconciled: false,
            startedAt,
            now: deps.now?.() ?? new Date()
          });
          return formatFailed(current, execution, "merge_rejected");
        }
        const execution = await persistMergeResult({
          projectRoot,
          candidate: current,
          candidatePath,
          lock,
          context: prepared,
          inspection,
          status: "merged",
          mergedSha: result.sha,
          reconciled: false,
          startedAt,
          now: deps.now?.() ?? new Date()
        });
        return formatMerged(current, execution, false);
      } catch (error) {
        const clientError = error instanceof GitHubPullRequestClientError ? error : undefined;
        const status = clientError?.kind === "network_error" ? "outcome_unknown" : "failed";
        const errorCode = clientError?.kind ?? "merge_client_error";
        const execution = await persistMergeResult({
          projectRoot,
          candidate: current,
          candidatePath,
          lock,
          context: prepared,
          inspection,
          status,
          errorCode,
          reconciled: false,
          startedAt,
          now: deps.now?.() ?? new Date()
        });
        return formatFailed(current, execution, errorCode);
      }
    }
  );
}

async function prepareMergeContext(
  projectRoot: string,
  candidate: GitPrCandidateArtifact,
  repository: string,
  method: GitPrMergeMethod,
  options: GitPrMergeOptions
): Promise<MergeContext | string> {
  if (candidate.status !== "ready_for_pr") {
    return formatBlocked(candidate, "candidate_status_not_ready");
  }
  if (candidate.commit_sha === undefined || candidate.base_sha === undefined) {
    return formatBlocked(candidate, "candidate_sha_missing");
  }
  const live = candidate.live_execution!;
  if (
    live.base_branch !== candidate.base_branch ||
    live.head_branch !== candidate.head_branch ||
    live.observed_base_sha !== candidate.base_sha ||
    live.expected_head_sha !== candidate.commit_sha ||
    live.observed_head_sha !== candidate.commit_sha
  ) {
    return formatBlocked(candidate, "live_execution_candidate_mismatch");
  }
  if (candidate.live_execution?.draft === true) {
    return formatBlocked(candidate, "draft_pull_request");
  }
  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  const allowedMethods = policies.git.allowed_merge_methods ?? defaultMergeMethods;
  if (!allowedMethods.includes(method)) {
    return formatBlocked(candidate, "merge_method_not_allowed");
  }
  if (!policies.git.require_approval_for.includes("merge")) {
    return formatBlocked(candidate, "merge_approval_policy_missing");
  }
  if (
    !policies.git.protected_branches.some((pattern) =>
      branchMatches(candidate.base_branch, pattern)
    )
  ) {
    return formatBlocked(candidate, "target_branch_not_protected");
  }
  if (options.followUpId === undefined) {
    return formatBlocked(candidate, "follow_up_required");
  }

  let followUp;
  try {
    followUp = await showApprovalFollowUp(projectRoot, options.followUpId);
  } catch (error) {
    if (error instanceof ApprovalFollowUpNotFoundError) {
      return formatBlocked(candidate, "follow_up_not_found");
    }
    throw error;
  }
  const authorization = authorizeGitPrMergeWithFollowUp(
    followUp,
    candidate.transaction_id
  );
  if (!authorization.ok) {
    return formatBlocked(candidate, authorization.reason);
  }

  let approval;
  try {
    approval = await new ApprovalQueue(projectRoot).show(authorization.approval_id);
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return formatBlocked(candidate, "approval_not_found");
    }
    throw error;
  }
  if (approval.status !== "decided" || approval.decision !== "approve") {
    return formatBlocked(candidate, "approval_not_approved");
  }
  const artifactRef = readString(approval.artifact_path);
  if (artifactRef === undefined) {
    return formatBlocked(candidate, "dry_run_artifact_missing");
  }
  const artifactPath = resolveInside(projectRoot, artifactRef);
  const artifact = await readJsonFile<DryRunArtifact>(artifactPath);
  const bindingFailure = validateDryRunBinding(
    artifact,
    candidate,
    authorization.approval_id
  );
  if (bindingFailure !== undefined) {
    return formatBlocked(candidate, bindingFailure);
  }
  const preflight = await buildExecutionPreflight(projectRoot, {
    operation: "merge",
    dryRunArtifact: artifactRef,
    mode: "preflight",
    approvalId: authorization.approval_id
  });
  if (preflight.status !== "passed") {
    return formatBlocked(candidate, "merge_preflight_failed");
  }
  return {
    candidate,
    repository,
    method,
    approvalId: authorization.approval_id,
    followUpId: authorization.follow_up_id,
    dryRunArtifactPath: artifactRef,
    preflight
  };
}

function validateDryRunBinding(
  artifact: DryRunArtifact,
  candidate: GitPrCandidateArtifact,
  approvalId: string
): string | undefined {
  if (artifact.operation !== "merge" || artifact.approval_id !== approvalId) {
    return "dry_run_artifact_mismatch";
  }
  if (artifact.candidate_id !== candidate.transaction_id) {
    return "dry_run_candidate_mismatch";
  }
  if (artifact.source_branch !== candidate.head_branch) {
    return "dry_run_source_mismatch";
  }
  if (artifact.target_branch !== candidate.base_branch) {
    return "dry_run_target_mismatch";
  }
  return undefined;
}

function validateLiveInspection(
  candidate: GitPrCandidateArtifact,
  inspection: GitHubPullRequestMergeInspection
): string | undefined {
  const live = candidate.live_execution!;
  if (inspection.repository !== live.repository) {
    return "repository_mismatch";
  }
  if (inspection.number !== live.pull_request_number) {
    return "pull_request_number_mismatch";
  }
  if (inspection.baseRef !== candidate.base_branch) {
    return "base_branch_mismatch";
  }
  if (inspection.headRef !== candidate.head_branch) {
    return "head_branch_mismatch";
  }
  if (inspection.headSha !== candidate.commit_sha) {
    return "head_sha_drift";
  }
  if (inspection.merged) {
    return inspection.mergeCommitSha === undefined ? "merged_sha_missing" : undefined;
  }
  if (inspection.state !== "open") {
    return "pull_request_not_open";
  }
  if (inspection.draft) {
    return "draft_pull_request";
  }
  if (inspection.baseSha !== candidate.base_sha) {
    return "base_sha_drift";
  }
  if (inspection.mergeable !== true || inspection.mergeableState !== "clean") {
    return inspection.mergeable === null ? "mergeability_unknown" : "merge_conflict";
  }
  if (inspection.requiredStatusChecks.length === 0) {
    return "required_status_checks_missing";
  }
  if (!inspection.requiredStatusChecksStrict) {
    return "strict_status_checks_required";
  }
  const checks = new Map(inspection.checks.map((check) => [check.context, check.status]));
  if (
    inspection.requiredStatusChecks.some((context) => checks.get(context) !== "success")
  ) {
    return "required_status_checks_not_successful";
  }
  if (inspection.requiredApprovingReviewCount < 1) {
    return "required_review_policy_missing";
  }
  if (inspection.approvalsOnHead < inspection.requiredApprovingReviewCount) {
    return "required_reviews_missing";
  }
  return undefined;
}

async function persistMergeResult(input: {
  projectRoot: string;
  candidate: GitPrCandidateArtifact;
  candidatePath: string;
  lock: Parameters<typeof writeJsonFileFenced>[0];
  context: MergeContext;
  inspection: GitHubPullRequestMergeInspection;
  status: GitPrCandidateMergeAttempt["status"];
  mergedSha?: string;
  errorCode?: string;
  reconciled: boolean;
  startedAt?: Date;
  now: Date;
}): Promise<GitPrCandidateMergeExecution> {
  const existing = input.candidate.merge_execution;
  const finishedAt = input.now.toISOString();
  const attempt: GitPrCandidateMergeAttempt = {
    attempt: (existing?.attempts ?? 0) + 1,
    status: input.status,
    method: input.context.method,
    pull_request_number: input.inspection.number,
    started_at: (input.startedAt ?? input.now).toISOString(),
    finished_at: finishedAt,
    observed_base_sha: input.inspection.baseSha,
    observed_head_sha: input.inspection.headSha,
    merged_sha: input.mergedSha,
    error_code: input.errorCode,
    reconciled: input.reconciled
  };
  const history = [...(existing?.history ?? []), attempt].slice(-20);
  const execution: GitPrCandidateMergeExecution = {
    status: input.status,
    repository: input.context.repository,
    pull_request_number: input.inspection.number,
    pull_request_url: input.inspection.url,
    method: input.context.method,
    approval_id: input.context.approvalId,
    follow_up_id: input.context.followUpId,
    expected_base_sha: input.candidate.base_sha,
    expected_head_sha: input.candidate.commit_sha!,
    observed_base_sha: input.inspection.baseSha,
    observed_head_sha: input.inspection.headSha,
    attempts: attempt.attempt,
    merged_sha: input.mergedSha,
    merged_at: input.status === "merged" ? finishedAt : undefined,
    reconciled: input.reconciled,
    last_error_code: input.errorCode,
    history,
    updated_at: finishedAt
  };
  input.candidate.merge_execution = execution;
  input.candidate.updated_at = finishedAt;
  await writeJsonFileFenced(input.lock, input.candidatePath, input.candidate);
  await new StateApplier(input.projectRoot).appendEvent({
    type:
      input.status === "merged"
        ? "git.pr.merge.completed"
        : "git.pr.merge.failed",
    task_id: input.candidate.task_id,
    run_id: input.candidate.run_id,
    actor: "git-pr-merge",
    payload: {
      candidate_id: input.candidate.transaction_id,
      repository: input.context.repository,
      pull_request_number: input.inspection.number,
      method: input.context.method,
      status: input.status,
      merged_sha: input.mergedSha,
      error_code: input.errorCode,
      reconciled: input.reconciled,
      attempt: attempt.attempt
    },
    created_at: finishedAt
  });
  return execution;
}

function sameCandidateRevision(
  expected: GitPrCandidateArtifact,
  actual: GitPrCandidateArtifact
): boolean {
  return (
    expected.transaction_id === actual.transaction_id &&
    expected.base_branch === actual.base_branch &&
    expected.base_sha === actual.base_sha &&
    expected.head_branch === actual.head_branch &&
    expected.commit_sha === actual.commit_sha &&
    expected.diff_sha256 === actual.diff_sha256 &&
    expected.live_execution?.pull_request_number ===
      actual.live_execution?.pull_request_number &&
    expected.live_execution?.repository === actual.live_execution?.repository
  );
}

function sameMergeRequest(
  execution: GitPrCandidateMergeExecution,
  context: MergeContext
): boolean {
  return (
    execution.repository === context.repository &&
    execution.method === context.method &&
    execution.approval_id === context.approvalId &&
    execution.follow_up_id === context.followUpId
  );
}

function parseMergeMethod(value: string | undefined): GitPrMergeMethod | undefined {
  const normalized = value?.trim().toLowerCase() ?? "squash";
  return normalized === "merge" || normalized === "squash" || normalized === "rebase"
    ? normalized
    : undefined;
}

async function resolveGitHubToken(input: {
  env: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  tokenEnv?: string;
}) {
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

function formatDryRun(
  candidate: GitPrCandidateArtifact,
  context: MergeContext,
  inspection: GitHubPullRequestMergeInspection
): string {
  return commonLines("Kairon git PR merge dry-run passed.", candidate, context, inspection)
    .concat([
      "mode=dry_run",
      "execution_performed=false",
      "preflight.status=passed",
      `required_status_checks=${inspection.requiredStatusChecks.join(",")}`,
      `strict_status_checks=${inspection.requiredStatusChecksStrict}`,
      `approvals_on_head=${inspection.approvalsOnHead}`,
      `required_approvals=${inspection.requiredApprovingReviewCount}`
    ])
    .join("\n");
}

function formatMerged(
  candidate: GitPrCandidateArtifact,
  execution: GitPrCandidateMergeExecution,
  idempotent: boolean
): string {
  return [
    "Kairon git PR merged.",
    `candidate_id=${candidate.transaction_id}`,
    `repository=${execution.repository}`,
    `pull_request_number=${execution.pull_request_number}`,
    `method=${execution.method}`,
    `merged_sha=${execution.merged_sha}`,
    `reconciled=${execution.reconciled}`,
    `idempotent=${idempotent}`,
    `attempts=${execution.attempts}`,
    `artifact=${candidate.artifact_path}`
  ].join("\n");
}

function formatBlocked(
  candidate: GitPrCandidateArtifact,
  reason: string,
  inspection?: GitHubPullRequestMergeInspection
): string {
  return [
    "Kairon git PR merge blocked.",
    `candidate_id=${candidate.transaction_id}`,
    `reason=${reason}`,
    ...(inspection === undefined
      ? []
      : [
          `pull_request_number=${inspection.number}`,
          `observed_base_sha=${inspection.baseSha}`,
          `observed_head_sha=${inspection.headSha}`
        ]),
    "execution_performed=false"
  ].join("\n");
}

function formatSetupRequired(
  candidate: GitPrCandidateArtifact,
  reason: string,
  httpStatus?: number
): string {
  return [
    "Kairon git PR merge setup required.",
    `candidate_id=${candidate.transaction_id}`,
    `reason=${reason}`,
    ...(httpStatus === undefined ? [] : [`http_status=${httpStatus}`]),
    "execution_performed=false"
  ].join("\n");
}

function formatClientFailure(
  candidate: GitPrCandidateArtifact,
  error: unknown,
  phase: "inspect" | "merge"
): string {
  if (error instanceof GitHubPullRequestClientError) {
    if (["auth_error", "permission_error", "not_found"].includes(error.kind)) {
      return formatSetupRequired(
        candidate,
        `github_${phase}_${error.kind}`,
        error.httpStatus
      );
    }
    return [
      "Kairon git PR merge failed.",
      `candidate_id=${candidate.transaction_id}`,
      `reason=github_${phase}_${error.kind}`,
      ...(error.httpStatus === undefined ? [] : [`http_status=${error.httpStatus}`]),
      "execution_performed=false"
    ].join("\n");
  }
  return [
    "Kairon git PR merge failed.",
    `candidate_id=${candidate.transaction_id}`,
    `reason=${phase}_client_error`,
    "execution_performed=false"
  ].join("\n");
}

function formatFailed(
  candidate: GitPrCandidateArtifact,
  execution: GitPrCandidateMergeExecution,
  reason: string
): string {
  return [
    "Kairon git PR merge failed.",
    `candidate_id=${candidate.transaction_id}`,
    `reason=${reason}`,
    `status=${execution.status}`,
    `attempts=${execution.attempts}`,
    "execution_performed=true",
    `artifact=${candidate.artifact_path}`
  ].join("\n");
}

function commonLines(
  header: string,
  candidate: GitPrCandidateArtifact,
  context: MergeContext,
  inspection: GitHubPullRequestMergeInspection
): string[] {
  return [
    header,
    `candidate_id=${candidate.transaction_id}`,
    `repository=${context.repository}`,
    `pull_request_number=${inspection.number}`,
    `base=${inspection.baseRef}`,
    `head=${inspection.headRef}`,
    `base_sha=${inspection.baseSha}`,
    `head_sha=${inspection.headSha}`,
    `method=${context.method}`,
    `approval_id=${context.approvalId}`,
    `follow_up_id=${context.followUpId}`,
    `dry_run_artifact=${context.dryRunArtifactPath}`
  ];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
