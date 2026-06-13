import { rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { acquireLockFile, type LockFileData } from "../core/fs/lock-file.js";
import { getKaironPaths } from "../core/fs/paths.js";

export type RuntimeLockMode = "single_tick" | "daemon";

export type RuntimeLockData = LockFileData & {
  mode?: RuntimeLockMode;
  heartbeat_at?: string;
  updated_at?: string;
  stop_requested?: boolean;
  stop_requested_at?: string;
  tick_count?: number;
  idle_count?: number;
  last_action?: string;
  next_tick_at?: string;
  last_error?: {
    code?: string;
    message: string;
    at: string;
  };
};

export type RuntimeLockStatus =
  | {
      locked: true;
      stale: boolean;
      data: RuntimeLockData;
      path: string;
    }
  | {
      locked: false;
      path: string;
    };

export type RuntimeLockOptions = {
  mode?: RuntimeLockMode;
  now?: Date;
  ttlMs?: number;
  heartbeatStaleMs?: number;
};

export async function acquireRuntimeLock(
  projectRoot: string,
  options: RuntimeLockOptions = {}
): Promise<RuntimeLockStatus> {
  const lockPath = runtimeLockPath(projectRoot);
  const existing = await readRuntimeLockStatus(projectRoot, options);
  if (existing.locked && existing.stale) {
    await rm(lockPath, { force: true });
  }

  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const handle = await acquireLockFile(lockPath, "kairon-runtime", ttlMs);
  const data: RuntimeLockData = {
    ...handle.data,
    mode: options.mode ?? "single_tick",
    heartbeat_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  };
  await writeRuntimeLockData(projectRoot, data);

  return {
    locked: true,
    stale: false,
    data,
    path: lockPath
  };
}

export async function releaseRuntimeLock(projectRoot: string): Promise<void> {
  await rm(runtimeLockPath(projectRoot), { force: true });
}

export async function readRuntimeLockStatus(
  projectRoot: string,
  options: Pick<RuntimeLockOptions, "now" | "heartbeatStaleMs"> = {}
): Promise<RuntimeLockStatus> {
  const lockPath = runtimeLockPath(projectRoot);

  try {
    const data = await readJsonFile<RuntimeLockData>(lockPath);
    return {
      locked: true,
      stale: await isRuntimeLockStale(data, options),
      data,
      path: lockPath
    };
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return { locked: false, path: lockPath };
    }

    throw error;
  }
}

export async function refreshRuntimeHeartbeat(
  projectRoot: string,
  options: {
    now?: Date;
    ttlMs?: number;
    tickCount?: number;
    idleCount?: number;
    lastAction?: string;
    nextTickAt?: string | null;
    lastError?: RuntimeLockData["last_error"] | null;
  } = {}
): Promise<RuntimeLockData> {
  const status = await readRuntimeLockStatus(projectRoot);
  if (!status.locked) {
    throw new Error("Runtime lock is not held.");
  }

  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const data: RuntimeLockData = {
    ...status.data,
    heartbeat_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  };

  if (options.tickCount !== undefined) {
    data.tick_count = options.tickCount;
  }
  if (options.idleCount !== undefined) {
    data.idle_count = options.idleCount;
  }
  if (options.lastAction !== undefined) {
    data.last_action = options.lastAction;
  }
  if (options.nextTickAt !== undefined) {
    if (options.nextTickAt === null) {
      delete data.next_tick_at;
    } else {
      data.next_tick_at = options.nextTickAt;
    }
  }
  if (options.lastError !== undefined) {
    if (options.lastError === null) {
      delete data.last_error;
    } else {
      data.last_error = options.lastError;
    }
  }

  await writeRuntimeLockData(projectRoot, data);
  return data;
}

export async function requestRuntimeStop(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<RuntimeLockData | null> {
  const status = await readRuntimeLockStatus(projectRoot);
  if (!status.locked) {
    return null;
  }

  const now = options.now ?? new Date();
  const data: RuntimeLockData = {
    ...status.data,
    stop_requested: true,
    stop_requested_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  await writeRuntimeLockData(projectRoot, data);
  return data;
}

export async function isRuntimeStopRequested(projectRoot: string): Promise<boolean> {
  const status = await readRuntimeLockStatus(projectRoot);
  return status.locked && status.data.stop_requested === true;
}

function runtimeLockPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "lock.json");
}

async function writeRuntimeLockData(
  projectRoot: string,
  data: RuntimeLockData
): Promise<void> {
  await writeJsonFileAtomic(runtimeLockPath(projectRoot), data);
}

async function isRuntimeLockStale(
  data: RuntimeLockData,
  options: Pick<RuntimeLockOptions, "now" | "heartbeatStaleMs">
): Promise<boolean> {
  const now = options.now ?? new Date();

  if (Date.parse(data.expires_at) <= now.getTime()) {
    return true;
  }

  if (data.mode !== "daemon") {
    return false;
  }

  if (!processExists(data.pid)) {
    return true;
  }

  const heartbeatAt = Date.parse(data.heartbeat_at ?? data.updated_at ?? "");
  if (!Number.isFinite(heartbeatAt)) {
    return true;
  }

  const heartbeatStaleMs = options.heartbeatStaleMs ?? 60_000;
  return heartbeatAt + heartbeatStaleMs <= now.getTime();
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
