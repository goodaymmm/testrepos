import {
  GitHubPullRequestClientError,
  type GitHubPullRequestClientErrorKind
} from "./pull-request-client.js";

export type GitHubPullRequestMergeMethod = "merge" | "squash" | "rebase";

export type GitHubPullRequestCheck = {
  context: string;
  status: "success" | "pending" | "failure";
};

export type GitHubPullRequestMergeInspectionRequest = {
  repository: string;
  number: number;
  token: string;
};

export type GitHubPullRequestMergeInspection = {
  repository: string;
  number: number;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState?: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  mergeCommitSha?: string;
  requiredStatusChecks: string[];
  requiredStatusChecksStrict: boolean;
  checks: GitHubPullRequestCheck[];
  requiredReviewPolicyPresent: boolean;
  requiredApprovingReviewCount: number;
  approvalsOnHead: number;
};

export type GitHubPullRequestMergeRequest = {
  repository: string;
  number: number;
  expectedHeadSha: string;
  method: GitHubPullRequestMergeMethod;
  token: string;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  sha?: string;
};

export type GitHubPullRequestMergeInspectionClient = (
  request: GitHubPullRequestMergeInspectionRequest
) => Promise<GitHubPullRequestMergeInspection>;

export type GitHubPullRequestMergeClient = (
  request: GitHubPullRequestMergeRequest
) => Promise<GitHubPullRequestMergeResult>;

type GitHubOperation = GitHubPullRequestClientError["operation"];

export async function inspectGitHubPullRequestForMerge(
  request: GitHubPullRequestMergeInspectionRequest
): Promise<GitHubPullRequestMergeInspection> {
  const repository = parseRepository(request.repository);
  const prefix = repositoryApiPrefix(repository);
  const pull = await fetchJsonRecord(
    `${prefix}/pulls/${request.number}`,
    request.token,
    "inspect_merge"
  );
  const base = readNestedRecord(pull, "base");
  const head = readNestedRecord(pull, "head");
  const baseRef = readRequiredString(base, "ref", "inspect_merge");
  const baseSha = readRequiredString(base, "sha", "inspect_merge");
  const headRef = readRequiredString(head, "ref", "inspect_merge");
  const headSha = readRequiredString(head, "sha", "inspect_merge");

  const [protection, reviews, status, checkRuns] = await Promise.all([
    fetchJsonRecord(
      `${prefix}/branches/${encodeURIComponent(baseRef)}/protection`,
      request.token,
      "inspect_merge"
    ),
    fetchJsonArray(
      `${prefix}/pulls/${request.number}/reviews?per_page=100`,
      request.token,
      "inspect_merge"
    ),
    fetchJsonRecord(
      `${prefix}/commits/${encodeURIComponent(headSha)}/status`,
      request.token,
      "inspect_merge"
    ),
    fetchJsonRecord(
      `${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
      request.token,
      "inspect_merge"
    )
  ]);

  const requiredStatusChecks = readRequiredStatusChecks(protection);
  const requiredStatusChecksStrict = readRequiredStatusChecksStrict(protection);
  const requiredApprovingReviewCount = readRequiredApprovals(protection);
  return {
    repository: request.repository,
    number: readRequiredNumber(pull, "number", "inspect_merge"),
    url: readRequiredString(pull, "html_url", "inspect_merge"),
    state: readRequiredString(pull, "state", "inspect_merge"),
    draft: readRequiredBoolean(pull, "draft", "inspect_merge"),
    merged: readRequiredBoolean(pull, "merged", "inspect_merge"),
    mergeable: readNullableBoolean(pull.mergeable, "inspect_merge"),
    mergeableState: readOptionalString(pull.mergeable_state),
    baseRef,
    baseSha,
    headRef,
    headSha,
    mergeCommitSha: readOptionalString(pull.merge_commit_sha),
    requiredStatusChecks,
    requiredStatusChecksStrict,
    checks: readChecks(status, checkRuns, headSha),
    requiredReviewPolicyPresent: hasRequiredReviewPolicy(protection),
    requiredApprovingReviewCount,
    approvalsOnHead: countApprovalsOnHead(reviews, headSha)
  };
}

export async function mergeGitHubPullRequest(
  request: GitHubPullRequestMergeRequest
): Promise<GitHubPullRequestMergeResult> {
  const repository = parseRepository(request.repository);
  const response = await fetchJsonRecord(
    `${repositoryApiPrefix(repository)}/pulls/${request.number}/merge`,
    request.token,
    "merge_pull_request",
    {
      method: "PUT",
      body: JSON.stringify({
        sha: request.expectedHeadSha,
        merge_method: request.method
      })
    }
  );
  const merged = readRequiredBoolean(response, "merged", "merge_pull_request");
  const sha = readOptionalString(response.sha);
  if (merged && sha === undefined) {
    throw new GitHubPullRequestClientError(
      "invalid_response",
      "merge_pull_request"
    );
  }
  return {
    merged,
    sha
  };
}

async function fetchJsonRecord(
  url: string,
  token: string,
  operation: GitHubOperation,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const parsed = await fetchJson(url, token, operation, init);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
  return parsed as Record<string, unknown>;
}

async function fetchJsonArray(
  url: string,
  token: string,
  operation: GitHubOperation
): Promise<unknown[]> {
  const parsed = await fetchJson(url, token, operation);
  if (!Array.isArray(parsed)) {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
  return parsed;
}

async function fetchJson(
  url: string,
  token: string,
  operation: GitHubOperation,
  init: RequestInit = {}
): Promise<unknown> {
  if (typeof globalThis.fetch !== "function") {
    throw new GitHubPullRequestClientError("network_error", operation);
  }
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "kairon-git-pr-merge",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
  } catch {
    throw new GitHubPullRequestClientError("network_error", operation);
  }
  if (!response.ok) {
    throw classifyGitHubError(operation, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
}

function readRequiredStatusChecks(protection: Record<string, unknown>): string[] {
  const required = protection.required_status_checks;
  if (required === null || typeof required !== "object" || Array.isArray(required)) {
    return [];
  }
  const record = required as Record<string, unknown>;
  const contexts = Array.isArray(record.contexts) ? record.contexts : [];
  const checks = Array.isArray(record.checks) ? record.checks : [];
  return [
    ...contexts.map(readOptionalString),
    ...checks.map((check) =>
      check !== null && typeof check === "object" && !Array.isArray(check)
        ? readOptionalString((check as Record<string, unknown>).context)
        : undefined
    )
  ]
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function readRequiredStatusChecksStrict(protection: Record<string, unknown>): boolean {
  const required = protection.required_status_checks;
  if (required === null || typeof required !== "object" || Array.isArray(required)) {
    return false;
  }
  return (required as Record<string, unknown>).strict === true;
}

function readRequiredApprovals(protection: Record<string, unknown>): number {
  const reviews = protection.required_pull_request_reviews;
  if (reviews === null || typeof reviews !== "object" || Array.isArray(reviews)) {
    return 0;
  }
  const value = (reviews as Record<string, unknown>).required_approving_review_count;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function hasRequiredReviewPolicy(protection: Record<string, unknown>): boolean {
  const reviews = protection.required_pull_request_reviews;
  return reviews !== null && typeof reviews === "object" && !Array.isArray(reviews);
}

function readChecks(
  status: Record<string, unknown>,
  checkRuns: Record<string, unknown>,
  headSha: string
): GitHubPullRequestCheck[] {
  const checks = new Map<string, GitHubPullRequestCheck["status"]>();
  for (const item of Array.isArray(status.statuses) ? status.statuses : []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const context = readOptionalString(record.context);
    const state = readOptionalString(record.state)?.toLowerCase();
    if (context !== undefined) {
      mergeCheckStatus(
        checks,
        context,
        state === "success" ? "success" : state === "pending" ? "pending" : "failure"
      );
    }
  }
  for (const item of Array.isArray(checkRuns.check_runs) ? checkRuns.check_runs : []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (readOptionalString(record.head_sha) !== headSha) {
      continue;
    }
    const context = readOptionalString(record.name);
    const runStatus = readOptionalString(record.status)?.toLowerCase();
    const conclusion = readOptionalString(record.conclusion)?.toLowerCase();
    if (context !== undefined) {
      const successful = ["success", "neutral", "skipped"].includes(conclusion ?? "");
      mergeCheckStatus(
        checks,
        context,
        runStatus !== "completed" ? "pending" : successful ? "success" : "failure"
      );
    }
  }
  return [...checks.entries()]
    .map(([context, checkStatus]) => ({ context, status: checkStatus }))
    .sort((left, right) => left.context.localeCompare(right.context));
}

function mergeCheckStatus(
  checks: Map<string, GitHubPullRequestCheck["status"]>,
  context: string,
  status: GitHubPullRequestCheck["status"]
): void {
  const priority = { success: 0, pending: 1, failure: 2 } as const;
  const current = checks.get(context);
  if (current === undefined || priority[status] > priority[current]) {
    checks.set(context, status);
  }
}

function countApprovalsOnHead(reviews: unknown[], headSha: string): number {
  const latestByUser = new Map<string, { state?: string; commitId?: string }>();
  for (const item of reviews) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const user = record.user;
    const login =
      user !== null && typeof user === "object" && !Array.isArray(user)
        ? readOptionalString((user as Record<string, unknown>).login)
        : undefined;
    const state = readOptionalString(record.state)?.toUpperCase();
    if (
      login !== undefined &&
      state !== undefined &&
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)
    ) {
      latestByUser.set(login, {
        state,
        commitId: readOptionalString(record.commit_id)
      });
    }
  }
  return [...latestByUser.values()].filter(
    (review) => review.state === "APPROVED" && review.commitId === headSha
  ).length;
}

function repositoryApiPrefix(repository: { owner: string; repo: string }): string {
  return `https://api.github.com/repos/${encodeURIComponent(
    repository.owner
  )}/${encodeURIComponent(repository.repo)}`;
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = repository.trim().split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

function readNestedRecord(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const nested = value[key];
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    throw new GitHubPullRequestClientError("invalid_response", "inspect_merge");
  }
  return nested as Record<string, unknown>;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  operation: GitHubOperation
): string {
  const parsed = readOptionalString(value[key]);
  if (parsed === undefined) {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
  return parsed;
}

function readRequiredNumber(
  value: Record<string, unknown>,
  key: string,
  operation: GitHubOperation
): number {
  const parsed = value[key];
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
  return parsed;
}

function readRequiredBoolean(
  value: Record<string, unknown>,
  key: string,
  operation: GitHubOperation
): boolean {
  const parsed = value[key];
  if (typeof parsed !== "boolean") {
    throw new GitHubPullRequestClientError("invalid_response", operation);
  }
  return parsed;
}

function readNullableBoolean(value: unknown, operation: GitHubOperation): boolean | null {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new GitHubPullRequestClientError("invalid_response", operation);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function classifyGitHubError(
  operation: GitHubOperation,
  httpStatus: number
): GitHubPullRequestClientError {
  const kind: GitHubPullRequestClientErrorKind =
    httpStatus === 401
      ? "auth_error"
      : httpStatus === 403
        ? "permission_error"
        : httpStatus === 404
          ? "not_found"
          : httpStatus === 422
            ? "validation_error"
            : "api_error";
  return new GitHubPullRequestClientError(kind, operation, httpStatus);
}
