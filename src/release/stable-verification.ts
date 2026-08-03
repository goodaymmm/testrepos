import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  resolveGitHubTokenSecret,
  type SecretProviderName,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import {
  defaultGitHubReleaseClient,
  GitHubReleaseClientError,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
  type GitHubReleaseInspection,
  type GitHubReleaseRecord
} from "../github/release-client.js";
import {
  parseReleaseManifestContent,
  verifyReleaseManifest,
  type ReleaseManifest,
  type ReleaseManifestVerificationResult
} from "./release-manifest.js";
import {
  selectReleaseForChannel,
  type UpdateChannelConfig
} from "../update/channel.js";

export type StableReleaseVerificationStatus =
  | "PASS"
  | "FAIL"
  | "SETUP_REQUIRED";

export type StableReleaseVerificationCheckId =
  | "github_access"
  | "release_identity"
  | "stable_state"
  | "asset_set"
  | "asset_integrity"
  | "manifest_verification"
  | "source_binding"
  | "channel_currentness"
  | "read_only_execution";

export type StableReleaseVerificationCheck = {
  id: StableReleaseVerificationCheckId;
  category: "integrity" | "currentness" | "safety" | "setup";
  status: "pass" | "fail" | "setup_required";
  reason: string;
  remediation?: string;
};

export type StableReleaseVerificationAsset = {
  id: number;
  name: string;
  size_bytes: number;
  sha256: string;
  state: string;
};

export type StableReleaseVerificationResult = {
  schema_version: "0.1";
  artifact_kind: "stable_release_verification";
  verification_id: string;
  status: StableReleaseVerificationStatus;
  integrity_status: "PASS" | "FAIL" | "SETUP_REQUIRED";
  currentness_status: "PASS" | "FAIL" | "SETUP_REQUIRED";
  repository: string;
  base_branch: string;
  version: string;
  tag: string;
  release_id: number | null;
  release_name: string | null;
  target_commit_sha: string | null;
  tag_commit_sha: string | null;
  draft: boolean | null;
  prerelease: boolean | null;
  assets: StableReleaseVerificationAsset[];
  manifest: {
    status: "verified" | "failed" | "not_available";
    package_version: string | null;
    source_commit: string | null;
    sha256: string | null;
    verification_context: "consumer";
    failed_checks: string[];
  };
  channel_selection: {
    channel: "stable";
    selected_release_id: number | null;
    selected_version: string | null;
    matches_requested_release: boolean;
  };
  credential_provider: SecretProviderName | null;
  checks: StableReleaseVerificationCheck[];
  reasons: string[];
  remediation: string[];
  state_digest: string;
  checked_at: string;
  expires_at: string;
  execution_performed: false;
};

export type VerifyPublishedStableReleaseInput = {
  version: string;
  repository: string;
  baseBranch?: string;
  tokenEnv?: string;
};

export type StableReleaseVerificationDependencies = {
  env?: NodeJS.ProcessEnv;
  secretResolver?: SecretResolver;
  client?: GitHubReleaseClient;
  now?: () => Date;
  tempRoot?: string;
};

export type StableReleaseVerificationExecution = {
  result: StableReleaseVerificationResult;
  result_path: string;
};

export type LatestStableReleaseVerification =
  | { status: "missing" }
  | { status: "corrupt" }
  | {
      status: "available";
      result: StableReleaseVerificationResult;
      result_path: string;
    };

type VerificationState = {
  inspection: GitHubReleaseInspection | null;
  releases: GitHubReleaseRecord[];
  assets: StableReleaseVerificationAsset[];
  manifest: ReleaseManifest | null;
  manifestBytes: Uint8Array | null;
  manifestVerification: ReleaseManifestVerificationResult | null;
  channelSelection: {
    release: GitHubReleaseRecord;
    version: string;
  } | undefined;
};

const verificationLifetimeMs = 24 * 60 * 60_000;

export async function verifyPublishedStableRelease(
  projectRoot: string,
  input: VerifyPublishedStableReleaseInput,
  deps: StableReleaseVerificationDependencies = {}
): Promise<StableReleaseVerificationExecution> {
  const version = normalizeVersion(input.version);
  const repository = normalizeRepository(input.repository);
  const baseBranch = normalizeBranch(input.baseBranch ?? "main");
  const tag = `v${version}`;
  const checkedAt = deps.now?.() ?? new Date();
  const expiresAt = new Date(checkedAt.getTime() + verificationLifetimeMs);
  const checks: StableReleaseVerificationCheck[] = [];
  const state: VerificationState = {
    inspection: null,
    releases: [],
    assets: [],
    manifest: null,
    manifestBytes: null,
    manifestVerification: null,
    channelSelection: undefined
  };
  const token = await resolveGitHubTokenSecret({
    env: deps.env,
    envName: input.tokenEnv,
    resolver: deps.secretResolver
  });
  if (token.status !== "present") {
    checks.push(check(
      "github_access",
      "setup",
      "setup_required",
      "missing_github_token",
      "configure GH_TOKEN, GITHUB_TOKEN, or the configured Windows credential target"
    ));
    checks.push(check(
      "read_only_execution",
      "safety",
      "pass",
      "github_mutation_not_requested"
    ));
    return persistResult(projectRoot, buildResult({
      version,
      repository,
      baseBranch,
      tag,
      checkedAt,
      expiresAt,
      credentialProvider: null,
      checks,
      state
    }));
  }

  const client = deps.client ?? defaultGitHubReleaseClient;
  let tempDirectory: string | undefined;
  try {
    const [releases, inspection] = await Promise.all([
      client.listReleases({
        repository,
        token: token.value,
        perPage: 100
      }),
      client.inspect({
        repository,
        branch: baseBranch,
        tag,
        token: token.value
      })
    ]);
    state.releases = releases;
    state.inspection = inspection;
    checks.push(check(
      "github_access",
      "setup",
      "pass",
      "github_read_completed"
    ));

    const release = inspection.release;
    const tagRecord = inspection.tag;
    const identityValid =
      release !== null &&
      tagRecord !== null &&
      release.tag_name === tag &&
      release.name === `Kairon ${version}`;
    checks.push(check(
      "release_identity",
      "integrity",
      identityValid ? "pass" : "fail",
      identityValid ? "release_identity_matches" : "release_identity_mismatch",
      identityValid
        ? undefined
        : "verify the repository, version, tag, and Stable release name"
    ));
    const stableState =
      release !== null &&
      release.draft === false &&
      release.prerelease === false;
    checks.push(check(
      "stable_state",
      "integrity",
      stableState ? "pass" : "fail",
      stableState
        ? "release_is_stable"
        : release?.draft === true
          ? "release_is_draft"
          : release?.prerelease === true
            ? "release_is_prerelease"
            : "stable_release_not_found",
      stableState ? undefined : "publish or promote the exact release to Stable"
    ));

    state.channelSelection = selectReleaseForChannel(
      stableChannelConfig(repository, baseBranch, checkedAt),
      releases
    );
    const channelCurrent =
      release !== null &&
      state.channelSelection?.release.id === release.id &&
      state.channelSelection.version === version;
    checks.push(check(
      "channel_currentness",
      "currentness",
      channelCurrent ? "pass" : "fail",
      channelCurrent
        ? "stable_channel_selects_release"
        : "stable_channel_selects_different_release",
      channelCurrent
        ? undefined
        : "verify the latest non-draft Stable release selected by the stable channel"
    ));

    if (release !== null) {
      const manifestAssets = release.assets.filter(
        (asset) => asset.name === "release-manifest.json"
      );
      if (manifestAssets.length === 1) {
        const manifestAsset = manifestAssets[0];
        state.manifestBytes = await client.downloadAsset({
          repository,
          assetId: manifestAsset.id,
          token: token.value
        });
        state.manifest = parseReleaseManifestContent(state.manifestBytes);
        const expectedNames = expectedAssetNames(version, state.manifest);
        const observedNames = release.assets.map((asset) => asset.name);
        const exactAssetSet =
          expectedNames.length === 5 &&
          new Set(observedNames).size === observedNames.length &&
          observedNames.length === expectedNames.length &&
          expectedNames.every((name) => observedNames.includes(name));
        checks.push(check(
          "asset_set",
          "integrity",
          exactAssetSet ? "pass" : "fail",
          exactAssetSet ? "exact_five_asset_set" : classifyAssetSet(
            expectedNames,
            observedNames
          ),
          exactAssetSet
            ? undefined
            : "restore the exact package, checksum, release manifest, SBOM, and provenance assets"
        ));

        if (exactAssetSet) {
          tempDirectory = await mkdtemp(
            path.join(deps.tempRoot ?? os.tmpdir(), "kairon-stable-verify-")
          );
          const downloaded = new Map<number, Uint8Array>([
            [manifestAsset.id, state.manifestBytes]
          ]);
          let assetIntegrity = true;
          for (const asset of release.assets) {
            const bytes = downloaded.get(asset.id) ?? await client.downloadAsset({
              repository,
              assetId: asset.id,
              token: token.value
            });
            downloaded.set(asset.id, bytes);
            const digest = sha256(bytes);
            if (!remoteAssetMatches(asset, bytes, digest)) {
              assetIntegrity = false;
            }
            const outputPath = resolveInside(tempDirectory, asset.name);
            await writeFile(outputPath, bytes);
            state.assets.push({
              id: asset.id,
              name: asset.name,
              size_bytes: bytes.byteLength,
              sha256: digest,
              state: asset.state
            });
          }
          checks.push(check(
            "asset_integrity",
            "integrity",
            assetIntegrity ? "pass" : "fail",
            assetIntegrity ? "remote_asset_bytes_match" : "asset_digest_drift",
            assetIntegrity ? undefined : "replace the drifted asset through a new release"
          ));

          const releaseManifestPath = resolveInside(
            tempDirectory,
            "release-manifest.json"
          );
          state.manifestVerification = await verifyReleaseManifest(
            releaseManifestPath,
            resolveInside(tempDirectory, state.manifest.artifact.package_file),
            resolveInside(
              tempDirectory,
              state.manifest.artifact.checksum_manifest_file
            ),
            { verificationContext: "consumer" }
          );
          checks.push(check(
            "manifest_verification",
            "integrity",
            state.manifestVerification.ok ? "pass" : "fail",
            state.manifestVerification.ok
              ? "consumer_manifest_verification_passed"
              : "consumer_manifest_verification_failed",
            state.manifestVerification.ok
              ? undefined
              : "regenerate the package and all release attestations from one clean source"
          ));
        }
      } else {
        checks.push(check(
          "asset_set",
          "integrity",
          "fail",
          manifestAssets.length === 0
            ? "release_manifest_asset_missing"
            : "release_manifest_asset_duplicated",
          "publish exactly one release-manifest.json asset"
        ));
      }
    }

    ensureCheck(
      checks,
      "asset_set",
      check(
        "asset_set",
        "integrity",
        "fail",
        "required_release_assets_not_available",
        "restore the exact five release assets and rerun verification"
      )
    );
    ensureCheck(
      checks,
      "asset_integrity",
      check(
        "asset_integrity",
        "integrity",
        "fail",
        "asset_integrity_not_verified",
        "restore the exact five release assets and rerun verification"
      )
    );
    ensureCheck(
      checks,
      "manifest_verification",
      check(
        "manifest_verification",
        "integrity",
        "fail",
        "release_manifest_not_verified",
        "restore a valid attested release manifest and rerun verification"
      )
    );
    const releaseTargetSha = normalizeSha(
      state.inspection?.release?.target_commitish
    );
    const tagSha = state.inspection?.tag?.sha ?? null;
    const manifestSourceSha = state.manifest?.source.commit_sha ?? null;
    const sourceBound =
      releaseTargetSha !== null &&
      tagSha !== null &&
      manifestSourceSha !== null &&
      releaseTargetSha === tagSha &&
      tagSha === manifestSourceSha;
    checks.push(check(
      "source_binding",
      "integrity",
      sourceBound ? "pass" : "fail",
      sourceBound
        ? "release_tag_and_manifest_source_match"
        : releaseTargetSha !== manifestSourceSha
          ? "release_target_drift"
          : "tag_source_drift",
      sourceBound
        ? undefined
        : "restore a release target and tag whose commit matches the release manifest source commit"
    ));
  } catch (error) {
    const reason = safeErrorReason(error);
    if (!checks.some((entry) => entry.id === "github_access")) {
      checks.push(check(
        "github_access",
        "setup",
        "fail",
        reason,
        "verify GitHub access and rerun the read-only Stable verification"
      ));
    } else if (!checks.some((entry) => entry.id === "asset_integrity")) {
      checks.push(check(
        "asset_integrity",
        "integrity",
        "fail",
        reason,
        "restore the published release assets and rerun verification"
      ));
    } else {
      ensureCheck(
        checks,
        "manifest_verification",
        check(
          "manifest_verification",
          "integrity",
          "fail",
          reason,
          "restore a valid attested release manifest and rerun verification"
        )
      );
    }
  } finally {
    if (tempDirectory !== undefined) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  ensureCheck(
    checks,
    "read_only_execution",
    check(
      "read_only_execution",
      "safety",
      "pass",
      "github_mutation_not_requested"
    )
  );
  return persistResult(projectRoot, buildResult({
    version,
    repository,
    baseBranch,
    tag,
    checkedAt,
    expiresAt,
    credentialProvider: token.provider,
    checks,
    state
  }));
}

export async function inspectLatestStableReleaseVerification(
  projectRoot: string
): Promise<LatestStableReleaseVerification> {
  const directory = stableVerificationDirectory(projectRoot);
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^STV-\d{14}-[a-f0-9]{12}\.json$/u.test(name))
      .sort()
      .reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "corrupt" };
  }
  const latest = names[0];
  if (latest === undefined) {
    return { status: "missing" };
  }
  const resultPath = resolveInside(directory, latest);
  try {
    const result = await readJsonFile<unknown>(resultPath);
    return isStableReleaseVerificationResult(result)
      ? { status: "available", result, result_path: resultPath }
      : { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

export function formatStableReleaseVerification(
  execution: StableReleaseVerificationExecution,
  projectRoot: string,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(execution.result, null, 2)}\n`;
  }
  const result = execution.result;
  return [
    "Kairon published Stable release verification:",
    `status=${result.status}`,
    `integrity_status=${result.integrity_status}`,
    `currentness_status=${result.currentness_status}`,
    `verification_id=${result.verification_id}`,
    `repository=${result.repository}`,
    `version=${result.version}`,
    `tag=${result.tag}`,
    `release_id=${result.release_id ?? "none"}`,
    `target_commit_sha=${result.target_commit_sha ?? "none"}`,
    `tag_commit_sha=${result.tag_commit_sha ?? "none"}`,
    `assets=${result.assets.length}`,
    `manifest_status=${result.manifest.status}`,
    `channel_release_id=${result.channel_selection.selected_release_id ?? "none"}`,
    `credential_provider=${result.credential_provider ?? "none"}`,
    `execution_performed=${result.execution_performed}`,
    `result=${toPosixPath(path.relative(projectRoot, execution.result_path))}`,
    ...result.checks.map(
      (entry) =>
        `${entry.status.toUpperCase()} ${entry.id} reason=${entry.reason}`
    ),
    ...result.remediation.map((entry) => `remediation=${entry}`)
  ].join("\n");
}

function buildResult(input: {
  version: string;
  repository: string;
  baseBranch: string;
  tag: string;
  checkedAt: Date;
  expiresAt: Date;
  credentialProvider: SecretProviderName | null;
  checks: StableReleaseVerificationCheck[];
  state: VerificationState;
}): StableReleaseVerificationResult {
  const integrityChecks = input.checks.filter(
    (entry) => entry.category === "integrity" || entry.category === "setup"
  );
  const currentnessChecks = input.checks.filter(
    (entry) => entry.category === "currentness" || entry.category === "setup"
  );
  const integrityStatus = summarizeChecks(integrityChecks);
  const currentnessStatus = summarizeChecks(currentnessChecks);
  const status = integrityStatus === "SETUP_REQUIRED" ||
    currentnessStatus === "SETUP_REQUIRED"
    ? "SETUP_REQUIRED"
    : integrityStatus === "PASS" && currentnessStatus === "PASS"
      ? "PASS"
      : "FAIL";
  const failedChecks =
    input.state.manifestVerification?.checks
      .filter((entry) => entry.status === "fail")
      .map((entry) => entry.id) ?? [];
  const stateDigest = sha256(Buffer.from(JSON.stringify({
    repository: input.repository,
    version: input.version,
    tag: input.tag,
    release_id: input.state.inspection?.release?.id ?? null,
    release_target_sha: normalizeSha(
      input.state.inspection?.release?.target_commitish
    ),
    tag_sha: input.state.inspection?.tag?.sha ?? null,
    assets: input.state.assets
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        size_bytes: asset.size_bytes,
        sha256: asset.sha256
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    manifest_sha256:
      input.state.manifestBytes === null
        ? null
        : sha256(input.state.manifestBytes),
    channel_release_id: input.state.channelSelection?.release.id ?? null
  }), "utf8"));
  const verificationId = `STV-${formatTimestamp(input.checkedAt)}-${stateDigest.slice(0, 12)}`;
  const reasons = unique(
    input.checks
      .filter((entry) => entry.status !== "pass")
      .map((entry) => entry.reason)
  );
  const remediation = unique(
    input.checks
      .map((entry) => entry.remediation)
      .filter((entry): entry is string => entry !== undefined)
  );
  return {
    schema_version: "0.1",
    artifact_kind: "stable_release_verification",
    verification_id: verificationId,
    status,
    integrity_status: integrityStatus,
    currentness_status: currentnessStatus,
    repository: input.repository,
    base_branch: input.baseBranch,
    version: input.version,
    tag: input.tag,
    release_id: input.state.inspection?.release?.id ?? null,
    release_name: input.state.inspection?.release?.name ?? null,
    target_commit_sha: normalizeSha(
      input.state.inspection?.release?.target_commitish
    ),
    tag_commit_sha: input.state.inspection?.tag?.sha ?? null,
    draft: input.state.inspection?.release?.draft ?? null,
    prerelease: input.state.inspection?.release?.prerelease ?? null,
    assets: [...input.state.assets].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    manifest: {
      status: input.state.manifestVerification === null
        ? input.state.manifest === null
          ? "not_available"
          : "failed"
        : input.state.manifestVerification.ok
          ? "verified"
          : "failed",
      package_version: input.state.manifest?.package_version ?? null,
      source_commit: input.state.manifest?.source.commit_sha ?? null,
      sha256: input.state.manifestBytes === null
        ? null
        : sha256(input.state.manifestBytes),
      verification_context: "consumer",
      failed_checks: failedChecks
    },
    channel_selection: {
      channel: "stable",
      selected_release_id: input.state.channelSelection?.release.id ?? null,
      selected_version: input.state.channelSelection?.version ?? null,
      matches_requested_release:
        input.state.inspection?.release !== null &&
        input.state.inspection?.release !== undefined &&
        input.state.channelSelection?.release.id ===
          input.state.inspection.release.id &&
        input.state.channelSelection.version === input.version
    },
    credential_provider: input.credentialProvider,
    checks: input.checks,
    reasons,
    remediation,
    state_digest: stateDigest,
    checked_at: input.checkedAt.toISOString(),
    expires_at: input.expiresAt.toISOString(),
    execution_performed: false
  };
}

async function persistResult(
  projectRoot: string,
  result: StableReleaseVerificationResult
): Promise<StableReleaseVerificationExecution> {
  const resultPath = resolveInside(
    stableVerificationDirectory(projectRoot),
    `${result.verification_id}.json`
  );
  await writeJsonFileAtomic(resultPath, result);
  return { result, result_path: resultPath };
}

function stableVerificationDirectory(projectRoot: string): string {
  return resolveInside(
    projectRoot,
    ".kairon",
    "release",
    "stable-verifications"
  );
}

function expectedAssetNames(
  version: string,
  manifest: ReleaseManifest
): string[] {
  if (
    manifest.package_version !== version ||
    manifest.attestations === undefined
  ) {
    return [];
  }
  const names = [
    manifest.artifact.package_file,
    manifest.artifact.checksum_manifest_file,
    "release-manifest.json",
    manifest.attestations.sbom.file,
    manifest.attestations.provenance.file
  ];
  return names.every(isSafeAssetName) && new Set(names).size === names.length
    ? names
    : [];
}

function isSafeAssetName(value: string): boolean {
  return value.length > 0 &&
    path.basename(value) === value &&
    value !== "." &&
    value !== "..";
}

function classifyAssetSet(expected: string[], observed: string[]): string {
  if (expected.length !== 5) {
    return "release_manifest_asset_contract_invalid";
  }
  const missing = expected.some((name) => !observed.includes(name));
  const extra = observed.some((name) => !expected.includes(name));
  if (missing) {
    return "required_release_asset_missing";
  }
  if (extra) {
    return "unexpected_release_asset";
  }
  return "duplicate_release_asset";
}

function remoteAssetMatches(
  asset: GitHubReleaseAsset,
  bytes: Uint8Array,
  digest: string
): boolean {
  if (asset.size_bytes !== bytes.byteLength || asset.state !== "uploaded") {
    return false;
  }
  if (asset.digest === undefined) {
    return true;
  }
  return asset.digest.toLowerCase() === `sha256:${digest}`;
}

function stableChannelConfig(
  repository: string,
  baseBranch: string,
  now: Date
): UpdateChannelConfig {
  return {
    schema_version: "0.1",
    channel: "stable",
    repository,
    base_branch: baseBranch,
    automatic_updates: false,
    updated_at: now.toISOString()
  };
}

function check(
  id: StableReleaseVerificationCheckId,
  category: StableReleaseVerificationCheck["category"],
  status: StableReleaseVerificationCheck["status"],
  reason: string,
  remediation?: string
): StableReleaseVerificationCheck {
  return {
    id,
    category,
    status,
    reason,
    ...(remediation === undefined ? {} : { remediation })
  };
}

function ensureCheck(
  checks: StableReleaseVerificationCheck[],
  id: StableReleaseVerificationCheckId,
  fallback: StableReleaseVerificationCheck
): void {
  if (!checks.some((entry) => entry.id === id)) {
    checks.push(fallback);
  }
}

function summarizeChecks(
  checks: StableReleaseVerificationCheck[]
): "PASS" | "FAIL" | "SETUP_REQUIRED" {
  if (checks.some((entry) => entry.status === "setup_required")) {
    return "SETUP_REQUIRED";
  }
  return checks.length > 0 && checks.every((entry) => entry.status === "pass")
    ? "PASS"
    : "FAIL";
}

function safeErrorReason(error: unknown): string {
  if (error instanceof GitHubReleaseClientError) {
    return `github_${error.operation}_${error.kind}`;
  }
  return "stable_release_verification_error";
}

function normalizeVersion(value: string): string {
  const version = value.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Stable verification version must be a core semantic version.");
  }
  return version;
}

function normalizeRepository(value: string): string {
  const repository = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error("Stable verification repository must use owner/repo.");
  }
  return repository;
}

function normalizeBranch(value: string): string {
  const branch = value.trim();
  if (
    branch.length === 0 ||
    branch.includes("..") ||
    path.isAbsolute(branch)
  ) {
    throw new Error("Stable verification base branch is invalid.");
  }
  return branch;
}

function normalizeSha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && /^[a-f0-9]{40}$/u.test(normalized)
    ? normalized
    : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/\D/gu, "").slice(0, 14);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isStableReleaseVerificationResult(
  value: unknown
): value is StableReleaseVerificationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StableReleaseVerificationResult>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "stable_release_verification" &&
    typeof candidate.verification_id === "string" &&
    (candidate.status === "PASS" ||
      candidate.status === "FAIL" ||
      candidate.status === "SETUP_REQUIRED") &&
    typeof candidate.repository === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.checked_at === "string" &&
    !Number.isNaN(Date.parse(candidate.checked_at)) &&
    typeof candidate.expires_at === "string" &&
    !Number.isNaN(Date.parse(candidate.expires_at)) &&
    Array.isArray(candidate.checks) &&
    candidate.execution_performed === false;
}
