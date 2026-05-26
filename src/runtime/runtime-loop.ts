import path from "node:path";
import { runDailyMaintenance, type DailyMaintenanceResult } from "../maintenance/run.js";
import { CommandInbox } from "../queue/command-inbox.js";
import {
  QueueWorker,
  type QueueWorkerHandlers,
  type QueueWorkerResult
} from "../queue/queue-worker.js";
import { WorkQueue } from "../queue/work-queue.js";
import { StateApplier } from "../state/state-applier.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  getLocalDateKey,
  getScheduleStatus,
  type ScheduleStatus
} from "./schedule-engine.js";

export type RuntimeTickAction =
  | "processed-command"
  | "processed-item"
  | "maintenance-run"
  | "maintenance-skipped"
  | "idle";

export type RuntimeTickResult = {
  schema_version: string;
  mode: ScheduleStatus["mode"];
  base_mode: ScheduleStatus["baseMode"];
  active_work_closed: boolean;
  action: RuntimeTickAction;
  worker_id: string;
  created_at: string;
  queue_result?: QueueWorkerResult;
  maintenance?: {
    date: string;
    daily_report_path?: string;
    cleanup_proposal_path?: string;
    handoff_count?: number;
    marker_path: string;
  };
};

export type RuntimeLoopOptions = {
  now?: () => Date;
  workerId?: string;
  handlers?: QueueWorkerHandlers;
  maintenanceRunner?: (
    projectRoot: string,
    request: { date: string; now: Date }
  ) => Promise<DailyMaintenanceResult>;
};

export class RuntimeLoop {
  constructor(
    private readonly projectRoot: string,
    private readonly options: RuntimeLoopOptions = {}
  ) {}

  async runTick(): Promise<RuntimeTickResult> {
    const now = this.now();
    const schedule = await getScheduleStatus(this.projectRoot, now);
    const workerId = this.options.workerId ?? `runtime-${process.pid}`;

    if (schedule.mode === "maintenance") {
      return this.recordTick(
        await this.runMaintenanceTick(schedule, workerId, now)
      );
    }

    const queueResult = await this.createQueueWorker(now).processNext(workerId, {
      scheduleMode: schedule.mode,
      now
    });
    return this.recordTick({
      ...this.baseTick(schedule, workerId, now),
      action: queueResult.status === "idle" ? "idle" : queueResult.status,
      queue_result: queueResult
    });
  }

  private createQueueWorker(now: Date): QueueWorker {
    return new QueueWorker(
      this.projectRoot,
      new WorkQueue(this.projectRoot),
      new CommandInbox(this.projectRoot),
      mergeHandlers(defaultQueueHandlers(this.projectRoot, now), this.options.handlers)
    );
  }

  private async runMaintenanceTick(
    schedule: ScheduleStatus,
    workerId: string,
    now: Date
  ): Promise<RuntimeTickResult> {
    const date = getLocalDateKey(now, schedule.timezone);
    const markerPath = maintenanceMarkerPath(this.projectRoot, date);

    if (await fileExists(markerPath)) {
      return {
        ...this.baseTick(schedule, workerId, now),
        action: "maintenance-skipped",
        maintenance: {
          date,
          marker_path: toProjectPath(this.projectRoot, markerPath)
        }
      };
    }

    const result = await (this.options.maintenanceRunner ?? runDailyMaintenance)(
      this.projectRoot,
      { date, now }
    );
    const marker = {
      schema_version: "0.1",
      date,
      completed_at: now.toISOString(),
      daily_report_path: result.daily_report_path,
      cleanup_proposal_path: result.cleanup_proposal_path,
      handoff_paths: result.handoff_paths
    };
    await writeJsonFileAtomic(markerPath, marker);

    return {
      ...this.baseTick(schedule, workerId, now),
      action: "maintenance-run",
      maintenance: {
        date,
        daily_report_path: result.daily_report_path,
        cleanup_proposal_path: result.cleanup_proposal_path,
        handoff_count: result.handoff_paths.length,
        marker_path: toProjectPath(this.projectRoot, markerPath)
      }
    };
  }

  private baseTick(
    schedule: ScheduleStatus,
    workerId: string,
    now: Date
  ): Omit<RuntimeTickResult, "action"> {
    return {
      schema_version: "0.1",
      mode: schedule.mode,
      base_mode: schedule.baseMode,
      active_work_closed: schedule.activeWorkClosed,
      worker_id: workerId,
      created_at: now.toISOString()
    };
  }

  private async recordTick(result: RuntimeTickResult): Promise<RuntimeTickResult> {
    await writeJsonFileAtomic(runtimeLastTickPath(this.projectRoot), result);
    return result;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function defaultQueueHandlers(projectRoot: string, now: Date): QueueWorkerHandlers {
  return {
    commands: {
      "approval.decide": async (envelope) => {
        const result = await new StateApplier(projectRoot).applyCommand(
          envelope.command
        );
        return { applied_event_ids: result.appliedEventIds };
      },
      "approval.snooze": async (envelope) => {
        const result = await new StateApplier(projectRoot).applyCommand(
          envelope.command
        );
        return { applied_event_ids: result.appliedEventIds };
      },
      "schedule.close_active_work": async (envelope) => {
        const result = await new StateApplier(projectRoot).applyCommand(
          envelope.command
        );
        return { applied_event_ids: result.appliedEventIds };
      }
    },
    items: {
      "agent.run": async (item) => {
        const result = await new TaskRunner(projectRoot, {
          now: () => now
        }).runQueuedAgentItem(item, { date: localDateKey(now) });
        return { ...result };
      },
      "maintenance.run": async (item) => {
        const payloadDate = readString(item.payload?.date);
        const result = await runDailyMaintenance(projectRoot, {
          date: payloadDate,
          now
        });
        return {
          date: result.date,
          daily_report_path: result.daily_report_path,
          cleanup_proposal_path: result.cleanup_proposal_path,
          handoff_count: result.handoff_paths.length
        };
      }
    }
  };
}

function mergeHandlers(
  base: QueueWorkerHandlers,
  overrides: QueueWorkerHandlers | undefined
): QueueWorkerHandlers {
  return {
    commands: {
      ...base.commands,
      ...overrides?.commands
    },
    items: {
      ...base.items,
      ...overrides?.items
    }
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readJsonFile<unknown>(filePath);
    return true;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return false;
    }

    throw error;
  }
}

function maintenanceMarkerPath(projectRoot: string, date: string): string {
  return path.join(
    getKaironPaths(projectRoot).runtimeDir,
    "maintenance-runs",
    `${date}.json`
  );
}

function runtimeLastTickPath(projectRoot: string): string {
  return path.join(getKaironPaths(projectRoot).runtimeDir, "last-tick.json");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
