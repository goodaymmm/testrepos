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
import { createAntigravityPtySessionRunner } from "../agents/pty-session-runner.js";
import { isAgentId } from "../agents/types.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";
import {
  GitTransactionExecutor,
  type ExecuteGitTransactionRequest,
  type GitTransactionRecord,
  type ResumeGitTransactionPushRequest
} from "../git/transaction-executor.js";
import {
  ReviewLoopExecutor,
  type ReviewLoopExecutionRequest,
  type ReviewLoopExecutionResult
} from "../review/review-loop-executor.js";
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
  reviewLoopRunner?: (
    request: ReviewLoopExecutionRequest
  ) => Promise<ReviewLoopExecutionResult>;
  gitTransactionRunner?: (
    request: RuntimeGitTransactionRequest
  ) => Promise<GitTransactionRecord>;
};

export type RuntimeGitTransactionRequest =
  | ExecuteGitTransactionRequest
  | ({ action: "resume_push" } & ResumeGitTransactionPushRequest);

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
      mergeHandlers(
        defaultQueueHandlers(this.projectRoot, now, {
          reviewLoopRunner: this.options.reviewLoopRunner,
          gitTransactionRunner: this.options.gitTransactionRunner
        }),
        this.options.handlers
      )
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

function defaultQueueHandlers(
  projectRoot: string,
  now: Date,
  options: Pick<RuntimeLoopOptions, "reviewLoopRunner" | "gitTransactionRunner"> = {}
): QueueWorkerHandlers {
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
          interactiveSessionRunner: createAntigravityPtySessionRunner(),
          now: () => now
        }).runQueuedAgentItem(item, { date: localDateKey(now) });
        return { ...result };
      },
      "review.run": async (item) => {
        const request = readReviewRunRequest(item.payload);
        const runner =
          options.reviewLoopRunner ??
          ((input: ReviewLoopExecutionRequest) =>
            new ReviewLoopExecutor(projectRoot, {
              interactiveSessionRunner: createAntigravityPtySessionRunner(),
              now: () => now
            }).run(input));
        const result = await runner({
          ...request,
          date: request.date ?? localDateKey(now)
        });
        return summarizeReviewRun(result);
      },
      "git.transaction": async (item) => {
        const request = readGitTransactionRequest(item.task_id, item.payload);
        const runner =
          options.gitTransactionRunner ??
          ((input: RuntimeGitTransactionRequest) => {
            const executor = new GitTransactionExecutor(projectRoot, {
              now: () => now
            });
            return isResumeGitTransactionPushRequest(input)
              ? executor.resumeApprovedPush(input)
              : executor.executeCommit(input);
          });
        const result = await runner(request);
        return summarizeGitTransaction(result);
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}

function readPayloadString(
  payload: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(payload?.[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readPayloadNumber(
  payload: Record<string, unknown> | undefined,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = readNumber(payload?.[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readPayloadBoolean(
  payload: Record<string, unknown> | undefined,
  keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = readBoolean(payload?.[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readPayloadStringArray(
  payload: Record<string, unknown> | undefined,
  keys: string[]
): string[] | undefined {
  for (const key of keys) {
    const value = readStringArray(payload?.[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readReviewRunRequest(
  payload: Record<string, unknown> | undefined
): ReviewLoopExecutionRequest {
  const loopId = readPayloadString(payload, ["loop_id", "loopId"]);
  if (loopId === undefined) {
    throw new Error("review.run payload is missing loop_id.");
  }

  return {
    loopId,
    date: readPayloadString(payload, ["date"]),
    timeoutMs: readPayloadNumber(payload, ["timeout_ms", "timeoutMs"])
  };
}

function readGitTransactionRequest(
  itemTaskId: string | undefined,
  payload: Record<string, unknown> | undefined
): RuntimeGitTransactionRequest {
  const action = readPayloadString(payload, ["action"]) ?? "commit";
  if (["resume_push", "push"].includes(action)) {
    const transactionId = readPayloadString(payload, [
      "transaction_id",
      "transactionId"
    ]);
    if (transactionId === undefined) {
      throw new Error("git.transaction resume_push payload is missing transaction_id.");
    }

    return {
      action: "resume_push",
      transactionId,
      approvalId: readPayloadString(payload, ["approval_id", "approvalId"]),
      expectedHeadSha: readPayloadString(payload, [
        "expected_head_sha",
        "expectedHeadSha"
      ]),
      remote: readPayloadString(payload, ["remote"]),
      remoteRef: readPayloadString(payload, ["remote_ref", "remoteRef"])
    };
  }

  if (!["commit", "execute_commit"].includes(action)) {
    throw new Error(`Unsupported git.transaction action: ${action}`);
  }

  const taskId =
    itemTaskId ?? readPayloadString(payload, ["task_id", "taskId"]);
  const runId = readPayloadString(payload, ["run_id", "runId"]);
  const agent = readPayloadString(payload, ["agent"]);
  const reviewLoopId = readPayloadString(payload, [
    "review_loop_id",
    "reviewLoopId"
  ]);

  if (taskId === undefined) {
    throw new Error("git.transaction item is missing task_id.");
  }
  if (runId === undefined) {
    throw new Error("git.transaction payload is missing run_id.");
  }
  if (agent === undefined || !isAgentId(agent)) {
    throw new Error("git.transaction payload is missing a valid agent.");
  }
  if (reviewLoopId === undefined) {
    throw new Error("git.transaction payload is missing review_loop_id.");
  }

  return {
    taskId,
    runId,
    agent,
    reviewLoopId,
    branch: readPayloadString(payload, ["branch"]),
    baseBranch: readPayloadString(payload, ["base_branch", "baseBranch"]),
    baseSha: readPayloadString(payload, ["base_sha", "baseSha"]),
    writePaths: readPayloadStringArray(payload, ["write_paths", "writePaths"]),
    commitMessage: readPayloadString(payload, ["commit_message", "commitMessage"]),
    pushRequested: readPayloadBoolean(payload, [
      "push_requested",
      "pushRequested"
    ]),
    pushTargetBranch: readPayloadString(payload, [
      "push_target_branch",
      "pushTargetBranch"
    ])
  };
}

function isResumeGitTransactionPushRequest(
  request: RuntimeGitTransactionRequest
): request is { action: "resume_push" } & ResumeGitTransactionPushRequest {
  return "action" in request && request.action === "resume_push";
}

function summarizeReviewRun(
  result: ReviewLoopExecutionResult
): Record<string, unknown> {
  return {
    loop_id: result.loop_id,
    status: result.status,
    iteration: result.iteration,
    decision: result.decision.status,
    next_action: result.next_action.action,
    review_run_ids: result.review_run_ids,
    review_result_ids: result.review_result_ids,
    iteration_path: result.iteration_path
  };
}

function summarizeGitTransaction(
  record: GitTransactionRecord
): Record<string, unknown> {
  return {
    transaction_id: record.transaction_id,
    task_id: record.task_id,
    run_id: record.run_id,
    review_loop_id: record.review_loop_id,
    status: record.status,
    branch: record.branch,
    commit_sha: record.commit_sha,
    push: record.push,
    transaction_path: record.transaction_path
  };
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
