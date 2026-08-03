import {
  formatRuntimeStatus,
  getRuntimeStatus
} from "../../runtime/status.js";

export async function getStatusText(projectRoot: string): Promise<string> {
  return formatRuntimeStatus(await getRuntimeStatus(projectRoot));
}
