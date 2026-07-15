import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { readRuntimeLockStatus } from "../runtime/runtime-lock.js";
import {
  checkStateIntegrity,
  type StateIntegrityCheckResult
} from "./integrity-check.js";
import { acquireStateLock, releaseStateLock } from "./state-lock.js";

export type StateSnapshotDryRunResult = {
  schema_version: "0.1";
  dry_run: true;
  generated_at: string;
  summary: {
    files: number;
    bytes: number;
  };
  targets: StateSnapshotTarget[];
};

export type StateSnapshotTarget = {
  path: string;
  bytes: number;
  category: string;
};

export type StateSnapshotManifestFile = StateSnapshotTarget & {
  sha256: string;
};

export type StateSnapshotManifest = {
  schema_version: "0.1";
  artifact_kind: "state_snapshot";
  snapshot_id: string;
  created_at: string;
  snapshot_path: string;
  summary: {
    files: number;
    bytes: number;
  };
  excluded: string[];
  files: StateSnapshotManifestFile[];
};

export type StateSnapshotCreateResult = {
  schema_version: "0.1";
  status: "created";
  snapshot_id: string;
  snapshot_path: string;
  manifest_path: string;
  created_at: string;
  summary: StateSnapshotManifest["summary"];
};

export type StateSnapshotRestoreAction = "add" | "update" | "delete";

export type StateSnapshotRestoreChange = {
  action: StateSnapshotRestoreAction;
  path: string;
  bytes: number;
};

export type StateSnapshotRestorePlan = {
  schema_version: "0.1";
  status: "planned";
  dry_run: true;
  snapshot_id: string;
  snapshot_path: string;
  generated_at: string;
  summary: {
    add: number;
    update: number;
    delete: number;
    unchanged: number;
  };
  changes: StateSnapshotRestoreChange[];
};

export type StateSnapshotRestoreResult = {
  schema_version: "0.1";
  status: "restored" | "restored_with_issues";
  dry_run: false;
  snapshot_id: string;
  snapshot_path: string;
  restored_at: string;
  backup_snapshot_id: string;
  backup_snapshot_path: string;
  summary: StateSnapshotRestorePlan["summary"];
  integrity: StateIntegrityCheckResult;
};

export type StateSnapshotOptions = {
  now?: () => Date;
  snapshotId?: string;
};

export type StateSnapshotRestoreOptions = {
  confirm: string;
  now?: () => Date;
};

type SnapshotFileRecord = StateSnapshotManifestFile & {
  absolutePath: string;
  content?: Buffer;
};

type LoadedSnapshot = {
  manifest: StateSnapshotManifest;
  directory: string;
  files: Map<string, SnapshotFileRecord>;
};

const snapshotExtensions = new Set([".json", ".jsonl", ".md"]);
const excludedSnapshotPaths = [
  ".kairon/runtime",
  ".kairon/snapshots",
  ".kairon/backups",
  ".kairon/tmp",
  ".kairon/worktrees"
];

export class StateSnapshotSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateSnapshotSafetyError";
  }
}

export async function collectStateSnapshotDryRun(
  projectRoot: string,
  options: StateSnapshotOptions = {}
): Promise<StateSnapshotDryRunResult> {
  const now = options.now?.() ?? new Date();
  const targets = await collectSnapshotTargets(projectRoot);

  return {
    schema_version: "0.1",
    dry_run: true,
    generated_at: now.toISOString(),
    summary: summarizeTargets(targets),
    targets
  };
}

export async function createStateSnapshot(
  projectRoot: string,
  options: StateSnapshotOptions = {}
): Promise<StateSnapshotCreateResult> {
  const lock = await acquireStateLock(projectRoot);
  try {
    return await createStateSnapshotWithoutLock(projectRoot, options);
  } finally {
    await releaseStateLock(lock);
  }
}

export async function createStateSnapshotWithExistingLock(
  projectRoot: string,
  options: StateSnapshotOptions = {}
): Promise<StateSnapshotCreateResult> {
  return createStateSnapshotWithoutLock(projectRoot, options);
}

export async function planStateSnapshotRestore(
  projectRoot: string,
  snapshotId: string,
  options: Pick<StateSnapshotRestoreOptions, "now"> = {}
): Promise<StateSnapshotRestorePlan> {
  const loaded = await loadSnapshot(projectRoot, snapshotId);
  return buildRestorePlan(
    projectRoot,
    loaded,
    options.now?.() ?? new Date()
  );
}

export async function restoreStateSnapshot(
  projectRoot: string,
  snapshotId: string,
  options: StateSnapshotRestoreOptions
): Promise<StateSnapshotRestoreResult> {
  assertSnapshotId(snapshotId);
  if (options.confirm !== snapshotId) {
    throw new StateSnapshotSafetyError(
      `Snapshot confirmation does not match. Expected --confirm ${snapshotId}.`
    );
  }

  const runtime = await readRuntimeLockStatus(projectRoot);
  if (runtime.locked) {
    throw new StateSnapshotSafetyError(
      "Kairon runtime must be stopped before restoring state. Run `kairon stop` first."
    );
  }

  const lock = await acquireStateLock(projectRoot);
  try {
    const now = options.now?.() ?? new Date();
    const loaded = await loadSnapshot(projectRoot, snapshotId);
    const plan = await buildRestorePlan(projectRoot, loaded, now);
    const backup = await createStateSnapshotWithoutLock(projectRoot, {
      now: () => now
    });

    for (const change of plan.changes.filter((item) => item.action !== "delete")) {
      const source = loaded.files.get(change.path);
      if (source?.content === undefined) {
        throw new StateSnapshotSafetyError(
          `Snapshot payload is unavailable for ${change.path}.`
        );
      }
      const targetPath = resolveStatePath(projectRoot, change.path);
      await assertNoSymbolicLinks(getKaironPaths(projectRoot).kaironDir, targetPath);
      await writeFileAtomic(targetPath, source.content);
    }

    for (const change of plan.changes.filter((item) => item.action === "delete")) {
      const targetPath = resolveStatePath(projectRoot, change.path);
      await assertNoSymbolicLinks(getKaironPaths(projectRoot).kaironDir, targetPath);
      await rm(targetPath, { force: true });
    }

    const integrity = await checkStateIntegrity(projectRoot, {
      now: () => now
    });

    return {
      schema_version: "0.1",
      status: integrity.summary.errors === 0 ? "restored" : "restored_with_issues",
      dry_run: false,
      snapshot_id: snapshotId,
      snapshot_path: loaded.manifest.snapshot_path,
      restored_at: now.toISOString(),
      backup_snapshot_id: backup.snapshot_id,
      backup_snapshot_path: backup.snapshot_path,
      summary: plan.summary,
      integrity
    };
  } finally {
    await releaseStateLock(lock);
  }
}

export function formatStateSnapshotDryRun(
  result: StateSnapshotDryRunResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "Kairon state snapshot dry-run.",
    `dry_run=${result.dry_run}`,
    `targets.files=${result.summary.files}`,
    `targets.bytes=${result.summary.bytes}`,
    ...result.targets.map(
      (target) =>
        `target category=${target.category} bytes=${target.bytes} path=${target.path}`
    )
  ].join("\n");
}

export function formatStateSnapshotCreate(
  result: StateSnapshotCreateResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "Kairon state snapshot created.",
    `status=${result.status}`,
    `snapshot_id=${result.snapshot_id}`,
    `snapshot_path=${result.snapshot_path}`,
    `manifest_path=${result.manifest_path}`,
    `summary.files=${result.summary.files}`,
    `summary.bytes=${result.summary.bytes}`
  ].join("\n");
}

export function formatStateSnapshotRestorePlan(
  result: StateSnapshotRestorePlan,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "Kairon state snapshot restore dry-run.",
    `status=${result.status}`,
    `dry_run=${result.dry_run}`,
    `snapshot_id=${result.snapshot_id}`,
    `snapshot_path=${result.snapshot_path}`,
    `changes.add=${result.summary.add}`,
    `changes.update=${result.summary.update}`,
    `changes.delete=${result.summary.delete}`,
    `changes.unchanged=${result.summary.unchanged}`,
    ...result.changes.map(
      (change) =>
        `change action=${change.action} bytes=${change.bytes} path=${change.path}`
    )
  ].join("\n");
}

export function formatStateSnapshotRestoreResult(
  result: StateSnapshotRestoreResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "Kairon state snapshot restored.",
    `status=${result.status}`,
    `dry_run=${result.dry_run}`,
    `snapshot_id=${result.snapshot_id}`,
    `snapshot_path=${result.snapshot_path}`,
    `backup_snapshot_id=${result.backup_snapshot_id}`,
    `backup_snapshot_path=${result.backup_snapshot_path}`,
    `changes.add=${result.summary.add}`,
    `changes.update=${result.summary.update}`,
    `changes.delete=${result.summary.delete}`,
    `integrity.status=${result.integrity.status}`,
    `integrity.errors=${result.integrity.summary.errors}`,
    `integrity.warnings=${result.integrity.summary.warnings}`
  ].join("\n");
}

async function createStateSnapshotWithoutLock(
  projectRoot: string,
  options: StateSnapshotOptions
): Promise<StateSnapshotCreateResult> {
  const now = options.now?.() ?? new Date();
  const snapshotRoot = snapshotRootPath(projectRoot);
  await mkdir(snapshotRoot, { recursive: true });
  await assertNoSymbolicLinks(
    getKaironPaths(projectRoot).kaironDir,
    snapshotRoot
  );
  const snapshotId =
    options.snapshotId === undefined
      ? await nextSnapshotId(snapshotRoot, now)
      : options.snapshotId;
  assertSnapshotId(snapshotId);

  const finalDirectory = resolveInside(snapshotRoot, snapshotId);
  if (await fileExists(finalDirectory)) {
    throw new StateSnapshotSafetyError(`Snapshot already exists: ${snapshotId}`);
  }

  const temporaryDirectory = resolveInside(
    snapshotRoot,
    `.${snapshotId}.${randomUUID()}.tmp`
  );
  const payloadRoot = resolveInside(temporaryDirectory, "files");
  const records = await collectSnapshotRecords(projectRoot, true);
  const manifest: StateSnapshotManifest = {
    schema_version: "0.1",
    artifact_kind: "state_snapshot",
    snapshot_id: snapshotId,
    created_at: now.toISOString(),
    snapshot_path: toProjectPath(projectRoot, finalDirectory),
    summary: summarizeTargets(records),
    excluded: [
      ...excludedSnapshotPaths.map((value) => `${value}/**`),
      "**/*.log",
      "**/.resource-locks/**"
    ],
    files: records.map(({ absolutePath: _absolutePath, content: _content, ...file }) => file)
  };

  try {
    for (const record of records) {
      if (record.content === undefined) {
        throw new StateSnapshotSafetyError(
          `Snapshot content is unavailable for ${record.path}.`
        );
      }
      const destination = snapshotPayloadPath(payloadRoot, record.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, record.content);
    }
    await writeJsonFileAtomic(
      resolveInside(temporaryDirectory, "manifest.json"),
      manifest
    );
    await rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    schema_version: "0.1",
    status: "created",
    snapshot_id: snapshotId,
    snapshot_path: manifest.snapshot_path,
    manifest_path: `${manifest.snapshot_path}/manifest.json`,
    created_at: manifest.created_at,
    summary: manifest.summary
  };
}

async function buildRestorePlan(
  projectRoot: string,
  loaded: LoadedSnapshot,
  now: Date
): Promise<StateSnapshotRestorePlan> {
  const current = new Map(
    (await collectSnapshotRecords(projectRoot, false)).map((file) => [file.path, file])
  );
  const changes: StateSnapshotRestoreChange[] = [];
  let unchanged = 0;

  for (const file of loaded.files.values()) {
    const currentFile = current.get(file.path);
    if (currentFile === undefined) {
      changes.push({ action: "add", path: file.path, bytes: file.bytes });
    } else if (currentFile.sha256 !== file.sha256) {
      changes.push({ action: "update", path: file.path, bytes: file.bytes });
    } else {
      unchanged += 1;
    }
    current.delete(file.path);
  }

  for (const file of current.values()) {
    changes.push({ action: "delete", path: file.path, bytes: file.bytes });
  }

  changes.sort(compareRestoreChanges);
  return {
    schema_version: "0.1",
    status: "planned",
    dry_run: true,
    snapshot_id: loaded.manifest.snapshot_id,
    snapshot_path: loaded.manifest.snapshot_path,
    generated_at: now.toISOString(),
    summary: {
      add: changes.filter((change) => change.action === "add").length,
      update: changes.filter((change) => change.action === "update").length,
      delete: changes.filter((change) => change.action === "delete").length,
      unchanged
    },
    changes
  };
}

async function loadSnapshot(
  projectRoot: string,
  snapshotId: string
): Promise<LoadedSnapshot> {
  assertSnapshotId(snapshotId);
  const directory = resolveInside(snapshotRootPath(projectRoot), snapshotId);
  const manifestPath = resolveInside(directory, "manifest.json");
  await assertNoSymbolicLinks(
    getKaironPaths(projectRoot).kaironDir,
    manifestPath
  );
  await assertRegularFile(manifestPath);
  const manifest = parseSnapshotManifest(
    await readJsonFile<unknown>(manifestPath),
    snapshotId
  );
  const payloadRoot = resolveInside(directory, "files");
  const files = new Map<string, SnapshotFileRecord>();

  for (const file of manifest.files) {
    if (files.has(file.path)) {
      throw new StateSnapshotSafetyError(
        `Snapshot manifest contains duplicate path: ${file.path}`
      );
    }
    resolveStatePath(projectRoot, file.path);
    const payloadPath = snapshotPayloadPath(payloadRoot, file.path);
    await assertNoSymbolicLinks(
      getKaironPaths(projectRoot).kaironDir,
      payloadPath
    );
    await assertRegularFile(payloadPath);
    const content = await readFile(payloadPath);
    const actualSha256 = hashBuffer(content);
    if (content.length !== file.bytes || actualSha256 !== file.sha256) {
      throw new StateSnapshotSafetyError(
        `Snapshot payload verification failed for ${file.path}.`
      );
    }
    files.set(file.path, {
      ...file,
      absolutePath: payloadPath,
      content
    });
  }

  return { manifest, directory, files };
}

async function collectSnapshotTargets(
  projectRoot: string
): Promise<StateSnapshotTarget[]> {
  return (await collectSnapshotRecords(projectRoot, false)).map(
    ({ absolutePath: _absolutePath, sha256: _sha256, content: _content, ...target }) =>
      target
  );
}

async function collectSnapshotRecords(
  projectRoot: string,
  includeContent: boolean
): Promise<SnapshotFileRecord[]> {
  const kaironDir = getKaironPaths(projectRoot).kaironDir;
  const files: string[] = [];
  await walkStateFiles(projectRoot, kaironDir, files);
  const records: SnapshotFileRecord[] = [];

  for (const absolutePath of files.sort()) {
    const relativePath = toProjectPath(projectRoot, absolutePath);
    const content = await readFile(absolutePath);
    records.push({
      path: relativePath,
      bytes: content.length,
      category: snapshotCategory(relativePath),
      sha256: hashBuffer(content),
      absolutePath,
      content: includeContent ? content : undefined
    });
  }

  return records;
}

async function walkStateFiles(
  projectRoot: string,
  directoryPath: string,
  files: string[]
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

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const relativePath = toProjectPath(projectRoot, fullPath);
    if (ignoredSnapshotPath(relativePath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new StateSnapshotSafetyError(
        `Symbolic links are not allowed in snapshot state: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      await walkStateFiles(projectRoot, fullPath, files);
    } else if (
      entry.isFile() &&
      snapshotExtensions.has(path.extname(entry.name).toLowerCase()) &&
      path.extname(entry.name).toLowerCase() !== ".log"
    ) {
      files.push(fullPath);
    }
  }
}

function parseSnapshotManifest(
  value: unknown,
  expectedSnapshotId: string
): StateSnapshotManifest {
  const record = toRecord(value);
  if (
    record.schema_version !== "0.1" ||
    record.artifact_kind !== "state_snapshot" ||
    record.snapshot_id !== expectedSnapshotId ||
    typeof record.created_at !== "string" ||
    record.snapshot_path !== `.kairon/snapshots/${expectedSnapshotId}` ||
    !Array.isArray(record.files)
  ) {
    throw new StateSnapshotSafetyError(
      `Invalid state snapshot manifest for ${expectedSnapshotId}.`
    );
  }

  const files = record.files.map((item) => parseManifestFile(item));
  return {
    schema_version: "0.1",
    artifact_kind: "state_snapshot",
    snapshot_id: expectedSnapshotId,
    created_at: record.created_at,
    snapshot_path: record.snapshot_path,
    summary: summarizeTargets(files),
    excluded: Array.isArray(record.excluded)
      ? record.excluded.filter((item): item is string => typeof item === "string")
      : [],
    files
  };
}

function parseManifestFile(value: unknown): StateSnapshotManifestFile {
  const record = toRecord(value);
  if (
    typeof record.path !== "string" ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.category !== "string" ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sha256)
  ) {
    throw new StateSnapshotSafetyError("Snapshot manifest contains an invalid file entry.");
  }
  validateStatePath(record.path);
  return {
    path: record.path,
    bytes: record.bytes,
    category: record.category,
    sha256: record.sha256
  };
}

function resolveStatePath(projectRoot: string, filePath: string): string {
  validateStatePath(filePath);
  const relative = filePath.slice(".kairon/".length);
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    ...relative.split("/")
  );
}

function snapshotPayloadPath(payloadRoot: string, filePath: string): string {
  validateStatePath(filePath);
  return resolveInside(
    payloadRoot,
    ...filePath.slice(".kairon/".length).split("/")
  );
}

function validateStatePath(filePath: string): void {
  if (
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    !filePath.startsWith(".kairon/") ||
    filePath.split("/").some((segment) => segment === "" || segment === ".." || segment === ".") ||
    ignoredSnapshotPath(filePath)
  ) {
    throw new StateSnapshotSafetyError(
      `Snapshot path must be a restorable .kairon path: ${filePath}`
    );
  }
}

function assertSnapshotId(snapshotId: string): void {
  if (!/^SNP-[A-Z0-9][A-Z0-9_-]{2,80}$/u.test(snapshotId)) {
    throw new StateSnapshotSafetyError(`Invalid snapshot id: ${snapshotId}`);
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw new StateSnapshotSafetyError(
      `Snapshot payload is missing: ${filePath}. ${String(error)}`
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StateSnapshotSafetyError(
      `Snapshot payload must be a regular file: ${filePath}`
    );
  }
}

async function assertNoSymbolicLinks(root: string, targetPath: string): Promise<void> {
  const relative = path.relative(root, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StateSnapshotSafetyError(`Restore target escapes .kairon: ${targetPath}`);
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new StateSnapshotSafetyError(
          `Symbolic links are not allowed in restore targets: ${current}`
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

async function nextSnapshotId(snapshotRoot: string, now: Date): Promise<string> {
  const timestamp = now.toISOString().replace(/\D/gu, "").slice(0, 17);
  const base = `SNP-${timestamp}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt).padStart(2, "0")}`;
    if (!(await fileExists(resolveInside(snapshotRoot, candidate)))) {
      return candidate;
    }
  }
  throw new StateSnapshotSafetyError(`Unable to allocate snapshot id for ${base}.`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function ignoredSnapshotPath(filePath: string): boolean {
  return (
    excludedSnapshotPaths.some(
      (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`)
    ) ||
    filePath.includes("/.resource-locks/") ||
    filePath.endsWith("/.resource-locks") ||
    filePath.endsWith(".log")
  );
}

function snapshotCategory(filePath: string): string {
  const segments = filePath.split("/");
  if (segments.length < 3 || segments[0] !== ".kairon") {
    return "unknown";
  }

  if (["reports", "reviews", "git", "cleanup"].includes(segments[1]) && segments[2] !== undefined) {
    return `${segments[1]}/${segments[2]}`;
  }

  return segments[1];
}

function summarizeTargets(targets: Array<{ bytes: number }>): {
  files: number;
  bytes: number;
} {
  return {
    files: targets.length,
    bytes: targets.reduce((total, target) => total + target.bytes, 0)
  };
}

function snapshotRootPath(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "snapshots");
}

function hashBuffer(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function compareRestoreChanges(
  left: StateSnapshotRestoreChange,
  right: StateSnapshotRestoreChange
): number {
  const order: Record<StateSnapshotRestoreAction, number> = {
    add: 0,
    update: 1,
    delete: 2
  };
  return order[left.action] - order[right.action] || left.path.localeCompare(right.path);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
