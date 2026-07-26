import { createHash } from "node:crypto";
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
  type GitHubReleaseClient,
  type GitHubReleaseInspection,
  type GitHubReleaseRecord
} from "../github/release-client.js";
import { StateApplier } from "../state/state-applier.js";
import {
  collectVerifiedRemoteAssets,
  loadLocalReleaseBundle,
  type GitHubReleasePlannedAsset,
  type LocalReleaseBundle
} from "./github-release.js";
import {
  recordStableReleasePromotion,
  stableReleasePointerPath
} from "../update/registry.js";

export type StablePromotionAsset = {
  id: number;
  name: string;
  size_bytes: number;
  sha256: string;
};

export type StablePromotionPlan = {
  schema_version: "0.1";
  artifact_kind: "stable_release_promotion_plan";
  plan_id: string;
  status: "approval_required";
  repository: string;
  base_branch: string;
  artifact_dir?: string;
  version: string;
  tag: string;
  source_commit: string;
  release_id: number;
  prerelease_name: string;
  stable_name: string;
  assets: StablePromotionAsset[];
  sbom_sha256: string;
  provenance_sha256: string;
  approval_id: string;
  correlation_id: string;
  expires_at: string;
  plan_digest: string;
  created_at: string;
};

export type StablePromotionResult = {
  schema_version: "0.1";
  artifact_kind: "stable_release_promotion_result";
  plan_id: string;
  status:
    | "promoted"
    | "already_promoted"
    | "blocked"
    | "setup_required"
    | "failed";
  repository: string;
  version: string;
  tag: string;
  source_commit: string;
  release_id: number;
  assets: StablePromotionAsset[];
  approval_id: string;
  correlation_id: string;
  attempts: number;
  idempotent: boolean;
  error_code?: string;
  http_status?: number;
  retryable?: boolean;
  stable_pointer_path?: string;
  created_at: string;
  updated_at: string;
};

export type StablePromotionCommandResult = {
  status:
    | "approval_required"
    | "promoted"
    | "already_promoted"
    | "blocked"
    | "setup_required"
    | "failed";
  reason?: string;
  http_status?: number;
  plan?: StablePromotionPlan;
  result?: StablePromotionResult;
  inspection?: GitHubReleaseInspection;
  execution_performed: boolean;
};

export type StablePromotionPlanRequest = {
  version: string;
  repository: string;
  baseBranch?: string;
  artifactDir?: string;
  expiresInMinutes?: number;
  tokenEnv?: string;
};

export type StablePromotionApplyRequest = {
  planId: string;
  approvalId?: string;
  confirm?: string;
  tokenEnv?: string;
};

export type StablePromotionDependencies = {
  env?: NodeJS.ProcessEnv;
  resolver?: SecretResolver;
  client?: GitHubReleaseClient;
  commandRunner?: CommandRunner;
  now?: () => Date;
};

type SourceState = {
  clean: boolean;
  commit: string | null;
};

class PromotionBlockError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PromotionBlockError";
  }
}

const planPattern = /^REL-\d{4,}$/u;
const defaultExpiryMinutes = 30;

export async function planStablePromotion(
  projectRoot: string,
  request: StablePromotionPlanRequest,
  deps: StablePromotionDependencies = {}
): Promise<StablePromotionCommandResult> {
  const version = validateVersion(request.version);
  const repository = validateRepository(request.repository);
  const baseBranch = validateRef(request.baseBranch ?? "main", "base branch");
  const expiryMinutes = validateExpiryMinutes(
    request.expiresInMinutes ?? defaultExpiryMinutes
  );
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
      artifactDir: request.artifactDir,
      requireAttestations: true
    });
  } catch (error) {
    return outcome("blocked", safeErrorCode(error));
  }
  const source = await collectSourceState(
    projectRoot,
    deps.commandRunner ?? spawnCommandRunner
  );
  if (!source.clean) {
    return outcome("blocked", "tracked_worktree_dirty");
  }
  if (source.commit !== bundle.sourceCommit) {
    return outcome("blocked", "local_source_commit_mismatch");
  }

  const client = deps.client ?? defaultGitHubReleaseClient;
  let inspection: GitHubReleaseInspection;
  let assets: StablePromotionAsset[];
  try {
    inspection = await client.inspect({
      repository,
      branch: baseBranch,
      tag: `v${version}`,
      token: token.value
    });
    assets = await validateAndCaptureRemote(
      inspection,
      bundle,
      client,
      token.value,
      "prerelease"
    );
  } catch (error) {
    return preflightFailure(error);
  }

  const now = deps.now?.() ?? new Date();
  const planId = await nextId(projectRoot, "release");
  const approvalId = await nextId(projectRoot, "approval");
  const correlationId = await nextId(projectRoot, "correlation");
  const base = {
    schema_version: "0.1" as const,
    artifact_kind: "stable_release_promotion_plan" as const,
    plan_id: planId,
    status: "approval_required" as const,
    repository,
    base_branch: baseBranch,
    ...(request.artifactDir === undefined
      ? {}
      : { artifact_dir: request.artifactDir }),
    version,
    tag: `v${version}`,
    source_commit: bundle.sourceCommit,
    release_id: inspection.release!.id,
    prerelease_name: prereleaseName(version),
    stable_name: stableName(version),
    assets,
    sbom_sha256: bundle.attestations!.sbom.sha256,
    provenance_sha256: bundle.attestations!.provenance.sha256,
    approval_id: approvalId,
    correlation_id: correlationId,
    expires_at: new Date(now.getTime() + expiryMinutes * 60_000).toISOString(),
    created_at: now.toISOString()
  };
  const plan: StablePromotionPlan = {
    ...base,
    plan_digest: calculateDigest(base)
  };
  const planPath = stablePromotionPlanPath(projectRoot, planId);
  const artifactPath = projectRelativePath(projectRoot, planPath);
  await writeJsonFileAtomic(planPath, plan);
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    actor: "stable-release-promotion-plan",
    payload: {
      approval: {
        id: approvalId,
        correlation_id: correlationId,
        type: "github_release_promote",
        title: `Promote ${plan.tag} to Stable in ${repository}`,
        actions: ["approve", "reject", "request_changes", "snooze"],
        risk_level: "high",
        approval_required_for: "github_release_promote",
        operation: "github_release_promote",
        plan_id: planId,
        plan_digest: plan.plan_digest,
        artifact_path: artifactPath,
        repository,
        target_branch: baseBranch,
        source_commit: plan.source_commit,
        tag: plan.tag,
        release_id: plan.release_id,
        assets: plan.assets,
        expires_at: plan.expires_at,
        confirmation: {
          status: "required",
          action: "approve",
          required_by: "board",
          reason: "stable_release_promotion_high_risk"
        }
      }
    }
  });
  await trackCorrelationMember(projectRoot, {
    correlationId,
    approvalId,
    kind: "stable_promotion_plan",
    id: planId,
    status: plan.status,
    artifactPath,
    createdAt: plan.created_at
  });
  return {
    status: "approval_required",
    plan,
    inspection,
    execution_performed: false
  };
}

export async function applyStablePromotion(
  projectRoot: string,
  request: StablePromotionApplyRequest,
  deps: StablePromotionDependencies = {}
): Promise<StablePromotionCommandResult> {
  let plan: StablePromotionPlan;
  try {
    plan = await readStablePromotionPlan(projectRoot, request.planId);
  } catch {
    return outcome("blocked", "promotion_plan_not_found");
  }
  if (request.confirm !== plan.plan_id) {
    return outcome("blocked", "exact_confirmation_required");
  }
  if (request.approvalId !== plan.approval_id) {
    return outcome("blocked", "approval_id_mismatch");
  }
  if (!planDigestMatches(plan)) {
    return outcome("blocked", "promotion_plan_digest_mismatch");
  }
  const now = deps.now?.() ?? new Date();
  if (Date.parse(plan.expires_at) <= now.getTime()) {
    return persistFailure(projectRoot, plan, {
      status: "blocked",
      errorCode: "promotion_plan_expired",
      retryable: false,
      now
    });
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
    approval.artifact_path !== projectRelativePath(
      projectRoot,
      stablePromotionPlanPath(projectRoot, plan.plan_id)
    )
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
      now
    });
  }
  const source = await collectSourceState(
    projectRoot,
    deps.commandRunner ?? spawnCommandRunner
  );
  if (!source.clean || source.commit !== plan.source_commit) {
    return persistFailure(projectRoot, plan, {
      status: "blocked",
      errorCode: !source.clean
        ? "tracked_worktree_dirty"
        : "local_source_commit_mismatch",
      retryable: false,
      now
    });
  }
  try {
    const bundle = await loadLocalReleaseBundle(projectRoot, {
      version: plan.version,
      artifactDir: plan.artifact_dir,
      requireAttestations: true
    });
    assertLocalPlanBinding(plan, bundle);
  } catch (error) {
    return persistFailure(projectRoot, plan, {
      status: "blocked",
      errorCode: error instanceof PromotionBlockError
        ? error.code
        : safeErrorCode(error),
      retryable: false,
      now
    });
  }

  return withResourceLock(
    projectRoot,
    stablePromotionPlanPath(projectRoot, plan.plan_id),
    { owner: "stable-release-promotion", ttlMs: 300_000 },
    async () => executePromotion(projectRoot, plan, token.value, deps)
  );
}

async function executePromotion(
  projectRoot: string,
  plan: StablePromotionPlan,
  token: string,
  deps: StablePromotionDependencies
): Promise<StablePromotionCommandResult> {
  const client = deps.client ?? defaultGitHubReleaseClient;
  const existing = await readOptionalResult(projectRoot, plan.plan_id);
  const attempts = (existing?.attempts ?? 0) + 1;
  const now = deps.now?.() ?? new Date();
  let inspection: GitHubReleaseInspection | undefined;
  let mutationPerformed = false;
  try {
    if (Date.parse(plan.expires_at) <= now.getTime()) {
      throw new PromotionBlockError("promotion_plan_expired");
    }
    if (!planDigestMatches(plan)) {
      throw new PromotionBlockError("promotion_plan_digest_mismatch");
    }
    const source = await collectSourceState(
      projectRoot,
      deps.commandRunner ?? spawnCommandRunner
    );
    if (!source.clean) {
      throw new PromotionBlockError("tracked_worktree_dirty");
    }
    if (source.commit !== plan.source_commit) {
      throw new PromotionBlockError("local_source_commit_mismatch");
    }
    const bundle = await loadLocalReleaseBundle(projectRoot, {
      version: plan.version,
      artifactDir: plan.artifact_dir,
      requireAttestations: true
    });
    assertLocalPlanBinding(plan, bundle);
    inspection = await client.inspect({
      repository: plan.repository,
      branch: plan.base_branch,
      tag: plan.tag,
      token
    });
    const remoteState = stableState(inspection, plan);
    if (remoteState === "stable") {
      const assets = await validateAndCaptureRemote(
        inspection,
        bundle,
        client,
        token,
        "stable",
        plan
      );
      const result = await persistSuccess(
        projectRoot,
        plan,
        assets,
        "already_promoted",
        attempts,
        true,
        now
      );
      return {
        status: "already_promoted",
        result,
        inspection,
        execution_performed: false
      };
    }
    await validateAndCaptureRemote(
      inspection,
      bundle,
      client,
      token,
      "prerelease",
      plan
    );
    await client.promoteRelease({
      repository: plan.repository,
      releaseId: plan.release_id,
      name: plan.stable_name,
      token
    });
    mutationPerformed = true;
    const verifiedInspection = await client.inspect({
      repository: plan.repository,
      branch: plan.base_branch,
      tag: plan.tag,
      token
    });
    const assets = await validateAndCaptureRemote(
      verifiedInspection,
      bundle,
      client,
      token,
      "stable",
      plan
    );
    const result = await persistSuccess(
      projectRoot,
      plan,
      assets,
      "promoted",
      attempts,
      false,
      now
    );
    return {
      status: "promoted",
      result,
      inspection: verifiedInspection,
      execution_performed: true
    };
  } catch (error) {
    const failure = classifyFailure(error);
    return persistFailure(projectRoot, plan, {
      status: failure.status,
      errorCode: failure.reason,
      retryable: failure.retryable,
      httpStatus: failure.httpStatus,
      attempts,
      executionPerformed: mutationPerformed,
      inspection,
      now
    });
  }
}

async function validateAndCaptureRemote(
  inspection: GitHubReleaseInspection,
  bundle: LocalReleaseBundle,
  client: GitHubReleaseClient,
  token: string,
  expectedState: "prerelease" | "stable",
  plan?: StablePromotionPlan
): Promise<StablePromotionAsset[]> {
  if (inspection.branch_sha !== bundle.sourceCommit) {
    throw new PromotionBlockError("remote_branch_sha_drift");
  }
  if (inspection.tag === null) {
    throw new PromotionBlockError("release_tag_missing");
  }
  if (inspection.tag.sha !== bundle.sourceCommit) {
    throw new PromotionBlockError("tag_sha_drift");
  }
  const release = inspection.release;
  if (release === null) {
    throw new PromotionBlockError("github_release_missing");
  }
  if (plan !== undefined && release.id !== plan.release_id) {
    throw new PromotionBlockError("release_id_drift");
  }
  if (release.tag_name !== inspection.tag.name) {
    throw new PromotionBlockError("release_tag_drift");
  }
  if (release.draft) {
    throw new PromotionBlockError("release_is_draft");
  }
  if (
    expectedState === "prerelease" &&
    (!release.prerelease || release.name !== prereleaseName(bundle.version))
  ) {
    throw new PromotionBlockError("prerelease_state_drift");
  }
  if (
    expectedState === "stable" &&
    (release.prerelease || release.name !== stableName(bundle.version))
  ) {
    throw new PromotionBlockError("stable_state_mismatch");
  }
  assertExactAssetNames(release, bundle.assets);
  let verified;
  try {
    verified = await collectVerifiedRemoteAssets(
      release,
      bundle.assets,
      inspection.repository,
      client,
      token
    );
  } catch {
    throw new PromotionBlockError("release_asset_digest_drift");
  }
  const assets = verified.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (plan !== undefined) {
    if (JSON.stringify(assets) !== JSON.stringify(plan.assets)) {
      throw new PromotionBlockError("release_asset_identity_drift");
    }
  }
  return assets;
}

function assertExactAssetNames(
  release: GitHubReleaseRecord,
  planned: GitHubReleasePlannedAsset[]
): void {
  const actualNames = release.assets.map((asset) => asset.name).sort();
  const expectedNames = planned.map((asset) => asset.name).sort();
  if (
    new Set(actualNames).size !== actualNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    const hasUnexpected = actualNames.some((name) => !expectedNames.includes(name));
    throw new PromotionBlockError(
      hasUnexpected ? "unexpected_remote_asset" : "release_asset_missing"
    );
  }
}

function assertLocalPlanBinding(
  plan: StablePromotionPlan,
  bundle: LocalReleaseBundle
): void {
  if (
    bundle.sourceCommit !== plan.source_commit ||
    bundle.version !== plan.version ||
    bundle.attestations === undefined ||
    bundle.attestations.sbom.sha256 !== plan.sbom_sha256 ||
    bundle.attestations.provenance.sha256 !== plan.provenance_sha256
  ) {
    throw new PromotionBlockError("local_release_binding_drift");
  }
  const expected = bundle.assets.map((asset) => ({
    name: asset.name,
    size_bytes: asset.size_bytes,
    sha256: asset.sha256
  })).sort((left, right) => left.name.localeCompare(right.name));
  const planned = plan.assets.map(({ id: _id, ...asset }) => asset);
  if (JSON.stringify(expected) !== JSON.stringify(planned)) {
    throw new PromotionBlockError("local_release_asset_drift");
  }
}

function stableState(
  inspection: GitHubReleaseInspection,
  plan: StablePromotionPlan
): "stable" | "prerelease" {
  const release = inspection.release;
  if (
    release !== null &&
    release.id === plan.release_id &&
    !release.draft &&
    !release.prerelease &&
    release.name === plan.stable_name
  ) {
    return "stable";
  }
  return "prerelease";
}

async function persistSuccess(
  projectRoot: string,
  plan: StablePromotionPlan,
  assets: StablePromotionAsset[],
  status: "promoted" | "already_promoted",
  attempts: number,
  idempotent: boolean,
  now: Date
): Promise<StablePromotionResult> {
  const pointerPath = await recordStableReleasePromotion(projectRoot, {
    schema_version: "0.1",
    artifact_kind: "stable_release_pointer",
    repository: plan.repository,
    base_branch: plan.base_branch,
    version: plan.version,
    tag: plan.tag,
    source_commit: plan.source_commit,
    release_id: plan.release_id,
    promotion_plan_id: plan.plan_id,
    promotion_plan_digest: plan.plan_digest,
    sbom_sha256: plan.sbom_sha256,
    provenance_sha256: plan.provenance_sha256,
    promoted_at: now.toISOString()
  });
  return persistResult(projectRoot, plan, {
    status,
    assets,
    attempts,
    idempotent,
    stablePointerPath: projectRelativePath(projectRoot, pointerPath),
    now
  });
}

async function persistFailure(
  projectRoot: string,
  plan: StablePromotionPlan,
  input: {
    status: "blocked" | "setup_required" | "failed";
    errorCode: string;
    retryable: boolean;
    httpStatus?: number;
    attempts?: number;
    executionPerformed?: boolean;
    inspection?: GitHubReleaseInspection;
    now: Date;
  }
): Promise<StablePromotionCommandResult> {
  const result = await persistResult(projectRoot, plan, {
    status: input.status,
    assets: [],
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
  plan: StablePromotionPlan,
  input: {
    status: StablePromotionResult["status"];
    assets: StablePromotionAsset[];
    attempts?: number;
    idempotent: boolean;
    errorCode?: string;
    httpStatus?: number;
    retryable?: boolean;
    stablePointerPath?: string;
    now: Date;
  }
): Promise<StablePromotionResult> {
  const existing = await readOptionalResult(projectRoot, plan.plan_id);
  const timestamp = input.now.toISOString();
  const result: StablePromotionResult = {
    schema_version: "0.1",
    artifact_kind: "stable_release_promotion_result",
    plan_id: plan.plan_id,
    status: input.status,
    repository: plan.repository,
    version: plan.version,
    tag: plan.tag,
    source_commit: plan.source_commit,
    release_id: plan.release_id,
    assets: input.assets,
    approval_id: plan.approval_id,
    correlation_id: plan.correlation_id,
    attempts: input.attempts ?? (existing?.attempts ?? 0) + 1,
    idempotent: input.idempotent,
    error_code: input.errorCode,
    http_status: input.httpStatus,
    retryable: input.retryable,
    stable_pointer_path: input.stablePointerPath,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  };
  const resultPath = stablePromotionResultPath(projectRoot, plan.plan_id);
  await writeJsonFileAtomic(resultPath, result);
  await trackCorrelationMember(projectRoot, {
    correlationId: plan.correlation_id,
    approvalId: plan.approval_id,
    kind: "stable_promotion_result",
    id: plan.plan_id,
    status: result.status,
    artifactPath: projectRelativePath(projectRoot, resultPath),
    createdAt: timestamp
  });
  return result;
}

export async function readStablePromotionPlan(
  projectRoot: string,
  planId: string
): Promise<StablePromotionPlan> {
  const normalized = validatePlanId(planId);
  const plan = await readJsonFile<StablePromotionPlan>(
    stablePromotionPlanPath(projectRoot, normalized)
  );
  if (
    plan.schema_version !== "0.1" ||
    plan.artifact_kind !== "stable_release_promotion_plan" ||
    plan.plan_id !== normalized ||
    !Number.isFinite(Date.parse(plan.expires_at))
  ) {
    throw new Error(`Invalid stable promotion plan: ${planId}`);
  }
  return plan;
}

export function stablePromotionPlanPath(
  projectRoot: string,
  planId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "release",
    "github",
    "promotions",
    "plans",
    `${validatePlanId(planId)}.json`
  );
}

export function stablePromotionResultPath(
  projectRoot: string,
  planId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "release",
    "github",
    "promotions",
    "results",
    `${validatePlanId(planId)}.json`
  );
}

export function formatStablePromotionResult(
  result: StablePromotionCommandResult,
  projectRoot: string = process.cwd()
): string {
  const plan = result.plan;
  const execution = result.result;
  return [
    result.status === "approval_required"
      ? "Kairon Stable promotion plan created."
      : result.status === "promoted"
        ? "Kairon GitHub prerelease promoted to Stable."
        : result.status === "already_promoted"
          ? "Kairon GitHub release is already Stable and verified."
          : result.status === "setup_required"
            ? "Kairon Stable promotion setup required."
            : result.status === "blocked"
              ? "Kairon Stable promotion blocked."
              : "Kairon Stable promotion failed.",
    `status=${result.status}`,
    ...(plan === undefined ? [] : [
      `plan_id=${plan.plan_id}`,
      `approval_id=${plan.approval_id}`,
      `repository=${plan.repository}`,
      `release_id=${plan.release_id}`,
      `tag=${plan.tag}`,
      `source_commit=${plan.source_commit}`,
      `assets=${plan.assets.length}`,
      `expires_at=${plan.expires_at}`,
      `plan_artifact=${projectRelativePath(
        projectRoot,
        stablePromotionPlanPath(projectRoot, plan.plan_id)
      )}`
    ]),
    ...(execution === undefined ? [] : [
      `plan_id=${execution.plan_id}`,
      `repository=${execution.repository}`,
      `release_id=${execution.release_id}`,
      `tag=${execution.tag}`,
      `assets=${execution.assets.length}`,
      `attempts=${execution.attempts}`,
      `idempotent=${execution.idempotent}`,
      `result_artifact=${projectRelativePath(
        projectRoot,
        stablePromotionResultPath(projectRoot, execution.plan_id)
      )}`,
      `stable_pointer=${execution.stable_pointer_path ?? projectRelativePath(
        projectRoot,
        stableReleasePointerPath(projectRoot)
      )}`
    ]),
    ...(result.reason === undefined ? [] : [`reason=${result.reason}`]),
    ...(result.http_status === undefined ? [] : [`http_status=${result.http_status}`]),
    `execution_performed=${result.execution_performed}`
  ].join("\n");
}

async function collectSourceState(
  projectRoot: string,
  runner: CommandRunner
): Promise<SourceState> {
  const status = await runner({
    command: "git",
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: projectRoot
  });
  if (status.exitCode !== 0 || status.timedOut) {
    return { clean: false, commit: null };
  }
  const revision = await runner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot
  });
  const commit = revision.stdout.trim().toLowerCase();
  return {
    clean: status.stdout.trim().length === 0,
    commit: revision.exitCode === 0 &&
      !revision.timedOut &&
      /^[a-f0-9]{40,64}$/u.test(commit)
      ? commit
      : null
  };
}

function planDigestMatches(plan: StablePromotionPlan): boolean {
  const { plan_digest: _digest, ...withoutDigest } = plan;
  return calculateDigest(withoutDigest) === plan.plan_digest;
}

function calculateDigest(value: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function readOptionalResult(
  projectRoot: string,
  planId: string
): Promise<StablePromotionResult | null> {
  try {
    return await readJsonFile<StablePromotionResult>(
      stablePromotionResultPath(projectRoot, planId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function preflightFailure(error: unknown): StablePromotionCommandResult {
  const failure = classifyFailure(error);
  return {
    status: failure.status,
    reason: failure.reason,
    http_status: failure.httpStatus,
    execution_performed: false
  };
}

function classifyFailure(error: unknown): {
  status: "setup_required" | "blocked" | "failed";
  reason: string;
  httpStatus?: number;
  retryable: boolean;
} {
  if (error instanceof PromotionBlockError) {
    return {
      status: "blocked",
      reason: error.code,
      retryable: false
    };
  }
  if (error instanceof GitHubReleaseClientError) {
    const reason = `github_${error.operation}_${error.kind}`;
    if (["auth_error", "permission_error", "not_found"].includes(error.kind)) {
      return {
        status: "setup_required",
        reason,
        httpStatus: error.httpStatus,
        retryable: false
      };
    }
    if (["conflict", "validation_error"].includes(error.kind)) {
      return {
        status: "blocked",
        reason,
        httpStatus: error.httpStatus,
        retryable: false
      };
    }
    return {
      status: "failed",
      reason,
      httpStatus: error.httpStatus,
      retryable: true
    };
  }
  return {
    status: "failed",
    reason: "stable_promotion_client_error",
    retryable: true
  };
}

function outcome(
  status: "blocked" | "setup_required" | "failed",
  reason: string
): StablePromotionCommandResult {
  return {
    status,
    reason,
    execution_performed: false
  };
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message)
    ? message
    : "invalid_local_release_bundle";
}

function prereleaseName(version: string): string {
  return `Kairon ${version} Local Beta`;
}

function stableName(version: string): string {
  return `Kairon ${version}`;
}

function projectRelativePath(projectRoot: string, filePath: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Promotion artifact escapes project root: ${filePath}`);
  }
  return toPosixPath(relative);
}

function validatePlanId(value: string): string {
  const planId = value.trim();
  if (!planPattern.test(planId)) {
    throw new Error(`Invalid Stable promotion plan id: ${value}`);
  }
  return planId;
}

function validateVersion(value: string): string {
  const version = value.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

function validateRepository(value: string): string {
  const repository = value.trim();
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
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

function validateExpiryMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_440) {
    throw new Error("Stable promotion expiry must be an integer from 1 to 1440 minutes.");
  }
  return value;
}
