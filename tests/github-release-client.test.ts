import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDraftGitHubRelease,
  createGitHubReleaseTag,
  downloadGitHubReleaseAsset,
  GitHubReleaseClientError,
  inspectGitHubRelease,
  listGitHubReleases,
  promoteGitHubRelease,
  publishGitHubRelease,
  uploadGitHubReleaseAsset
} from "../src/github/release-client.js";

const sha = "a".repeat(40);

describe("GitHub release client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists normalized releases for update discovery", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => jsonResponse(200, [
      releaseResponse({ draft: false })
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGitHubReleases({
      repository: "goodaymmm/Kairon",
      token: "secret-token"
    })).resolves.toMatchObject([{
      id: 162,
      tag_name: "v0.2.0",
      prerelease: true
    }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/releases?per_page=100");
  });

  it("normalizes branch, tag, release, and asset fields without returning the token", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/heads/main")) {
        return jsonResponse(200, { object: { type: "commit", sha } });
      }
      if (url.includes("/git/ref/tags/")) {
        return jsonResponse(200, { object: { type: "commit", sha } });
      }
      return jsonResponse(200, releaseResponse({ draft: false }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await inspectGitHubRelease({
      repository: "goodaymmm/Kairon",
      branch: "main",
      tag: "v0.2.0",
      token: "secret-token"
    });

    expect(result).toMatchObject({
      branch_sha: sha,
      tag: { name: "v0.2.0", sha, object_type: "commit" },
      release: {
        id: 162,
        tag_name: "v0.2.0",
        draft: false,
        prerelease: true,
        assets: [{ id: 1, name: "kairon-0.2.0.tgz", size_bytes: 12 }]
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats absent tags and releases as an empty remote state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/heads/main")
        ? jsonResponse(200, { object: { type: "commit", sha } })
        : jsonResponse(404, { message: "not found" })
    ));

    await expect(inspectGitHubRelease({
      repository: "goodaymmm/Kairon",
      branch: "main",
      tag: "v0.2.0",
      token: "secret-token"
    })).resolves.toMatchObject({ tag: null, release: null });
  });

  it("uses safe REST contracts for tag, draft release, upload, download, and publish", async () => {
    const content = new TextEncoder().encode("package-bytes");
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.endsWith("/git/refs")) {
        return jsonResponse(201, { object: { type: "commit", sha } });
      }
      if (url.includes("uploads.github.com")) {
        return jsonResponse(201, assetResponse());
      }
      if (url.includes("/releases/assets/1")) {
        return new Response(content, { status: 200 });
      }
      if (init?.method === "PATCH") {
        return jsonResponse(200, releaseResponse({ draft: false }));
      }
      return jsonResponse(201, releaseResponse({ draft: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubReleaseTag({
      repository: "goodaymmm/Kairon",
      tag: "v0.2.0",
      sha,
      token: "secret-token"
    });
    await createDraftGitHubRelease({
      repository: "goodaymmm/Kairon",
      tag: "v0.2.0",
      targetCommitish: sha,
      name: "Kairon 0.2.0 Local Beta",
      body: "safe body",
      prerelease: true,
      token: "secret-token"
    });
    await uploadGitHubReleaseAsset({
      repository: "goodaymmm/Kairon",
      releaseId: 162,
      name: "kairon-0.2.0.tgz",
      content,
      contentType: "application/gzip",
      token: "secret-token"
    });
    await expect(downloadGitHubReleaseAsset({
      repository: "goodaymmm/Kairon",
      assetId: 1,
      token: "secret-token"
    })).resolves.toEqual(content);
    await publishGitHubRelease({
      repository: "goodaymmm/Kairon",
      releaseId: 162,
      name: "Kairon 0.2.0 Local Beta",
      prerelease: true,
      token: "secret-token"
    });
    await promoteGitHubRelease({
      repository: "goodaymmm/Kairon",
      releaseId: 162,
      name: "Kairon 0.2.0",
      token: "secret-token"
    });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      init
    }));
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      ref: "refs/tags/v0.2.0",
      sha
    });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      draft: true,
      prerelease: true,
      target_commitish: sha
    });
    expect(calls[2].url).toContain("?name=kairon-0.2.0.tgz");
    expect(calls[2].init?.headers).toMatchObject({
      "Content-Type": "application/gzip"
    });
    expect(calls[3].init?.headers).toMatchObject({
      Accept: "application/octet-stream"
    });
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({
      name: "Kairon 0.2.0",
      draft: false,
      prerelease: false
    });
    expect(JSON.stringify(calls.map((call) => call.url))).not.toContain("secret-token");
  });

  it.each([
    [401, {}, "auth_error"],
    [403, {}, "permission_error"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [404, {}, "not_found"],
    [409, {}, "conflict"],
    [422, {}, "validation_error"],
    [500, {}, "api_error"]
  ] as const)("classifies HTTP %s without exposing raw response data", async (status, headers, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, {
      token: "secret-token",
      message: "sensitive response"
    }, headers)));

    const error = await createGitHubReleaseTag({
      repository: "goodaymmm/Kairon",
      tag: "v0.2.0",
      sha,
      token: "secret-token"
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubReleaseClientError);
    expect(error).toMatchObject({ kind, httpStatus: status });
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("sensitive response");
  });
});

function releaseResponse(input: { draft: boolean }): Record<string, unknown> {
  return {
    id: 162,
    tag_name: "v0.2.0",
    name: "Kairon 0.2.0 Local Beta",
    draft: input.draft,
    prerelease: true,
    html_url: "https://github.com/goodaymmm/Kairon/releases/tag/v0.2.0",
    assets: [assetResponse()]
  };
}

function assetResponse(): Record<string, unknown> {
  return {
    id: 1,
    name: "kairon-0.2.0.tgz",
    size: 12,
    state: "uploaded",
    digest: `sha256:${"b".repeat(64)}`
  };
}

function jsonResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
