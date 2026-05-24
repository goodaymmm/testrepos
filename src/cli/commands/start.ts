import { LockAlreadyExistsError } from "../../core/fs/lock-file.js";
import { acquireRuntimeLock } from "../../runtime/runtime-lock.js";

export const RUNTIME_ALREADY_RUNNING_EXIT_CODE = 3;

export async function startRuntime(projectRoot: string): Promise<string> {
  try {
    const status = await acquireRuntimeLock(projectRoot);
    return `Kairon runtime started. pid=${status.locked ? status.data.pid : "unknown"}`;
  } catch (error) {
    if (error instanceof LockAlreadyExistsError) {
      process.exitCode = RUNTIME_ALREADY_RUNNING_EXIT_CODE;
      return `Kairon runtime is already running. lock=${error.lockPath}`;
    }

    throw error;
  }
}
