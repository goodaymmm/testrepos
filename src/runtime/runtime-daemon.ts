import path from "node:path";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import {
  isRuntimeStopRequested,
  refreshRuntimeHeartbeat,
  releaseRuntimeLock
} from "./runtime-lock.js";
import { RuntimeLoop, type RuntimeTickResult } from "./runtime-loop.js";

export type RuntimeDaemonStopReason =
  | "stop_requested"
  | "max_ticks"
  | "max_idle_ticks";

export type RuntimeDaemonResult = {
  schema_version: string;
  started_at: string;
  finished_at: string;
  ticks: number;
  idle_ticks: number;
  stop_reason: RuntimeDaemonStopReason;
};

export type RuntimeDaemonOptions = {
  intervalMs?: number;
  maxTicks?: number;
  maxIdleTicks?: number;
  lockTtlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  runTick?: () => Promise<RuntimeTickResult>;
};

export class RuntimeDaemon {
  constructor(
    private readonly projectRoot: string,
    private readonly options: RuntimeDaemonOptions = {}
  ) {}

  async run(): Promise<RuntimeDaemonResult> {
    const startedAt = this.now().toISOString();
    let ticks = 0;
    let idleTicks = 0;
    let stopReason: RuntimeDaemonStopReason = "stop_requested";

    try {
      while (true) {
        if (await isRuntimeStopRequested(this.projectRoot)) {
          stopReason = "stop_requested";
          break;
        }

        await this.refreshHeartbeat();
        const tick = await this.runTick();
        await appendRuntimeTickHistory(this.projectRoot, tick);
        ticks += 1;

        if (tick.action === "idle") {
          idleTicks += 1;
        } else {
          idleTicks = 0;
        }

        await this.refreshHeartbeat();

        if (this.options.maxTicks !== undefined && ticks >= this.options.maxTicks) {
          stopReason = "max_ticks";
          break;
        }

        if (
          this.options.maxIdleTicks !== undefined &&
          idleTicks >= this.options.maxIdleTicks
        ) {
          stopReason = "max_idle_ticks";
          break;
        }

        if (await isRuntimeStopRequested(this.projectRoot)) {
          stopReason = "stop_requested";
          break;
        }

        await this.sleep(this.options.intervalMs ?? 5_000);
      }
    } finally {
      await releaseRuntimeLock(this.projectRoot);
    }

    return {
      schema_version: "0.1",
      started_at: startedAt,
      finished_at: this.now().toISOString(),
      ticks,
      idle_ticks: idleTicks,
      stop_reason: stopReason
    };
  }

  private runTick(): Promise<RuntimeTickResult> {
    return (
      this.options.runTick?.() ??
      new RuntimeLoop(this.projectRoot, { now: () => this.now() }).runTick()
    );
  }

  private refreshHeartbeat(): Promise<unknown> {
    return refreshRuntimeHeartbeat(this.projectRoot, {
      now: this.now(),
      ttlMs: this.options.lockTtlMs
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
