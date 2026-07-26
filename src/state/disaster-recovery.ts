import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { defaultBackupGenerationRetentionRule } from "../core/config/cleanup-retention.js";
import { loadConfigFile, validateAllConfigs } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { verifyWorkflowCheckpointStore } from "../workflow/checkpoint-manager.js";
import {
  BackupCatalog,
  type BackupCatalogOptions,
  type OffDeviceBackupCatalogEntry
} from "./backup-catalog.js";
import {
  rehearseStateBackup,
  verifyStateBackup,
  type StateBackupRehearsalResult,
  type StateBackupVerifyResult
} from "./backup.js";

export type DisasterRecoveryErrorCode =
  | "destination_missing"
  | "destination_not_directory"
  | "destination_not_writable"
  | "destination_inside_project"
  | "destination_symbolic_link"
  | "insufficient_space"
  | "source_backup_invalid"
  | "source_backup_changed"
  | "copy_interrupted"
  | "destination_tampered"
  | "backup_schema_unsupported"
  | "plan_invalid"
  | "confirmation_mismatch";

export class DisasterRecoveryError extends Error {
  constructor(
    readonly code: DisasterRecoveryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DisasterRecoveryError";
  }
}

export type OffDeviceBackupRetentionProfile = {
  max_backups: number;
  max_age_days: number;
  min_keep: number;
};

export type OffDeviceBackupDestinationProfile = {
  schema_version: "0.1";
  destination_root: string;
  minimum_free_bytes: number;
  verification_interval_days: number;
  retention: OffDeviceBackupRetentionProfile;
};

export type DisasterRecoveryPlan = {
  schema_version: "0.1";
  artifact_kind: "disaster_recovery_plan";
  plan_id: string;
  status: "planned";
  created_at: string;
  backup_id: string;
  project_id: string;
  source_package_path: string;
  source_content_sha256: string;
  source_bytes: number;
  destination: OffDeviceBackupDestinationProfile;
  destination_package_path: string;
  retention_candidates: Array<{
    backup_id: string;
    package_path: string;
  }>;
  confirmation: {
    required: true;
    expected: string;
  };
};

export type DisasterRecoveryCopyResult = {
  schema_version: "0.1";
  status: "copied" | "already_copied";
  plan_id: string;
  backup_id: string;
  project_id: string;
  package_path: string;
  content_sha256: string;
  copied_at: string;
  verified_at: string;
  retention_removed: string[];
};

export type DisasterRecoveryVerifyResult = {
  schema_version: "0.1";
  status: "verified";
  backup_id: string;
  project_id: string;
  package_path: string;
  content_sha256: string;
  verified_at: string;
  verification_due_at: string;
};

export type DisasterRecoveryRehearsalResult = {
  schema_version: "0.1";
  status: "passed" | "failed";
  backup_id: string;
  project_id: string;
  package_path: string;
  rehearsed_at: string;
  cleaned_up: true;
  integrity: StateBackupRehearsalResult["integrity"];
  config_validation: {
    ok: boolean;
    errors: number;
    warnings: number;
  };
  workflow_replay: {
    status: "ready" | "not_ready";
    canonical_records: number;
    issues: number;
  };
};

export type DisasterRecoveryPlanOptions = BackupCatalogOptions & {
  destinationRoot: string;
  source?: string;
  minimumFreeBytes?: number;
  verificationIntervalDays?: number;
  maxBackups?: number;
  maxAgeDays?: number;
  minKeep?: number;
  now?: () => Date;
  freeSpaceReader?: (root: string) => Promise<number>;
};

export type DisasterRecoveryCopyOptions = BackupCatalogOptions & {
  confirm: string;
  now?: () => Date;
  freeSpaceReader?: (root: string) => Promise<number>;
  afterFileCopied?: (relativePath: string, copiedFiles: number) => Promise<void>;
};

export type DisasterRecoveryCatalogOptions = BackupCatalogOptions & {
  packagePath?: string;
  now?: () => Date;
};

export const defaultOffDeviceBackupProfile = {
  minimum_free_bytes: 536_870_912,
  verification_interval_days: 30,
  retention: defaultBackupGenerationRetentionRule
} as const;

export async function planDisasterRecoveryCopy(
  projectRoot: string,
  backupId: string,
  options: DisasterRecoveryPlanOptions
): Promise<{
  plan: DisasterRecoveryPlan;
  plan_path: string;
}> {
  const now = options.now?.() ?? new Date();
  const destination = normalizeDestinationProfile(options);
  await validateDestination(
    projectRoot,
    destination,
    0,
    options.freeSpaceReader
  );
  const source = await verifySourceBackup(
    projectRoot,
    backupId,
    options.source
  );
  await validateDestination(
    projectRoot,
    destination,
    source.summary.bytes,
    options.freeSpaceReader
  );
  const project = await loadConfigFile<{ project_id?: unknown }>(
    projectRoot,
    "project.json"
  );
  if (typeof project.project_id !== "string" || project.project_id.length === 0) {
    throw new DisasterRecoveryError(
      "source_backup_invalid",
      "Source project id is unavailable."
    );
  }
  const destinationPackagePath = packageDestination(
    destination.destination_root,
    project.project_id,
    backupId
  );
  assertSeparatePackagePaths(source.package_path, destinationPackagePath);
  const catalog = new BackupCatalog(options);
  assertCatalogOutsideProject(projectRoot, catalog.catalogPath);
  const existingDestinationEntries = (await catalog.list(project.project_id)).filter(
      (entry) =>
        normalizePathKey(entry.destination_root) ===
        normalizePathKey(destination.destination_root)
    );
  const plannedEntry: OffDeviceBackupCatalogEntry = {
    backup_id: backupId,
    project_id: project.project_id,
    destination_root: destination.destination_root,
    package_path: destinationPackagePath,
    content_sha256: source.content_sha256,
    bytes: source.summary.bytes,
    copied_at: now.toISOString(),
    verification_interval_days: destination.verification_interval_days,
    verification_status: "verified",
    verified_at: now.toISOString()
  };
  const retentionCandidates = selectRetentionCandidates(
    [...existingDestinationEntries, plannedEntry],
    destination.retention,
    now
  ).filter(
    (entry) =>
      normalizePathKey(entry.package_path) !==
      normalizePathKey(destinationPackagePath)
  );
  const planDigest = createHash("sha256")
    .update(
      JSON.stringify({
        backup_id: backupId,
        project_id: project.project_id,
        source_content_sha256: source.content_sha256,
        destination,
        destination_package_path: destinationPackagePath
      })
    )
    .digest("hex")
    .slice(0, 12);
  const planId = `DRP-${formatTimestamp(now)}-${planDigest}`;
  const plan: DisasterRecoveryPlan = {
    schema_version: "0.1",
    artifact_kind: "disaster_recovery_plan",
    plan_id: planId,
    status: "planned",
    created_at: now.toISOString(),
    backup_id: backupId,
    project_id: project.project_id,
    source_package_path: source.package_path,
    source_content_sha256: source.content_sha256,
    source_bytes: source.summary.bytes,
    destination,
    destination_package_path: destinationPackagePath,
    retention_candidates: retentionCandidates.map((entry) => ({
      backup_id: entry.backup_id,
      package_path: entry.package_path
    })),
    confirmation: {
      required: true,
      expected: planId
    }
  };
  const planPath = disasterRecoveryPlanPath(catalog.catalogPath, planId);
  await writeJsonFileAtomic(planPath, plan);
  return { plan, plan_path: planPath };
}

export async function copyDisasterRecoveryBackup(
  projectRoot: string,
  planId: string,
  options: DisasterRecoveryCopyOptions
): Promise<DisasterRecoveryCopyResult> {
  assertPlanId(planId);
  if (options.confirm !== planId) {
    throw new DisasterRecoveryError(
      "confirmation_mismatch",
      `Disaster recovery confirmation does not match. Expected --confirm ${planId}.`
    );
  }
  const now = options.now?.() ?? new Date();
  const catalog = new BackupCatalog(options);
  assertCatalogOutsideProject(projectRoot, catalog.catalogPath);
  const plan = parsePlan(
    await readJsonFile<unknown>(
      disasterRecoveryPlanPath(catalog.catalogPath, planId)
    ),
    planId
  );
  await validateDestination(
    projectRoot,
    plan.destination,
    plan.source_bytes,
    options.freeSpaceReader
  );
  const source = await verifySourceBackup(
    projectRoot,
    plan.backup_id,
    plan.source_package_path
  );
  if (source.content_sha256 !== plan.source_content_sha256) {
    throw new DisasterRecoveryError(
      "source_backup_changed",
      `Source backup changed after planning: ${plan.backup_id}.`
    );
  }
  assertSeparatePackagePaths(
    source.package_path,
    plan.destination_package_path
  );

  const existing = await pathExists(plan.destination_package_path);
  if (existing) {
    const verified = await verifyDestinationBackup(
      projectRoot,
      plan.backup_id,
      plan.destination_package_path
    );
    if (verified.content_sha256 !== plan.source_content_sha256) {
      throw new DisasterRecoveryError(
        "destination_tampered",
        `Existing destination backup digest differs: ${plan.backup_id}.`
      );
    }
    const copiedAt = now.toISOString();
    await catalog.upsert(
      catalogEntry(plan, copiedAt, verified.verified_at, "verified")
    );
    return {
      schema_version: "0.1",
      status: "already_copied",
      plan_id: plan.plan_id,
      backup_id: plan.backup_id,
      project_id: plan.project_id,
      package_path: plan.destination_package_path,
      content_sha256: verified.content_sha256,
      copied_at: copiedAt,
      verified_at: verified.verified_at,
      retention_removed: []
    };
  }

  const parent = path.dirname(plan.destination_package_path);
  await mkdir(parent, { recursive: true });
  await assertNoSymbolicLinkBetween(
    plan.destination.destination_root,
    parent
  );
  const temporaryPath = path.join(
    parent,
    `.${plan.backup_id}.${randomUUID()}.partial`
  );
  let copiedFiles = 0;
  try {
    copiedFiles = await copyPackageTree(
      plan.source_package_path,
      temporaryPath,
      options.afterFileCopied
    );
    if (copiedFiles === 0) {
      throw new DisasterRecoveryError(
        "copy_interrupted",
        "Source backup package contained no files."
      );
    }
    const verified = await verifyDestinationBackup(
      projectRoot,
      plan.backup_id,
      temporaryPath
    );
    if (verified.content_sha256 !== plan.source_content_sha256) {
      throw new DisasterRecoveryError(
        "destination_tampered",
        `Copied destination digest differs: ${plan.backup_id}.`
      );
    }
    await rename(temporaryPath, plan.destination_package_path);
    const copiedAt = now.toISOString();
    await catalog.upsert(
      catalogEntry(plan, copiedAt, verified.verified_at, "verified")
    );
    const retentionRemoved = await applyDestinationRetention(
      catalog,
      plan.project_id,
      plan.destination,
      now
    );
    return {
      schema_version: "0.1",
      status: "copied",
      plan_id: plan.plan_id,
      backup_id: plan.backup_id,
      project_id: plan.project_id,
      package_path: plan.destination_package_path,
      content_sha256: verified.content_sha256,
      copied_at: copiedAt,
      verified_at: verified.verified_at,
      retention_removed: retentionRemoved
    };
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    if (error instanceof DisasterRecoveryError) {
      throw error;
    }
    throw new DisasterRecoveryError(
      "copy_interrupted",
      `Off-device backup copy failed after ${copiedFiles} files: ${errorName(error)}.`
    );
  }
}

export async function verifyDisasterRecoveryBackup(
  projectRoot: string,
  backupId: string,
  options: DisasterRecoveryCatalogOptions = {}
): Promise<DisasterRecoveryVerifyResult> {
  const now = options.now?.() ?? new Date();
  const catalog = new BackupCatalog(options);
  assertCatalogOutsideProject(projectRoot, catalog.catalogPath);
  const entry = await selectCatalogEntry(
    catalog,
    backupId,
    options.packagePath
  );
  try {
    const verification = await verifyDestinationBackup(
      projectRoot,
      backupId,
      entry.package_path
    );
    if (verification.content_sha256 !== entry.content_sha256) {
      throw new DisasterRecoveryError(
        "destination_tampered",
        `Catalog digest differs from destination backup: ${backupId}.`
      );
    }
    const verifiedAt = now.toISOString();
    await catalog.update(backupId, entry.package_path, {
      verification_status: "verified",
      verified_at: verifiedAt
    });
    return {
      schema_version: "0.1",
      status: "verified",
      backup_id: backupId,
      project_id: entry.project_id,
      package_path: entry.package_path,
      content_sha256: entry.content_sha256,
      verified_at: verifiedAt,
      verification_due_at: new Date(
        now.getTime() +
          entry.verification_interval_days * 86_400_000
      ).toISOString()
    };
  } catch (error) {
    await catalog.update(backupId, entry.package_path, {
      verification_status: "failed"
    });
    if (error instanceof DisasterRecoveryError) {
      throw error;
    }
    throw classifyVerificationError(error, backupId);
  }
}

export async function rehearseDisasterRecoveryBackup(
  projectRoot: string,
  backupId: string,
  options: DisasterRecoveryCatalogOptions = {}
): Promise<DisasterRecoveryRehearsalResult> {
  const now = options.now?.() ?? new Date();
  const catalog = new BackupCatalog(options);
  assertCatalogOutsideProject(projectRoot, catalog.catalogPath);
  const entry = await selectCatalogEntry(
    catalog,
    backupId,
    options.packagePath
  );
  await verifyDisasterRecoveryBackup(projectRoot, backupId, {
    ...options,
    packagePath: entry.package_path,
    now: () => now
  });

  let configValidation = {
    ok: false,
    errors: 1,
    warnings: 0
  };
  let workflowReplay: DisasterRecoveryRehearsalResult["workflow_replay"] = {
    status: "not_ready",
    canonical_records: 0,
    issues: 1
  };
  const rehearsal = await rehearseStateBackup(projectRoot, backupId, {
    source: entry.package_path,
    now: () => now,
    inspectIsolatedProject: async (isolatedRoot) => {
      const validation = await validateAllConfigs(isolatedRoot);
      configValidation = {
        ok: validation.ok,
        errors: validation.errors.length,
        warnings: validation.warnings.length
      };
      const workflow = await verifyWorkflowCheckpointStore(
        isolatedRoot,
        {},
        {
          now: () => now,
          persistHealth: false
        }
      );
      workflowReplay = {
        status:
          workflow.summary.canonical_errors === 0 ? "ready" : "not_ready",
        canonical_records: workflow.canonical_records,
        issues: workflow.summary.issues
      };
    }
  });
  const status =
    rehearsal.status === "passed" &&
    configValidation.ok &&
    workflowReplay.status === "ready"
      ? "passed"
      : "failed";
  await catalog.update(backupId, entry.package_path, {
    rehearsed_at: now.toISOString(),
    rehearsal_status: status
  });
  return {
    schema_version: "0.1",
    status,
    backup_id: backupId,
    project_id: entry.project_id,
    package_path: entry.package_path,
    rehearsed_at: now.toISOString(),
    cleaned_up: true,
    integrity: rehearsal.integrity,
    config_validation: configValidation,
    workflow_replay: workflowReplay
  };
}

function normalizeDestinationProfile(
  options: DisasterRecoveryPlanOptions
): OffDeviceBackupDestinationProfile {
  const destinationRoot = path.resolve(options.destinationRoot);
  const minimumFreeBytes = nonNegativeInteger(
    options.minimumFreeBytes ??
      defaultOffDeviceBackupProfile.minimum_free_bytes,
    "minimumFreeBytes"
  );
  const verificationIntervalDays = positiveInteger(
    options.verificationIntervalDays ??
      defaultOffDeviceBackupProfile.verification_interval_days,
    "verificationIntervalDays"
  );
  const maxBackups = positiveInteger(
    options.maxBackups ?? defaultOffDeviceBackupProfile.retention.max_backups,
    "maxBackups"
  );
  const maxAgeDays = positiveInteger(
    options.maxAgeDays ?? defaultOffDeviceBackupProfile.retention.max_age_days,
    "maxAgeDays"
  );
  const minKeep = positiveInteger(
    options.minKeep ?? defaultOffDeviceBackupProfile.retention.min_keep,
    "minKeep"
  );
  if (minKeep > maxBackups) {
    throw new Error("minKeep cannot exceed maxBackups.");
  }
  return {
    schema_version: "0.1",
    destination_root: destinationRoot,
    minimum_free_bytes: minimumFreeBytes,
    verification_interval_days: verificationIntervalDays,
    retention: {
      max_backups: maxBackups,
      max_age_days: maxAgeDays,
      min_keep: minKeep
    }
  };
}

async function validateDestination(
  projectRoot: string,
  profile: OffDeviceBackupDestinationProfile,
  backupBytes: number,
  freeSpaceReader: ((root: string) => Promise<number>) | undefined
): Promise<void> {
  const destinationRoot = path.resolve(profile.destination_root);
  const project = path.resolve(projectRoot);
  if (isInside(project, destinationRoot)) {
    throw new DisasterRecoveryError(
      "destination_inside_project",
      "Off-device destination must be outside the source project."
    );
  }
  let stats;
  try {
    stats = await lstat(destinationRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DisasterRecoveryError(
        "destination_missing",
        `Off-device destination is missing: ${destinationRoot}`
      );
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new DisasterRecoveryError(
      "destination_symbolic_link",
      "Off-device destination cannot be a symbolic link or reparse-point link."
    );
  }
  if (!stats.isDirectory()) {
    throw new DisasterRecoveryError(
      "destination_not_directory",
      "Off-device destination must be a directory."
    );
  }
  try {
    await access(destinationRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new DisasterRecoveryError(
      "destination_not_writable",
      "Off-device destination is not writable."
    );
  }
  const freeBytes = await (freeSpaceReader ?? readFreeSpace)(destinationRoot);
  const required = profile.minimum_free_bytes + backupBytes;
  if (freeBytes < required) {
    throw new DisasterRecoveryError(
      "insufficient_space",
      `Off-device destination has insufficient free space. required=${required} available=${freeBytes}`
    );
  }
}

async function readFreeSpace(root: string): Promise<number> {
  const stats = await statfs(root);
  return stats.bavail * stats.bsize;
}

async function verifySourceBackup(
  projectRoot: string,
  backupId: string,
  source: string | undefined
): Promise<StateBackupVerifyResult> {
  try {
    return await verifyStateBackup(projectRoot, backupId, { source });
  } catch (error) {
    throw classifySourceError(error, backupId);
  }
}

async function verifyDestinationBackup(
  projectRoot: string,
  backupId: string,
  packagePath: string
): Promise<StateBackupVerifyResult> {
  try {
    return await verifyStateBackup(projectRoot, backupId, {
      source: packagePath
    });
  } catch (error) {
    throw classifyVerificationError(error, backupId);
  }
}

function classifySourceError(
  error: unknown,
  backupId: string
): DisasterRecoveryError {
  if (String(error).includes("Invalid backup manifest")) {
    return new DisasterRecoveryError(
      "backup_schema_unsupported",
      `Source backup schema is unsupported: ${backupId}.`
    );
  }
  return new DisasterRecoveryError(
    "source_backup_invalid",
    `Source backup verification failed: ${backupId}.`
  );
}

function classifyVerificationError(
  error: unknown,
  backupId: string
): DisasterRecoveryError {
  if (error instanceof DisasterRecoveryError) {
    return error;
  }
  if (String(error).includes("Invalid backup manifest")) {
    return new DisasterRecoveryError(
      "backup_schema_unsupported",
      `Destination backup schema is unsupported: ${backupId}.`
    );
  }
  return new DisasterRecoveryError(
    "destination_tampered",
    `Destination backup verification failed: ${backupId}.`
  );
}

async function copyPackageTree(
  sourceRoot: string,
  destinationRoot: string,
  afterFileCopied:
    | ((relativePath: string, copiedFiles: number) => Promise<void>)
    | undefined
): Promise<number> {
  await assertPackageDirectory(sourceRoot);
  await mkdir(destinationRoot, { recursive: false });
  let copiedFiles = 0;
  const copyDirectory = async (
    sourceDirectory: string,
    destinationDirectory: string
  ): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const source = path.join(sourceDirectory, entry.name);
      const destination = path.join(destinationDirectory, entry.name);
      const stats = await lstat(source);
      if (stats.isSymbolicLink()) {
        throw new DisasterRecoveryError(
          "source_backup_invalid",
          `Symbolic links are not allowed in backup packages: ${entry.name}.`
        );
      }
      if (stats.isDirectory()) {
        await mkdir(destination);
        await copyDirectory(source, destination);
        continue;
      }
      if (!stats.isFile()) {
        throw new DisasterRecoveryError(
          "source_backup_invalid",
          `Unsupported backup package entry: ${entry.name}.`
        );
      }
      await writeFile(destination, await readFile(source));
      copiedFiles += 1;
      await afterFileCopied?.(
        path.relative(sourceRoot, source).split(path.sep).join("/"),
        copiedFiles
      );
    }
  };
  await copyDirectory(sourceRoot, destinationRoot);
  return copiedFiles;
}

async function assertPackageDirectory(packagePath: string): Promise<void> {
  const stats = await lstat(packagePath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new DisasterRecoveryError(
      "source_backup_invalid",
      "Source backup package must be a regular directory."
    );
  }
}

async function assertNoSymbolicLinkBetween(
  root: string,
  destination: string
): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(destination));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new DisasterRecoveryError(
      "destination_inside_project",
      "Destination package escapes its configured root."
    );
  }
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!(await pathExists(current))) {
      continue;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new DisasterRecoveryError(
        "destination_symbolic_link",
        `Destination path contains a symbolic link: ${segment}.`
      );
    }
  }
}

async function selectCatalogEntry(
  catalog: BackupCatalog,
  backupId: string,
  packagePath: string | undefined
): Promise<OffDeviceBackupCatalogEntry> {
  const entries = (await catalog.list()).filter(
    (entry) =>
      entry.backup_id === backupId &&
      (packagePath === undefined ||
        normalizePathKey(entry.package_path) === normalizePathKey(packagePath))
  );
  if (entries.length === 0) {
    throw new DisasterRecoveryError(
      "destination_missing",
      `Off-device backup is not cataloged: ${backupId}.`
    );
  }
  if (entries.length > 1 && packagePath === undefined) {
    throw new DisasterRecoveryError(
      "plan_invalid",
      `Multiple off-device packages exist for ${backupId}; select one with --package.`
    );
  }
  return entries[0];
}

function selectRetentionCandidates(
  entries: OffDeviceBackupCatalogEntry[],
  retention: OffDeviceBackupRetentionProfile,
  now: Date
): OffDeviceBackupCatalogEntry[] {
  const sorted = [...entries].sort((left, right) =>
    right.copied_at.localeCompare(left.copied_at)
  );
  const latestVerified = sorted.find(
    (entry) => entry.verification_status === "verified"
  );
  const protectedKeys = new Set(
    sorted.slice(0, retention.min_keep).map(catalogEntryKey)
  );
  if (latestVerified !== undefined) {
    protectedKeys.add(catalogEntryKey(latestVerified));
  }
  const cutoff = now.getTime() - retention.max_age_days * 86_400_000;
  return sorted.filter((entry, index) => {
    if (protectedKeys.has(catalogEntryKey(entry))) {
      return false;
    }
    return index >= retention.max_backups ||
      Date.parse(entry.copied_at) < cutoff;
  });
}

async function applyDestinationRetention(
  catalog: BackupCatalog,
  projectId: string,
  destination: OffDeviceBackupDestinationProfile,
  now: Date
): Promise<string[]> {
  const entries = (await catalog.list(projectId)).filter(
    (entry) =>
      normalizePathKey(entry.destination_root) ===
      normalizePathKey(destination.destination_root)
  );
  const candidates = selectRetentionCandidates(
    entries,
    destination.retention,
    now
  );
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (
      !isInside(
        path.resolve(destination.destination_root),
        path.resolve(candidate.package_path)
      )
    ) {
      continue;
    }
    await assertNoSymbolicLinkBetween(
      destination.destination_root,
      path.dirname(candidate.package_path)
    );
    await rm(candidate.package_path, { recursive: true, force: true });
    await catalog.remove(candidate.backup_id, candidate.package_path);
    removed.push(candidate.backup_id);
  }
  return removed.sort();
}

function catalogEntry(
  plan: DisasterRecoveryPlan,
  copiedAt: string,
  verifiedAt: string,
  verificationStatus: OffDeviceBackupCatalogEntry["verification_status"]
): OffDeviceBackupCatalogEntry {
  return {
    backup_id: plan.backup_id,
    project_id: plan.project_id,
    destination_root: plan.destination.destination_root,
    package_path: plan.destination_package_path,
    content_sha256: plan.source_content_sha256,
    bytes: plan.source_bytes,
    copied_at: copiedAt,
    verification_interval_days: plan.destination.verification_interval_days,
    verification_status: verificationStatus,
    verified_at: verifiedAt
  };
}

function parsePlan(value: unknown, expectedId: string): DisasterRecoveryPlan {
  try {
    const plan = toRecord(value);
    const destination = toRecord(plan.destination);
    const retention = toRecord(destination.retention);
    const confirmation = toRecord(plan.confirmation);
    const retentionCandidates = Array.isArray(plan.retention_candidates)
      ? plan.retention_candidates
      : [];
    const destinationRoot =
      typeof destination.destination_root === "string"
        ? destination.destination_root
        : "";
    const destinationPackagePath =
      typeof plan.destination_package_path === "string"
        ? plan.destination_package_path
        : "";
    if (
      plan.schema_version !== "0.1" ||
      plan.artifact_kind !== "disaster_recovery_plan" ||
      plan.plan_id !== expectedId ||
      plan.status !== "planned" ||
      typeof plan.created_at !== "string" ||
      !Number.isFinite(Date.parse(plan.created_at)) ||
      typeof plan.backup_id !== "string" ||
      typeof plan.project_id !== "string" ||
      typeof plan.source_package_path !== "string" ||
      !path.isAbsolute(plan.source_package_path) ||
      typeof plan.source_content_sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(plan.source_content_sha256) ||
      !isNonNegativeSafeInteger(plan.source_bytes) ||
      destination.schema_version !== "0.1" ||
      !path.isAbsolute(destinationRoot) ||
      !isNonNegativeSafeInteger(destination.minimum_free_bytes) ||
      !isPositiveSafeInteger(destination.verification_interval_days) ||
      !isPositiveSafeInteger(retention.max_backups) ||
      !isPositiveSafeInteger(retention.max_age_days) ||
      !isPositiveSafeInteger(retention.min_keep) ||
      Number(retention.min_keep) > Number(retention.max_backups) ||
      !path.isAbsolute(destinationPackagePath) ||
      normalizePathKey(destinationPackagePath) ===
        normalizePathKey(destinationRoot) ||
      !isInside(destinationRoot, destinationPackagePath) ||
      !Array.isArray(plan.retention_candidates) ||
      !retentionCandidates.every((candidate) =>
        isValidRetentionCandidate(candidate, destinationRoot)
      ) ||
      confirmation.required !== true ||
      confirmation.expected !== expectedId
    ) {
      throw new Error("plan fields are invalid");
    }
    return plan as unknown as DisasterRecoveryPlan;
  } catch {
    throw new DisasterRecoveryError(
      "plan_invalid",
      `Invalid disaster recovery plan: ${expectedId}.`
    );
  }
}

function isValidRetentionCandidate(
  value: unknown,
  destinationRoot: string
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.backup_id === "string" &&
    typeof candidate.package_path === "string" &&
    path.isAbsolute(candidate.package_path) &&
    isInside(destinationRoot, candidate.package_path)
  );
}

function disasterRecoveryPlanPath(
  catalogPath: string,
  planId: string
): string {
  assertPlanId(planId);
  return path.join(path.dirname(catalogPath), "dr", "plans", `${planId}.json`);
}

function packageDestination(
  destinationRoot: string,
  projectId: string,
  backupId: string
): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return path.join(
    path.resolve(destinationRoot),
    "kairon-dr",
    safeProjectId,
    backupId
  );
}

function assertCatalogOutsideProject(
  projectRoot: string,
  catalogPath: string
): void {
  if (isInside(path.resolve(projectRoot), path.resolve(catalogPath))) {
    throw new DisasterRecoveryError(
      "destination_inside_project",
      "Off-device backup catalog must be outside the source project."
    );
  }
}

function assertSeparatePackagePaths(
  sourcePackagePath: string,
  destinationPackagePath: string
): void {
  const source = path.resolve(sourcePackagePath);
  const destination = path.resolve(destinationPackagePath);
  if (isInside(source, destination) || isInside(destination, source)) {
    throw new DisasterRecoveryError(
      "plan_invalid",
      "Source and destination backup packages cannot overlap."
    );
  }
}

function assertPlanId(planId: string): void {
  if (!/^DRP-\d{17}-[0-9a-f]{12}$/u.test(planId)) {
    throw new DisasterRecoveryError(
      "plan_invalid",
      `Invalid disaster recovery plan id: ${planId}.`
    );
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\D/gu, "").slice(0, 17);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function catalogEntryKey(entry: OffDeviceBackupCatalogEntry): string {
  return `${entry.backup_id}:${normalizePathKey(entry.package_path)}`;
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object.");
  }
  return value as Record<string, unknown>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}
