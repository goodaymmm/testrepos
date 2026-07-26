import { access } from "node:fs/promises";
import path from "node:path";
import {
  acquireLockFile,
  releaseLockFile
} from "../core/fs/lock-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getProjectsRegistryPath } from "../core/fs/paths.js";

export type OffDeviceBackupVerificationStatus =
  | "verified"
  | "failed"
  | "not_verified";

export type OffDeviceBackupCatalogEntry = {
  backup_id: string;
  project_id: string;
  destination_root: string;
  package_path: string;
  content_sha256: string;
  bytes: number;
  copied_at: string;
  verification_interval_days: number;
  verification_status: OffDeviceBackupVerificationStatus;
  verified_at?: string;
  rehearsed_at?: string;
  rehearsal_status?: "passed" | "failed";
};

export type OffDeviceBackupCatalogDocument = {
  schema_version: "0.1";
  artifact_kind: "off_device_backup_catalog";
  updated_at: string;
  entries: OffDeviceBackupCatalogEntry[];
};

export type BackupCatalogOptions = {
  catalogPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  lockTtlMs?: number;
};

export class BackupCatalogCorruptError extends Error {
  constructor(
    readonly catalogPath: string,
    message: string
  ) {
    super(`Off-device backup catalog is corrupt: ${message}`);
    this.name = "BackupCatalogCorruptError";
  }
}

export function getBackupCatalogPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicit = env.KAIRON_DR_CATALOG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(
    path.dirname(getProjectsRegistryPath(env)),
    "backup-catalog.json"
  );
}

export class BackupCatalog {
  readonly catalogPath: string;
  private readonly now: () => Date;
  private readonly lockTtlMs: number;

  constructor(options: BackupCatalogOptions = {}) {
    this.catalogPath =
      options.catalogPath ?? getBackupCatalogPath(options.env ?? process.env);
    this.now = options.now ?? (() => new Date());
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.catalogPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async read(): Promise<OffDeviceBackupCatalogDocument> {
    try {
      return validateCatalog(
        await readJsonFile<unknown>(this.catalogPath),
        this.catalogPath
      );
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return emptyCatalog(this.now());
      }
      if (error instanceof BackupCatalogCorruptError) {
        throw error;
      }
      throw new BackupCatalogCorruptError(this.catalogPath, String(error));
    }
  }

  async list(projectId?: string): Promise<OffDeviceBackupCatalogEntry[]> {
    const catalog = await this.read();
    return catalog.entries
      .filter((entry) => projectId === undefined || entry.project_id === projectId)
      .sort(
        (left, right) =>
          right.copied_at.localeCompare(left.copied_at) ||
          left.backup_id.localeCompare(right.backup_id)
      );
  }

  async find(
    backupId: string,
    packagePath?: string
  ): Promise<OffDeviceBackupCatalogEntry | undefined> {
    const normalizedPackage =
      packagePath === undefined ? undefined : normalizePathKey(packagePath);
    return (await this.read()).entries.find(
      (entry) =>
        entry.backup_id === backupId &&
        (normalizedPackage === undefined ||
          normalizePathKey(entry.package_path) === normalizedPackage)
    );
  }

  async upsert(
    entry: OffDeviceBackupCatalogEntry
  ): Promise<OffDeviceBackupCatalogEntry> {
    return this.mutate((catalog) => {
      const index = catalog.entries.findIndex(
        (candidate) =>
          candidate.backup_id === entry.backup_id &&
          normalizePathKey(candidate.package_path) ===
            normalizePathKey(entry.package_path)
      );
      if (index >= 0) {
        catalog.entries[index] = entry;
      } else {
        catalog.entries.push(entry);
      }
      return entry;
    });
  }

  async update(
    backupId: string,
    packagePath: string,
    updates: Partial<
      Pick<
        OffDeviceBackupCatalogEntry,
        | "verification_status"
        | "verified_at"
        | "rehearsed_at"
        | "rehearsal_status"
      >
    >
  ): Promise<OffDeviceBackupCatalogEntry> {
    return this.mutate((catalog) => {
      const entry = catalog.entries.find(
        (candidate) =>
          candidate.backup_id === backupId &&
          normalizePathKey(candidate.package_path) ===
            normalizePathKey(packagePath)
      );
      if (entry === undefined) {
        throw new Error(`Off-device backup is not cataloged: ${backupId}`);
      }
      Object.assign(entry, updates);
      return entry;
    });
  }

  async remove(
    backupId: string,
    packagePath: string
  ): Promise<OffDeviceBackupCatalogEntry | undefined> {
    return this.mutate((catalog) => {
      const index = catalog.entries.findIndex(
        (candidate) =>
          candidate.backup_id === backupId &&
          normalizePathKey(candidate.package_path) ===
            normalizePathKey(packagePath)
      );
      if (index < 0) {
        return undefined;
      }
      return catalog.entries.splice(index, 1)[0];
    });
  }

  private async mutate<T>(
    operation: (catalog: OffDeviceBackupCatalogDocument) => T
  ): Promise<T> {
    const lock = await acquireLockFile(
      `${this.catalogPath}.lock`,
      "off-device-backup-catalog",
      this.lockTtlMs
    );
    try {
      const catalog = await this.read();
      const result = operation(catalog);
      catalog.updated_at = this.now().toISOString();
      catalog.entries.sort(
        (left, right) =>
          left.project_id.localeCompare(right.project_id) ||
          right.copied_at.localeCompare(left.copied_at) ||
          left.backup_id.localeCompare(right.backup_id)
      );
      await writeJsonFileAtomic(this.catalogPath, catalog);
      return result;
    } finally {
      await releaseLockFile(lock);
    }
  }
}

function emptyCatalog(now: Date): OffDeviceBackupCatalogDocument {
  return {
    schema_version: "0.1",
    artifact_kind: "off_device_backup_catalog",
    updated_at: now.toISOString(),
    entries: []
  };
}

function validateCatalog(
  value: unknown,
  catalogPath: string
): OffDeviceBackupCatalogDocument {
  const record = toRecord(value);
  if (
    record.schema_version !== "0.1" ||
    record.artifact_kind !== "off_device_backup_catalog" ||
    typeof record.updated_at !== "string" ||
    !Array.isArray(record.entries)
  ) {
    throw new BackupCatalogCorruptError(
      catalogPath,
      "schema or top-level fields are invalid"
    );
  }
  const entries = record.entries.map((entry) =>
    validateEntry(entry, catalogPath)
  );
  const keys = entries.map(
    (entry) => `${entry.backup_id}:${normalizePathKey(entry.package_path)}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new BackupCatalogCorruptError(catalogPath, "duplicate entries");
  }
  return {
    schema_version: "0.1",
    artifact_kind: "off_device_backup_catalog",
    updated_at: record.updated_at,
    entries
  };
}

function validateEntry(
  value: unknown,
  catalogPath: string
): OffDeviceBackupCatalogEntry {
  const entry = toRecord(value);
  if (
    typeof entry.backup_id !== "string" ||
    typeof entry.project_id !== "string" ||
    typeof entry.destination_root !== "string" ||
    typeof entry.package_path !== "string" ||
    !path.isAbsolute(entry.destination_root) ||
    !path.isAbsolute(entry.package_path) ||
    typeof entry.content_sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(entry.content_sha256) ||
    typeof entry.bytes !== "number" ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    typeof entry.copied_at !== "string" ||
    typeof entry.verification_interval_days !== "number" ||
    !Number.isInteger(entry.verification_interval_days) ||
    entry.verification_interval_days <= 0 ||
    !["verified", "failed", "not_verified"].includes(
      String(entry.verification_status)
    )
  ) {
    throw new BackupCatalogCorruptError(catalogPath, "entry is invalid");
  }
  return {
    backup_id: entry.backup_id,
    project_id: entry.project_id,
    destination_root: path.resolve(entry.destination_root),
    package_path: path.resolve(entry.package_path),
    content_sha256: entry.content_sha256,
    bytes: entry.bytes,
    copied_at: entry.copied_at,
    verification_interval_days: entry.verification_interval_days,
    verification_status:
      entry.verification_status as OffDeviceBackupVerificationStatus,
    verified_at:
      typeof entry.verified_at === "string" ? entry.verified_at : undefined,
    rehearsed_at:
      typeof entry.rehearsed_at === "string" ? entry.rehearsed_at : undefined,
    rehearsal_status:
      entry.rehearsal_status === "passed" || entry.rehearsal_status === "failed"
        ? entry.rehearsal_status
        : undefined
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object.");
  }
  return value as Record<string, unknown>;
}

function normalizePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
