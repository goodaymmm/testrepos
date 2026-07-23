import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  acquireResourceLock,
  releaseResourceLock,
  type ResourceLockHandle
} from "../core/fs/resource-lock.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { toPosixPath } from "../core/fs/paths.js";
import {
  resolveWorkflowRuntimeConfig,
  type WorkflowRuntimeConfig
} from "./config.js";
import { FileWorkflowCheckpointStore } from "./checkpoint-file-store.js";
import { isNodeSqliteAvailable, SqliteWorkflowCheckpointStore } from "./checkpoint-sqlite-store.js";
import {
  prepareWorkflowCheckpoint,
  workflowCheckpointRecordKey,
  workflowCheckpointRecordsDigest,
  workflowCheckpointRebuildPath,
  workflowCheckpointSqlitePath,
  workflowCheckpointStoreStatusPath,
  type WorkflowCheckpointIssue,
  type WorkflowCheckpointRecord,
  type WorkflowCheckpointWrite
} from "./checkpoint-store.js";
import type { WorkflowRunArtifact } from "./types.js";

export type WorkflowCheckpointStoreHealth = {
  schema_version: "0.1";
  artifact_kind: "workflow_checkpoint_store_status";
  configured_store: WorkflowRuntimeConfig["checkpoint_store"];
  canonical_store: "file";
  status: "healthy" | "degraded" | "rebuild_required";
  sqlite_available: boolean;
  sqlite_path: string;
  rebuild_required: boolean;
  last_record?: {
    workflow_id: string;
    sequence: number;
    state_hash: string;
  };
  error_code?: WorkflowCheckpointErrorCode;
  updated_at: string;
};

export type WorkflowCheckpointErrorCode =
  | "sqlite_busy"
  | "sqlite_corrupt"
  | "sqlite_schema_unsupported"
  | "sqlite_unavailable"
  | "checkpoint_integrity_failed"
  | "checkpoint_index_mismatch";

export type WorkflowCheckpointVerification = {
  schema_version: "0.1";
  artifact_kind: "workflow_checkpoint_verification";
  status: "verified" | "mismatch" | "failed";
  configured_store: WorkflowRuntimeConfig["checkpoint_store"];
  canonical_records: number;
  indexed_records: number;
  rebuild_required: boolean;
  summary: {
    issues: number;
    missing_rows: number;
    orphan_rows: number;
    mismatched_rows: number;
    canonical_errors: number;
  };
  issues: WorkflowCheckpointIssue[];
  verified_at: string;
};

export type WorkflowCheckpointRebuildArtifact = {
  schema_version: "0.1";
  artifact_kind: "workflow_checkpoint_rebuild";
  rebuild_id: string;
  status: "planned" | "completed" | "failed";
  dry_run: boolean;
  configured_store: "file+sqlite";
  target_path: string;
  source: {
    canonical_store: "file";
    records: number;
    digest: string;
  };
  confirmation: {
    required: true;
    expected: string;
  };
  result?: {
    indexed_records: number;
    fencing_token: string;
  };
  error_code?: WorkflowCheckpointErrorCode;
  created_at: string;
  updated_at: string;
};

export class WorkflowCheckpointCoordinator {
  private readonly fileStore: FileWorkflowCheckpointStore;

  constructor(
    private readonly projectRoot: string,
    private readonly config: WorkflowRuntimeConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    this.fileStore = new FileWorkflowCheckpointStore(projectRoot);
  }

  async persistCanonical(
    artifact: WorkflowRunArtifact
  ): Promise<WorkflowCheckpointWrite> {
    const write = prepareWorkflowCheckpoint(
      this.projectRoot,
      artifact,
      this.now().toISOString()
    );
    await this.fileStore.upsert(write);
    return write;
  }

  async mirror(write: WorkflowCheckpointWrite): Promise<void> {
    if (this.config.checkpoint_store === "file") {
      await writeCheckpointStoreHealthBestEffort(this.projectRoot, {
        config: this.config,
        sqliteAvailable: nodeVersionSupportsSqlite(),
        status: "healthy",
        rebuildRequired: false,
        record: write.record,
        now: this.now()
      });
      return;
    }

    const sqliteAvailable = await isNodeSqliteAvailable();
    let lock: ResourceLockHandle | undefined;
    try {
      if (!sqliteAvailable) {
        throw new Error("node:sqlite is unavailable");
      }
      lock = await acquireResourceLock(
        this.projectRoot,
        "workflow-checkpoint-sqlite",
        {
          owner: `workflow-checkpoint:${write.record.workflow_id}:${write.record.sequence}`,
          now: this.now(),
          ttlMs: Math.max(
            30_000,
            this.config.checkpoint_sqlite_busy_timeout_ms + 5_000
          )
        }
      );
      const sqlite = await SqliteWorkflowCheckpointStore.open(
        workflowCheckpointSqlitePath(
          this.projectRoot,
          this.config.checkpoint_sqlite_path
        ),
        {
          busyTimeoutMs: this.config.checkpoint_sqlite_busy_timeout_ms
        }
      );
      try {
        await sqlite.upsert(write);
      } finally {
        await sqlite.close();
      }
      await writeCheckpointStoreHealthBestEffort(this.projectRoot, {
        config: this.config,
        sqliteAvailable,
        status: "healthy",
        rebuildRequired: false,
        record: write.record,
        now: this.now()
      });
    } catch (error) {
      await writeCheckpointStoreHealthBestEffort(this.projectRoot, {
        config: this.config,
        sqliteAvailable,
        status: "degraded",
        rebuildRequired: true,
        errorCode: classifyCheckpointError(error),
        record: write.record,
        now: this.now()
      });
    } finally {
      if (lock !== undefined) {
        try {
          await releaseResourceLock(lock);
        } catch {
          await writeCheckpointStoreHealthBestEffort(this.projectRoot, {
            config: this.config,
            sqliteAvailable,
            status: "degraded",
            rebuildRequired: true,
            errorCode: "sqlite_busy",
            record: write.record,
            now: this.now()
          });
        }
      }
    }
  }
}

export async function inspectWorkflowCheckpointStore(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<WorkflowCheckpointStoreHealth> {
  const resolution = await resolveWorkflowRuntimeConfig(projectRoot, env);
  const config = resolution.config;
  const sqliteAvailable =
    config.checkpoint_store === "file"
      ? nodeVersionSupportsSqlite()
      : await isNodeSqliteAvailable();
  const stored = await readOptionalJson<WorkflowCheckpointStoreHealth>(
    workflowCheckpointStoreStatusPath(projectRoot)
  );
  const verification = await verifyWorkflowCheckpointStore(projectRoot, env, {
    persistHealth: false
  });
  return {
    schema_version: "0.1",
    artifact_kind: "workflow_checkpoint_store_status",
    configured_store: config.checkpoint_store,
    canonical_store: "file",
    status:
      verification.status === "verified"
        ? "healthy"
        : verification.rebuild_required
          ? "rebuild_required"
          : "degraded",
    sqlite_available: sqliteAvailable,
    sqlite_path: toPosixPath(config.checkpoint_sqlite_path),
    rebuild_required: verification.rebuild_required,
    last_record:
      stored?.configured_store === config.checkpoint_store
        ? stored.last_record
        : undefined,
    error_code:
      verification.status === "verified"
        ? undefined
        : stored?.configured_store === config.checkpoint_store &&
            stored.error_code !== undefined
          ? stored.error_code
        : verification.rebuild_required
          ? "checkpoint_index_mismatch"
          : "checkpoint_integrity_failed",
    updated_at: new Date().toISOString()
  };
}

export async function verifyWorkflowCheckpointStore(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => Date; persistHealth?: boolean } = {}
): Promise<WorkflowCheckpointVerification> {
  const now = options.now?.() ?? new Date();
  const config = (await resolveWorkflowRuntimeConfig(projectRoot, env)).config;
  const fileScan = await new FileWorkflowCheckpointStore(projectRoot).scan();
  const issues = [...fileScan.issues];
  let indexedRecords: WorkflowCheckpointRecord[] = [];
  const sqliteAvailable =
    config.checkpoint_store === "file"
      ? nodeVersionSupportsSqlite()
      : await isNodeSqliteAvailable();

  if (config.checkpoint_store === "file+sqlite") {
    const sqlitePath = workflowCheckpointSqlitePath(
      projectRoot,
      config.checkpoint_sqlite_path
    );
    if (!sqliteAvailable) {
      issues.push({
        kind: "sqlite_unavailable",
        message: "Node SQLite is unavailable for the configured mirror."
      });
    } else if (await fileExists(sqlitePath)) {
      try {
        const sqlite = await SqliteWorkflowCheckpointStore.open(sqlitePath, {
          busyTimeoutMs: config.checkpoint_sqlite_busy_timeout_ms,
          create: false
        });
        try {
          indexedRecords = (await sqlite.scan()).records;
        } finally {
          await sqlite.close();
        }
      } catch (error) {
        issues.push({
          kind: "sqlite_unavailable",
          message: checkpointErrorMessage(classifyCheckpointError(error))
        });
      }
    }
    compareCheckpointRecords(fileScan.records, indexedRecords, issues);
  }

  const canonicalErrors = issues.filter((issue) =>
    issue.kind.startsWith("file_") || issue.kind === "invalid_checkpoint_file"
  ).length;
  const missingRows = issues.filter(
    (issue) => issue.kind === "missing_index_row"
  ).length;
  const orphanRows = issues.filter(
    (issue) => issue.kind === "orphan_index_row"
  ).length;
  const mismatchedRows = issues.filter((issue) =>
    ["index_hash_mismatch", "index_fencing_mismatch", "index_path_mismatch"].includes(
      issue.kind
    )
  ).length;
  const rebuildRequired =
    config.checkpoint_store === "file+sqlite" &&
    canonicalErrors === 0 &&
    issues.length > 0;
  const result: WorkflowCheckpointVerification = {
    schema_version: "0.1",
    artifact_kind: "workflow_checkpoint_verification",
    status:
      issues.length === 0
        ? "verified"
        : canonicalErrors > 0
          ? "failed"
          : "mismatch",
    configured_store: config.checkpoint_store,
    canonical_records: fileScan.records.length,
    indexed_records: indexedRecords.length,
    rebuild_required: rebuildRequired,
    summary: {
      issues: issues.length,
      missing_rows: missingRows,
      orphan_rows: orphanRows,
      mismatched_rows: mismatchedRows,
      canonical_errors: canonicalErrors
    },
    issues,
    verified_at: now.toISOString()
  };

  if (options.persistHealth !== false) {
    await writeCheckpointStoreHealth(projectRoot, {
      config,
      sqliteAvailable,
      status:
        result.status === "verified"
          ? "healthy"
          : rebuildRequired
            ? "rebuild_required"
            : "degraded",
      rebuildRequired,
      errorCode:
        result.status === "verified"
          ? undefined
          : rebuildRequired
            ? "checkpoint_index_mismatch"
            : "checkpoint_integrity_failed",
      now
    });
  }
  return result;
}

export async function planWorkflowCheckpointRebuild(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => Date } = {}
): Promise<WorkflowCheckpointRebuildArtifact> {
  const now = options.now?.() ?? new Date();
  const config = await requireSqliteConfig(projectRoot, env);
  const fileScan = await new FileWorkflowCheckpointStore(projectRoot).scan();
  if (fileScan.issues.length > 0) {
    throw new Error(
      "Canonical workflow checkpoints failed verification; SQLite rebuild is unsafe."
    );
  }
  const digest = workflowCheckpointRecordsDigest(fileScan.records);
  const rebuildId = `WCR-${formatTimestamp(now)}-${digest.slice(0, 12)}`;
  const targetPath = toPosixPath(
    path.relative(
      projectRoot,
      workflowCheckpointSqlitePath(
        projectRoot,
        config.checkpoint_sqlite_path
      )
    )
  );
  const artifact: WorkflowCheckpointRebuildArtifact = {
    schema_version: "0.1",
    artifact_kind: "workflow_checkpoint_rebuild",
    rebuild_id: rebuildId,
    status: "planned",
    dry_run: true,
    configured_store: "file+sqlite",
    target_path: targetPath,
    source: {
      canonical_store: "file",
      records: fileScan.records.length,
      digest
    },
    confirmation: {
      required: true,
      expected: rebuildId
    },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  await writeJsonFileAtomic(
    workflowCheckpointRebuildPath(projectRoot, rebuildId),
    artifact
  );
  return artifact;
}

export async function executeWorkflowCheckpointRebuild(
  projectRoot: string,
  confirm: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => Date } = {}
): Promise<WorkflowCheckpointRebuildArtifact> {
  assertRebuildId(confirm);
  const now = options.now?.() ?? new Date();
  const config = await requireSqliteConfig(projectRoot, env);
  const artifactPath = workflowCheckpointRebuildPath(projectRoot, confirm);
  const artifact = await readJsonFile<WorkflowCheckpointRebuildArtifact>(
    artifactPath
  );
  if (
    artifact.rebuild_id !== confirm ||
    artifact.confirmation.expected !== confirm
  ) {
    throw new Error("Workflow checkpoint rebuild confirmation does not match.");
  }
  if (artifact.status === "completed") {
    return artifact;
  }
  const configuredTargetPath = toPosixPath(
    path.relative(
      projectRoot,
      workflowCheckpointSqlitePath(
        projectRoot,
        config.checkpoint_sqlite_path
      )
    )
  );
  if (artifact.target_path !== configuredTargetPath) {
    throw new Error(
      "Workflow checkpoint SQLite path changed after rebuild planning."
    );
  }

  const fileScan = await new FileWorkflowCheckpointStore(projectRoot).scan();
  if (fileScan.issues.length > 0) {
    throw new Error(
      "Canonical workflow checkpoints failed verification; SQLite rebuild is unsafe."
    );
  }
  const currentDigest = workflowCheckpointRecordsDigest(fileScan.records);
  if (currentDigest !== artifact.source.digest) {
    throw new Error(
      "Workflow checkpoints changed after rebuild planning; create a new dry-run plan."
    );
  }

  let lock: ResourceLockHandle | undefined;
  try {
    lock = await acquireResourceLock(
      projectRoot,
      "workflow-checkpoint-sqlite",
      {
        owner: `workflow-checkpoint-rebuild:${confirm}`,
        now,
        ttlMs: Math.max(
          60_000,
          config.checkpoint_sqlite_busy_timeout_ms + 10_000
        )
      }
    );
    const targetPath = workflowCheckpointSqlitePath(
      projectRoot,
      config.checkpoint_sqlite_path
    );
    await replaceSqliteIndex(targetPath, fileScan.records, {
      busyTimeoutMs: config.checkpoint_sqlite_busy_timeout_ms,
      rebuildId: confirm
    });
    artifact.status = "completed";
    artifact.dry_run = false;
    artifact.result = {
      indexed_records: fileScan.records.length,
      fencing_token: lock.data.fencing_token
    };
    artifact.updated_at = now.toISOString();
    delete artifact.error_code;
    await writeJsonFileAtomic(artifactPath, artifact);
    await writeCheckpointStoreHealth(projectRoot, {
      config,
      sqliteAvailable: true,
      status: "healthy",
      rebuildRequired: false,
      now
    });
    return artifact;
  } catch (error) {
    artifact.status = "failed";
    artifact.dry_run = false;
    artifact.error_code = classifyCheckpointError(error);
    artifact.updated_at = now.toISOString();
    await writeJsonFileAtomic(artifactPath, artifact);
    throw error;
  } finally {
    if (lock !== undefined) {
      await releaseResourceLock(lock);
    }
  }
}

export function formatWorkflowCheckpointStoreHealth(
  health: WorkflowCheckpointStoreHealth
): string {
  return [
    "Kairon workflow checkpoint store status.",
    `status=${health.status}`,
    `configured_store=${health.configured_store}`,
    `canonical_store=${health.canonical_store}`,
    `sqlite_available=${health.sqlite_available}`,
    `sqlite_path=${health.sqlite_path}`,
    `rebuild_required=${health.rebuild_required}`,
    `error_code=${health.error_code ?? "none"}`,
    `last_workflow_id=${health.last_record?.workflow_id ?? "none"}`,
    `last_sequence=${health.last_record?.sequence ?? "none"}`,
    `updated_at=${health.updated_at}`
  ].join("\n");
}

export function formatWorkflowCheckpointVerification(
  verification: WorkflowCheckpointVerification
): string {
  return [
    "Kairon workflow checkpoint verification completed.",
    `status=${verification.status}`,
    `configured_store=${verification.configured_store}`,
    `canonical_records=${verification.canonical_records}`,
    `indexed_records=${verification.indexed_records}`,
    `rebuild_required=${verification.rebuild_required}`,
    `issues=${verification.summary.issues}`,
    `missing_rows=${verification.summary.missing_rows}`,
    `orphan_rows=${verification.summary.orphan_rows}`,
    `mismatched_rows=${verification.summary.mismatched_rows}`,
    `canonical_errors=${verification.summary.canonical_errors}`,
    ...verification.issues.map(
      (issue, index) =>
        `issue.${index + 1}=kind:${issue.kind};workflow:${issue.workflow_id ?? "none"};sequence:${issue.sequence ?? "none"};path:${issue.checkpoint_path ?? "none"};message:${issue.message}`
    )
  ].join("\n");
}

export function formatWorkflowCheckpointRebuild(
  artifact: WorkflowCheckpointRebuildArtifact
): string {
  return [
    artifact.status === "planned"
      ? "Kairon workflow checkpoint rebuild planned."
      : "Kairon workflow checkpoint rebuild completed.",
    `rebuild_id=${artifact.rebuild_id}`,
    `status=${artifact.status}`,
    `dry_run=${artifact.dry_run}`,
    `configured_store=${artifact.configured_store}`,
    `target_path=${artifact.target_path}`,
    `source.records=${artifact.source.records}`,
    `source.digest=${artifact.source.digest}`,
    `confirm=${artifact.confirmation.expected}`,
    `indexed_records=${artifact.result?.indexed_records ?? "none"}`,
    `error_code=${artifact.error_code ?? "none"}`
  ].join("\n");
}

async function requireSqliteConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv
): Promise<WorkflowRuntimeConfig & { checkpoint_store: "file+sqlite" }> {
  const config = (await resolveWorkflowRuntimeConfig(projectRoot, env)).config;
  if (config.checkpoint_store !== "file+sqlite") {
    throw new Error(
      "Workflow checkpoint SQLite mirror is not configured. Set checkpoint_store=file+sqlite."
    );
  }
  if (!(await isNodeSqliteAvailable())) {
    throw new Error("Node SQLite is unavailable in this Node 22 runtime.");
  }
  return config as WorkflowRuntimeConfig & { checkpoint_store: "file+sqlite" };
}

function compareCheckpointRecords(
  canonicalRecords: WorkflowCheckpointRecord[],
  indexedRecords: WorkflowCheckpointRecord[],
  issues: WorkflowCheckpointIssue[]
): void {
  const canonical = new Map(
    canonicalRecords.map((record) => [workflowCheckpointRecordKey(record), record])
  );
  const indexed = new Map(
    indexedRecords.map((record) => [workflowCheckpointRecordKey(record), record])
  );
  for (const [key, fileRecord] of canonical) {
    const indexRecord = indexed.get(key);
    if (indexRecord === undefined) {
      issues.push({
        kind: "missing_index_row",
        workflow_id: fileRecord.workflow_id,
        sequence: fileRecord.sequence,
        checkpoint_path: fileRecord.checkpoint_path,
        message: "Canonical checkpoint is missing from the SQLite mirror."
      });
      continue;
    }
    if (indexRecord.state_hash !== fileRecord.state_hash) {
      issues.push({
        kind: "index_hash_mismatch",
        workflow_id: fileRecord.workflow_id,
        sequence: fileRecord.sequence,
        checkpoint_path: fileRecord.checkpoint_path,
        message: "SQLite state hash differs from the canonical checkpoint."
      });
    }
    if (indexRecord.fencing_token !== fileRecord.fencing_token) {
      issues.push({
        kind: "index_fencing_mismatch",
        workflow_id: fileRecord.workflow_id,
        sequence: fileRecord.sequence,
        checkpoint_path: fileRecord.checkpoint_path,
        message: "SQLite fencing token differs from the canonical checkpoint."
      });
    }
    if (indexRecord.checkpoint_path !== fileRecord.checkpoint_path) {
      issues.push({
        kind: "index_path_mismatch",
        workflow_id: fileRecord.workflow_id,
        sequence: fileRecord.sequence,
        checkpoint_path: fileRecord.checkpoint_path,
        message: "SQLite checkpoint path differs from the canonical checkpoint."
      });
    }
  }
  for (const [key, indexRecord] of indexed) {
    if (!canonical.has(key)) {
      issues.push({
        kind: "orphan_index_row",
        workflow_id: indexRecord.workflow_id,
        sequence: indexRecord.sequence,
        checkpoint_path: indexRecord.checkpoint_path,
        message: "SQLite row has no canonical checkpoint file."
      });
    }
  }
}

async function replaceSqliteIndex(
  targetPath: string,
  records: WorkflowCheckpointRecord[],
  options: { busyTimeoutMs: number; rebuildId: string }
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${options.rebuildId}.tmp`;
  const backupPath = `${targetPath}.${options.rebuildId}.bak`;
  await removeSqliteFiles(temporaryPath);
  await rm(backupPath, { force: true });

  const temporary = await SqliteWorkflowCheckpointStore.open(temporaryPath, {
    busyTimeoutMs: options.busyTimeoutMs
  });
  try {
    await temporary.replace(records);
  } finally {
    await temporary.close();
  }

  const targetExists = await fileExists(targetPath);
  try {
    await removeSqliteSidecars(targetPath);
    if (targetExists) {
      await rename(targetPath, backupPath);
    }
    await rename(temporaryPath, targetPath);
    await rm(backupPath, { force: true });
  } catch (error) {
    if (!(await fileExists(targetPath)) && (await fileExists(backupPath))) {
      await rename(backupPath, targetPath);
    }
    throw error;
  } finally {
    await removeSqliteFiles(temporaryPath);
  }
}

async function writeCheckpointStoreHealth(
  projectRoot: string,
  input: {
    config: WorkflowRuntimeConfig;
    sqliteAvailable: boolean;
    status: WorkflowCheckpointStoreHealth["status"];
    rebuildRequired: boolean;
    errorCode?: WorkflowCheckpointErrorCode;
    record?: WorkflowCheckpointRecord;
    now: Date;
  }
): Promise<void> {
  const artifact: WorkflowCheckpointStoreHealth = {
    schema_version: "0.1",
    artifact_kind: "workflow_checkpoint_store_status",
    configured_store: input.config.checkpoint_store,
    canonical_store: "file",
    status: input.status,
    sqlite_available: input.sqliteAvailable,
    sqlite_path: toPosixPath(input.config.checkpoint_sqlite_path),
    rebuild_required: input.rebuildRequired,
    last_record:
      input.record === undefined
        ? undefined
        : {
            workflow_id: input.record.workflow_id,
            sequence: input.record.sequence,
            state_hash: input.record.state_hash
          },
    error_code: input.errorCode,
    updated_at: input.now.toISOString()
  };
  await writeJsonFileAtomic(
    workflowCheckpointStoreStatusPath(projectRoot),
    artifact
  );
}

async function writeCheckpointStoreHealthBestEffort(
  projectRoot: string,
  input: Parameters<typeof writeCheckpointStoreHealth>[1]
): Promise<void> {
  try {
    await writeCheckpointStoreHealth(projectRoot, input);
  } catch {
    // Canonical checkpoint and run files have already been persisted.
  }
}

function classifyCheckpointError(error: unknown): WorkflowCheckpointErrorCode {
  const message = String(error).toLowerCase();
  if (message.includes("busy") || message.includes("locked") || message.includes("resource lock")) {
    return "sqlite_busy";
  }
  if (message.includes("malformed") || message.includes("not a database")) {
    return "sqlite_corrupt";
  }
  if (message.includes("unsupported workflow checkpoint sqlite schema")) {
    return "sqlite_schema_unsupported";
  }
  return "sqlite_unavailable";
}

function checkpointErrorMessage(code: WorkflowCheckpointErrorCode): string {
  switch (code) {
    case "sqlite_busy":
      return "SQLite checkpoint mirror is busy or locked.";
    case "sqlite_corrupt":
      return "SQLite checkpoint mirror is corrupt.";
    case "sqlite_schema_unsupported":
      return "SQLite checkpoint mirror schema is unsupported.";
    default:
      return "SQLite checkpoint mirror is unavailable.";
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
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

async function removeSqliteFiles(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await removeSqliteSidecars(databasePath);
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
}

function assertRebuildId(value: string): void {
  if (!/^WCR-\d{17}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`Invalid workflow checkpoint rebuild id: ${value}`);
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 17);
}

function nodeVersionSupportsSqlite(): boolean {
  const [major, minor] = process.versions.node
    .split(".")
    .map((value) => Number.parseInt(value, 10));
  return major > 22 || (major === 22 && minor >= 5);
}
