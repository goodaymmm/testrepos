import { rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import {
  acquireLockFile,
  LockAlreadyExistsError,
  type LockFileData
} from "../core/fs/lock-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import {
  ResourceFencingTokenError,
  ResourceLockAlreadyExistsError,
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";

const runtimeResourceLockTtlMs = 5 * 60 * 1_000;
const runtimeLockRetryDelaysMs = [
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  15_000
] as const;

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
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  return withRuntimeLockWriteRetry(async () =>
    withResourceLock(
      projectRoot,
      lockPath,
      { owner: "runtime-lock-acquire", ttlMs: runtimeResourceLockTtlMs },
      async (resourceLock) => {
        const existing = await readRuntimeLockStatus(projectRoot, options);
        if (existing.locked) {
          if (
            existing.stale &&
            !isRuntimeLockOwnerProcessAlive(existing.data)
          ) {
            await rm(lockPath, { force: true });
          } else {
            throw new LockAlreadyExistsError(lockPath);
          }
        }

        const handle = await acquireLockFile(lockPath, "kairon-runtime", ttlMs);
        const data: RuntimeLockData = {
          ...handle.data,
          mode: options.mode ?? "single_tick",
          heartbeat_at: now.toISOString(),
          updated_at: now.toISOString(),
          expires_at: new Date(now.getTime() + ttlMs).toISOString()
        };
        try {
          await writeJsonFileFenced(resourceLock, lockPath, data);
        } catch (error) {
          await rm(lockPath, { force: true });
          throw error;
        }

        return {
          locked: true,
          stale: false,
          data,
          path: lockPath
        };
      }
    )
  );
}

export async function releaseRuntimeLock(projectRoot: string): Promise<void> {
  const lockPath = runtimeLockPath(projectRoot);
  await withRuntimeLockWriteRetry(async () =>
    withResourceLock(
      projectRoot,
      lockPath,
      { owner: "runtime-lock-release", ttlMs: runtimeResourceLockTtlMs },
      async () => {
        await rm(lockPath, { force: true });
      }
    )
  );
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
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  return mutateRuntimeLockData(projectRoot, (current) => {
    if (current === null) {
      throw new Error("Runtime lock is not held.");
    }
    if (current.owner !== "kairon-runtime" || current.pid !== process.pid) {
      throw new Error(
        `Runtime lock ownership was lost. expected_pid=${process.pid} actual_pid=${current.pid}`
      );
    }

    const data: RuntimeLockData = {
      ...current,
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

    return data;
  });
}

export async function requestRuntimeStop(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<RuntimeLockData | null> {
  const now = options.now ?? new Date();
  return mutateRuntimeLockData(projectRoot, (current) => {
    if (current === null) {
      return null;
    }
    return {
      ...current,
      stop_requested: true,
      stop_requested_at: now.toISOString(),
      updated_at: now.toISOString()
    };
  });
}

export async function isRuntimeStopRequested(projectRoot: string): Promise<boolean> {
  const status = await readRuntimeLockStatus(projectRoot);
  return status.locked && status.data.stop_requested === true;
}

function runtimeLockPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "lock.json");
}

async function mutateRuntimeLockData<T extends RuntimeLockData | null>(
  projectRoot: string,
  mutate: (current: RuntimeLockData | null) => T
): Promise<T> {
  const lockPath = runtimeLockPath(projectRoot);
  return withRuntimeLockWriteRetry(async () =>
    withResourceLock(
      projectRoot,
      lockPath,
      { owner: "runtime-lock", ttlMs: runtimeResourceLockTtlMs },
      async (lock) => {
        let current: RuntimeLockData | null;
        try {
          current = await readJsonFile<RuntimeLockData>(lockPath);
        } catch (error) {
          if (String(error).includes("ENOENT")) {
            current = null;
          } else {
            throw error;
          }
        }
        const next = mutate(current);
        if (next !== null) {
          await writeJsonFileFenced(lock, lockPath, next);
        }
        return next;
      }
    )
  );
}

export function isRuntimeLockOwnerProcessAlive(data: RuntimeLockData): boolean {
  return processExists(data.pid);
}

async function withRuntimeLockWriteRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (
        !isRetryableRuntimeLockError(error) ||
        attempt >= runtimeLockRetryDelaysMs.length
      ) {
        throw error;
      }
      await delay(runtimeLockRetryDelaysMs[attempt]);
    }
  }
}

function isRetryableRuntimeLockError(error: unknown): boolean {
  if (
    error instanceof ResourceLockAlreadyExistsError ||
    error instanceof ResourceFencingTokenError
  ) {
    return true;
  }
  const code = findErrorCode(error);
  return code !== undefined && ["EACCES", "EBUSY", "EPERM"].includes(code);
}

function findErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
