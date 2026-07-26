import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { nextId } from "../core/ids/counter.js";
import {
  resolveGitHubTokenSecret,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import {
  defaultGitHubReleaseClient,
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
  type GitHubReleaseRecord
} from "../github/release-client.js";
import {
  parseReleaseManifestContent,
  verifyReleaseManifest,
  type ReleaseManifest
} from "../release/release-manifest.js";
import {
  compareCoreVersions,
  isVersionAllowedByChannel,
  parseCoreVersion,
  requireUpdateChannel,
  type UpdateChannelConfig
} from "./channel.js";
import {
  findVerifiedUpdateDownloadByVersion,
  loadUpdateRegistry,
  readVerifiedUpdateDownload,
  recordSuccessfulUpdate,
  writeVerifiedUpdateDownload,
  type UpdateRegistry,
  type VerifiedUpdateDownload
} from "./registry.js";
import {
  beginUpdateTransaction,
  finalizeUpdateTransaction,
  type UpdateTransactionArtifact,
  type UpdateTransactionDependencies,
  type UpdateTransactionPhase
} from "./transaction.js";

export type UpdateDependencies = {
  releaseClient?: GitHubReleaseClient;
  secretResolver?: SecretResolver;
  env?: NodeJS.ProcessEnv;
  cacheRoot?: string;
  commandRunner?: CommandRunner;
  updateScriptPath?: string;
  powershellCommand?: string;
  now?: () => Date;
  transaction?: UpdateTransactionDependencies;
};

export type UpdateNetworkOptions = {
  tokenEnv?: string;
};

export type UpdateCheckResult = {
  schema_version: "0.1";
  status: "update_available" | "current" | "downgrade_available";
  channel: UpdateChannelConfig["channel"];
  repository: string;
  current_version: string;
  selected_version: string;
  selected_tag: string;
  selected_source_commit: string;
  prerelease: boolean;
  filesystem_changed: false;
  automatic_updates: false;
};

export type UpdateDownloadResult = {
  schema_version: "0.1";
  status: "downloaded";
  download: VerifiedUpdateDownload;
  metadata_path: string;
};

export type UpdateApplyOptions = {
  confirm?: string;
  dryRun?: boolean;
  timeoutMs?: number;
};

export type UpdateApplyResult = {
  schema_version: "0.1";
  status: "would_apply" | "completed";
  action: "apply" | "rollback";
  current_version: string;
  target_version: string;
  download_id: string;
  confirmation: string;
  downgrade: boolean;
  major_change: boolean;
  registry: UpdateRegistry;
  transaction: UpdateTransactionArtifact | null;
};

type RemoteUpdateCandidate = {
  release: GitHubReleaseRecord;
  version: string;
  tag: string;
  sourceCommit: string;
  manifest: ReleaseManifest;
  assets: {
    package: GitHubReleaseAsset;
    checksumManifest: GitHubReleaseAsset;
    releaseManifest: GitHubReleaseAsset;
    sbom?: GitHubReleaseAsset;
    provenance?: GitHubReleaseAsset;
  };
  manifestBytes: Uint8Array;
};

export async function checkForUpdate(
  projectRoot: string,
  currentVersion: string,
  options: UpdateNetworkOptions = {},
  deps: UpdateDependencies = {}
): Promise<UpdateCheckResult> {
  parseCoreVersion(currentVersion);
  const config = await requireUpdateChannel(projectRoot);
  const token = await requireGitHubToken(options, deps);
  const candidate = await selectRemoteCandidate(config, undefined, token, deps);
  const comparison = compareCoreVersions(candidate.version, currentVersion);
  return {
    schema_version: "0.1",
    status: comparison > 0
      ? "update_available"
      : comparison < 0
        ? "downgrade_available"
        : "current",
    channel: config.channel,
    repository: config.repository,
    current_version: currentVersion,
    selected_version: candidate.version,
    selected_tag: candidate.tag,
    selected_source_commit: candidate.sourceCommit,
    prerelease: candidate.release.prerelease,
    filesystem_changed: false,
    automatic_updates: false
  };
}

export async function downloadUpdate(
  projectRoot: string,
  version: string,
  options: UpdateNetworkOptions = {},
  deps: UpdateDependencies = {}
): Promise<UpdateDownloadResult> {
  parseCoreVersion(version);
  const config = await requireUpdateChannel(projectRoot);
  const token = await requireGitHubToken(options, deps);
  const candidate = await selectRemoteCandidate(config, version, token, deps);
  const downloadId = await nextId(projectRoot, "update_download");
  const cacheRoot = resolveUpdateCacheRoot(projectRoot, deps.cacheRoot);
  const stagingDirectory = path.join(cacheRoot, `.partial-${downloadId}`);
  const finalDirectory = path.join(cacheRoot, version, downloadId);
  const packagePath = path.join(finalDirectory, candidate.manifest.artifact.package_file);
  const checksumManifestPath = path.join(
    finalDirectory,
    candidate.manifest.artifact.checksum_manifest_file
  );
  const releaseManifestPath = path.join(finalDirectory, "release-manifest.json");
  const sbomPath = candidate.manifest.attestations === undefined
    ? undefined
    : path.join(finalDirectory, candidate.manifest.attestations.sbom.file);
  const provenancePath = candidate.manifest.attestations === undefined
    ? undefined
    : path.join(finalDirectory, candidate.manifest.attestations.provenance.file);
  const releaseClient = deps.releaseClient ?? defaultGitHubReleaseClient;

  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });
  try {
    const packageBytes = await releaseClient.downloadAsset({
      repository: config.repository,
      assetId: candidate.assets.package.id,
      token
    });
    const checksumBytes = await releaseClient.downloadAsset({
      repository: config.repository,
      assetId: candidate.assets.checksumManifest.id,
      token
    });
    const sbomBytes = candidate.assets.sbom === undefined
      ? undefined
      : await releaseClient.downloadAsset({
          repository: config.repository,
          assetId: candidate.assets.sbom.id,
          token
        });
    const provenanceBytes = candidate.assets.provenance === undefined
      ? undefined
      : await releaseClient.downloadAsset({
          repository: config.repository,
          assetId: candidate.assets.provenance.id,
          token
        });
    verifyRemoteAssetBytes(candidate.assets.package, packageBytes);
    verifyRemoteAssetBytes(candidate.assets.checksumManifest, checksumBytes);
    if (candidate.assets.sbom !== undefined && sbomBytes !== undefined) {
      verifyRemoteAssetBytes(candidate.assets.sbom, sbomBytes);
    }
    if (candidate.assets.provenance !== undefined && provenanceBytes !== undefined) {
      verifyRemoteAssetBytes(candidate.assets.provenance, provenanceBytes);
    }
    await writeFile(
      path.join(stagingDirectory, candidate.manifest.artifact.package_file),
      packageBytes
    );
    await writeFile(
      path.join(stagingDirectory, candidate.manifest.artifact.checksum_manifest_file),
      checksumBytes
    );
    await writeFile(
      path.join(stagingDirectory, "release-manifest.json"),
      candidate.manifestBytes
    );
    if (
      candidate.manifest.attestations !== undefined &&
      sbomBytes !== undefined &&
      provenanceBytes !== undefined
    ) {
      await writeFile(
        path.join(stagingDirectory, candidate.manifest.attestations.sbom.file),
        sbomBytes
      );
      await writeFile(
        path.join(stagingDirectory, candidate.manifest.attestations.provenance.file),
        provenanceBytes
      );
    }

    const stagedVerification = await verifyReleaseManifest(
      path.join(stagingDirectory, "release-manifest.json"),
      path.join(stagingDirectory, candidate.manifest.artifact.package_file),
      path.join(stagingDirectory, candidate.manifest.artifact.checksum_manifest_file)
    );
    if (!stagedVerification.ok || stagedVerification.source_commit !== candidate.sourceCommit) {
      throw new Error("Downloaded update failed release manifest verification.");
    }
    await mkdir(path.dirname(finalDirectory), { recursive: true });
    await rename(stagingDirectory, finalDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  const packageInfo = await stat(packagePath);
  const download: VerifiedUpdateDownload = {
    schema_version: "0.1",
    artifact_kind: "verified_update_download",
    download_id: downloadId,
    repository: config.repository,
    release_id: candidate.release.id,
    release_channel: candidate.release.prerelease ? "beta" : "stable",
    version,
    tag: candidate.tag,
    source_commit: candidate.sourceCommit,
    package_sha256: candidate.manifest.artifact.sha256,
    package_size_bytes: packageInfo.size,
    cache_directory: finalDirectory,
    package_path: packagePath,
    checksum_manifest_path: checksumManifestPath,
    release_manifest_path: releaseManifestPath,
    ...(sbomPath === undefined ? {} : { sbom_path: sbomPath }),
    ...(provenancePath === undefined ? {} : { provenance_path: provenancePath }),
    downloaded_at: (deps.now?.() ?? new Date()).toISOString()
  };
  await verifyDownloadedUpdate(download);
  const metadataPath = await writeVerifiedUpdateDownload(projectRoot, download);
  return {
    schema_version: "0.1",
    status: "downloaded",
    download,
    metadata_path: metadataPath
  };
}

export async function applyDownloadedUpdate(
  projectRoot: string,
  currentVersion: string,
  downloadId: string,
  options: UpdateApplyOptions,
  deps: UpdateDependencies = {}
): Promise<UpdateApplyResult> {
  const download = await readVerifiedUpdateDownload(projectRoot, downloadId);
  return applyVerifiedDownload(
    projectRoot,
    currentVersion,
    download,
    "apply",
    downloadId,
    options,
    deps
  );
}

export async function rollbackUpdate(
  projectRoot: string,
  currentVersion: string,
  targetVersion: string,
  options: UpdateApplyOptions,
  deps: UpdateDependencies = {}
): Promise<UpdateApplyResult> {
  parseCoreVersion(targetVersion);
  const download = await findVerifiedUpdateDownloadByVersion(projectRoot, targetVersion);
  return applyVerifiedDownload(
    projectRoot,
    currentVersion,
    download,
    "rollback",
    targetVersion,
    options,
    deps
  );
}

export async function verifyDownloadedUpdate(
  download: VerifiedUpdateDownload
): Promise<ReleaseManifest> {
  assertPathInside(download.cache_directory, download.package_path);
  assertPathInside(download.cache_directory, download.checksum_manifest_path);
  assertPathInside(download.cache_directory, download.release_manifest_path);
  if (download.sbom_path !== undefined) {
    assertPathInside(download.cache_directory, download.sbom_path);
  }
  if (download.provenance_path !== undefined) {
    assertPathInside(download.cache_directory, download.provenance_path);
  }
  const verification = await verifyReleaseManifest(
    download.release_manifest_path,
    download.package_path,
    download.checksum_manifest_path
  );
  if (!verification.ok ||
      verification.package_version !== download.version ||
      verification.source_commit !== download.source_commit) {
    throw new Error(`Verified update download is no longer valid: ${download.download_id}`);
  }
  const [packageBytes, manifestBytes, packageInfo] = await Promise.all([
    readFile(download.package_path),
    readFile(download.release_manifest_path),
    stat(download.package_path)
  ]);
  const manifest = parseReleaseManifestContent(manifestBytes);
  if (sha256(packageBytes) !== download.package_sha256 ||
      packageInfo.size !== download.package_size_bytes ||
      manifest.artifact.sha256 !== download.package_sha256) {
    throw new Error(`Verified update package hash or size changed: ${download.download_id}`);
  }
  return manifest;
}

export function formatUpdateCheck(result: UpdateCheckResult): string {
  return [
    "Kairon update check:",
    `status=${result.status}`,
    `channel=${result.channel}`,
    `repository=${result.repository}`,
    `current_version=${result.current_version}`,
    `selected_version=${result.selected_version}`,
    `selected_tag=${result.selected_tag}`,
    `selected_source_commit=${result.selected_source_commit}`,
    `prerelease=${result.prerelease}`,
    "filesystem_changed=false",
    "automatic_updates=false"
  ].join("\n");
}

export function formatUpdateDownload(result: UpdateDownloadResult): string {
  return [
    "Kairon update downloaded and verified.",
    `status=${result.status}`,
    `download_id=${result.download.download_id}`,
    `version=${result.download.version}`,
    `tag=${result.download.tag}`,
    `source_commit=${result.download.source_commit}`,
    `package_sha256=${result.download.package_sha256}`,
    `cache_directory=${result.download.cache_directory}`,
    `metadata=${result.metadata_path}`
  ].join("\n");
}

export function formatUpdateApply(result: UpdateApplyResult): string {
  return [
    result.status === "completed"
      ? "Kairon update lifecycle completed."
      : "Kairon update lifecycle dry run.",
    `status=${result.status}`,
    `action=${result.action}`,
    `current_version=${result.current_version}`,
    `target_version=${result.target_version}`,
    `download_id=${result.download_id}`,
    `confirm=${result.confirmation}`,
    `downgrade=${result.downgrade}`,
    `major_change=${result.major_change}`,
    `transaction_id=${result.transaction?.transaction_id ?? "not_created"}`,
    `transaction_status=${result.transaction?.status ?? "not_created"}`,
    `transaction_phase=${result.transaction?.phase ?? "not_created"}`,
    `transaction_artifact=${result.transaction?.artifact_path ?? "not_created"}`,
    `registry.installed=${result.registry.installed.version}`,
    `registry.previous=${result.registry.previous?.version ?? "none"}`,
    `registry.last_successful=${result.registry.last_successful_version}`
  ].join("\n");
}

async function applyVerifiedDownload(
  projectRoot: string,
  currentVersion: string,
  download: VerifiedUpdateDownload,
  action: "apply" | "rollback",
  confirmation: string,
  options: UpdateApplyOptions,
  deps: UpdateDependencies
): Promise<UpdateApplyResult> {
  const currentParts = parseCoreVersion(currentVersion);
  const targetParts = parseCoreVersion(download.version);
  await verifyDownloadedUpdate(download);
  if (options.confirm !== confirmation) {
    throw new Error(`${action} requires --confirm ${confirmation}.`);
  }
  const initialRegistry = await loadUpdateRegistry(
    projectRoot,
    currentVersion,
    deps.now
  );
  const common = {
    schema_version: "0.1" as const,
    action,
    current_version: currentVersion,
    target_version: download.version,
    download_id: download.download_id,
    confirmation,
    downgrade: compareCoreVersions(download.version, currentVersion) < 0,
    major_change: currentParts[0] !== targetParts[0]
  };
  if (options.dryRun === true) {
    return {
      ...common,
      status: "would_apply",
      registry: initialRegistry,
      transaction: null
    };
  }

  const transaction = await beginUpdateTransaction(projectRoot, {
    action,
    currentVersion,
    targetVersion: download.version,
    downloadId: download.download_id,
    packageSha256: download.package_sha256,
    packageSizeBytes: download.package_size_bytes
  }, {
    ...deps.transaction,
    now: deps.now ?? deps.transaction?.now
  });
  const runner = deps.commandRunner ?? spawnCommandRunner;
  let result;
  try {
    result = await runner({
      command: deps.powershellCommand ?? "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        deps.updateScriptPath ?? defaultUpdateScriptPath(),
        "-Package",
        download.package_path,
        "-Manifest",
        download.checksum_manifest_path,
        "-ReleaseManifest",
        download.release_manifest_path,
        "-ProjectRoot",
        path.resolve(projectRoot),
        "-TransactionId",
        transaction.transaction_id,
        "-StagingRoot",
        transaction.staging_path,
        "-ExpectedCurrentVersion",
        currentVersion
      ],
      cwd: path.resolve(projectRoot),
      timeoutMs: options.timeoutMs ?? 15 * 60_000
    });
  } catch {
    await finalizeUpdateTransaction(projectRoot, transaction.transaction_id, {
      status: "recovery_required",
      phase: "switch",
      errorCode: "lifecycle_launch_failed"
    }, { now: deps.now });
    throw new Error(
      `Kairon ${action} lifecycle could not be launched; transaction ${transaction.transaction_id} requires recovery.`
    );
  }
  if (result.exitCode !== 0 || result.timedOut) {
    const rollbackStatus = readOutputValue(result.stdout, "rollback.status");
    const failurePhase = readTransactionPhase(
      readOutputValue(result.stdout, "transaction.failed_phase")
    );
    const errorCode =
      readOutputValue(result.stdout, "transaction.error_code") ??
      (result.timedOut ? "lifecycle_timed_out" : "lifecycle_failed");
    const safeRollback =
      rollbackStatus === "completed" || rollbackStatus === "not_required";
    const failedTransaction = await finalizeUpdateTransaction(
      projectRoot,
      transaction.transaction_id,
      {
        status: safeRollback ? "rolled_back" : "recovery_required",
        phase: "rollback",
        failedPhase: failurePhase,
        stateBackupId: readOutputValue(result.stdout, "state_backup_id"),
        rollbackPackageSha256: readOutputValue(
          result.stdout,
          "rollback_package_sha256"
        ),
        errorCode
      },
      { now: deps.now }
    );
    throw new Error(
      `Kairon ${action} lifecycle failed: transaction=${failedTransaction.transaction_id} status=${failedTransaction.status} error_code=${errorCode}`
    );
  }
  const installedVersion = readOutputValue(result.stdout, "installed_version");
  if (readOutputValue(result.stdout, "update.status") !== "completed" ||
      installedVersion !== download.version ||
      readOutputValue(result.stdout, "transaction.staging_health") !== "passed" ||
      readOutputValue(result.stdout, "transaction.switch") !== "completed" ||
      readOutputValue(result.stdout, "transaction.post_check") !== "passed") {
    await finalizeUpdateTransaction(projectRoot, transaction.transaction_id, {
      status: "recovery_required",
      phase: "rollback",
      failedPhase: "post_check",
      stateBackupId: readOutputValue(result.stdout, "state_backup_id"),
      rollbackPackageSha256: readOutputValue(
        result.stdout,
        "rollback_package_sha256"
      ),
      errorCode: "lifecycle_confirmation_missing"
    }, { now: deps.now });
    throw new Error(
      `Kairon ${action} lifecycle did not confirm target version ${download.version}; transaction ${transaction.transaction_id} requires recovery.`
    );
  }
  const registry = await recordSuccessfulUpdate(projectRoot, {
    action,
    currentVersion,
    download,
    transactionId: transaction.transaction_id,
    now: deps.now
  });
  const completedTransaction = await finalizeUpdateTransaction(
    projectRoot,
    transaction.transaction_id,
    {
      status: "completed",
      phase: "completed",
      stateBackupId: readOutputValue(result.stdout, "state_backup_id"),
      rollbackPackageSha256: readOutputValue(
        result.stdout,
        "rollback_package_sha256"
      )
    },
    { now: deps.now }
  );
  return {
    ...common,
    status: "completed",
    registry,
    transaction: completedTransaction
  };
}

async function selectRemoteCandidate(
  config: UpdateChannelConfig,
  requestedVersion: string | undefined,
  token: string,
  deps: UpdateDependencies
): Promise<RemoteUpdateCandidate> {
  const releaseClient = deps.releaseClient ?? defaultGitHubReleaseClient;
  const releases = await releaseClient.listReleases({
    repository: config.repository,
    token,
    perPage: 100
  });
  const eligible = releases
    .filter((release) => !release.draft)
    .map((release) => ({ release, version: versionFromTag(release.tag_name) }))
    .filter((entry): entry is { release: GitHubReleaseRecord; version: string } =>
      entry.version !== null &&
      isVersionAllowedByChannel(config, entry.version, entry.release.prerelease) &&
      (requestedVersion === undefined || entry.version === requestedVersion)
    )
    .sort((left, right) => compareCoreVersions(right.version, left.version));
  const selected = eligible[0];
  if (selected === undefined) {
    throw new Error(
      requestedVersion === undefined
        ? `No verified GitHub Release is available for update channel ${config.channel}.`
        : `Version ${requestedVersion} is not available on update channel ${config.channel}.`
    );
  }
  const releaseManifestAsset = selectReleaseManifestAsset(selected.release);
  const manifestBytes = await releaseClient.downloadAsset({
    repository: config.repository,
    assetId: releaseManifestAsset.id,
    token
  });
  const manifest = parseReleaseManifestContent(manifestBytes);
  verifyRemoteAssetBytes(releaseManifestAsset, manifestBytes);
  const assets = selectRequiredAssets(selected.release, selected.version, manifest);
  const inspection = await releaseClient.inspect({
    repository: config.repository,
    branch: config.base_branch,
    tag: selected.release.tag_name,
    token
  });
  if (inspection.tag === null ||
      inspection.release === null ||
      inspection.release.id !== selected.release.id ||
      inspection.release.draft ||
      inspection.release.prerelease !== selected.release.prerelease ||
      inspection.tag.sha !== manifest.source.commit_sha ||
      manifest.package_version !== selected.version ||
      manifest.artifact.package_file !== assets.package.name ||
      manifest.artifact.checksum_manifest_file !== assets.checksumManifest.name) {
    throw new Error(`GitHub Release ${selected.release.tag_name} is not bound to a verified manifest.`);
  }
  assertRuntimeCompatible(manifest);
  assertManifestTimestamp(manifest, deps.now?.() ?? new Date());
  return {
    release: selected.release,
    version: selected.version,
    tag: selected.release.tag_name,
    sourceCommit: inspection.tag.sha,
    manifest,
    assets,
    manifestBytes
  };
}

function selectRequiredAssets(
  release: GitHubReleaseRecord,
  version: string,
  manifest: ReleaseManifest
): RemoteUpdateCandidate["assets"] {
  const expectedNames = [
    `kairon-${version}.tgz`,
    `kairon-${version}.tgz.sha256.json`,
    "release-manifest.json",
    ...(manifest.attestations === undefined
      ? []
      : [
          manifest.attestations.sbom.file,
          manifest.attestations.provenance.file
        ])
  ];
  if (release.assets.length !== expectedNames.length ||
      new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length) {
    throw new Error(`GitHub Release v${version} has an unexpected or duplicate asset set.`);
  }
  const selected = expectedNames.map((name) =>
    release.assets.find((asset) => asset.name === name && asset.state === "uploaded")
  );
  if (selected.some((asset) => asset === undefined)) {
    throw new Error(`GitHub Release v${version} is missing a required uploaded asset.`);
  }
  return {
    package: selected[0]!,
    checksumManifest: selected[1]!,
    releaseManifest: selected[2]!,
    ...(manifest.attestations === undefined
      ? {}
      : {
          sbom: selected[3]!,
          provenance: selected[4]!
        })
  };
}

function selectReleaseManifestAsset(
  release: GitHubReleaseRecord
): GitHubReleaseAsset {
  const matches = release.assets.filter(
    (asset) => asset.name === "release-manifest.json" && asset.state === "uploaded"
  );
  if (matches.length !== 1) {
    throw new Error(
      `GitHub Release ${release.tag_name} is missing a unique release manifest asset.`
    );
  }
  return matches[0];
}

async function requireGitHubToken(
  options: UpdateNetworkOptions,
  deps: UpdateDependencies
): Promise<string> {
  const resolved = await resolveGitHubTokenSecret({
    env: deps.env,
    envName: options.tokenEnv,
    resolver: deps.secretResolver
  });
  if (resolved.status !== "present") {
    throw new Error(
      `GitHub token is required for update operations${
        resolved.source === undefined ? "" : `: source=${resolved.source}`
      }.`
    );
  }
  return resolved.value;
}

function versionFromTag(tag: string): string | null {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(tag);
  return match?.[1] ?? null;
}

function assertRuntimeCompatible(manifest: ReleaseManifest): void {
  const required = /^>=(\d+)$/u.exec(manifest.runtime_support.node);
  const current = /^v(\d+)\./u.exec(process.version);
  if (required === null || current === null || Number(current[1]) < Number(required[1])) {
    throw new Error(
      `Current Node runtime ${process.version} does not satisfy ${manifest.runtime_support.node}.`
    );
  }
}

function assertManifestTimestamp(manifest: ReleaseManifest, now: Date): void {
  const created = Date.parse(manifest.created_at);
  if (Number.isNaN(created) || created > now.getTime() + 5 * 60_000) {
    throw new Error("Release manifest timestamp is invalid or in the future.");
  }
}

function resolveUpdateCacheRoot(projectRoot: string, override?: string): string {
  const configured = override === undefined
    ? process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Kairon", "updates")
      : path.join(os.homedir(), ".kairon", "updates")
    : override;
  const resolved = path.resolve(configured);
  const relative = path.relative(path.resolve(projectRoot), resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Update cache must be outside the project root.");
  }
  return resolved;
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Update artifact path escapes its cache directory: ${candidate}`);
  }
}

function defaultUpdateScriptPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "scripts",
    "update-local-beta.ps1"
  );
}

function readOutputValue(stdout: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^${escaped}=(.*)$`, "mu").exec(stdout);
  return match?.[1]?.trim();
}

function readTransactionPhase(value: string | undefined): UpdateTransactionPhase {
  if (
    value === "preflight" ||
    value === "staging" ||
    value === "switch" ||
    value === "post_check" ||
    value === "rollback" ||
    value === "completed"
  ) {
    return value;
  }
  return "switch";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyRemoteAssetBytes(
  asset: GitHubReleaseAsset,
  content: Uint8Array
): void {
  const hash = sha256(content);
  const digestValid = asset.digest === undefined || asset.digest === `sha256:${hash}`;
  if (content.byteLength !== asset.size_bytes || !digestValid) {
    throw new Error(`GitHub Release asset metadata does not match downloaded content: ${asset.name}`);
  }
}
