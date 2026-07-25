import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { KAIRON_VERSION } from "../index.js";
import { loadConfigFile } from "../core/config/load-config.js";
import {
  acquireLockFile,
  releaseLockFile,
  type LockHandle
} from "../core/fs/lock-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getProjectsRegistryPath, normalizeProjectRoot } from "../core/fs/paths.js";

export type ProjectDoctorSummary = {
  checked_at: string;
  status: "pass" | "warning" | "error";
  pass: number;
  warning: number;
  error: number;
};

export type ProjectRegistryEntry = {
  project_id: string;
  root: string;
  registered_at: string;
  last_seen_at: string;
  kairon_version: string;
  board_url?: string;
  previous_root?: string;
  last_doctor_summary?: ProjectDoctorSummary;
};

export type ProjectRegistryDocument = {
  schema_version: "0.1";
  updated_at: string;
  projects: ProjectRegistryEntry[];
};

export type ProjectRegistration = {
  entry: ProjectRegistryEntry;
  status: "registered" | "already_registered" | "moved";
};

export type ProjectObservation = {
  project_id: string;
  root: string;
  seen: boolean;
  kairon_version: string;
  board_url?: string;
  doctor_summary: ProjectDoctorSummary;
};

export type ProjectRegistryOptions = {
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  lockTtlMs?: number;
};

type ProjectConfig = {
  schema_version?: unknown;
  project_id?: unknown;
  root?: unknown;
};

export class ProjectRegistryCorruptError extends Error {
  constructor(
    readonly registryPath: string,
    message: string
  ) {
    super(`Project registry is corrupt: ${message}`);
    this.name = "ProjectRegistryCorruptError";
  }
}

export class ProjectRegistrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationConflictError";
  }
}

export class ProjectRegistry {
  readonly registryPath: string;
  private readonly now: () => Date;
  private readonly lockTtlMs: number;

  constructor(options: ProjectRegistryOptions = {}) {
    this.registryPath =
      options.registryPath ??
      getProjectsRegistryPath(options.env ?? process.env);
    this.now = options.now ?? (() => new Date());
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.registryPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async read(): Promise<ProjectRegistryDocument> {
    try {
      const raw = await readJsonFile<unknown>(this.registryPath);
      return validateRegistryDocument(raw, this.registryPath);
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return emptyRegistry(this.now());
      }
      if (error instanceof ProjectRegistryCorruptError) {
        throw error;
      }
      throw new ProjectRegistryCorruptError(this.registryPath, String(error));
    }
  }

  async list(): Promise<ProjectRegistryEntry[]> {
    const registry = await this.read();
    return registry.projects.map(copyEntry).sort(compareEntries);
  }

  async show(projectId: string): Promise<ProjectRegistryEntry | undefined> {
    const normalizedId = normalizeProjectId(projectId);
    return (await this.list()).find((entry) => entry.project_id === normalizedId);
  }

  async register(projectRoot: string): Promise<ProjectRegistration> {
    const project = await inspectProjectConfig(projectRoot);
    return this.withLock(async () => {
      const registry = await this.read();
      const now = this.now().toISOString();
      const rootKey = normalizeRootKey(project.root);
      const sameRoot = registry.projects.find(
        (entry) => normalizeRootKey(entry.root) === rootKey
      );

      if (sameRoot && sameRoot.project_id !== project.projectId) {
        throw new ProjectRegistrationConflictError(
          `Project root is already registered as ${sameRoot.project_id}: ${project.root}`
        );
      }

      if (sameRoot) {
        sameRoot.last_seen_at = now;
        sameRoot.kairon_version = KAIRON_VERSION;
        registry.updated_at = now;
        await this.write(registry);
        return {
          entry: copyEntry(sameRoot),
          status: "already_registered"
        };
      }

      const sameId = registry.projects.find(
        (entry) => entry.project_id === project.projectId
      );
      if (sameId) {
        if (await pathExists(sameId.root)) {
          throw new ProjectRegistrationConflictError(
            `Project id is already registered at another root: ${project.projectId}`
          );
        }

        sameId.previous_root = sameId.root;
        sameId.root = project.root;
        sameId.last_seen_at = now;
        sameId.kairon_version = KAIRON_VERSION;
        registry.updated_at = now;
        registry.projects.sort(compareEntries);
        await this.write(registry);
        return { entry: copyEntry(sameId), status: "moved" };
      }

      const entry: ProjectRegistryEntry = {
        project_id: project.projectId,
        root: project.root,
        registered_at: now,
        last_seen_at: now,
        kairon_version: KAIRON_VERSION
      };
      registry.projects.push(entry);
      registry.projects.sort(compareEntries);
      registry.updated_at = now;
      await this.write(registry);
      return { entry: copyEntry(entry), status: "registered" };
    });
  }

  async unregister(projectId: string): Promise<ProjectRegistryEntry> {
    const normalizedId = normalizeProjectId(projectId);
    return this.withLock(async () => {
      const registry = await this.read();
      const index = registry.projects.findIndex(
        (entry) => entry.project_id === normalizedId
      );
      if (index < 0) {
        throw new Error(`Project is not registered: ${normalizedId}`);
      }

      const [removed] = registry.projects.splice(index, 1);
      registry.updated_at = this.now().toISOString();
      await this.write(registry);
      return copyEntry(removed);
    });
  }

  async updateObservations(observations: ProjectObservation[]): Promise<void> {
    if (observations.length === 0) {
      return;
    }

    await this.withLock(async () => {
      const registry = await this.read();
      const now = this.now().toISOString();
      for (const observation of observations) {
        const entry = registry.projects.find(
          (candidate) => candidate.project_id === observation.project_id
        );
        if (
          entry === undefined ||
          normalizeRootKey(entry.root) !== normalizeRootKey(observation.root)
        ) {
          continue;
        }

        if (observation.seen) {
          entry.last_seen_at = observation.doctor_summary.checked_at;
          entry.kairon_version = observation.kairon_version;
        }
        entry.last_doctor_summary = { ...observation.doctor_summary };
        if (observation.board_url !== undefined) {
          entry.board_url = observation.board_url;
        }
      }
      registry.updated_at = now;
      await this.write(registry);
    });
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = `${this.registryPath}.lock`;
    let handle: LockHandle | undefined;
    try {
      handle = await acquireLockFile(
        lockPath,
        "projects-registry",
        this.lockTtlMs
      );
      return await run();
    } finally {
      if (handle !== undefined) {
        await releaseLockFile(handle);
      }
    }
  }

  private async write(registry: ProjectRegistryDocument): Promise<void> {
    await writeJsonFileAtomic(this.registryPath, {
      ...registry,
      projects: [...registry.projects].sort(compareEntries)
    });
  }
}

export async function inspectRegisteredProject(
  projectRoot: string,
  options: ProjectRegistryOptions = {}
): Promise<{
  registry_path: string;
  status: "not_configured" | "registered" | "not_registered" | "corrupt";
  project_id?: string;
}> {
  const registry = new ProjectRegistry(options);
  if (!(await registry.exists())) {
    return {
      registry_path: registry.registryPath,
      status: "not_configured"
    };
  }

  try {
    const project = await inspectProjectConfig(projectRoot);
    const entry = (await registry.list()).find(
      (candidate) =>
        candidate.project_id === project.projectId &&
        normalizeRootKey(candidate.root) === normalizeRootKey(project.root)
    );
    return {
      registry_path: registry.registryPath,
      status: entry === undefined ? "not_registered" : "registered",
      project_id: project.projectId
    };
  } catch (error) {
    if (error instanceof ProjectRegistryCorruptError) {
      return {
        registry_path: registry.registryPath,
        status: "corrupt"
      };
    }
    throw error;
  }
}

async function inspectProjectConfig(projectRoot: string): Promise<{
  projectId: string;
  root: string;
}> {
  const resolved = normalizeProjectRoot(projectRoot);
  const root = await realpath(resolved);
  const config = await loadConfigFile<ProjectConfig>(root, "project.json");
  if (
    config.schema_version !== "0.1" ||
    typeof config.project_id !== "string" ||
    config.project_id.trim().length === 0
  ) {
    throw new Error(`Invalid Kairon project config: ${root}`);
  }

  return {
    projectId: normalizeProjectId(config.project_id),
    root: normalizeProjectRoot(root)
  };
}

function validateRegistryDocument(
  value: unknown,
  registryPath: string
): ProjectRegistryDocument {
  if (!isRecord(value)) {
    throw new ProjectRegistryCorruptError(registryPath, "root must be an object");
  }

  const schemaVersion = value.schema_version ?? "0.1";
  if (schemaVersion !== "0.1" || !Array.isArray(value.projects)) {
    throw new ProjectRegistryCorruptError(
      registryPath,
      "unsupported schema or projects is not an array"
    );
  }

  const updatedAt =
    typeof value.updated_at === "string"
      ? value.updated_at
      : new Date(0).toISOString();
  const entries = value.projects.map((entry, index) =>
    validateRegistryEntry(entry, registryPath, index)
  );
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const entry of entries) {
    const rootKey = normalizeRootKey(entry.root);
    if (ids.has(entry.project_id) || roots.has(rootKey)) {
      throw new ProjectRegistryCorruptError(
        registryPath,
        "duplicate project id or root"
      );
    }
    ids.add(entry.project_id);
    roots.add(rootKey);
  }

  return {
    schema_version: "0.1",
    updated_at: updatedAt,
    projects: entries.sort(compareEntries)
  };
}

function validateRegistryEntry(
  value: unknown,
  registryPath: string,
  index: number
): ProjectRegistryEntry {
  if (
    !isRecord(value) ||
    typeof value.project_id !== "string" ||
    typeof value.root !== "string" ||
    typeof value.registered_at !== "string" ||
    typeof value.last_seen_at !== "string" ||
    typeof value.kairon_version !== "string"
  ) {
    throw new ProjectRegistryCorruptError(
      registryPath,
      `invalid project entry at index ${index}`
    );
  }

  const entry: ProjectRegistryEntry = {
    project_id: normalizeProjectId(value.project_id),
    root: normalizeProjectRoot(value.root),
    registered_at: value.registered_at,
    last_seen_at: value.last_seen_at,
    kairon_version: value.kairon_version
  };
  if (typeof value.board_url === "string") {
    entry.board_url = value.board_url;
  }
  if (typeof value.previous_root === "string") {
    entry.previous_root = normalizeProjectRoot(value.previous_root);
  }
  if (isDoctorSummary(value.last_doctor_summary)) {
    entry.last_doctor_summary = { ...value.last_doctor_summary };
  }
  return entry;
}

function isDoctorSummary(value: unknown): value is ProjectDoctorSummary {
  return (
    isRecord(value) &&
    typeof value.checked_at === "string" &&
    (value.status === "pass" ||
      value.status === "warning" ||
      value.status === "error") &&
    typeof value.pass === "number" &&
    typeof value.warning === "number" &&
    typeof value.error === "number"
  );
}

function emptyRegistry(now: Date): ProjectRegistryDocument {
  return {
    schema_version: "0.1",
    updated_at: now.toISOString(),
    projects: []
  };
}

function normalizeProjectId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid project id: ${value}`);
  }
  return normalized;
}

function normalizeRootKey(root: string): string {
  const normalized = normalizeProjectRoot(root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function copyEntry(entry: ProjectRegistryEntry): ProjectRegistryEntry {
  return {
    ...entry,
    last_doctor_summary:
      entry.last_doctor_summary === undefined
        ? undefined
        : { ...entry.last_doctor_summary }
  };
}

function compareEntries(
  left: ProjectRegistryEntry,
  right: ProjectRegistryEntry
): number {
  return (
    left.project_id.localeCompare(right.project_id) ||
    left.root.localeCompare(right.root)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
