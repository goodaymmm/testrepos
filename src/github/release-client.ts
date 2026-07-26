export type GitHubReleaseClientErrorKind =
  | "auth_error"
  | "permission_error"
  | "not_found"
  | "conflict"
  | "validation_error"
  | "rate_limited"
  | "api_error"
  | "network_error"
  | "invalid_response";

export type GitHubReleaseOperation =
  | "list_releases"
  | "inspect_branch"
  | "inspect_tag"
  | "inspect_release"
  | "create_tag"
  | "create_release"
  | "upload_asset"
  | "download_asset"
  | "publish_release"
  | "promote_release";

export class GitHubReleaseClientError extends Error {
  constructor(
    readonly kind: GitHubReleaseClientErrorKind,
    readonly operation: GitHubReleaseOperation,
    readonly httpStatus?: number
  ) {
    super(
      `GitHub release ${operation} failed: kind=${kind}${
        httpStatus === undefined ? "" : ` http_status=${httpStatus}`
      }`
    );
    this.name = "GitHubReleaseClientError";
  }
}

export type GitHubReleaseTag = {
  name: string;
  sha: string;
  object_type: "commit";
};

export type GitHubReleaseAsset = {
  id: number;
  name: string;
  size_bytes: number;
  state: string;
  digest?: string;
};

export type GitHubReleaseRecord = {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: GitHubReleaseAsset[];
};

export type GitHubReleaseInspection = {
  repository: string;
  branch: string;
  branch_sha: string;
  tag: GitHubReleaseTag | null;
  release: GitHubReleaseRecord | null;
};

export type InspectGitHubReleaseRequest = {
  repository: string;
  branch: string;
  tag: string;
  token: string;
};

export type ListGitHubReleasesRequest = {
  repository: string;
  token: string;
  perPage?: number;
};

export type CreateGitHubReleaseTagRequest = {
  repository: string;
  tag: string;
  sha: string;
  token: string;
};

export type CreateGitHubReleaseRequest = {
  repository: string;
  tag: string;
  targetCommitish: string;
  name: string;
  body: string;
  prerelease: boolean;
  token: string;
};

export type UploadGitHubReleaseAssetRequest = {
  repository: string;
  releaseId: number;
  name: string;
  content: Uint8Array;
  contentType: string;
  token: string;
};

export type DownloadGitHubReleaseAssetRequest = {
  repository: string;
  assetId: number;
  token: string;
};

export type PublishGitHubReleaseRequest = {
  repository: string;
  releaseId: number;
  name: string;
  prerelease: boolean;
  token: string;
};

export type PromoteGitHubReleaseRequest = {
  repository: string;
  releaseId: number;
  name: string;
  token: string;
};

export type GitHubReleaseClient = {
  listReleases(request: ListGitHubReleasesRequest): Promise<GitHubReleaseRecord[]>;
  inspect(request: InspectGitHubReleaseRequest): Promise<GitHubReleaseInspection>;
  createTag(request: CreateGitHubReleaseTagRequest): Promise<GitHubReleaseTag>;
  createDraftRelease(request: CreateGitHubReleaseRequest): Promise<GitHubReleaseRecord>;
  uploadAsset(request: UploadGitHubReleaseAssetRequest): Promise<GitHubReleaseAsset>;
  downloadAsset(request: DownloadGitHubReleaseAssetRequest): Promise<Uint8Array>;
  publishRelease(request: PublishGitHubReleaseRequest): Promise<GitHubReleaseRecord>;
  promoteRelease(request: PromoteGitHubReleaseRequest): Promise<GitHubReleaseRecord>;
};

export const defaultGitHubReleaseClient: GitHubReleaseClient = {
  listReleases: listGitHubReleases,
  inspect: inspectGitHubRelease,
  createTag: createGitHubReleaseTag,
  createDraftRelease: createDraftGitHubRelease,
  uploadAsset: uploadGitHubReleaseAsset,
  downloadAsset: downloadGitHubReleaseAsset,
  publishRelease: publishGitHubRelease,
  promoteRelease: promoteGitHubRelease
};

export async function listGitHubReleases(
  request: ListGitHubReleasesRequest
): Promise<GitHubReleaseRecord[]> {
  const repository = parseRepository(request.repository);
  const perPage = request.perPage ?? 100;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Error("GitHub release perPage must be an integer from 1 to 100.");
  }
  const response = await requestGitHub(
    `${repositoryApiPrefix(repository)}/releases?per_page=${perPage}`,
    request.token,
    "list_releases"
  );
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch {
    throw new GitHubReleaseClientError("invalid_response", "list_releases");
  }
  if (!Array.isArray(value)) {
    throw new GitHubReleaseClientError("invalid_response", "list_releases");
  }
  return value.map((entry) =>
    normalizeRelease(readRecord(entry, "list_releases"), "list_releases")
  );
}

export async function inspectGitHubRelease(
  request: InspectGitHubReleaseRequest
): Promise<GitHubReleaseInspection> {
  const repository = parseRepository(request.repository);
  const prefix = repositoryApiPrefix(repository);
  const branch = await fetchJsonRecord(
    `${prefix}/git/ref/heads/${encodeRef(request.branch)}`,
    request.token,
    "inspect_branch"
  );
  const branchObject = readRecord(branch.object, "inspect_branch");
  const branchSha = readSha(branchObject.sha, "inspect_branch");
  const tagResponse = await fetchOptionalJsonRecord(
    `${prefix}/git/ref/tags/${encodeRef(request.tag)}`,
    request.token,
    "inspect_tag"
  );
  const releaseResponse = await fetchOptionalJsonRecord(
    `${prefix}/releases/tags/${encodeURIComponent(request.tag)}`,
    request.token,
    "inspect_release"
  );

  return {
    repository: request.repository,
    branch: request.branch,
    branch_sha: branchSha,
    tag: tagResponse === null ? null : normalizeTag(request.tag, tagResponse),
    release: releaseResponse === null ? null : normalizeRelease(releaseResponse, "inspect_release")
  };
}

export async function createGitHubReleaseTag(
  request: CreateGitHubReleaseTagRequest
): Promise<GitHubReleaseTag> {
  const repository = parseRepository(request.repository);
  const response = await fetchJsonRecord(
    `${repositoryApiPrefix(repository)}/git/refs`,
    request.token,
    "create_tag",
    {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/tags/${request.tag}`,
        sha: request.sha
      })
    }
  );
  return normalizeTag(request.tag, response);
}

export async function createDraftGitHubRelease(
  request: CreateGitHubReleaseRequest
): Promise<GitHubReleaseRecord> {
  const repository = parseRepository(request.repository);
  const response = await fetchJsonRecord(
    `${repositoryApiPrefix(repository)}/releases`,
    request.token,
    "create_release",
    {
      method: "POST",
      body: JSON.stringify({
        tag_name: request.tag,
        target_commitish: request.targetCommitish,
        name: request.name,
        body: request.body,
        draft: true,
        prerelease: request.prerelease
      })
    }
  );
  return normalizeRelease(response, "create_release");
}

export async function uploadGitHubReleaseAsset(
  request: UploadGitHubReleaseAssetRequest
): Promise<GitHubReleaseAsset> {
  const repository = parseRepository(request.repository);
  const url = `${uploadsApiPrefix(repository)}/releases/${request.releaseId}/assets?name=${encodeURIComponent(
    request.name
  )}`;
  const response = await fetchJsonRecord(url, request.token, "upload_asset", {
    method: "POST",
    headers: {
      "Content-Type": request.contentType,
      "Content-Length": String(request.content.byteLength)
    },
    body: request.content
  });
  return normalizeAsset(response, "upload_asset");
}

export async function downloadGitHubReleaseAsset(
  request: DownloadGitHubReleaseAssetRequest
): Promise<Uint8Array> {
  const repository = parseRepository(request.repository);
  const response = await requestGitHub(
    `${repositoryApiPrefix(repository)}/releases/assets/${request.assetId}`,
    request.token,
    "download_asset",
    {
      headers: { Accept: "application/octet-stream" }
    }
  );
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new GitHubReleaseClientError("invalid_response", "download_asset");
  }
}

export async function publishGitHubRelease(
  request: PublishGitHubReleaseRequest
): Promise<GitHubReleaseRecord> {
  const repository = parseRepository(request.repository);
  const response = await fetchJsonRecord(
    `${repositoryApiPrefix(repository)}/releases/${request.releaseId}`,
    request.token,
    "publish_release",
    {
      method: "PATCH",
      body: JSON.stringify({
        name: request.name,
        draft: false,
        prerelease: request.prerelease
      })
    }
  );
  return normalizeRelease(response, "publish_release");
}

export async function promoteGitHubRelease(
  request: PromoteGitHubReleaseRequest
): Promise<GitHubReleaseRecord> {
  const repository = parseRepository(request.repository);
  const response = await fetchJsonRecord(
    `${repositoryApiPrefix(repository)}/releases/${request.releaseId}`,
    request.token,
    "promote_release",
    {
      method: "PATCH",
      body: JSON.stringify({
        name: request.name,
        draft: false,
        prerelease: false
      })
    }
  );
  return normalizeRelease(response, "promote_release");
}

async function fetchOptionalJsonRecord(
  url: string,
  token: string,
  operation: GitHubReleaseOperation
): Promise<Record<string, unknown> | null> {
  const response = await requestGitHub(url, token, operation, {}, true);
  if (response.status === 404) {
    return null;
  }
  return parseJsonRecord(response, operation);
}

async function fetchJsonRecord(
  url: string,
  token: string,
  operation: GitHubReleaseOperation,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  return parseJsonRecord(
    await requestGitHub(url, token, operation, init),
    operation
  );
}

async function requestGitHub(
  url: string,
  token: string,
  operation: GitHubReleaseOperation,
  init: RequestInit = {},
  allowNotFound = false
): Promise<Response> {
  if (typeof globalThis.fetch !== "function") {
    throw new GitHubReleaseClientError("network_error", operation);
  }
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "kairon-release",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers
      }
    });
  } catch {
    throw new GitHubReleaseClientError("network_error", operation);
  }
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw classifyGitHubError(operation, response);
  }
  return response;
}

async function parseJsonRecord(
  response: Response,
  operation: GitHubReleaseOperation
): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    return readRecord(value, operation);
  } catch (error) {
    if (error instanceof GitHubReleaseClientError) {
      throw error;
    }
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
}

function normalizeTag(
  name: string,
  value: Record<string, unknown>
): GitHubReleaseTag {
  const object = readRecord(value.object, "inspect_tag");
  const type = readString(object.type, "inspect_tag");
  if (type !== "commit") {
    throw new GitHubReleaseClientError("invalid_response", "inspect_tag");
  }
  return {
    name,
    sha: readSha(object.sha, "inspect_tag"),
    object_type: "commit"
  };
}

function normalizeRelease(
  value: Record<string, unknown>,
  operation: GitHubReleaseOperation
): GitHubReleaseRecord {
  const assets = Array.isArray(value.assets)
    ? value.assets.map((asset) => normalizeAsset(readRecord(asset, operation), operation))
    : (() => {
        throw new GitHubReleaseClientError("invalid_response", operation);
      })();
  return {
    id: readPositiveInteger(value.id, operation),
    tag_name: readString(value.tag_name, operation),
    name: readString(value.name, operation),
    draft: readBoolean(value.draft, operation),
    prerelease: readBoolean(value.prerelease, operation),
    html_url: readString(value.html_url, operation),
    assets
  };
}

function normalizeAsset(
  value: Record<string, unknown>,
  operation: GitHubReleaseOperation
): GitHubReleaseAsset {
  const digest = readOptionalString(value.digest);
  return {
    id: readPositiveInteger(value.id, operation),
    name: readString(value.name, operation),
    size_bytes: readNonNegativeInteger(value.size, operation),
    state: readString(value.state, operation),
    ...(digest === undefined ? {} : { digest })
  };
}

function classifyGitHubError(
  operation: GitHubReleaseOperation,
  response: Response
): GitHubReleaseClientError {
  const status = response.status;
  const rateLimited = status === 429 || (
    status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after")
    )
  );
  const kind: GitHubReleaseClientErrorKind = rateLimited
    ? "rate_limited"
    : status === 401
      ? "auth_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 422
              ? "validation_error"
              : "api_error";
  return new GitHubReleaseClientError(kind, operation, status);
}

function repositoryApiPrefix(repository: { owner: string; repo: string }): string {
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
    repository.repo
  )}`;
}

function uploadsApiPrefix(repository: { owner: string; repo: string }): string {
  return `https://uploads.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
    repository.repo
  )}`;
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = repository.trim().split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

function encodeRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("..") || trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new Error(`Invalid GitHub ref: ${value}`);
  }
  return trimmed.split("/").map(encodeURIComponent).join("/");
}

function readRecord(
  value: unknown,
  operation: GitHubReleaseOperation
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, operation: GitHubReleaseOperation): string {
  const parsed = readOptionalString(value);
  if (parsed === undefined) {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return parsed;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSha(value: unknown, operation: GitHubReleaseOperation): string {
  const sha = readString(value, operation).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(sha)) {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return sha;
}

function readPositiveInteger(value: unknown, operation: GitHubReleaseOperation): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, operation: GitHubReleaseOperation): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return value;
}

function readBoolean(value: unknown, operation: GitHubReleaseOperation): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubReleaseClientError("invalid_response", operation);
  }
  return value;
}
