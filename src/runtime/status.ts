import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import { listApprovalFollowUps } from "../approvals/follow-up-runner.js";
import { WorkQueue } from "../queue/work-queue.js";
import { inspectRuntimeRecoveryTargets } from "../recovery/runtime-recovery.js";
import { readRuntimeLockStatus, type RuntimeLockStatus } from "./runtime-lock.js";
import { getScheduleStatus, type ScheduleStatus } from "./schedule-engine.js";
import type { SameDaySessionSummary } from "../agents/session-host.js";
import {
  readWatchdogAlertSummary,
  type WatchdogAlertSummary
} from "./watchdog.js";
import {
  latestSloSummaryPath,
  readLatestSloSummary,
  type RuntimeSloSummary
} from "../observability/slo.js";

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
  followUps: {
    pending: number;
    snoozed: number;
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
  daemonHealth?: {
    status: "running" | "stopped" | "fatal_error" | "stale_lock" | "unknown";
    latest_log?: string;
    started_at?: string;
    latest_event_at?: string;
    ticks?: number;
    idle_ticks?: number;
    processed_ticks?: number;
    fatal_errors?: number;
    stop_reason?: string;
    last_action?: string;
    stale_lock_suspected?: boolean;
    last_error?: {
      code?: string;
      message?: string;
      at?: string;
    };
  };
  discordGateway?: {
    status?: string;
    commands_registered?: boolean;
    error_code?: string;
    operation?: string;
    next_action?: string;
    http_status?: number;
  };
  watchdog: WatchdogAlertSummary;
  observability: {
    slo_status: RuntimeSloSummary["status"] | "NOT_EVALUATED";
    evaluated_at?: string;
    minimum_samples?: number;
    corrupt_samples?: number;
  };
  artifacts: {
    last_tick: string;
    latest_daily_report?: string;
    latest_cleanup_proposal?: string;
    latest_recovery_artifact?: string;
    latest_next_day_plan?: string;
    board_projection?: string;
    latest_daemon_log?: string;
    latest_slo_summary?: string;
  };
};

export type RuntimeStatusSummary = {
  locked: boolean;
  stale: boolean;
  mode?: string;
  queue: RuntimeStatus["queue"];
  pending_approvals: number;
  watchdog_open: number;
  daemon_status?: NonNullable<RuntimeStatus["daemonHealth"]>["status"];
};

export async function getRuntimeStatus(projectRoot: string): Promise<RuntimeStatus> {
  const [
    schedule,
    lock,
    queueItems,
    pendingApprovals,
    followUps,
    recovery,
    sessions,
    discordGateway,
    watchdog,
    observability,
    artifacts
  ] = await Promise.all([
    getScheduleStatus(projectRoot),
    readRuntimeLockStatus(projectRoot),
    new WorkQueue(projectRoot).list(),
    countPendingApprovals(projectRoot),
    listApprovalFollowUps(projectRoot),
    inspectRuntimeRecoveryTargets(projectRoot),
    readLatestSessionSummary(projectRoot),
    readDiscordGatewaySummary(projectRoot),
    readWatchdogAlertSummary(projectRoot),
    readObservabilitySummary(projectRoot),
    readOperationalArtifacts(projectRoot)
  ]);

  const daemonHealth = await readDaemonHealth(projectRoot, lock);

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
    followUps: {
      pending: followUps.filter((followUp) => followUp.status === "pending").length,
      snoozed: followUps.filter((followUp) => followUp.status === "snoozed").length
    },
    recovery: recovery.summary,
    sessions,
    daemonHealth,
    discordGateway,
    watchdog,
    observability,
    artifacts
  };
}

export function summarizeRuntimeStatus(
  status: RuntimeStatus
): RuntimeStatusSummary {
  return {
    locked: status.runtimeLock.locked,
    stale: status.runtimeLock.stale ?? false,
    mode: status.runtimeLock.mode,
    queue: { ...status.queue },
    pending_approvals: status.approvals.pending,
    watchdog_open: status.watchdog.open,
    daemon_status: status.daemonHealth?.status
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
    `followups.pending=${status.followUps.pending}`,
    `followups.snoozed=${status.followUps.snoozed}`,
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
    status.daemonHealth?.status === undefined
      ? null
      : `daemon.health.status=${status.daemonHealth.status}`,
    status.daemonHealth?.latest_log === undefined
      ? null
      : `daemon.health.latestLog=${status.daemonHealth.latest_log}`,
    status.daemonHealth?.started_at === undefined
      ? null
      : `daemon.health.startedAt=${status.daemonHealth.started_at}`,
    status.daemonHealth?.latest_event_at === undefined
      ? null
      : `daemon.health.latestEventAt=${status.daemonHealth.latest_event_at}`,
    status.daemonHealth?.ticks === undefined
      ? null
      : `daemon.health.ticks=${status.daemonHealth.ticks}`,
    status.daemonHealth?.idle_ticks === undefined
      ? null
      : `daemon.health.idleTicks=${status.daemonHealth.idle_ticks}`,
    status.daemonHealth?.processed_ticks === undefined
      ? null
      : `daemon.health.processedTicks=${status.daemonHealth.processed_ticks}`,
    status.daemonHealth?.fatal_errors === undefined
      ? null
      : `daemon.health.fatalErrors=${status.daemonHealth.fatal_errors}`,
    status.daemonHealth?.stop_reason === undefined
      ? null
      : `daemon.health.stopReason=${status.daemonHealth.stop_reason}`,
    status.daemonHealth?.last_action === undefined
      ? null
      : `daemon.health.lastAction=${status.daemonHealth.last_action}`,
    status.daemonHealth?.stale_lock_suspected === undefined
      ? null
      : `daemon.health.staleLockSuspected=${status.daemonHealth.stale_lock_suspected}`,
    status.daemonHealth?.last_error?.code === undefined
      ? null
      : `daemon.health.lastErrorCode=${sanitizeStatusText(
          status.daemonHealth.last_error.code
        )}`,
    status.daemonHealth?.last_error?.message === undefined
      ? null
      : `daemon.health.lastErrorMessage=${sanitizeStatusText(
          status.daemonHealth.last_error.message
        )}`,
    status.daemonHealth?.last_error?.at === undefined
      ? null
      : `daemon.health.lastErrorAt=${status.daemonHealth.last_error.at}`,
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
    `watchdog.open=${status.watchdog.open}`,
    `watchdog.acknowledged=${status.watchdog.acknowledged}`,
    `watchdog.resolved=${status.watchdog.resolved}`,
    `watchdog.highestSeverity=${status.watchdog.highest_severity}`,
    `watchdog.notificationsPending=${status.watchdog.notifications_pending}`,
    status.watchdog.last_checked_at === undefined
      ? null
      : `watchdog.lastCheckedAt=${status.watchdog.last_checked_at}`,
    `observability.sloStatus=${status.observability.slo_status}`,
    status.observability.evaluated_at === undefined
      ? null
      : `observability.evaluatedAt=${status.observability.evaluated_at}`,
    status.observability.corrupt_samples === undefined
      ? null
      : `observability.corruptSamples=${status.observability.corrupt_samples}`,
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
      : `artifacts.boardProjection=${status.artifacts.board_projection}`,
    status.artifacts.latest_daemon_log === undefined
      ? null
      : `artifacts.latestDaemonLog=${status.artifacts.latest_daemon_log}`,
    status.artifacts.latest_slo_summary === undefined
      ? null
      : `artifacts.latestSloSummary=${status.artifacts.latest_slo_summary}`
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
    ),
    latest_daemon_log: await latestJsonlPath(
      projectRoot,
      path.join(paths.runtimeDir, "daemon")
    ),
    latest_slo_summary: await optionalJsonPath(
      projectRoot,
      latestSloSummaryPath(projectRoot)
    )
  };
}

async function readObservabilitySummary(
  projectRoot: string
): Promise<RuntimeStatus["observability"]> {
  const summary = await readLatestSloSummary(projectRoot);
  return summary === undefined
    ? { slo_status: "NOT_EVALUATED" }
    : {
        slo_status: summary.status,
        evaluated_at: summary.evaluated_at,
        minimum_samples: summary.minimum_samples,
        corrupt_samples: summary.corrupt_samples
      };
}

async function readDaemonHealth(
  projectRoot: string,
  lock: RuntimeLockStatus
): Promise<RuntimeStatus["daemonHealth"] | undefined> {
  const daemonDir = path.join(getKaironPaths(projectRoot).runtimeDir, "daemon");
  const latestLogPath = await latestFilePath(daemonDir, ".jsonl");
  const events =
    latestLogPath === undefined
      ? []
      : await readJsonLines<Record<string, unknown>>(latestLogPath);
  const latestEvent = events.at(-1);
  const latestTick = findLastEvent(events, "tick");
  const latestStarted = findLastEvent(events, "started");
  const latestStopped = findLastEvent(events, "stopped");
  const latestFatal = findLastEvent(events, "fatal_error");
  const hasDaemonLock = lock.locked && lock.data.mode === "daemon";

  if (latestLogPath === undefined && !hasDaemonLock) {
    return undefined;
  }

  const stopReason = asString(latestStopped?.stop_reason);
  const running = hasDaemonLock && !lock.stale;
  const status = running
    ? "running"
    : hasDaemonLock && lock.stale
      ? "stale_lock"
      : stopReason === "fatal_error" || latestEvent?.event === "fatal_error"
        ? "fatal_error"
        : latestEvent?.event === "stopped"
          ? "stopped"
          : "unknown";
  const ticks =
    lock.locked && lock.data.mode === "daemon"
      ? lock.data.tick_count
      : asNumber(latestStopped?.ticks) ?? maxEventNumber(events, "tick_count");
  const idleTicks =
    lock.locked && lock.data.mode === "daemon"
      ? lock.data.idle_count
      : asNumber(latestStopped?.idle_ticks) ?? maxEventNumber(events, "idle_count");
  const fatalErrorSource = lock.locked
    ? lock.data.last_error
    : asErrorRecord(latestStopped?.last_error) ?? asErrorRecord(latestFatal?.error);

  return {
    status,
    latest_log:
      latestLogPath === undefined ? undefined : toProjectPath(projectRoot, latestLogPath),
    started_at: asString(latestStarted?.started_at) ?? (lock.locked ? lock.data.created_at : undefined),
    latest_event_at:
      (lock.locked && lock.data.mode === "daemon"
        ? lock.data.heartbeat_at ?? lock.data.updated_at
        : undefined) ?? asString(latestEvent?.created_at),
    ticks,
    idle_ticks: idleTicks,
    processed_ticks: events.filter(
      (event) => event.event === "tick" && asString(event.action) !== "idle"
    ).length,
    fatal_errors: events.filter((event) => event.event === "fatal_error").length,
    stop_reason: stopReason,
    last_action:
      lock.locked && lock.data.mode === "daemon"
        ? lock.data.last_action
        : asString(latestTick?.action),
    stale_lock_suspected: hasDaemonLock ? lock.stale : undefined,
    last_error:
      fatalErrorSource === undefined
        ? undefined
        : {
            code: sanitizeStatusText(asString(fatalErrorSource.code)),
            message: sanitizeStatusText(asString(fatalErrorSource.message)),
            at: asString(fatalErrorSource.at)
          }
  };
}

async function latestJsonPath(
  projectRoot: string,
  directoryPath: string
): Promise<string | undefined> {
  const latest = await latestFilePath(directoryPath, ".json");
  return latest === undefined ? undefined : toProjectPath(projectRoot, latest);
}

async function latestJsonlPath(
  projectRoot: string,
  directoryPath: string
): Promise<string | undefined> {
  const latest = await latestFilePath(directoryPath, ".jsonl");
  return latest === undefined ? undefined : toProjectPath(projectRoot, latest);
}

async function latestFilePath(
  directoryPath: string,
  extension: ".json" | ".jsonl"
): Promise<string | undefined> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
      .sort()
      .at(-1);

    return latest === undefined ? undefined : path.join(directoryPath, latest);
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

function asErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function findLastEvent(
  events: Record<string, unknown>[],
  eventName: string
): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === eventName) {
      return event;
    }
  }

  return undefined;
}

function maxEventNumber(
  events: Record<string, unknown>[],
  property: string
): number | undefined {
  const values = events
    .map((event) => asNumber(event[property]))
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
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
