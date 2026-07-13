import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubPullRequest,
  GitHubPullRequestClientError,
  inspectGitHubPullRequestRefs
} from "../src/github/pull-request-client.js";

describe("GitHub pull request client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inspects encoded base and head refs without returning the token", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
    const fetchMock = vi.fn(async () =>
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
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
