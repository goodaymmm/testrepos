import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ApprovalNotFoundError, ApprovalQueue } from "../approvals/approval-queue.js";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { trackCorrelationMember } from "../correlation/store.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { withResourceLock } from "../core/fs/resource-lock.js";
import { nextId } from "../core/ids/counter.js";
import {
  resolveGitHubTokenSecret,
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
import { StateApplier } from "../state/state-applier.js";
import {
  verifyReleaseManifest,
  type ReleaseManifest
} from "./release-manifest.js";

export type GitHubReleasePlannedAsset = {
  name: string;
  path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
};

export type GitHubReleasePlan = {
  schema_version: "0.1";
  artifact_kind: "github_release_plan";
  plan_id: string;
  status: "approval_required";
  repository: string;
  base_branch: string;
  source_commit: string;
  version: string;
  tag: string;
  release_name: string;
  prerelease: boolean;
  assets: GitHubReleasePlannedAsset[];
  approval_id: string;
  correlation_id: string;
  plan_digest: string;
  created_at: string;
};

export type GitHubReleasePublishedAsset = {
  id: number;
  name: string;
  size_bytes: number;
  sha256: string;
  status: "verified";
};

export type GitHubReleaseResult = {
  schema_version: "0.1";
  artifact_kind: "github_release_result";
  plan_id: string;
  status: "published" | "blocked" | "setup_required" | "failed";
  repository: string;
  source_commit: string;
  tag: string;
  tag_sha?: string;
  release_id?: number;
  prerelease: boolean;
  assets: GitHubReleasePublishedAsset[];
  approval_id: string;
  correlation_id: string;
  attempts: number;
  idempotent: boolean;
  error_code?: string;
  http_status?: number;
  retryable?: boolean;
  created_at: string;
  updated_at: string;
};

export type GitHubReleaseCommandStatus =
  | "approval_required"
  | "published"
  | "verified"
  | "blocked"
  | "setup_required"
  | "failed";

export type GitHubReleaseCommandResult = {
  status: GitHubReleaseCommandStatus;
  reason?: string;
  http_status?: number;
  plan?: GitHubReleasePlan;
  result?: GitHubReleaseResult;
  inspection?: GitHubReleaseInspection;
  assets?: GitHubReleasePublishedAsset[];
  execution_performed: boolean;
};

export type GitHubReleasePlanRequest = {
  version: string;
  repository: string;
  baseBranch?: string;
  artifactDir?: string;
  stable?: boolean;
  tokenEnv?: string;
};

export type GitHubReleasePublishRequest = {
  planId: string;
  approvalId?: string;
  confirm?: string;
  tokenEnv?: string;
};

export type GitHubReleaseVerifyRequest = {
  version: string;
  repository: string;
  baseBranch?: string;
  artifactDir?: string;
  stable?: boolean;
  tokenEnv?: string;
};

export type GitHubReleaseDependencies = {
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  client?: GitHubReleaseClient;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

type LocalReleaseBundle = {
  version: string;
  sourceCommit: string;
  assets: GitHubReleasePlannedAsset[];
};

type SourceState = {
  clean: boolean;
  commit: string | null;
};

const releasePlanPattern = /^REL-\d{4,}$/u;

export async function planGitHubRelease(
  projectRoot: string,
  request: GitHubReleasePlanRequest,
  deps: GitHubReleaseDependencies = {}
): Promise<GitHubReleaseCommandResult> {
  const version = validateVersion(request.version);
  const repository = validateRepository(request.repository);
  const baseBranch = validateRef(request.baseBranch ?? "main", "base branch");
  const prerelease = request.stable !== true;
  const token = await resolveGitHubTokenSecret({
    env: deps.env,
    envName: request.tokenEnv,
    resolver: deps.resolver
  });
  if (token.status !== "present") {
    return outcome("setup_required", "missing_github_token");
  }

  let bundle: LocalReleaseBundle;
  try {
    bundle = await loadLocalReleaseBundle(projectRoot, {
      version,
      artifactDir: request.artifactDir
    });
  } catch (error) {
    return outcome("blocked", safeLocalError(error));
  }
  const source = await collectSourceState(
    projectRoot,
    deps.commandRunner ?? spawnCommandRunner
  );
  if (!source.clean) {
    return outcome("blocked", "tracked_worktree_dirty");
  }
  if (source.commit === null || source.commit !== bundle.sourceCommit) {
    return outcome("blocked", "local_source_commit_mismatch");
  }

  const tag = `v${version}`;
  const client = deps.client ?? defaultGitHubReleaseClient;
  let inspection: GitHubReleaseInspection;
  try {
    inspection = await client.inspect({
      repository,
      branch: baseBranch,
      tag,
      token: token.value
    });
  } catch (error) {
    return clientFailure(error, false);
  }
  let remoteBlock: string | undefined;
  try {
    remoteBlock = await validateRemotePreflight(
      inspection,
      bundle,
      prerelease,
      client,
      token.value
    );
  } catch (error) {
    return clientFailure(error, false);
  }
  if (remoteBlock !== undefined) {
    return outcome("blocked", remoteBlock, { inspection });
  }

  const planId = await nextId(projectRoot, "release");
  const approvalId = await nextId(projectRoot, "approval");
  const correlationId = await nextId(projectRoot, "correlation");
  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  const planWithoutDigest = {
    schema_version: "0.1" as const,
    artifact_kind: "github_release_plan" as const,
    plan_id: planId,
    status: "approval_required" as const,
    repository,
    base_branch: baseBranch,
    source_commit: bundle.sourceCommit,
    version,
    tag,
    release_name: expectedReleaseName(version, prerelease),
    prerelease,
    assets: bundle.assets,
    approval_id: approvalId,
    correlation_id: correlationId,
    created_at: createdAt
  };
  const plan: GitHubReleasePlan = {
    ...planWithoutDigest,
    plan_digest: calculatePlanDigest(planWithoutDigest)
  };
  const planPath = githubReleasePlanPath(projectRoot, planId);
  const planArtifactPath = projectRelativePath(projectRoot, planPath);
  await writeJsonFileAtomic(planPath, plan);
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    actor: "release-github-plan",
    payload: {
      approval: {
        id: approvalId,
        correlation_id: correlationId,
        type: "github_release_publish",
        title: `Publish ${tag} to ${repository}`,
        actions: ["approve", "reject", "request_changes", "snooze"],
        risk_level: "high",
        approval_required_for: "github_release_publish",
        operation: "github_release_publish",
        plan_id: planId,
        plan_digest: plan.plan_digest,
        repository,
        target_branch: baseBranch,
        source_commit: bundle.sourceCommit,
        tag,
        prerelease,
        assets: bundle.assets.map((asset) => ({
          name: asset.name,
          size_bytes: asset.size_bytes,
          sha256: asset.sha256
        })),
        artifact_path: planArtifactPath,
        confirmation: {
          status: "required",
          action: "approve",
          required_by: "board",
          reason: "github_release_publish_high_risk"
        }
      }
    }
  });
  await trackCorrelationMember(projectRoot, {
    correlationId,
    approvalId,
    kind: "release_plan",
    id: planId,
    status: plan.status,
    artifactPath: planArtifactPath,
    createdAt
  });
  return {
    status: "approval_required",
    plan,
    inspection,
    execution_performed: false
  };
}

export async function publishGitHubRelease(
  projectRoot: string,
  request: GitHubReleasePublishRequest,
  deps: GitHubReleaseDependencies = {}
): Promise<GitHubReleaseCommandResult> {
  const planId = validatePlanId(request.planId);
  let plan: GitHubReleasePlan;
  try {
    plan = await readGitHubReleasePlan(projectRoot, planId);
  } catch {
    return outcome("blocked", "release_plan_not_found");
  }
  if (request.confirm !== planId) {
    return outcome("blocked", "exact_confirmation_required");
  }
  if (request.approvalId !== plan.approval_id) {
    return outcome("blocked", "approval_id_mismatch");
  }
  if (!planDigestMatches(plan)) {
    return outcome("blocked", "release_plan_digest_mismatch");
  }
  let approval;
  try {
    approval = await new ApprovalQueue(projectRoot).show(plan.approval_id);
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return outcome("blocked", "approval_not_found");
    }
    throw error;
  }
  if (approval.status !== "decided" || approval.decision !== "approve") {
    return outcome("blocked", "approval_not_approved");
  }
  if (
    approval.plan_id !== plan.plan_id ||
    approval.plan_digest !== plan.plan_digest ||
    approval.artifact_path !== projectRelativePath(projectRoot, githubReleasePlanPath(projectRoot, planId))
  ) {
    return outcome("blocked", "approval_plan_binding_mismatch");
  }

  const token = await resolveGitHubTokenSecret({
    env: deps.env,
    envName: request.tokenEnv,
    resolver: deps.resolver
  });
  if (token.status !== "present") {
    return persistFailure(projectRoot, plan, {
      status: "setup_required",
      errorCode: "missing_github_token",
      retryable: false,
      now: deps.now?.() ?? new Date()
    });
  }
  const source = await collectSourceState(
    projectRoot,
    deps.commandRunner ?? spawnCommandRunner
  );
  if (!source.clean || source.commit !== plan.source_commit) {
    return persistFailure(projectRoot, plan, {
      status: "blocked",
      errorCode: !source.clean ? "tracked_worktree_dirty" : "local_source_commit_mismatch",
      retryable: false,
      now: deps.now?.() ?? new Date()
    });
  }
  const localBinding = await verifyPlanAssets(projectRoot, plan);
  if (localBinding !== undefined) {
    return persistFailure(projectRoot, plan, {
      status: "blocked",
      errorCode: localBinding,
      retryable: false,
      now: deps.now?.() ?? new Date()
    });
  }

  return withResourceLock(
    projectRoot,
    githubReleasePlanPath(projectRoot, planId),
    { owner: "github-release-publish", ttlMs: 300_000 },
    async () => executePublish(projectRoot, plan, token.value, deps)
  );
}

export async function verifyGitHubRelease(
  projectRoot: string,
  request: GitHubReleaseVerifyRequest,
  deps: GitHubReleaseDependencies = {}
): Promise<GitHubReleaseCommandResult> {
  const version = validateVersion(request.version);
  const repository = validateRepository(request.repository);
  const baseBranch = validateRef(request.baseBranch ?? "main", "base branch");
  const prerelease = request.stable !== true;
  const token = await resolveGitHubTokenSecret({
    env: deps.env,
    envName: request.tokenEnv,
    resolver: deps.resolver
  });
  if (token.status !== "present") {
    return outcome("setup_required", "missing_github_token");
  }
  let bundle: LocalReleaseBundle;
  try {
    bundle = await loadLocalReleaseBundle(projectRoot, {
      version,
      artifactDir: request.artifactDir
    });
  } catch (error) {
    return outcome("blocked", safeLocalError(error));
  }
  const client = deps.client ?? defaultGitHubReleaseClient;
  let inspection: GitHubReleaseInspection;
  try {
    inspection = await client.inspect({
      repository,
      branch: baseBranch,
      tag: `v${version}`,
      token: token.value
    });
    const reason = await verifyRemoteState(
      inspection,
      bundle,
      prerelease,
      client,
      token.value
    );
    if (reason !== undefined) {
      return outcome("blocked", reason, { inspection });
    }
    const assets = await collectVerifiedRemoteAssets(
      inspection.release!,
      bundle.assets,
      repository,
      client,
      token.value
    );
    return {
      status: "verified",
      inspection,
      assets,
      execution_performed: false
    };
  } catch (error) {
    return clientFailure(error, false);
  }
}

async function executePublish(
  projectRoot: string,
  plan: GitHubReleasePlan,
  token: string,
  deps: GitHubReleaseDependencies
): Promise<GitHubReleaseCommandResult> {
  const client = deps.client ?? defaultGitHubReleaseClient;
  const previous = await readOptionalGitHubReleaseResult(projectRoot, plan.plan_id);
  const attempts = (previous?.attempts ?? 0) + 1;
  const now = deps.now?.() ?? new Date();
  let inspection: GitHubReleaseInspection;
  let release: GitHubReleaseRecord | null = null;
  let tagSha: string | undefined;
  const verifiedAssets: GitHubReleasePublishedAsset[] = [];
  let mutationPerformed = false;
  try {
    inspection = await client.inspect({
      repository: plan.repository,
      branch: plan.base_branch,
      tag: plan.tag,
      token
    });
    if (inspection.branch_sha !== plan.source_commit) {
      return persistFailure(projectRoot, plan, {
        status: "blocked",
        errorCode: "remote_branch_sha_drift",
        retryable: false,
        inspection,
        attempts,
        executionPerformed: mutationPerformed,
        now
      });
    }
    if (inspection.tag !== null && inspection.tag.sha !== plan.source_commit) {
      return persistFailure(projectRoot, plan, {
        status: "blocked",
        errorCode: "tag_sha_conflict",
        retryable: false,
        inspection,
        attempts,
        executionPerformed: mutationPerformed,
        now
      });
    }
    if (inspection.tag === null) {
      const tag = await client.createTag({
        repository: plan.repository,
        tag: plan.tag,
        sha: plan.source_commit,
        token
      });
      tagSha = tag.sha;
      mutationPerformed = true;
    } else {
      tagSha = inspection.tag.sha;
    }

    release = inspection.release;
    if (release !== null) {
      const releaseConflict = validateExistingRelease(release, plan);
      if (releaseConflict !== undefined) {
        return persistFailure(projectRoot, plan, {
          status: "blocked",
          errorCode: releaseConflict,
          retryable: false,
          inspection,
          attempts,
          executionPerformed: mutationPerformed,
          now
        });
      }
    } else {
      release = await client.createDraftRelease({
        repository: plan.repository,
        tag: plan.tag,
        targetCommitish: plan.source_commit,
        name: plan.release_name,
        body: releaseBody(plan),
        prerelease: plan.prerelease,
        token
      });
      mutationPerformed = true;
    }

    for (const planned of plan.assets) {
      const matches = release.assets.filter((asset) => asset.name === planned.name);
      if (matches.length > 1) {
        return persistFailure(projectRoot, plan, {
          status: "blocked",
          errorCode: "duplicate_remote_asset_name",
          retryable: false,
          inspection,
          release,
          tagSha,
          assets: verifiedAssets,
          attempts,
          executionPerformed: mutationPerformed,
          now
        });
      }
      let remote: GitHubReleaseAsset;
      if (matches.length === 1) {
        remote = matches[0];
      } else {
        const content = await readFile(resolveInside(projectRoot, planned.path));
        remote = await client.uploadAsset({
          repository: plan.repository,
          releaseId: release.id,
          name: planned.name,
          content,
          contentType: planned.content_type,
          token
        });
        release = { ...release, assets: [...release.assets, remote] };
        mutationPerformed = true;
      }
      const verified = await verifyRemoteAsset(
        remote,
        planned,
        plan.repository,
        client,
        token
      );
      if (verified === null) {
        return persistFailure(projectRoot, plan, {
          status: "blocked",
          errorCode: "remote_asset_hash_conflict",
          retryable: false,
          inspection,
          release,
          tagSha,
          assets: verifiedAssets,
          attempts,
          executionPerformed: mutationPerformed,
          now
        });
      }
      verifiedAssets.push(verified);
    }

    if (release.draft) {
      release = await client.publishRelease({
        repository: plan.repository,
        releaseId: release.id,
        name: plan.release_name,
        prerelease: plan.prerelease,
        token
      });
      mutationPerformed = true;
    }
    if (release.prerelease !== plan.prerelease || release.draft) {
      return persistFailure(projectRoot, plan, {
        status: "blocked",
        errorCode: "published_release_state_mismatch",
        retryable: false,
        inspection,
        release,
        tagSha,
        assets: verifiedAssets,
        attempts,
        executionPerformed: mutationPerformed,
        now
      });
    }
    const result = await persistResult(projectRoot, plan, {
      status: "published",
      tagSha,
      release,
      assets: verifiedAssets,
      attempts,
      idempotent: !mutationPerformed,
      now
    });
    return {
      status: "published",
      result,
      inspection,
      execution_performed: mutationPerformed
    };
  } catch (error) {
    const classified = classifyClientFailure(error);
    return persistFailure(projectRoot, plan, {
      status: classified.status,
      errorCode: classified.reason,
      httpStatus: classified.http_status,
      retryable: classified.retryable,
      release: release ?? undefined,
      tagSha,
      assets: verifiedAssets,
      attempts,
      executionPerformed: mutationPerformed,
      now
    });
  }
}

async function validateRemotePreflight(
  inspection: GitHubReleaseInspection,
  bundle: LocalReleaseBundle,
  prerelease: boolean,
  client: GitHubReleaseClient,
  token: string
): Promise<string | undefined> {
  if (inspection.branch_sha !== bundle.sourceCommit) {
    return "remote_branch_sha_mismatch";
  }
  if (inspection.tag !== null && inspection.tag.sha !== bundle.sourceCommit) {
    return "tag_sha_conflict";
  }
  if (inspection.release !== null) {
    if (inspection.release.tag_name !== inspection.tag?.name) {
      return "release_tag_conflict";
    }
    if (inspection.release.name !== expectedReleaseName(bundle.version, prerelease)) {
      return "release_name_conflict";
    }
    if (!inspection.release.draft && inspection.release.prerelease !== prerelease) {
      return "release_channel_conflict";
    }
    const plannedNames = new Set(bundle.assets.map((asset) => asset.name));
    if (inspection.release.assets.some((asset) => !plannedNames.has(asset.name))) {
      return "unexpected_remote_asset";
    }
    for (const planned of bundle.assets) {
      const matches = inspection.release.assets.filter((asset) => asset.name === planned.name);
      if (matches.length > 1) {
        return "duplicate_remote_asset_name";
      }
      if (matches.length === 1) {
        const verified = await verifyRemoteAsset(
          matches[0],
          planned,
          inspection.repository,
          client,
          token
        );
        if (verified === null) {
          return "remote_asset_hash_conflict";
        }
      }
    }
  }
  return undefined;
}

async function verifyRemoteState(
  inspection: GitHubReleaseInspection,
  bundle: LocalReleaseBundle,
  prerelease: boolean,
  client: GitHubReleaseClient,
  token: string
): Promise<string | undefined> {
  if (inspection.branch_sha !== bundle.sourceCommit) {
    return "remote_branch_sha_mismatch";
  }
  if (inspection.tag === null) {
    return "release_tag_missing";
  }
  if (inspection.tag.sha !== bundle.sourceCommit) {
    return "tag_sha_conflict";
  }
  if (inspection.release === null) {
    return "github_release_missing";
  }
  if (inspection.release.draft || inspection.release.prerelease !== prerelease) {
    return "published_release_state_mismatch";
  }
  try {
    await collectVerifiedRemoteAssets(
      inspection.release,
      bundle.assets,
      inspection.repository,
      client,
      token
    );
  } catch (error) {
    if (error instanceof Error && error.message === "remote_asset_verification_failed") {
      return "remote_asset_hash_conflict";
    }
    throw error;
  }
  return undefined;
}

async function collectVerifiedRemoteAssets(
  release: GitHubReleaseRecord,
  plannedAssets: GitHubReleasePlannedAsset[],
  repository: string,
  client: GitHubReleaseClient,
  token: string
): Promise<GitHubReleasePublishedAsset[]> {
  const verified: GitHubReleasePublishedAsset[] = [];
  for (const planned of plannedAssets) {
    const matches = release.assets.filter((asset) => asset.name === planned.name);
    if (matches.length !== 1) {
      throw new Error("remote_asset_verification_failed");
    }
    const result = await verifyRemoteAsset(matches[0], planned, repository, client, token);
    if (result === null) {
      throw new Error("remote_asset_verification_failed");
    }
    verified.push(result);
  }
  return verified;
}

async function verifyRemoteAsset(
  remote: GitHubReleaseAsset,
  planned: GitHubReleasePlannedAsset,
  repository: string,
  client: GitHubReleaseClient,
  token: string
): Promise<GitHubReleasePublishedAsset | null> {
  if (
    remote.name !== planned.name ||
    remote.size_bytes !== planned.size_bytes ||
    remote.state !== "uploaded"
  ) {
    return null;
  }
  if (remote.digest !== undefined && remote.digest !== `sha256:${planned.sha256}`) {
    return null;
  }
  const content = await client.downloadAsset({
    repository,
    assetId: remote.id,
    token
  });
  if (sha256(content) !== planned.sha256) {
    return null;
  }
  return {
    id: remote.id,
    name: remote.name,
    size_bytes: remote.size_bytes,
    sha256: planned.sha256,
    status: "verified"
  };
}

function validateExistingRelease(
  release: GitHubReleaseRecord,
  plan: GitHubReleasePlan
): string | undefined {
  if (release.tag_name !== plan.tag) {
    return "release_tag_conflict";
  }
  if (release.name !== plan.release_name) {
    return "release_name_conflict";
  }
  if (!release.draft && release.prerelease !== plan.prerelease) {
    return "release_channel_conflict";
  }
  const plannedNames = new Set(plan.assets.map((asset) => asset.name));
  if (release.assets.some((asset) => !plannedNames.has(asset.name))) {
    return "unexpected_remote_asset";
  }
  return undefined;
}

async function loadLocalReleaseBundle(
  projectRoot: string,
  input: { version: string; artifactDir?: string }
): Promise<LocalReleaseBundle> {
  const artifactRoot = resolveInside(
    projectRoot,
    input.artifactDir ?? path.join("release-artifacts", input.version)
  );
  const releaseManifestPath = resolveInside(artifactRoot, "release-manifest.json");
  const releaseManifest = await readJsonFile<ReleaseManifest>(releaseManifestPath);
  const packagePath = resolveInside(artifactRoot, releaseManifest.artifact.package_file);
  const checksumPath = resolveInside(
    artifactRoot,
    releaseManifest.artifact.checksum_manifest_file
  );
  const verification = await verifyReleaseManifest(
    releaseManifestPath,
    packagePath,
    checksumPath
  );
  if (!verification.ok) {
    const failedChecks = verification.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.id)
      .join("_");
    throw new Error(`release_manifest_verification_failed_${failedChecks}`);
  }
  if (releaseManifest.package_version !== input.version) {
    throw new Error("release_version_mismatch");
  }
  const files = [
    { filePath: packagePath, contentType: "application/gzip" },
    { filePath: checksumPath, contentType: "application/json" },
    { filePath: releaseManifestPath, contentType: "application/json" }
  ];
  const assets = await Promise.all(
    files.map(async ({ filePath, contentType }) => {
      const [content, info] = await Promise.all([readFile(filePath), stat(filePath)]);
      return {
        name: path.basename(filePath),
        path: projectRelativePath(projectRoot, filePath),
        content_type: contentType,
        size_bytes: info.size,
        sha256: sha256(content)
      };
    })
  );
  return {
    version: input.version,
    sourceCommit: releaseManifest.source.commit_sha,
    assets: assets.sort((left, right) => left.name.localeCompare(right.name))
  };
}

async function verifyPlanAssets(
  projectRoot: string,
  plan: GitHubReleasePlan
): Promise<string | undefined> {
  if (!planDigestMatches(plan)) {
    return "release_plan_digest_mismatch";
  }
  for (const asset of plan.assets) {
    try {
      const filePath = resolveInside(projectRoot, asset.path);
      const [content, info] = await Promise.all([readFile(filePath), stat(filePath)]);
      if (info.size !== asset.size_bytes || sha256(content) !== asset.sha256) {
        return "local_release_asset_drift";
      }
    } catch {
      return "local_release_asset_missing";
    }
  }
  return undefined;
}

async function collectSourceState(
  projectRoot: string,
  commandRunner: CommandRunner
): Promise<SourceState> {
  const status = await commandRunner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });
  if (status.exitCode !== 0 || status.timedOut) {
    return { clean: false, commit: null };
  }
  const clean = status.stdout.trim().length === 0;
  const revision = await commandRunner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot
  });
  const commit = revision.stdout.trim().toLowerCase();
  return {
    clean,
    commit:
      revision.exitCode === 0 && !revision.timedOut && /^[a-f0-9]{40,64}$/u.test(commit)
        ? commit
        : null
  };
}

async function persistFailure(
  projectRoot: string,
  plan: GitHubReleasePlan,
  input: {
    status: "blocked" | "setup_required" | "failed";
    errorCode: string;
    retryable: boolean;
    httpStatus?: number;
    inspection?: GitHubReleaseInspection;
    release?: GitHubReleaseRecord;
    tagSha?: string;
    assets?: GitHubReleasePublishedAsset[];
    attempts?: number;
    executionPerformed?: boolean;
    now: Date;
  }
): Promise<GitHubReleaseCommandResult> {
  const result = await persistResult(projectRoot, plan, {
    status: input.status,
    tagSha: input.tagSha ?? input.inspection?.tag?.sha,
    release: input.release ?? input.inspection?.release ?? undefined,
    assets: input.assets ?? [],
    attempts: input.attempts,
    idempotent: false,
    errorCode: input.errorCode,
    httpStatus: input.httpStatus,
    retryable: input.retryable,
    now: input.now
  });
  return {
    status: input.status,
    reason: input.errorCode,
    http_status: input.httpStatus,
    result,
    inspection: input.inspection,
    execution_performed: input.executionPerformed ?? false
  };
}

async function persistResult(
  projectRoot: string,
  plan: GitHubReleasePlan,
  input: {
    status: GitHubReleaseResult["status"];
    tagSha?: string;
    release?: GitHubReleaseRecord;
    assets: GitHubReleasePublishedAsset[];
    attempts?: number;
    idempotent: boolean;
    errorCode?: string;
    httpStatus?: number;
    retryable?: boolean;
    now: Date;
  }
): Promise<GitHubReleaseResult> {
  const existing = await readOptionalGitHubReleaseResult(projectRoot, plan.plan_id);
  const timestamp = input.now.toISOString();
  const result: GitHubReleaseResult = {
    schema_version: "0.1",
    artifact_kind: "github_release_result",
    plan_id: plan.plan_id,
    status: input.status,
    repository: plan.repository,
    source_commit: plan.source_commit,
    tag: plan.tag,
    tag_sha: input.tagSha,
    release_id: input.release?.id,
    prerelease: plan.prerelease,
    assets: input.assets,
    approval_id: plan.approval_id,
    correlation_id: plan.correlation_id,
    attempts: input.attempts ?? (existing?.attempts ?? 0) + 1,
    idempotent: input.idempotent,
    error_code: input.errorCode,
    http_status: input.httpStatus,
    retryable: input.retryable,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  };
  const resultPath = githubReleaseResultPath(projectRoot, plan.plan_id);
  const artifactPath = projectRelativePath(projectRoot, resultPath);
  await writeJsonFileAtomic(resultPath, result);
  await trackCorrelationMember(projectRoot, {
    correlationId: plan.correlation_id,
    approvalId: plan.approval_id,
    kind: "release_result",
    id: plan.plan_id,
    status: result.status,
    artifactPath,
    createdAt: timestamp
  });
  return result;
}

export async function readGitHubReleasePlan(
  projectRoot: string,
  planId: string
): Promise<GitHubReleasePlan> {
  const plan = await readJsonFile<GitHubReleasePlan>(
    githubReleasePlanPath(projectRoot, validatePlanId(planId))
  );
  if (
    plan.schema_version !== "0.1" ||
    plan.artifact_kind !== "github_release_plan" ||
    plan.plan_id !== planId
  ) {
    throw new Error(`Invalid GitHub release plan: ${planId}`);
  }
  return plan;
}

export function githubReleasePlanPath(projectRoot: string, planId: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "release",
    "github",
    "plans",
    `${validatePlanId(planId)}.json`
  );
}

export function githubReleaseResultPath(projectRoot: string, planId: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "release",
    "github",
    "results",
    `${validatePlanId(planId)}.json`
  );
}

export function formatGitHubReleaseResult(
  result: GitHubReleaseCommandResult,
  projectRoot: string = process.cwd()
): string {
  const plan = result.plan;
  const execution = result.result;
  const inspection = result.inspection;
  const lines = [
    result.status === "approval_required"
      ? "Kairon GitHub release plan created."
      : result.status === "published"
        ? "Kairon GitHub release published."
        : result.status === "verified"
          ? "Kairon GitHub release verified."
          : result.status === "setup_required"
            ? "Kairon GitHub release setup required."
            : result.status === "blocked"
              ? "Kairon GitHub release blocked."
              : "Kairon GitHub release failed.",
    `status=${result.status}`,
    ...(plan === undefined ? [] : [
      `plan_id=${plan.plan_id}`,
      `approval_id=${plan.approval_id}`,
      `repository=${plan.repository}`,
      `tag=${plan.tag}`,
      `source_commit=${plan.source_commit}`,
      `prerelease=${plan.prerelease}`,
      `assets=${plan.assets.length}`,
      `plan_artifact=${projectRelativePath(projectRoot, githubReleasePlanPath(projectRoot, plan.plan_id))}`
    ]),
    ...(execution === undefined ? [] : [
      `plan_id=${execution.plan_id}`,
      `repository=${execution.repository}`,
      `tag=${execution.tag}`,
      `release_id=${execution.release_id ?? "none"}`,
      `assets=${execution.assets.length}`,
      `attempts=${execution.attempts}`,
      `idempotent=${execution.idempotent}`,
      `result_artifact=${projectRelativePath(projectRoot, githubReleaseResultPath(projectRoot, execution.plan_id))}`
    ]),
    ...(inspection === undefined ? [] : [
      `repository=${inspection.repository}`,
      `branch=${inspection.branch}`,
      `branch_sha=${inspection.branch_sha}`,
      `tag_sha=${inspection.tag?.sha ?? "missing"}`,
      `release_id=${inspection.release?.id ?? "missing"}`
    ]),
    ...(result.assets === undefined ? [] : [`verified_assets=${result.assets.length}`]),
    ...(result.reason === undefined ? [] : [`reason=${result.reason}`]),
    ...(result.http_status === undefined ? [] : [`http_status=${result.http_status}`]),
    `execution_performed=${result.execution_performed}`
  ];
  return [...new Set(lines)].join("\n");
}

function planDigestMatches(plan: GitHubReleasePlan): boolean {
  const { plan_digest: _digest, ...withoutDigest } = plan;
  return calculatePlanDigest(withoutDigest) === plan.plan_digest;
}

function calculatePlanDigest(value: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function readOptionalGitHubReleaseResult(
  projectRoot: string,
  planId: string
): Promise<GitHubReleaseResult | null> {
  try {
    return await readJsonFile<GitHubReleaseResult>(
      githubReleaseResultPath(projectRoot, planId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function classifyClientFailure(error: unknown): {
  status: "setup_required" | "blocked" | "failed";
  reason: string;
  http_status?: number;
  retryable: boolean;
} {
  if (!(error instanceof GitHubReleaseClientError)) {
    return { status: "failed", reason: "github_release_client_error", retryable: true };
  }
  const reason = `github_${error.operation}_${error.kind}`;
  if (["auth_error", "permission_error", "not_found"].includes(error.kind)) {
    return {
      status: "setup_required",
      reason,
      http_status: error.httpStatus,
      retryable: false
    };
  }
  if (["conflict", "validation_error"].includes(error.kind)) {
    return {
      status: "blocked",
      reason,
      http_status: error.httpStatus,
      retryable: false
    };
  }
  return {
    status: "failed",
    reason,
    http_status: error.httpStatus,
    retryable: true
  };
}

function clientFailure(
  error: unknown,
  executionPerformed: boolean
): GitHubReleaseCommandResult {
  const classified = classifyClientFailure(error);
  return {
    status: classified.status,
    reason: classified.reason,
    http_status: classified.http_status,
    execution_performed: executionPerformed
  };
}

function outcome(
  status: "blocked" | "setup_required" | "failed",
  reason: string,
  extra: Partial<GitHubReleaseCommandResult> = {}
): GitHubReleaseCommandResult {
  return {
    status,
    reason,
    execution_performed: false,
    ...extra
  };
}

function releaseBody(plan: GitHubReleasePlan): string {
  return [
    expectedReleaseName(plan.version, plan.prerelease),
    "",
    `Source commit: ${plan.source_commit}`,
    `Release plan: ${plan.plan_id}`,
    "",
    "Install and rollback instructions are included in docs/installation.md."
  ].join("\n");
}

function expectedReleaseName(version: string, prerelease: boolean): string {
  return prerelease ? `Kairon ${version} Local Beta` : `Kairon ${version}`;
}

function projectRelativePath(projectRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Release artifact escapes project root: ${filePath}`);
  }
  return toPosixPath(relative);
}

function validatePlanId(value: string): string {
  const planId = value.trim();
  if (!releasePlanPattern.test(planId)) {
    throw new Error(`Invalid GitHub release plan id: ${value}`);
  }
  return planId;
}

function validateRepository(value: string): string {
  const repository = value.trim();
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) {
    throw new Error(`Invalid GitHub repository: ${value}`);
  }
  return repository;
}

function validateRef(value: string, label: string): string {
  const ref = value.trim();
  if (
    ref.length === 0 ||
    ref.includes("..") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/u.test(ref)
  ) {
    throw new Error(`Invalid GitHub ${label}: ${value}`);
  }
  return ref;
}

function validateVersion(value: string): string {
  const version = value.trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

function safeLocalError(error: unknown): string {
  const message = error instanceof Error ? error.message : "local_release_validation_failed";
  return /^[a-z0-9_]+$/u.test(message) ? message : "local_release_validation_failed";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
