import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import { WorkQueue } from "../queue/work-queue.js";
import { readRuntimeLockStatus } from "./runtime-lock.js";
import { getScheduleStatus, type ScheduleStatus } from "./schedule-engine.js";
import type { SameDaySessionSummary } from "../agents/session-host.js";

export type RuntimeStatus = {
  schedule: ScheduleStatus;
  runtimeLock: {
    locked: boolean;
    stale?: boolean;
    pid?: number;
    owner?: string;
    mode?: string;
    heartbeat_at?: string;
    stop_requested?: boolean;
  };
  queue: {
    ready: number;
    claimed: number;
    failed: number;
  };
  approvals: {
    pending: number;
  };
  sessions?: SameDaySessionSummary;
  discordGateway?: {
    status?: string;
    commands_registered?: boolean;
    error_code?: string;
    operation?: string;
    next_action?: string;
    http_status?: number;
  };
};

export async function getRuntimeStatus(projectRoot: string): Promise<RuntimeStatus> {
  const [
    schedule,
    lock,
    queueItems,
    pendingApprovals,
    sessions,
    discordGateway
  ] = await Promise.all([
    getScheduleStatus(projectRoot),
    readRuntimeLockStatus(projectRoot),
    new WorkQueue(projectRoot).list(),
    countPendingApprovals(projectRoot),
    readLatestSessionSummary(projectRoot),
    readDiscordGatewaySummary(projectRoot)
  ]);

  return {
    schedule,
    runtimeLock: lock.locked
      ? {
          locked: true,
          stale: lock.stale,
          pid: lock.data.pid,
          owner: lock.data.owner,
          mode: lock.data.mode,
          heartbeat_at: lock.data.heartbeat_at,
          stop_requested: lock.data.stop_requested
        }
      : { locked: false },
    queue: {
      ready: queueItems.filter((item) => item.status === "ready").length,
      claimed: queueItems.filter((item) => item.status === "claimed").length,
      failed: queueItems.filter((item) => item.status === "failed").length
    },
    approvals: {
      pending: pendingApprovals
    },
    sessions,
    discordGateway
  };
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  return [
    `schedule.mode=${status.schedule.mode}`,
    `schedule.baseMode=${status.schedule.baseMode}`,
    `schedule.activeWorkClosed=${status.schedule.activeWorkClosed}`,
    `runtime.locked=${status.runtimeLock.locked}`,
    `runtime.stale=${status.runtimeLock.stale ?? false}`,
    status.runtimeLock.mode === undefined
      ? null
      : `runtime.mode=${status.runtimeLock.mode}`,
    status.runtimeLock.heartbeat_at === undefined
      ? null
      : `runtime.heartbeatAt=${status.runtimeLock.heartbeat_at}`,
    status.runtimeLock.stop_requested === undefined
      ? null
      : `runtime.stopRequested=${status.runtimeLock.stop_requested}`,
    `queue.ready=${status.queue.ready}`,
    `queue.claimed=${status.queue.claimed}`,
    `queue.failed=${status.queue.failed}`,
    `approvals.pending=${status.approvals.pending}`,
    status.sessions?.date === undefined ? null : `sessions.date=${status.sessions.date}`,
    status.sessions?.initialized === undefined
      ? null
      : `sessions.initialized=${status.sessions.initialized}`,
    status.sessions?.ready === undefined ? null : `sessions.ready=${status.sessions.ready}`,
    status.sessions?.idle === undefined ? null : `sessions.idle=${status.sessions.idle}`,
    status.sessions?.busy === undefined ? null : `sessions.busy=${status.sessions.busy}`,
    status.sessions?.setup_required === undefined
      ? null
      : `sessions.setupRequired=${status.sessions.setup_required}`,
    status.sessions?.permission_required === undefined
      ? null
      : `sessions.permissionRequired=${status.sessions.permission_required}`,
    status.sessions?.rate_limited === undefined
      ? null
      : `sessions.rateLimited=${status.sessions.rate_limited}`,
    status.sessions?.usage_limited === undefined
      ? null
      : `sessions.usageLimited=${status.sessions.usage_limited}`,
    status.discordGateway?.status === undefined
      ? null
      : `discord.gateway.status=${status.discordGateway.status}`,
    status.discordGateway?.commands_registered === undefined
      ? null
      : `discord.gateway.commandsRegistered=${status.discordGateway.commands_registered}`,
    status.discordGateway?.error_code === undefined
      ? null
      : `discord.gateway.errorCode=${status.discordGateway.error_code}`,
    status.discordGateway?.operation === undefined
      ? null
      : `discord.gateway.operation=${status.discordGateway.operation}`,
    status.discordGateway?.http_status === undefined
      ? null
      : `discord.gateway.httpStatus=${status.discordGateway.http_status}`,
    status.discordGateway?.next_action === undefined
      ? null
      : `discord.gateway.nextAction=${status.discordGateway.next_action}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function readLatestSessionSummary(
  projectRoot: string
): Promise<SameDaySessionSummary | undefined> {
  try {
    const tick = await readJsonFile<{ sessions?: SameDaySessionSummary }>(
      path.join(getKaironPaths(projectRoot).runtimeDir, "last-tick.json")
    );
    return tick.sessions;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function readDiscordGatewaySummary(
  projectRoot: string
): Promise<RuntimeStatus["discordGateway"] | undefined> {
  try {
    const gateway = await readJsonFile<Record<string, unknown>>(
      path.join(getKaironPaths(projectRoot).runtimeDir, "discord", "gateway.json")
    );
    return {
      status: asString(gateway.status),
      commands_registered: asBoolean(gateway.commands_registered),
      error_code: asString(gateway.error_code),
      operation: asString(gateway.operation),
      next_action: sanitizeStatusText(asString(gateway.next_action)),
      http_status: asNumber(gateway.http_status)
    };
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sanitizeStatusText(value: string | undefined): string | undefined {
  return value
    ?.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
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
