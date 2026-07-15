export type GitHubPullRequestCreateRequest = {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  token: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
};

export type GitHubPullRequestCreateResult = {
  url: string;
  number: number;
  state?: string;
};

export type GitHubPullRequestRefRequest = {
  repository: string;
  base: string;
  head: string;
  token: string;
};

export type GitHubPullRequestRefResult = {
  baseSha: string;
  headSha: string;
};

export type GitHubPullRequestClientErrorKind =
  | "auth_error"
  | "permission_error"
  | "not_found"
  | "validation_error"
  | "api_error"
  | "network_error"
  | "invalid_response";

export class GitHubPullRequestClientError extends Error {
  constructor(
    readonly kind: GitHubPullRequestClientErrorKind,
    readonly operation:
      | "inspect_refs"
      | "create_pull_request"
      | "inspect_merge"
      | "merge_pull_request",
    readonly httpStatus?: number
  ) {
    super(
      `GitHub pull request ${operation} failed: kind=${kind}${
        httpStatus === undefined ? "" : ` http_status=${httpStatus}`
      }`
    );
    this.name = "GitHubPullRequestClientError";
  }
}

export type GitHubPullRequestClient = (
  request: GitHubPullRequestCreateRequest
) => Promise<GitHubPullRequestCreateResult>;

export type GitHubPullRequestRefClient = (
  request: GitHubPullRequestRefRequest
) => Promise<GitHubPullRequestRefResult>;

export async function inspectGitHubPullRequestRefs(
  request: GitHubPullRequestRefRequest
): Promise<GitHubPullRequestRefResult> {
  const repository = parseRepository(request.repository);
  const [baseSha, headSha] = await Promise.all([
    fetchGitHubBranchRef(repository, request.base, request.token),
    fetchGitHubBranchRef(repository, request.head, request.token)
  ]);
  return { baseSha, headSha };
}

export async function createGitHubPullRequest(
  request: GitHubPullRequestCreateRequest
): Promise<GitHubPullRequestCreateResult> {
  assertFetchAvailable("create_pull_request");

  const repository = parseRepository(request.repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(
    repository.owner
  )}/${encodeURIComponent(repository.repo)}/pulls`;
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers: githubHeaders(request.token),
      body: JSON.stringify({
        title: request.title,
        body: request.body,
        base: request.base,
        head: request.head,
        draft: request.draft === true,
        maintainer_can_modify: request.maintainerCanModify ?? true
      })
    });
  } catch {
    throw new GitHubPullRequestClientError(
      "network_error",
      "create_pull_request"
    );
  }

  if (!response.ok) {
    throw classifyGitHubError("create_pull_request", response.status);
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  const htmlUrl = typeof parsed.html_url === "string" ? parsed.html_url : undefined;
  const number = typeof parsed.number === "number" ? parsed.number : undefined;
  if (htmlUrl === undefined || number === undefined) {
    throw new GitHubPullRequestClientError(
      "invalid_response",
      "create_pull_request"
    );
  }

  return {
    url: htmlUrl,
    number,
    state: typeof parsed.state === "string" ? parsed.state : undefined
  };
}

async function fetchGitHubBranchRef(
  repository: { owner: string; repo: string },
  branch: string,
  token: string
): Promise<string> {
  assertFetchAvailable("inspect_refs");
  const encodedBranch = branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(
    repository.owner
  )}/${encodeURIComponent(repository.repo)}/git/ref/heads/${encodedBranch}`;

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      headers: githubHeaders(token, false)
    });
  } catch {
    throw new GitHubPullRequestClientError("network_error", "inspect_refs");
  }

  if (!response.ok) {
    throw classifyGitHubError("inspect_refs", response.status);
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  const object = parsed.object;
  const sha =
    object !== null && typeof object === "object"
      ? (object as Record<string, unknown>).sha
      : undefined;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new GitHubPullRequestClientError("invalid_response", "inspect_refs");
  }
  return sha;
}

function githubHeaders(token: string, includeContentType = true): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "kairon-git-pr",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function assertFetchAvailable(
  operation: GitHubPullRequestClientError["operation"]
): void {
  if (typeof globalThis.fetch !== "function") {
    throw new GitHubPullRequestClientError("network_error", operation);
  }
}

function classifyGitHubError(
  operation: GitHubPullRequestClientError["operation"],
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

function parseRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = repository.split("/");
  if (
    owner === undefined ||
    owner.trim().length === 0 ||
    repo === undefined ||
    repo.trim().length === 0 ||
    extra.length > 0
  ) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }

  return { owner, repo };
}
