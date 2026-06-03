import {
  readRuntimeLockStatus,
  releaseRuntimeLock,
  requestRuntimeStop
} from "../../runtime/runtime-lock.js";

export async function stopRuntime(projectRoot: string): Promise<string> {
  const status = await readRuntimeLockStatus(projectRoot);
  if (status.locked && status.data.mode === "daemon" && !status.stale) {
    await requestRuntimeStop(projectRoot);
    return `Kairon runtime stop requested. pid=${status.data.pid}`;
  }

  await releaseRuntimeLock(projectRoot);
  return "Kairon runtime stopped.";
}
