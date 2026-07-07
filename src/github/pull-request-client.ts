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

export type GitHubPullRequestClient = (
  request: GitHubPullRequestCreateRequest
) => Promise<GitHubPullRequestCreateResult>;

export async function createGitHubPullRequest(
  request: GitHubPullRequestCreateRequest
): Promise<GitHubPullRequestCreateResult> {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("GitHub pull request API is unavailable: fetch is missing.");
  }

  const repository = parseRepository(request.repository);
  const url = `https://api.github.com/repos/${encodeURIComponent(
    repository.owner
  )}/${encodeURIComponent(repository.repo)}/pulls`;
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${request.token}`,
      "Content-Type": "application/json",
      "User-Agent": "kairon-git-pr",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      title: request.title,
      body: request.body,
      base: request.base,
      head: request.head,
      draft: request.draft === true,
      maintainer_can_modify: request.maintainerCanModify ?? true
    })
  });

  if (!response.ok) {
    throw new Error(
      `GitHub pull request create failed: http_status=${response.status}`
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  const htmlUrl = typeof parsed.html_url === "string" ? parsed.html_url : undefined;
  const number = typeof parsed.number === "number" ? parsed.number : undefined;
  if (htmlUrl === undefined || number === undefined) {
    throw new Error("GitHub pull request create failed: invalid response");
  }

  return {
    url: htmlUrl,
    number,
    state: typeof parsed.state === "string" ? parsed.state : undefined
  };
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
