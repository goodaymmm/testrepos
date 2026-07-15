import path from "node:path";
import { uptime } from "node:os";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  isRuntimeStopRequested,
  refreshRuntimeHeartbeat,
  releaseRuntimeLock
} from "./runtime-lock.js";
import { RuntimeLoop, type RuntimeTickResult } from "./runtime-loop.js";

export type RuntimeDaemonStopReason =
  | "stop_requested"
  | "max_ticks"
  | "max_idle_ticks"
  | "fatal_error";

export type RuntimeDaemonErrorSummary = {
  code?: string;
  message: string;
  at: string;
};

export type RuntimeDaemonResult = {
  schema_version: string;
  started_at: string;
  finished_at: string;
  ticks: number;
  idle_ticks: number;
  stop_reason: RuntimeDaemonStopReason;
  daemon_log_path: string;
  last_error?: RuntimeDaemonErrorSummary;
};

export type RuntimeDaemonOptions = {
  intervalMs?: number;
  maxTicks?: number;
  maxIdleTicks?: number;
  lockTtlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  runTick?: () => Promise<RuntimeTickResult>;
  hostBootAt?: () => string;
};

export class RuntimeDaemon {
  constructor(
    private readonly projectRoot: string,
    private readonly options: RuntimeDaemonOptions = {}
  ) {}

  async run(): Promise<RuntimeDaemonResult> {
    const startedAt = this.now().toISOString();
    const hostBootAt = this.options.hostBootAt?.() ?? getHostBootAt(this.now());
    let ticks = 0;
    let idleTicks = 0;
    let stopReason: RuntimeDaemonStopReason = "stop_requested";
    let lastError: RuntimeDaemonErrorSummary | undefined;
    const daemonLogPath = toProjectPath(
      this.projectRoot,
      daemonLogPathFor(this.projectRoot, startedAt)
    );

    try {
      await appendDaemonEvent(this.projectRoot, {
        schema_version: "0.1",
        event: "started",
        pid: process.pid,
        started_at: startedAt,
        host_boot_at: hostBootAt,
        interval_ms: this.options.intervalMs ?? 5_000,
        max_ticks: this.options.maxTicks,
        max_idle_ticks: this.options.maxIdleTicks,
        created_at: startedAt
      });

      while (true) {
        if (await isRuntimeStopRequested(this.projectRoot)) {
          stopReason = "stop_requested";
          break;
        }

        await this.refreshHeartbeat({
          tickCount: ticks,
          idleCount: idleTicks,
          nextTickAt: null,
          lastError: null
        });
        const tick = await this.runTick();
        await appendRuntimeTickHistory(this.projectRoot, tick);
        ticks += 1;

        if (tick.action === "idle") {
          idleTicks += 1;
        } else {
          idleTicks = 0;
        }

        const maxTicksReached =
          this.options.maxTicks !== undefined && ticks >= this.options.maxTicks;
        const maxIdleTicksReached =
          this.options.maxIdleTicks !== undefined &&
          idleTicks >= this.options.maxIdleTicks;
        const stopRequested = await isRuntimeStopRequested(this.projectRoot);
        const willContinue =
          !maxTicksReached && !maxIdleTicksReached && !stopRequested;
        const nextTickAt = willContinue
          ? new Date(this.now().getTime() + (this.options.intervalMs ?? 5_000)).toISOString()
          : null;

        await this.refreshHeartbeat({
          tickCount: ticks,
          idleCount: idleTicks,
          lastAction: tick.action,
          nextTickAt,
          lastError: null
        });
        await appendDaemonEvent(this.projectRoot, {
          schema_version: "0.1",
          event: "tick",
          tick_count: ticks,
          idle_count: idleTicks,
          action: tick.action,
          mode: tick.mode,
          next_tick_at: nextTickAt ?? undefined,
          created_at: this.now().toISOString()
        });

        if (maxTicksReached) {
          stopReason = "max_ticks";
          break;
        }

        if (maxIdleTicksReached) {
          stopReason = "max_idle_ticks";
          break;
        }

        if (stopRequested) {
          stopReason = "stop_requested";
          break;
        }

        await this.sleep(this.options.intervalMs ?? 5_000);
      }
    } catch (error) {
      stopReason = "fatal_error";
      lastError = summarizeDaemonError(error, this.now());
      await appendDaemonEvent(this.projectRoot, {
        schema_version: "0.1",
        event: "fatal_error",
        tick_count: ticks,
        idle_count: idleTicks,
        error: lastError,
        created_at: lastError.at
      });
      await this.refreshHeartbeat({
        tickCount: ticks,
        idleCount: idleTicks,
        nextTickAt: null,
        lastError
      });
    } finally {
      try {
        await appendDaemonEvent(this.projectRoot, {
          schema_version: "0.1",
          event: "stopped",
          ticks,
          idle_ticks: idleTicks,
          stop_reason: stopReason,
          last_error: lastError,
          created_at: this.now().toISOString()
        });
      } finally {
        await releaseRuntimeLock(this.projectRoot);
      }
    }

    return {
      schema_version: "0.1",
      started_at: startedAt,
      finished_at: this.now().toISOString(),
      ticks,
      idle_ticks: idleTicks,
      stop_reason: stopReason,
      daemon_log_path: daemonLogPath,
      last_error: lastError
    };
  }

  private runTick(): Promise<RuntimeTickResult> {
    return (
      this.options.runTick?.() ??
      new RuntimeLoop(this.projectRoot, { now: () => this.now() }).runTick()
    );
  }

  private refreshHeartbeat(
    metadata: {
      tickCount?: number;
      idleCount?: number;
      lastAction?: string;
      nextTickAt?: string | null;
      lastError?: RuntimeDaemonErrorSummary | null;
    } = {}
  ): Promise<unknown> {
    return refreshRuntimeHeartbeat(this.projectRoot, {
      now: this.now(),
      ttlMs: this.options.lockTtlMs,
      ...metadata
    });
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

async function appendRuntimeTickHistory(
  projectRoot: string,
  tick: RuntimeTickResult
): Promise<void> {
  await appendJsonLine(
    path.join(
      getKaironPaths(projectRoot).runtimeDir,
      "ticks",
      `${tick.created_at.slice(0, 10)}.jsonl`
    ),
    tick
  );
}

async function appendDaemonEvent(
  projectRoot: string,
  event: Record<string, unknown> & { created_at: string }
): Promise<void> {
  await appendJsonLine(daemonLogPathFor(projectRoot, event.created_at), event);
}

function daemonLogPathFor(projectRoot: string, isoTimestamp: string): string {
  return path.join(
    getKaironPaths(projectRoot).runtimeDir,
    "daemon",
    `${isoTimestamp.slice(0, 10)}.jsonl`
  );
}

function summarizeDaemonError(
  error: unknown,
  now: Date
): RuntimeDaemonErrorSummary {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? sanitizeText(String((error as { code?: unknown }).code))
      : undefined;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  return {
    code,
    message: sanitizeText(message),
    at: now.toISOString()
  };
}

function sanitizeText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim();
}

function getHostBootAt(now: Date): string {
  const bootTimeMs = now.getTime() - uptime() * 1_000;
  return new Date(Math.floor(bootTimeMs / 60_000) * 60_000).toISOString();
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
