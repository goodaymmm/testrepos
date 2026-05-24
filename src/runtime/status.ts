import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import { WorkQueue } from "../queue/work-queue.js";
import { readRuntimeLockStatus } from "./runtime-lock.js";
import { getScheduleStatus, type ScheduleStatus } from "./schedule-engine.js";

export type RuntimeStatus = {
  schedule: ScheduleStatus;
  runtimeLock: {
    locked: boolean;
    stale?: boolean;
    pid?: number;
    owner?: string;
  };
  queue: {
    ready: number;
    claimed: number;
    failed: number;
  };
  approvals: {
    pending: number;
  };
};

export async function getRuntimeStatus(projectRoot: string): Promise<RuntimeStatus> {
  const [schedule, lock, queueItems, pendingApprovals] = await Promise.all([
    getScheduleStatus(projectRoot),
    readRuntimeLockStatus(projectRoot),
    new WorkQueue(projectRoot).list(),
    countPendingApprovals(projectRoot)
  ]);

  return {
    schedule,
    runtimeLock: lock.locked
      ? {
          locked: true,
          stale: lock.stale,
          pid: lock.data.pid,
          owner: lock.data.owner
        }
      : { locked: false },
    queue: {
      ready: queueItems.filter((item) => item.status === "ready").length,
      claimed: queueItems.filter((item) => item.status === "claimed").length,
      failed: queueItems.filter((item) => item.status === "failed").length
    },
    approvals: {
      pending: pendingApprovals
    }
  };
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  return [
    `schedule.mode=${status.schedule.mode}`,
    `schedule.baseMode=${status.schedule.baseMode}`,
    `schedule.activeWorkClosed=${status.schedule.activeWorkClosed}`,
    `runtime.locked=${status.runtimeLock.locked}`,
    `runtime.stale=${status.runtimeLock.stale ?? false}`,
    `queue.ready=${status.queue.ready}`,
    `queue.claimed=${status.queue.claimed}`,
    `queue.failed=${status.queue.failed}`,
    `approvals.pending=${status.approvals.pending}`
  ].join("\n");
}

async function countPendingApprovals(projectRoot: string): Promise<number> {
  const approvalsDir = getKaironPaths(projectRoot).approvalsDir;

  try {
    const entries = await readdir(approvalsDir, { withFileTypes: true });
    const approvals = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJsonFile<{ status?: string }>(path.join(approvalsDir, entry.name))
        )
    );

    return approvals.filter((approval) => approval.status === "pending").length;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return 0;
    }

    throw error;
  }
}
