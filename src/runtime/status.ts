import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import { WorkQueue } from "../queue/work-queue.js";
import { inspectRuntimeRecoveryTargets } from "../recovery/runtime-recovery.js";
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
  queue: {
    ready: number;
    claimed: number;
    failed: number;
  };
  approvals: {
    pending: number;
  };
  recovery: {
    targets: number;
    stale_locks: number;
    expired_claims: number;
    run_issues: number;
    gateway_issues: number;
    git_transaction_issues: number;
    resolved_targets: number;
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
  artifacts: {
    last_tick: string;
    latest_daily_report?: string;
    latest_cleanup_proposal?: string;
    latest_recovery_artifact?: string;
    latest_next_day_plan?: string;
    board_projection?: string;
  };
};

export async function getRuntimeStatus(projectRoot: string): Promise<RuntimeStatus> {
  const [
    schedule,
    lock,
    queueItems,
    pendingApprovals,
    recovery,
    sessions,
    discordGateway,
    artifacts
  ] = await Promise.all([
    getScheduleStatus(projectRoot),
    readRuntimeLockStatus(projectRoot),
    new WorkQueue(projectRoot).list(),
    countPendingApprovals(projectRoot),
    inspectRuntimeRecoveryTargets(projectRoot),
    readLatestSessionSummary(projectRoot),
    readDiscordGatewaySummary(projectRoot),
    readOperationalArtifacts(projectRoot)
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
          stop_requested: lock.data.stop_requested,
          tick_count: lock.data.tick_count,
          idle_count: lock.data.idle_count,
          last_action: lock.data.last_action,
          next_tick_at: lock.data.next_tick_at,
          last_error: lock.data.last_error
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
    recovery: recovery.summary,
    sessions,
    discordGateway,
    artifacts
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
    status.runtimeLock.tick_count === undefined
      ? null
      : `runtime.tickCount=${status.runtimeLock.tick_count}`,
    status.runtimeLock.idle_count === undefined
      ? null
      : `runtime.idleCount=${status.runtimeLock.idle_count}`,
    status.runtimeLock.last_action === undefined
      ? null
      : `runtime.lastAction=${status.runtimeLock.last_action}`,
    status.runtimeLock.next_tick_at === undefined
      ? null
      : `runtime.nextTickAt=${status.runtimeLock.next_tick_at}`,
    status.runtimeLock.last_error?.code === undefined
      ? null
      : `runtime.lastErrorCode=${sanitizeStatusText(status.runtimeLock.last_error.code)}`,
    status.runtimeLock.last_error?.message === undefined
      ? null
      : `runtime.lastErrorMessage=${sanitizeStatusText(
          status.runtimeLock.last_error.message
        )}`,
    `queue.ready=${status.queue.ready}`,
    `queue.claimed=${status.queue.claimed}`,
    `queue.failed=${status.queue.failed}`,
    `approvals.pending=${status.approvals.pending}`,
    `recovery.targets=${status.recovery.targets}`,
    `recovery.staleLocks=${status.recovery.stale_locks}`,
    `recovery.expiredClaims=${status.recovery.expired_claims}`,
    `recovery.runIssues=${status.recovery.run_issues}`,
    `recovery.gatewayIssues=${status.recovery.gateway_issues}`,
    `recovery.gitTransactionIssues=${status.recovery.git_transaction_issues}`,
    `recovery.resolvedTargets=${status.recovery.resolved_targets}`,
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
      : `discord.gateway.nextAction=${status.discordGateway.next_action}`,
    `artifacts.lastTick=${status.artifacts.last_tick}`,
    status.artifacts.latest_daily_report === undefined
      ? null
      : `artifacts.latestDailyReport=${status.artifacts.latest_daily_report}`,
    status.artifacts.latest_cleanup_proposal === undefined
      ? null
      : `artifacts.latestCleanupProposal=${status.artifacts.latest_cleanup_proposal}`,
    status.artifacts.latest_recovery_artifact === undefined
      ? null
      : `artifacts.latestRecoveryArtifact=${status.artifacts.latest_recovery_artifact}`,
    status.artifacts.latest_next_day_plan === undefined
      ? null
      : `artifacts.latestNextDayPlan=${status.artifacts.latest_next_day_plan}`,
    status.artifacts.board_projection === undefined
      ? null
      : `artifacts.boardProjection=${status.artifacts.board_projection}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function readOperationalArtifacts(
  projectRoot: string
): Promise<RuntimeStatus["artifacts"]> {
  const paths = getKaironPaths(projectRoot);

  return {
    last_tick: toProjectPath(projectRoot, path.join(paths.runtimeDir, "last-tick.json")),
    latest_daily_report: await latestJsonPath(
      projectRoot,
      path.join(paths.reportsDir, "daily")
    ),
    latest_cleanup_proposal: await latestJsonPath(
      projectRoot,
      path.join(paths.cleanupDir, "proposals")
    ),
    latest_recovery_artifact: await latestJsonPath(projectRoot, paths.recoveryDir),
    latest_next_day_plan: await latestJsonPath(
      projectRoot,
      path.join(paths.reportsDir, "next-day")
    ),
    board_projection: await optionalJsonPath(
      projectRoot,
      path.join(paths.kaironDir, "board", "projection.json")
    )
  };
}

async function latestJsonPath(
  projectRoot: string,
  directoryPath: string
): Promise<string | undefined> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .at(-1);

    return latest === undefined
      ? undefined
      : toProjectPath(projectRoot, path.join(directoryPath, latest));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function optionalJsonPath(
  projectRoot: string,
  filePath: string
): Promise<string | undefined> {
  try {
    await readJsonFile<unknown>(filePath);
    return toProjectPath(projectRoot, filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }

    throw error;
  }
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

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
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
