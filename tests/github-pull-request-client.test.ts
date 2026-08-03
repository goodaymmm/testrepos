import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubPullRequest,
  GitHubPullRequestClientError,
  inspectGitHubPullRequestRefs
} from "../src/github/pull-request-client.js";
import {
  inspectGitHubPullRequestForMerge,
  mergeGitHubPullRequest
} from "../src/github/pull-request-merge.js";

type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

describe("GitHub pull request client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inspects encoded base and head refs without returning the token", async () => {
    const fetchMock = vi.fn<FetchFunction>(async (input) => {
      const url = String(input);
      const sha = url.endsWith("/heads/main") ? "base-sha" : "head-sha";
      return jsonResponse(200, { object: { sha } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectGitHubPullRequestRefs({
      repository: "goodaymmm/Kairon",
      base: "main",
      head: "codex/t134-live-pr",
      token: "secret-token"
    });

    expect(result).toEqual({ baseSha: "base-sha", headSha: "head-sha" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/git/ref/heads/codex/t134-live-pr"
    );
    const requestOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestOptions.headers).toMatchObject({
      Authorization: "Bearer secret-token"
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("creates a pull request with the shared GitHub request contract", async () => {
    const fetchMock = vi.fn<FetchFunction>(async () =>
      jsonResponse(201, {
        html_url: "https://github.com/goodaymmm/Kairon/pull/134",
        number: 134,
        state: "open"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGitHubPullRequest({
      repository: "goodaymmm/Kairon",
      base: "main",
      head: "codex/t134-live-pr",
      title: "T134 live PR",
      body: "## 目的\n- live PRを確認する",
      token: "secret-token"
    });

    expect(result).toEqual({
      url: "https://github.com/goodaymmm/Kairon/pull/134",
      number: 134,
      state: "open"
    });
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      base: "main",
      head: "codex/t134-live-pr",
      draft: false,
      maintainer_can_modify: true
    });
  });

  it.each([
    [401, "auth_error"],
    [403, "permission_error"],
    [404, "not_found"],
    [422, "validation_error"],
    [500, "api_error"]
  ] as const)("classifies HTTP %s without exposing response or token values", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, {
      message: "secret-token must not be surfaced"
    })));

    const error = await createGitHubPullRequest({
      repository: "goodaymmm/Kairon",
      base: "main",
      head: "codex/t134-live-pr",
      title: "T134 live PR",
      body: "body",
      token: "secret-token"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubPullRequestClientError);
    expect(error).toMatchObject({ kind, httpStatus: status });
    expect(String(error)).not.toContain("secret-token");
  });

  it("normalizes live PR, protection, check, and review evidence for merge", async () => {
    const fetchMock = vi.fn<FetchFunction>(async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/149")) {
        return jsonResponse(200, {
          number: 149,
          html_url: "https://github.com/goodaymmm/Kairon/pull/149",
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          base: { ref: "main", sha: "base-sha" },
          head: { ref: "codex/t149", sha: "head-sha" }
        });
      }
      if (url.includes("/branches/main/protection")) {
        return jsonResponse(200, {
          required_status_checks: {
            strict: true,
            contexts: ["build"],
            checks: [{ context: "test" }]
          },
          required_pull_request_reviews: {
            required_approving_review_count: 1
          }
        });
      }
      if (url.includes("/reviews")) {
        return jsonResponse(200, [
          {
            user: { login: "reviewer" },
            state: "APPROVED",
            commit_id: "head-sha"
          }
        ]);
      }
      if (url.endsWith("/status")) {
        return jsonResponse(200, {
          statuses: [{ context: "build", state: "success" }]
        });
      }
      return jsonResponse(200, {
        check_runs: [
          {
            name: "test",
            head_sha: "head-sha",
            status: "completed",
            conclusion: "success"
          }
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectGitHubPullRequestForMerge({
      repository: "goodaymmm/Kairon",
      number: 149,
      token: "secret-token"
    });

    expect(result).toMatchObject({
      number: 149,
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      baseRef: "main",
      baseSha: "base-sha",
      headRef: "codex/t149",
      headSha: "head-sha",
      requiredStatusChecks: ["build", "test"],
      requiredStatusChecksStrict: true,
      requiredReviewPolicyPresent: true,
      requiredApprovingReviewCount: 1,
      approvalsOnHead: 1
    });
    expect(result.checks).toEqual([
      { context: "build", status: "success" },
      { context: "test", status: "success" }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("merges with the expected head SHA and selected method", async () => {
    const fetchMock = vi.fn<FetchFunction>(async () =>
      jsonResponse(200, { merged: true, sha: "merged-sha" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await mergeGitHubPullRequest({
      repository: "goodaymmm/Kairon",
      number: 149,
      expectedHeadSha: "head-sha",
      method: "squash",
      token: "secret-token"
    });

    expect(result).toEqual({ merged: true, sha: "merged-sha" });
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.method).toBe("PUT");
    expect(JSON.parse(String(options.body))).toEqual({
      sha: "head-sha",
      merge_method: "squash"
    });
  });
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
