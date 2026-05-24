import { releaseRuntimeLock } from "../../runtime/runtime-lock.js";

export async function stopRuntime(projectRoot: string): Promise<string> {
  await releaseRuntimeLock(projectRoot);
  return "Kairon runtime stopped.";
}
