import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { readRuntimeLockStatus } from "../runtime/runtime-lock.js";
import {
  checkStateIntegrity,
  type StateIntegrityCheckResult
} from "./integrity-check.js";
import {
  createStateSnapshotWithExistingLock,
  type StateSnapshotCreateResult
} from "./snapshot.js";
import { acquireStateLock, releaseStateLock } from "./state-lock.js";

export type StateBackupExclusionReason =
  | "runtime_ephemeral"
  | "temporary"
  | "generated"
  | "snapshot_storage"
  | "backup_storage"
  | "log"
  | "secret_like_path"
  | "symbolic_link"
  | "unsupported_type";

export type StateBackupExcludedPath = {
  path: string;
  reason: StateBackupExclusionReason;
};

export type StateBackupManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  category: string;
  schema_version: string | null;
};

export type StateBackupManifest = {
  schema_version: "0.1";
  artifact_kind: "state_backup";
  backup_id: string;
  created_at: string;
  content_sha256: string;
  summary: {
    files: number;
    bytes: number;
    excluded: number;
  };
  policy: {
    included_extensions: string[];
    excluded_prefixes: string[];
    secret_like_paths: "excluded";
    symbolic_links: "excluded";
  };
  excluded: StateBackupExcludedPath[];
  files: StateBackupManifestFile[];
};

export type StateBackupDryRunResult = {
  schema_version: "0.1";
  status: "planned";
  dry_run: true;
  generated_at: string;
  proposed_backup_id: string;
  content_sha256: string;
  summary: StateBackupManifest["summary"];
  excluded: StateBackupExcludedPath[];
  files: StateBackupManifestFile[];
};

export type StateBackupCreateResult = {
  schema_version: "0.1";
  status: "created";
  dry_run: false;
  backup_id: string;
  package_path: string;
  manifest_path: string;
  registry_path: string;
  content_sha256: string;
  created_at: string;
  summary: StateBackupManifest["summary"];
};

export type StateBackupVerifyResult = {
  schema_version: "0.1";
  status: "verified";
  backup_id: string;
  package_path: string;
  manifest_path: string;
  content_sha256: string;
  verified_at: string;
  summary: StateBackupManifest["summary"];
};

export type StateBackupRehearsalResult = {
  schema_version: "0.1";
  status: "passed" | "failed";
  backup_id: string;
  rehearsed_at: string;
  isolated_project_path: string;
  cleaned_up: true;
  integrity: StateIntegrityCheckResult;
};

export type StateBackupRestoreResult = {
  schema_version: "0.1";
  status: "restored";
  backup_id: string;
  restored_at: string;
  pre_restore_snapshot_id: string;
  pre_restore_snapshot_path: string;
  summary: {
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
  };
  integrity: StateIntegrityCheckResult;
};

export type StateBackupRestoreMarker = {
  schema_version: "0.1";
  artifact_kind: "state_backup_restore";
  status:
    | "pre_restore_snapshot_created"
    | "restoring"
    | "validating"
    | "restore_failed";
  backup_id: string;
  pre_restore_snapshot_id: string;
  pre_restore_snapshot_path: string;
  created_at: string;
  updated_at: string;
  restored_files: number;
  deleted_files: number;
  error_code?: "restore_apply_failed" | "post_restore_integrity_failed";
  next_action: string;
};

export type StateBackupCreateOptions = {
  output?: string;
  now?: () => Date;
};

export type StateBackupRestoreOptions = {
  confirm: string;
  source?: string;
  now?: () => Date;
  afterFileRestored?: (
    file: StateBackupManifestFile,
    restoredCount: number
  ) => Promise<void>;
};

type StateBackupFileRecord = StateBackupManifestFile & {
  absolute_path: string;
  content?: Buffer;
};

type CollectedBackupState = {
  files: StateBackupFileRecord[];
  excluded: StateBackupExcludedPath[];
};

type LoadedStateBackup = {
  manifest: StateBackupManifest;
  package_path: string;
  manifest_path: string;
  files: Map<string, StateBackupFileRecord>;
};

type StateBackupRegistry = {
  schema_version: "0.1";
  artifact_kind: "state_backup_registry";
  backup_id: string;
  package_path: string;
  manifest_path: string;
  content_sha256: string;
  created_at: string;
};

const backupIdPattern = /^BKP-\d{17}-[0-9a-f]{12}$/u;
const includedExtensions = [".json", ".jsonl", ".md"];
const excludedPrefixes: Array<{
  path: string;
  reason: StateBackupExclusionReason;
}> = [
  { path: ".kairon/runtime", reason: "runtime_ephemeral" },
  { path: ".kairon/tmp", reason: "temporary" },
  { path: ".kairon/worktrees", reason: "generated" },
  { path: ".kairon/rag", reason: "generated" },
  { path: ".kairon/board", reason: "generated" },
  { path: ".kairon/workflows/checkpoints.sqlite", reason: "generated" },
  { path: ".kairon/workflows/checkpoints.sqlite-wal", reason: "generated" },
  { path: ".kairon/workflows/checkpoints.sqlite-shm", reason: "generated" },
  { path: ".kairon/snapshots", reason: "snapshot_storage" },
  { path: ".kairon/backups", reason: "backup_storage" }
];

export class StateBackupSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateBackupSafetyError";
  }
}

class StateBackupIntegrityError extends StateBackupSafetyError {
  constructor(message: string) {
    super(message);
    this.name = "StateBackupIntegrityError";
  }
}

export async function planStateBackup(
  projectRoot: string,
  options: { now?: () => Date } = {}
): Promise<StateBackupDryRunResult> {
  const now = options.now?.() ?? new Date();
  const collected = await collectBackupState(projectRoot, false, true);
  return buildBackupPlan(collected, now);
}

export async function createStateBackup(
  projectRoot: string,
  options: StateBackupCreateOptions = {}
): Promise<StateBackupCreateResult> {
  const now = options.now?.() ?? new Date();
  const lock = await acquireStateLock(projectRoot);
  try {
    const collected = await collectBackupState(projectRoot, true, true);
    const plan = buildBackupPlan(collected, now);
    const packageRoot = resolveBackupOutputRoot(projectRoot, options.output);
    await assertBackupOutputRoot(projectRoot, packageRoot);
    await mkdir(packageRoot, { recursive: true });
    await assertNotSymbolicLink(packageRoot, "Backup output root");
    const packagePath = path.resolve(packageRoot, plan.proposed_backup_id);
    const temporaryPath = path.resolve(
      packageRoot,
      `.${plan.proposed_backup_id}.${randomUUID()}.tmp`
    );
    await assertPathMissing(packagePath, "Backup package");
    await assertPathMissing(temporaryPath, "Temporary backup package");

    const manifest: StateBackupManifest = {
      schema_version: "0.1",
      artifact_kind: "state_backup",
      backup_id: plan.proposed_backup_id,
      created_at: now.toISOString(),
      content_sha256: plan.content_sha256,
      summary: plan.summary,
      policy: backupPolicy(),
      excluded: plan.excluded,
      files: plan.files
    };

    try {
      for (const record of collected.files) {
        if (record.content === undefined) {
          throw new StateBackupSafetyError(
            `Backup content is unavailable for ${record.path}.`
          );
        }
        const destination = backupPayloadPath(temporaryPath, record.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, record.content);
      }
      await writeJsonFileAtomic(path.join(temporaryPath, "manifest.json"), manifest);
      await rename(temporaryPath, packagePath);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }

    const manifestPath = path.join(packagePath, "manifest.json");
    const registryPath = backupRegistryPath(projectRoot, manifest.backup_id);
    const registry: StateBackupRegistry = {
      schema_version: "0.1",
      artifact_kind: "state_backup_registry",
      backup_id: manifest.backup_id,
      package_path: packagePath,
      manifest_path: manifestPath,
      content_sha256: manifest.content_sha256,
      created_at: manifest.created_at
    };
    await writeJsonFileAtomic(registryPath, registry);

    return {
      schema_version: "0.1",
      status: "created",
      dry_run: false,
      backup_id: manifest.backup_id,
      package_path: packagePath,
      manifest_path: manifestPath,
      registry_path: toProjectOrAbsolutePath(projectRoot, registryPath),
      content_sha256: manifest.content_sha256,
      created_at: manifest.created_at,
      summary: manifest.summary
    };
  } finally {
    await releaseStateLock(lock);
  }
}

export async function verifyStateBackup(
  projectRoot: string,
  backupId: string,
  options: { source?: string; now?: () => Date } = {}
): Promise<StateBackupVerifyResult> {
  const loaded = await loadAndVerifyStateBackup(
    projectRoot,
    backupId,
    options.source
  );
  return {
    schema_version: "0.1",
    status: "verified",
    backup_id: loaded.manifest.backup_id,
    package_path: loaded.package_path,
    manifest_path: loaded.manifest_path,
    content_sha256: loaded.manifest.content_sha256,
    verified_at: (options.now?.() ?? new Date()).toISOString(),
    summary: loaded.manifest.summary
  };
}

export async function rehearseStateBackup(
  projectRoot: string,
  backupId: string,
  options: { source?: string; now?: () => Date } = {}
): Promise<StateBackupRehearsalResult> {
  const now = options.now?.() ?? new Date();
  const loaded = await loadAndVerifyStateBackup(
    projectRoot,
    backupId,
    options.source
  );
  const rehearsalRoot = await mkdtemp(
    path.join(os.tmpdir(), "kairon-backup-rehearsal-")
  );
  let integrity: StateIntegrityCheckResult;
  try {
    for (const record of loaded.files.values()) {
      if (record.content === undefined) {
        throw new StateBackupSafetyError(
          `Backup content is unavailable for rehearsal: ${record.path}.`
        );
      }
      const destination = resolveProjectStatePath(rehearsalRoot, record.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, record.content);
    }
    integrity = await checkStateIntegrity(rehearsalRoot, { now: () => now });
  } finally {
    await rm(rehearsalRoot, { recursive: true, force: true });
  }

  return {
    schema_version: "0.1",
    status: integrity.summary.errors === 0 ? "passed" : "failed",
    backup_id: backupId,
    rehearsed_at: now.toISOString(),
    isolated_project_path: rehearsalRoot,
    cleaned_up: true,
    integrity
  };
}

export async function restoreStateBackup(
  projectRoot: string,
  backupId: string,
  options: StateBackupRestoreOptions
): Promise<StateBackupRestoreResult> {
  assertBackupId(backupId);
  if (options.confirm !== backupId) {
    throw new StateBackupSafetyError(
      `Backup confirmation does not match. Expected --confirm ${backupId}.`
    );
  }
  const runtime = await readRuntimeLockStatus(projectRoot);
  if (runtime.locked) {
    throw new StateBackupSafetyError(
      "Kairon runtime must be stopped before restoring a backup. Run `kairon stop` first."
    );
  }
  const markerPath = stateBackupRestoreMarkerPath(projectRoot);
  if (await fileExists(markerPath)) {
    throw new StateBackupSafetyError(
      "A previous backup restore requires recovery before another restore can start."
    );
  }

  const loaded = await loadAndVerifyStateBackup(
    projectRoot,
    backupId,
    options.source
  );
  const now = options.now?.() ?? new Date();
  const lock = await acquireStateLock(projectRoot);
  let marker: StateBackupRestoreMarker | undefined;
  try {
    const preRestoreSnapshot = await createStateSnapshotWithExistingLock(projectRoot, {
      now: () => now
    });
    const current = await collectBackupState(projectRoot, false, false);
    const changes = calculateRestoreChanges(current.files, loaded.files);
    marker = createRestoreMarker(backupId, preRestoreSnapshot, now);
    await writeJsonFileAtomic(markerPath, marker);

    let restoredFiles = 0;
    for (const record of loaded.files.values()) {
      if (record.content === undefined) {
        throw new StateBackupSafetyError(
          `Backup content is unavailable for restore: ${record.path}.`
        );
      }
      const destination = resolveProjectStatePath(projectRoot, record.path);
      await assertNoSymbolicLinks(getKaironPaths(projectRoot).kaironDir, destination);
      await writeFileAtomic(destination, record.content);
      restoredFiles += 1;
      marker.status = "restoring";
      marker.restored_files = restoredFiles;
      marker.updated_at = new Date().toISOString();
      await writeJsonFileAtomic(markerPath, marker);
      await options.afterFileRestored?.(record, restoredFiles);
    }

    for (const record of current.files) {
      if (loaded.files.has(record.path)) {
        continue;
      }
      const target = resolveProjectStatePath(projectRoot, record.path);
      await assertNoSymbolicLinks(getKaironPaths(projectRoot).kaironDir, target);
      await rm(target, { force: true });
      marker.deleted_files += 1;
      marker.updated_at = new Date().toISOString();
      await writeJsonFileAtomic(markerPath, marker);
    }

    marker.status = "validating";
    marker.updated_at = new Date().toISOString();
    await writeJsonFileAtomic(markerPath, marker);
    const integrity = await checkStateIntegrity(projectRoot, { now: () => now });
    if (integrity.summary.errors > 0) {
      throw new StateBackupIntegrityError(
        `Restored backup failed state integrity with ${integrity.summary.errors} errors.`
      );
    }

    await rm(markerPath, { force: true });
    return {
      schema_version: "0.1",
      status: "restored",
      backup_id: backupId,
      restored_at: new Date().toISOString(),
      pre_restore_snapshot_id: preRestoreSnapshot.snapshot_id,
      pre_restore_snapshot_path: preRestoreSnapshot.snapshot_path,
      summary: changes,
      integrity
    };
  } catch (error) {
    if (marker !== undefined) {
      marker.status = "restore_failed";
      marker.error_code =
        error instanceof StateBackupIntegrityError
          ? "post_restore_integrity_failed"
          : "restore_apply_failed";
      marker.updated_at = new Date().toISOString();
      marker.next_action =
        `Run kairon state snapshot restore ${marker.pre_restore_snapshot_id} ` +
        `--confirm ${marker.pre_restore_snapshot_id} after reviewing the recovery target.`;
      try {
        await writeJsonFileAtomic(markerPath, marker);
      } catch {
        // Preserve the original restore error when marker refresh also fails.
      }
    }
    throw error;
  } finally {
    await releaseStateLock(lock);
  }
}

export function formatStateBackupDryRun(
  result: StateBackupDryRunResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon state backup dry-run.",
    `status=${result.status}`,
    `dry_run=${result.dry_run}`,
    `proposed_backup_id=${result.proposed_backup_id}`,
    `content_sha256=${result.content_sha256}`,
    `files=${result.summary.files}`,
    `bytes=${result.summary.bytes}`,
    `excluded=${result.summary.excluded}`,
    ...result.excluded.map(
      (item) => `exclude reason=${item.reason} path=${item.path}`
    ),
    ...result.files.map(
      (file) =>
        `file category=${file.category} bytes=${file.bytes} schema=${file.schema_version ?? "none"} path=${file.path}`
    )
  ].join("\n");
}

export function formatStateBackupCreate(
  result: StateBackupCreateResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon state backup created.",
    `status=${result.status}`,
    `backup_id=${result.backup_id}`,
    `package_path=${result.package_path}`,
    `manifest_path=${result.manifest_path}`,
    `registry_path=${result.registry_path}`,
    `content_sha256=${result.content_sha256}`,
    `files=${result.summary.files}`,
    `bytes=${result.summary.bytes}`,
    `excluded=${result.summary.excluded}`
  ].join("\n");
}

export function formatStateBackupVerify(
  result: StateBackupVerifyResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon state backup verified.",
    `status=${result.status}`,
    `backup_id=${result.backup_id}`,
    `package_path=${result.package_path}`,
    `manifest_path=${result.manifest_path}`,
    `content_sha256=${result.content_sha256}`,
    `files=${result.summary.files}`,
    `bytes=${result.summary.bytes}`
  ].join("\n");
}

export function formatStateBackupRehearsal(
  result: StateBackupRehearsalResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon state backup rehearsal completed.",
    `status=${result.status}`,
    `backup_id=${result.backup_id}`,
    `isolated_project_path=${result.isolated_project_path}`,
    `cleaned_up=${result.cleaned_up}`,
    `integrity.status=${result.integrity.status}`,
    `integrity.errors=${result.integrity.summary.errors}`,
    `integrity.warnings=${result.integrity.summary.warnings}`
  ].join("\n");
}

export function formatStateBackupRestore(
  result: StateBackupRestoreResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon state backup restored.",
    `status=${result.status}`,
    `backup_id=${result.backup_id}`,
    `pre_restore_snapshot_id=${result.pre_restore_snapshot_id}`,
    `pre_restore_snapshot_path=${result.pre_restore_snapshot_path}`,
    `changes.added=${result.summary.added}`,
    `changes.updated=${result.summary.updated}`,
    `changes.deleted=${result.summary.deleted}`,
    `changes.unchanged=${result.summary.unchanged}`,
    `integrity.status=${result.integrity.status}`,
    `integrity.errors=${result.integrity.summary.errors}`
  ].join("\n");
}

export function stateBackupRestoreMarkerPath(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "state-backup-restore.json"
  );
}

async function collectBackupState(
  projectRoot: string,
  includeContent: boolean,
  validateSchema: boolean
): Promise<CollectedBackupState> {
  const files: StateBackupFileRecord[] = [];
  const excluded: StateBackupExcludedPath[] = [];
  await walkBackupState(
    projectRoot,
    getKaironPaths(projectRoot).kaironDir,
    files,
    excluded,
    includeContent,
    validateSchema
  );
  files.sort((left, right) => left.path.localeCompare(right.path));
  excluded.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason)
  );
  return { files, excluded };
}

async function walkBackupState(
  projectRoot: string,
  directoryPath: string,
  files: StateBackupFileRecord[],
  excluded: StateBackupExcludedPath[],
  includeContent: boolean,
  validateSchema: boolean
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directoryPath, entry.name);
    const projectPath = toProjectPath(projectRoot, absolutePath);
    if (entry.isSymbolicLink()) {
      excluded.push({ path: projectPath, reason: "symbolic_link" });
      continue;
    }
    const policyReason = excludedPathReason(projectPath);
    if (policyReason !== undefined) {
      excluded.push({
        path: entry.isDirectory() ? `${projectPath}/**` : projectPath,
        reason: policyReason
      });
      continue;
    }
    if (entry.isDirectory()) {
      await walkBackupState(
        projectRoot,
        absolutePath,
        files,
        excluded,
        includeContent,
        validateSchema
      );
      continue;
    }
    if (!entry.isFile()) {
      excluded.push({ path: projectPath, reason: "unsupported_type" });
      continue;
    }
    if (entry.name.toLowerCase().endsWith(".log")) {
      excluded.push({ path: projectPath, reason: "log" });
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!includedExtensions.includes(extension)) {
      excluded.push({ path: projectPath, reason: "unsupported_type" });
      continue;
    }

    const content = await readFile(absolutePath);
    files.push({
      path: projectPath,
      bytes: content.length,
      sha256: hashBuffer(content),
      category: backupCategory(projectPath),
      schema_version: validateSchema
        ? readArtifactSchemaVersion(projectPath, content)
        : null,
      absolute_path: absolutePath,
      content: includeContent ? content : undefined
    });
  }
}

function buildBackupPlan(
  collected: CollectedBackupState,
  now: Date
): StateBackupDryRunResult {
  const files = collected.files.map(stripBackupRecord);
  const contentSha256 = hashManifestFiles(files);
  return {
    schema_version: "0.1",
    status: "planned",
    dry_run: true,
    generated_at: now.toISOString(),
    proposed_backup_id: backupIdFor(now, contentSha256),
    content_sha256: contentSha256,
    summary: summarizeBackup(files, collected.excluded),
    excluded: collected.excluded,
    files
  };
}

async function loadAndVerifyStateBackup(
  projectRoot: string,
  backupId: string,
  source?: string
): Promise<LoadedStateBackup> {
  assertBackupId(backupId);
  const packagePath = source === undefined
    ? await resolveBackupPackagePath(projectRoot, backupId)
    : path.isAbsolute(source)
      ? path.resolve(source)
      : path.resolve(projectRoot, source);
  await assertNotSymbolicLink(packagePath, "Backup package");
  const manifestPath = path.join(packagePath, "manifest.json");
  await assertRegularFile(manifestPath, "Backup manifest");
  const manifest = parseBackupManifest(
    await readJsonFile<unknown>(manifestPath),
    backupId
  );
  const payloadRoot = path.join(packagePath, "files");
  const actualPayloadPaths: string[] = [];
  await walkBackupPayload(payloadRoot, actualPayloadPaths);
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = new Set(
    actualPayloadPaths.map((filePath) => payloadStatePath(payloadRoot, filePath))
  );
  if (
    expectedPaths.size !== actualPaths.size ||
    [...expectedPaths].some((filePath) => !actualPaths.has(filePath))
  ) {
    throw new StateBackupSafetyError(
      `Backup payload file set does not match manifest ${backupId}.`
    );
  }

  const files = new Map<string, StateBackupFileRecord>();
  for (const file of manifest.files) {
    if (excludedPathReason(file.path) !== undefined) {
      throw new StateBackupSafetyError(
        `Backup manifest contains a policy-excluded path: ${file.path}.`
      );
    }
    const payloadPath = backupPayloadPath(packagePath, file.path);
    await assertRegularFile(payloadPath, "Backup payload");
    const content = await readFile(payloadPath);
    const schemaVersion = readArtifactSchemaVersion(file.path, content);
    if (
      content.length !== file.bytes ||
      hashBuffer(content) !== file.sha256 ||
      backupCategory(file.path) !== file.category ||
      schemaVersion !== file.schema_version
    ) {
      throw new StateBackupSafetyError(
        `Backup payload verification failed: ${file.path}.`
      );
    }
    files.set(file.path, {
      ...file,
      absolute_path: payloadPath,
      content
    });
  }

  const contentSha256 = hashManifestFiles(manifest.files);
  const summary = summarizeBackup(manifest.files, manifest.excluded);
  if (
    contentSha256 !== manifest.content_sha256 ||
    !backupId.endsWith(contentSha256.slice("sha256:".length, "sha256:".length + 12)) ||
    JSON.stringify(summary) !== JSON.stringify(manifest.summary)
  ) {
    throw new StateBackupSafetyError(
      `Backup manifest checksum or summary is invalid: ${backupId}.`
    );
  }

  return { manifest, package_path: packagePath, manifest_path: manifestPath, files };
}

function parseBackupManifest(value: unknown, expectedId: string): StateBackupManifest {
  const record = toRecord(value);
  const summary = toRecord(record.summary);
  const policy = toRecord(record.policy);
  if (
    record.schema_version !== "0.1" ||
    record.artifact_kind !== "state_backup" ||
    record.backup_id !== expectedId ||
    typeof record.created_at !== "string" ||
    typeof record.content_sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.content_sha256) ||
    typeof summary.files !== "number" ||
    typeof summary.bytes !== "number" ||
    typeof summary.excluded !== "number" ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.excluded) ||
    !Array.isArray(policy.included_extensions) ||
    !Array.isArray(policy.excluded_prefixes) ||
    policy.secret_like_paths !== "excluded" ||
    policy.symbolic_links !== "excluded"
  ) {
    throw new StateBackupSafetyError(`Invalid backup manifest: ${expectedId}.`);
  }
  const files = record.files.map(parseManifestFile);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new StateBackupSafetyError(`Backup manifest has duplicate paths: ${expectedId}.`);
  }
  return {
    schema_version: "0.1",
    artifact_kind: "state_backup",
    backup_id: expectedId,
    created_at: record.created_at,
    content_sha256: record.content_sha256,
    summary: {
      files: summary.files,
      bytes: summary.bytes,
      excluded: summary.excluded
    },
    policy: backupPolicy(),
    excluded: record.excluded.map(parseExcludedPath),
    files
  };
}

function parseManifestFile(value: unknown): StateBackupManifestFile {
  const record = toRecord(value);
  if (
    typeof record.path !== "string" ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sha256) ||
    typeof record.category !== "string" ||
    !(typeof record.schema_version === "string" || record.schema_version === null)
  ) {
    throw new StateBackupSafetyError("Backup manifest contains an invalid file record.");
  }
  validateStatePath(record.path);
  return {
    path: record.path,
    bytes: record.bytes,
    sha256: record.sha256,
    category: record.category,
    schema_version: record.schema_version
  };
}

function parseExcludedPath(value: unknown): StateBackupExcludedPath {
  const record = toRecord(value);
  const reasons: StateBackupExclusionReason[] = [
    "runtime_ephemeral",
    "temporary",
    "generated",
    "snapshot_storage",
    "backup_storage",
    "log",
    "secret_like_path",
    "symbolic_link",
    "unsupported_type"
  ];
  if (
    typeof record.path !== "string" ||
    typeof record.reason !== "string" ||
    !reasons.includes(record.reason as StateBackupExclusionReason)
  ) {
    throw new StateBackupSafetyError("Backup manifest contains an invalid exclusion.");
  }
  return { path: record.path, reason: record.reason as StateBackupExclusionReason };
}

function readArtifactSchemaVersion(filePath: string, content: Buffer): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md") {
    return null;
  }
  const text = stripUtf8Bom(content.toString("utf8"));
  if (extension === ".json") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new StateBackupSafetyError(
        `Backup source is not valid JSON: ${filePath}. ${shortError(error)}`
      );
    }
    const schemaVersion = toRecord(value).schema_version;
    return typeof schemaVersion === "string" ? schemaVersion : null;
  }

  const versions = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new StateBackupSafetyError(
        `Backup source is not valid JSONL at ${filePath}:${index + 1}. ${shortError(error)}`
      );
    }
    const schemaVersion = toRecord(value).schema_version;
    if (typeof schemaVersion === "string") {
      versions.add(schemaVersion);
    }
  }
  if (versions.size > 1) {
    throw new StateBackupSafetyError(
      `Backup source has mixed schema versions: ${filePath}.`
    );
  }
  return [...versions][0] ?? null;
}

async function walkBackupPayload(
  directoryPath: string,
  files: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateBackupSafetyError(`Backup payload directory is missing: ${directoryPath}.`);
    }
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new StateBackupSafetyError(
        `Symbolic links are not allowed in backup payloads: ${fullPath}.`
      );
    }
    if (entry.isDirectory()) {
      await walkBackupPayload(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    } else {
      throw new StateBackupSafetyError(`Unsupported backup payload entry: ${fullPath}.`);
    }
  }
}

function calculateRestoreChanges(
  current: StateBackupFileRecord[],
  backup: Map<string, StateBackupFileRecord>
): StateBackupRestoreResult["summary"] {
  const currentMap = new Map(current.map((record) => [record.path, record]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const record of backup.values()) {
    const currentRecord = currentMap.get(record.path);
    if (currentRecord === undefined) {
      added += 1;
    } else if (currentRecord.sha256 !== record.sha256) {
      updated += 1;
    } else {
      unchanged += 1;
    }
    currentMap.delete(record.path);
  }
  return { added, updated, deleted: currentMap.size, unchanged };
}

function createRestoreMarker(
  backupId: string,
  snapshot: StateSnapshotCreateResult,
  now: Date
): StateBackupRestoreMarker {
  return {
    schema_version: "0.1",
    artifact_kind: "state_backup_restore",
    status: "pre_restore_snapshot_created",
    backup_id: backupId,
    pre_restore_snapshot_id: snapshot.snapshot_id,
    pre_restore_snapshot_path: snapshot.snapshot_path,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    restored_files: 0,
    deleted_files: 0,
    next_action: "Continue verified restore; use the pre-restore snapshot for rollback on failure."
  };
}

function backupPolicy(): StateBackupManifest["policy"] {
  return {
    included_extensions: [...includedExtensions],
    excluded_prefixes: excludedPrefixes.map((item) => `${item.path}/**`),
    secret_like_paths: "excluded",
    symbolic_links: "excluded"
  };
}

function excludedPathReason(filePath: string): StateBackupExclusionReason | undefined {
  const prefix = excludedPrefixes.find(
    (item) => filePath === item.path || filePath.startsWith(`${item.path}/`)
  );
  if (prefix !== undefined) {
    return prefix.reason;
  }
  const normalized = filePath.toLowerCase();
  if (
    normalized.split("/").some((segment) =>
      /(^|[._-])(secret|token|credential|password)([._-]|$)/u.test(segment)
    ) ||
    /(^|\/)\.env(?:\.|$)/u.test(normalized) ||
    /\.(pem|key|p12|pfx)$/u.test(normalized)
  ) {
    return "secret_like_path";
  }
  return undefined;
}

function resolveBackupOutputRoot(projectRoot: string, output?: string): string {
  if (output === undefined) {
    return defaultBackupPackagesRoot(projectRoot);
  }
  return path.isAbsolute(output)
    ? path.resolve(output)
    : path.resolve(projectRoot, output);
}

async function assertBackupOutputRoot(
  projectRoot: string,
  outputRoot: string
): Promise<void> {
  const kaironDir = getKaironPaths(projectRoot).kaironDir;
  const relative = toPosixPath(path.relative(kaironDir, outputRoot));
  if (
    relative === "" ||
    (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative))
  ) {
    if (!(relative === "backups" || relative.startsWith("backups/"))) {
      throw new StateBackupSafetyError(
        "Backup output inside .kairon must be under .kairon/backups."
      );
    }
  }
}

async function resolveBackupPackagePath(
  projectRoot: string,
  backupId: string
): Promise<string> {
  const registryPath = backupRegistryPath(projectRoot, backupId);
  if (await fileExists(registryPath)) {
    const registry = await readJsonFile<StateBackupRegistry>(registryPath);
    if (
      registry.schema_version !== "0.1" ||
      registry.artifact_kind !== "state_backup_registry" ||
      registry.backup_id !== backupId ||
      typeof registry.package_path !== "string"
    ) {
      throw new StateBackupSafetyError(`Invalid backup registry: ${backupId}.`);
    }
    return path.resolve(registry.package_path);
  }
  return path.join(defaultBackupPackagesRoot(projectRoot), backupId);
}

function backupRegistryPath(projectRoot: string, backupId: string): string {
  assertBackupId(backupId);
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "backups",
    "index",
    `${backupId}.json`
  );
}

function defaultBackupPackagesRoot(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "backups",
    "packages"
  );
}

function backupPayloadPath(packagePath: string, statePath: string): string {
  validateStatePath(statePath);
  return path.resolve(
    packagePath,
    "files",
    ...statePath.slice(".kairon/".length).split("/")
  );
}

function payloadStatePath(payloadRoot: string, filePath: string): string {
  const relative = toPosixPath(path.relative(payloadRoot, filePath));
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new StateBackupSafetyError(`Backup payload escapes package: ${filePath}.`);
  }
  return `.kairon/${relative}`;
}

function resolveProjectStatePath(projectRoot: string, statePath: string): string {
  validateStatePath(statePath);
  return resolveInside(projectRoot, ...statePath.split("/"));
}

function validateStatePath(statePath: string): void {
  if (
    !statePath.startsWith(".kairon/") ||
    statePath.includes("\\") ||
    path.posix.isAbsolute(statePath) ||
    statePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new StateBackupSafetyError(`Invalid backup state path: ${statePath}.`);
  }
}

function stripBackupRecord(record: StateBackupFileRecord): StateBackupManifestFile {
  const { absolute_path: _absolutePath, content: _content, ...file } = record;
  return file;
}

function hashManifestFiles(files: StateBackupManifestFile[]): string {
  const normalized = files
    .map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      category: file.category,
      schema_version: file.schema_version
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return hashBuffer(Buffer.from(JSON.stringify(normalized), "utf8"));
}

function summarizeBackup(
  files: StateBackupManifestFile[],
  excluded: StateBackupExcludedPath[]
): StateBackupManifest["summary"] {
  return {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    excluded: excluded.length
  };
}

function backupIdFor(now: Date, contentSha256: string): string {
  const timestamp = now.toISOString().replace(/\D/gu, "").slice(0, 17);
  const digest = contentSha256.slice("sha256:".length, "sha256:".length + 12);
  return `BKP-${timestamp}-${digest}`;
}

function assertBackupId(backupId: string): void {
  if (!backupIdPattern.test(backupId)) {
    throw new StateBackupSafetyError(`Invalid backup id: ${backupId}.`);
  }
}

function backupCategory(filePath: string): string {
  return filePath.split("/")[1] ?? "unknown";
}

async function writeFileAtomic(filePath: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function assertNoSymbolicLinks(root: string, targetPath: string): Promise<void> {
  const relative = path.relative(root, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StateBackupSafetyError(`Restore target escapes .kairon: ${targetPath}.`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter((item) => item.length > 0)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new StateBackupSafetyError(
          `Symbolic links are not allowed in backup restore targets: ${current}.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw new StateBackupSafetyError(`${label} is missing: ${filePath}. ${shortError(error)}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StateBackupSafetyError(`${label} must be a regular file: ${filePath}.`);
  }
}

async function assertNotSymbolicLink(filePath: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw new StateBackupSafetyError(`${label} is missing: ${filePath}. ${shortError(error)}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StateBackupSafetyError(`${label} must be a regular directory: ${filePath}.`);
  }
}

async function assertPathMissing(filePath: string, label: string): Promise<void> {
  if (await fileExists(filePath)) {
    throw new StateBackupSafetyError(`${label} already exists: ${filePath}.`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hashBuffer(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function shortError(error: unknown): string {
  return String(error).replace(/\s+/gu, " ").split("\n")[0].slice(0, 240);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function toProjectOrAbsolutePath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? filePath
    : toPosixPath(relative);
}
