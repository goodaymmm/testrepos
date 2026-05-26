import { LockAlreadyExistsError } from "../../core/fs/lock-file.js";
import {
  acquireRuntimeLock,
  releaseRuntimeLock
} from "../../runtime/runtime-lock.js";
import { RuntimeLoop } from "../../runtime/runtime-loop.js";

export const RUNTIME_ALREADY_RUNNING_EXIT_CODE = 3;

export async function startRuntime(projectRoot: string): Promise<string> {
  try {
    const status = await acquireRuntimeLock(projectRoot);
    let tick;
    try {
      tick = await new RuntimeLoop(projectRoot).runTick();
    } catch (error) {
      await releaseRuntimeLock(projectRoot);
      throw error;
    }

    return [
      `Kairon runtime started. pid=${status.locked ? status.data.pid : "unknown"}`,
      `runtime.tick.mode=${tick.mode}`,
      `runtime.tick.action=${tick.action}`
    ].join("\n");
  } catch (error) {
    if (error instanceof LockAlreadyExistsError) {
      process.exitCode = RUNTIME_ALREADY_RUNNING_EXIT_CODE;
      return `Kairon runtime is already running. lock=${error.lockPath}`;
    }

    throw error;
  }
}
