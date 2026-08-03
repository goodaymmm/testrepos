import { LockAlreadyExistsError } from "../../core/fs/lock-file.js";
import {
  acquireRuntimeLock,
  requestRuntimeStop,
  releaseRuntimeLock
} from "../../runtime/runtime-lock.js";
import { RuntimeDaemon } from "../../runtime/runtime-daemon.js";
import { RuntimeLoop } from "../../runtime/runtime-loop.js";
import { startDiscordGateway } from "../../discord/gateway.js";
import { runRuntimeRecovery } from "../../recovery/runtime-recovery.js";

export const RUNTIME_ALREADY_RUNNING_EXIT_CODE = 3;

export type StartRuntimeOptions = {
  daemon?: boolean;
  intervalMs?: number;
  maxTicks?: number;
  maxIdleTicks?: number;
};

export async function startRuntime(
  projectRoot: string,
  options: StartRuntimeOptions = {}
): Promise<string> {
  try {
    await runRuntimeRecovery(projectRoot, {
      safeOnly: true,
      writeNoopArtifact: false
    });
    const status = await acquireRuntimeLock(projectRoot, {
      mode: options.daemon === true ? "daemon" : "single_tick"
    });

    if (options.daemon === true) {
      const unregisterSignals = registerRuntimeStopSignals(projectRoot);
      const discordGateway = await startDiscordGateway(projectRoot);
      try {
        const result = await new RuntimeDaemon(projectRoot, {
          intervalMs: options.intervalMs,
          maxTicks: options.maxTicks,
          maxIdleTicks: options.maxIdleTicks
        }).run();
        const lines = [
          `Kairon runtime daemon stopped. pid=${status.locked ? status.data.pid : "unknown"}`,
          `runtime.daemon.ticks=${result.ticks}`,
          `runtime.daemon.idleTicks=${result.idle_ticks}`,
          `runtime.daemon.stopReason=${result.stop_reason}`,
          `runtime.daemon.log=${result.daemon_log_path}`
        ];
        if (result.stop_reason === "fatal_error") {
          process.exitCode = 1;
        }
        if (result.last_error !== undefined) {
          if (result.last_error.code !== undefined) {
            lines.push(`runtime.daemon.lastErrorCode=${result.last_error.code}`);
          }
          lines.push(`runtime.daemon.lastErrorMessage=${result.last_error.message}`);
        }
        if (
          discordGateway.status === "setup_required" ||
          discordGateway.status === "error"
        ) {
          lines.push(`discord.gateway.status=${discordGateway.status}`);
          if (discordGateway.reason !== undefined) {
            lines.push(`discord.gateway.reason=${discordGateway.reason}`);
          }
          if (discordGateway.next_action !== undefined) {
            lines.push(`discord.gateway.next=${discordGateway.next_action}`);
          }
        }
        return lines.join("\n");
      } finally {
        await discordGateway.stop();
        unregisterSignals();
      }
    }

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

function registerRuntimeStopSignals(projectRoot: string): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handler = () => {
    void requestRuntimeStop(projectRoot);
  };

  for (const signal of signals) {
    process.once(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, handler);
    }
  };
}
