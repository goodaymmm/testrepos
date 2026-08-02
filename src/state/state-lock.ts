import { getKaironPaths } from "../core/fs/paths.js";
import {
  acquireLockFile,
  releaseLockFile,
  type LockHandle
} from "../core/fs/lock-file.js";

export async function acquireStateLock(projectRoot: string): Promise<LockHandle> {
  return acquireLockFile(
    `${getKaironPaths(projectRoot).runtimeDir}/state.lock`,
    "state-applier",
    30_000
  );
}

export async function releaseStateLock(handle: LockHandle): Promise<void> {
  await releaseLockFile(handle);
}
