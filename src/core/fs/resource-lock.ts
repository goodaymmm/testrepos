import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "./paths.js";

export type ResourceLockData = {
  schema_version: "0.1";
  kind: "resource_lock";
  resource: string;
  owner: string;
  pid: number;
  fencing_token: string;
  acquired_at: string;
  updated_at: string;
  expires_at: string;
};

export type ResourceLockHandle = {
  path: string;
  data: ResourceLockData;
};

export type ResourceLockOptions = {
  owner?: string;
  fencingToken?: string;
  now?: Date;
  ttlMs?: number;
};

export type RecoveredResourceLock = {
  lock_path: string;
  resource: string;
  owner: string;
  fencing_token: string;
  expires_at: string;
};

export class ResourceLockAlreadyExistsError extends Error {
  constructor(
    readonly resource: string,
    readonly lockPath: string
  ) {
    super(`Resource lock already exists: ${resource}`);
    this.name = "ResourceLockAlreadyExistsError";
  }
}

export class ResourceFencingTokenError extends Error {
  constructor(
    readonly resource: string,
    readonly lockPath: string
  ) {
    super(`Resource fencing token is not current: ${resource}`);
    this.name = "ResourceFencingTokenError";
  }
}

export async function acquireResourceLock(
  projectRoot: string,
  resourcePath: string,
  options: ResourceLockOptions = {}
): Promise<ResourceLockHandle> {
  const resource = normalizeResourcePath(projectRoot, resourcePath);
  const lockPath = resourceLockPath(projectRoot, resource);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 30_000;
  const data: ResourceLockData = {
    schema_version: "0.1",
    kind: "resource_lock",
    resource,
    owner: options.owner ?? "resource-writer",
    pid: process.pid,
    fencing_token: options.fencingToken ?? randomUUID(),
    acquired_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  };

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await handle.close();
    return { path: lockPath, data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    if (await isResourceLockExpired(lockPath, now)) {
      await rm(lockPath, { force: true });
      return acquireResourceLock(projectRoot, resourcePath, options);
    }

    throw new ResourceLockAlreadyExistsError(resource, lockPath);
  }
}

export async function releaseResourceLock(
  handle: ResourceLockHandle
): Promise<void> {
  try {
    const current = await readJsonFile<ResourceLockData>(handle.path);
    if (current.fencing_token !== handle.data.fencing_token) {
      return;
    }
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return;
    }
    throw error;
  }

  await rm(handle.path, { force: true });
}

export async function assertResourceLockFencingToken(
  handle: ResourceLockHandle,
  options: { now?: Date } = {}
): Promise<void> {
  const current = await readJsonFile<ResourceLockData>(handle.path);
  const now = options.now ?? new Date();

  if (
    current.fencing_token !== handle.data.fencing_token ||
    Date.parse(current.expires_at) <= now.getTime()
  ) {
    throw new ResourceFencingTokenError(handle.data.resource, handle.path);
  }
}

export async function withResourceLock<T>(
  projectRoot: string,
  resourcePath: string,
  options: ResourceLockOptions,
  run: (handle: ResourceLockHandle) => Promise<T>
): Promise<T> {
  const handle = await acquireResourceLock(projectRoot, resourcePath, options);
  try {
    return await run(handle);
  } finally {
    await releaseResourceLock(handle);
  }
}

export async function writeJsonFileFenced(
  handle: ResourceLockHandle,
  filePath: string,
  value: unknown
): Promise<void> {
  await assertResourceLockFencingToken(handle);
  await writeJsonFileAtomic(filePath, value);
}

export async function recoverExpiredResourceLocks(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<RecoveredResourceLock[]> {
  const directory = resourceLocksDirectory(projectRoot);
  const now = options.now ?? new Date();
  const recovered: RecoveredResourceLock[] = [];
  let entries: string[] = [];

  try {
    entries = await readdir(directory);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return [];
    }
    throw error;
  }

  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const lockPath = resolveInside(directory, entry);
    let lock: ResourceLockData;
    try {
      lock = await readJsonFile<ResourceLockData>(lockPath);
    } catch {
      continue;
    }

    if (Date.parse(lock.expires_at) > now.getTime()) {
      continue;
    }

    await rm(lockPath, { force: true });
    recovered.push({
      lock_path: toPosixPath(path.relative(getKaironPaths(projectRoot).root, lockPath)),
      resource: lock.resource,
      owner: lock.owner,
      fencing_token: lock.fencing_token,
      expires_at: lock.expires_at
    });
  }

  return recovered;
}

function resourceLocksDirectory(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).runtimeDir, "resource-locks");
}

function resourceLockPath(projectRoot: string, resource: string): string {
  const digest = createHash("sha256").update(resource).digest("hex").slice(0, 24);
  return resolveInside(resourceLocksDirectory(projectRoot), `${digest}.json`);
}

function normalizeResourcePath(projectRoot: string, resourcePath: string): string {
  const paths = getKaironPaths(projectRoot);
  const absolute = path.isAbsolute(resourcePath)
    ? path.resolve(resourcePath)
    : resolveInside(paths.root, resourcePath);
  const relative = path.relative(paths.root, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resource path escapes project root: ${resourcePath}`);
  }

  return toPosixPath(relative);
}

async function isResourceLockExpired(lockPath: string, now: Date): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const data = JSON.parse(raw) as ResourceLockData;
    return Date.parse(data.expires_at) <= now.getTime();
  } catch {
    return false;
  }
}
