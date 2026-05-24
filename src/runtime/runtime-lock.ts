import { rm } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import {
  acquireLockFile,
  isLockExpired,
  type LockFileData
} from "../core/fs/lock-file.js";
import { getKaironPaths } from "../core/fs/paths.js";

export type RuntimeLockStatus =
  | {
      locked: true;
      stale: boolean;
      data: LockFileData;
      path: string;
    }
  | {
      locked: false;
      path: string;
    };

export async function acquireRuntimeLock(projectRoot: string): Promise<RuntimeLockStatus> {
  const lockPath = runtimeLockPath(projectRoot);
  const handle = await acquireLockFile(lockPath, "kairon-runtime", 24 * 60 * 60 * 1000);

  return {
    locked: true,
    stale: false,
    data: handle.data,
    path: lockPath
  };
}

export async function releaseRuntimeLock(projectRoot: string): Promise<void> {
  await rm(runtimeLockPath(projectRoot), { force: true });
}

export async function readRuntimeLockStatus(
  projectRoot: string
): Promise<RuntimeLockStatus> {
  const lockPath = runtimeLockPath(projectRoot);

  try {
    return {
      locked: true,
      stale: await isLockExpired(lockPath),
      data: await readJsonFile<LockFileData>(lockPath),
      path: lockPath
    };
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return { locked: false, path: lockPath };
    }

    throw error;
  }
}

function runtimeLockPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "lock.json");
}
