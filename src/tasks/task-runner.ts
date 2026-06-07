import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CliSessionRunner,
  type CliSessionRunRecord
} from "../agents/cli-session-runner.js";
import type { CommandRunner } from "../agents/command-runner.js";
import {
  AgentDispatcher,
  type AgentSessionAvailability
} from "../agents/dispatcher.js";
import type { InteractiveSessionRunner } from "../agents/interactive-session-runner.js";
import type { CommandAvailabilityChecker } from "../agents/session-host.js";
import type { AgentId } from "../agents/types.js";
import { nextId } from "../core/ids/counter.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  WorkQueue,
  type QueueItem,
  type QueueTestScope,
  type ScheduleMode
} from "../queue/work-queue.js";
import { StateApplier } from "../state/state-applier.js";
import {
  ReviewLoopManager,
  type ReviewLoopState
} from "../review/review-loop-manager.js";

export type CreateTaskRequest = {
  title: string;
  persona: string;
  description?: string;
  capabilities?: string[];
  tags?: string[];
  approvalRequired?: boolean;
  codeProducing?: boolean;
  commitRequested?: boolean;
  priority?: number;
  scheduleMode?: ScheduleMode;
};

export type TaskRecord = {
  schema_version: string;
  id: string;
  title: string;
  status: string;
  version: number;
  persona: string;
  description?: string;
  capabilities: string[];
  tags: string[];
  approval_required: boolean;
  code_producing: boolean;
  commit_requested: boolean;
  priority: number;
  schedule_mode?: ScheduleMode;
  created_at: string;
  updated_at: string;
  last_run_id?: string;
  last_run_status?: string;
};

export type CreateTaskResult = {
  schema_version: string;
  task_id: string;
  task_path: string;
  status: string;
  persona: string;
};

export type RunTaskRequest = {
  taskId: string;
  timeoutMs?: number;
  workerId?: string;
  date?: string;
  allowInteractiveAgents?: boolean;
  availableSessions?: AgentSessionAvailability[];
};

export type RunQueuedTaskRequest = {
  timeoutMs?: number;
  date?: string;
  allowInteractiveAgents?: boolean;
  availableSessions?: AgentSessionAvailability[];
};

export type RunTaskResult = {
  schema_version: string;
  task_id: string;
  queue_item_id: string;
  run_id: string;
  status: CliSessionRunRecord["status"];
  agent: AgentId;
  persona: string;
  dispatch_reason: string;
  runner_metadata_path: string;
  outbox_path: string;
  applied_event_ids: string[];
  review_loop?: TaskReviewLoopSummary;
  command: string;
  command_available: boolean;
};

export type TaskReviewLoopSummary = NonNullable<CliSessionRunRecord["review_loop"]> & {
  next_review_queue_item_id?: string;
};

type ReviewFixContext = {
  loop: ReviewLoopState;
  instruction_path: string;
};

export class TaskRunner {
  constructor(
    private readonly projectRoot: string,
    private readonly options: {
      commandAvailability?: CommandAvailabilityChecker;
      commandRunner?: CommandRunner;
      interactiveSessionRunner?: InteractiveSessionRunner;
      now?: () => Date;
    } = {}
  ) {}

  async createTask(request: CreateTaskRequest): Promise<CreateTaskResult> {
    const taskId = await nextId(this.projectRoot, "task");
    const now = this.now().toISOString();
    const task: TaskRecord = {
      schema_version: "0.1",
      id: taskId,
      title: request.title,
      status: "ready",
      version: 1,
      persona: request.persona,
      description: request.description,
      capabilities: uniqueStrings(request.capabilities),
      tags: uniqueStrings(request.tags),
      approval_required: request.approvalRequired ?? false,
      code_producing: request.codeProducing ?? false,
      commit_requested: request.commitRequested ?? false,
      priority: request.priority ?? 50,
      schedule_mode: request.scheduleMode,
      created_at: now,
      updated_at: now
    };

    await new StateApplier(this.projectRoot).appendEvent({
      type: "task.created",
      task_id: taskId,
      actor: "kairon.task",
      payload: { task },
      created_at: now
    });

    return {
      schema_version: "0.1",
      task_id: taskId,
      task_path: toProjectPath(this.projectRoot, taskPath(this.projectRoot, taskId)),
      status: task.status,
      persona: task.persona
    };
  }

  async runTask(request: RunTaskRequest): Promise<RunTaskResult> {
    assertTaskId(request.taskId);
    const task = await readJsonFile<TaskRecord>(taskPath(this.projectRoot, request.taskId));
    const queue = new WorkQueue(this.projectRoot);
    const now = this.now();
    const queueItem = await queue.enqueue({
      type: "agent.run",
      task_id: request.taskId,
      priority: task.priority,
      schedule_mode: task.schedule_mode,
      test_scope: buildTestScope(task.tags, now),
      created_at: now.toISOString(),
      payload: {
        persona: task.persona,
        capabilities: task.capabilities,
        tags: task.tags,
        allow_interactive_agents: request.allowInteractiveAgents,
        code_producing: task.code_producing,
        commit_requested: task.commit_requested,
        approval_required: task.approval_required,
        timeout_ms: request.timeoutMs
      }
    });
    const claimed = await queue.claimById(
      queueItem.id,
      request.workerId ?? "task-runner"
    );

    if (claimed === null) {
      throw new Error(`Unable to claim queued task run: ${queueItem.id}`);
    }

    try {
      const result = await this.processAgentRun(claimed, task, request);
      await queue.complete(queueItem.id, {
        run_id: result.run_id,
        status: result.status,
        agent: result.agent,
        outbox_path: result.outbox_path,
        applied_event_ids: result.applied_event_ids
      });
      return result;
    } catch (error) {
      await queue.fail(queueItem.id, { message: String(error) });
      throw error;
    }
  }

  async runQueuedAgentItem(
    item: QueueItem,
    request: RunQueuedTaskRequest = {}
  ): Promise<RunTaskResult> {
    if (item.type !== "agent.run") {
      throw new Error(`Unsupported queued task item: ${item.type}`);
    }
    if (item.task_id === undefined) {
      throw new Error("Queued agent.run item is missing task_id.");
    }

    assertTaskId(item.task_id);
    const task = await readJsonFile<TaskRecord>(taskPath(this.projectRoot, item.task_id));
    return this.processAgentRun(item, task, {
      taskId: item.task_id,
      timeoutMs: request.timeoutMs,
      date: request.date,
      allowInteractiveAgents: request.allowInteractiveAgents,
      availableSessions: request.availableSessions
    });
  }

  private async processAgentRun(
    item: QueueItem,
    task: TaskRecord,
    request: RunTaskRequest
  ): Promise<RunTaskResult> {
    const payload = item.payload ?? {};
    const reviewFix = await this.loadReviewFixContext(item, payload);
    const persona = readString(payload.persona) ?? task.persona;
    const capabilities = readStringArray(payload.capabilities) ?? task.capabilities;
    const tags = readStringArray(payload.tags) ?? task.tags;
    const codeProducing =
      readBoolean(payload.code_producing) ?? task.code_producing;
    const commitRequested =
      readBoolean(payload.commit_requested) ?? task.commit_requested;
    const allowInteractiveAgents =
      readBoolean(payload.allow_interactive_agents) ??
      request.allowInteractiveAgents ??
      this.options.interactiveSessionRunner !== undefined;
    const timeoutMs = request.timeoutMs ?? readNumber(payload.timeout_ms);
    const decision = await new AgentDispatcher(this.projectRoot).decide({
      taskId: task.id,
      persona,
      requiredCapabilities: capabilities,
      tags,
      allowInteractiveAgents,
      availableSessions: request.availableSessions,
      policy:
        reviewFix === undefined
          ? undefined
          : { allowedAgents: [reviewFix.loop.implementer] }
    });
    const runId = await nextId(this.projectRoot, "run");
    const record = await new CliSessionRunner(this.projectRoot, {
      commandAvailability: this.options.commandAvailability,
      commandRunner: this.options.commandRunner,
      interactiveSessionRunner: this.options.interactiveSessionRunner,
      now: this.options.now
    }).runAgentJob({
      agent: decision.agent,
      date: request.date ?? localDateKey(this.now()),
      runId,
      taskId: task.id,
      persona,
      timeoutMs,
      capabilities,
      extraSources:
        reviewFix === undefined ? undefined : [reviewFix.instruction_path],
      tags,
      codeProducing: reviewFix === undefined ? codeProducing : false,
      commitRequested: reviewFix === undefined ? commitRequested : false
    });
    const outboxPath = record.outbox_path ?? toProjectPath(this.projectRoot, runOutboxPath(this.projectRoot, runId));
    const applied =
      record.outbox_path === undefined
        ? { appliedEventIds: [] }
        : await new StateApplier(this.projectRoot).applyOutbox(
            resolveInside(this.projectRoot, record.outbox_path)
          );

    const reviewLoop = await this.completeReviewFix(reviewFix, record);

    return {
      schema_version: "0.1",
      task_id: task.id,
      queue_item_id: item.id,
      run_id: runId,
      status: record.status,
      agent: decision.agent,
      persona,
      dispatch_reason: decision.reason,
      runner_metadata_path: record.runner_metadata_path,
      outbox_path: outboxPath,
      applied_event_ids: applied.appliedEventIds,
      review_loop: reviewLoop ?? record.review_loop,
      command: record.command,
      command_available: record.command_available
    };
  }

  private async loadReviewFixContext(
    item: QueueItem,
    payload: Record<string, unknown>
  ): Promise<ReviewFixContext | undefined> {
    if (payload.purpose !== "review_fix") {
      return undefined;
    }

    const loopId = readString(payload.review_loop_id);
    if (loopId === undefined) {
      throw new Error("review_fix queue item is missing review_loop_id.");
    }

    const manager = new ReviewLoopManager(this.projectRoot);
    const loop = await manager.loadLoopState(loopId);
    if (item.task_id !== loop.task_id) {
      throw new Error(
        `review_fix queue item task_id does not match review loop ${loopId}.`
      );
    }

    return {
      loop,
      instruction_path: await this.writeReviewFixInstruction(loop, payload)
    };
  }

  private async writeReviewFixInstruction(
    loop: ReviewLoopState,
    payload: Record<string, unknown>
  ): Promise<string> {
    const iteration = readNumber(payload.iteration) ?? loop.iteration;
    const reasons = readStringArray(payload.reasons) ?? [];
    const instructionPath = resolveInside(
      getKaironPaths(this.projectRoot).kaironDir,
      "reviews",
      "loops",
      `${loop.loop_id}-fix-${iteration}.md`
    );
    const content = [
      "# Kairon Review Fix Request",
      "",
      `Loop: ${loop.loop_id}`,
      `Task: ${loop.task_id}`,
      `Iteration: ${iteration}`,
      `Implementer: ${loop.implementer}`,
      "",
      "Resolve the review findings below, then write the normal Kairon outbox.",
      "Do not create or update review loop state directly; Kairon will record the fix run and queue the next review.",
      "",
      "Review reasons:",
      ...(reasons.length === 0 ? ["- No detailed reasons were provided."] : reasons.map((reason) => `- ${reason}`)),
      ""
    ].join("\n");

    await mkdir(path.dirname(instructionPath), { recursive: true });
    await writeFile(instructionPath, content, "utf8");
    return toProjectPath(this.projectRoot, instructionPath);
  }

  private async completeReviewFix(
    reviewFix: ReviewFixContext | undefined,
    record: CliSessionRunRecord
  ): Promise<TaskReviewLoopSummary | undefined> {
    if (reviewFix === undefined || record.run_id === undefined) {
      return undefined;
    }

    const update = await new ReviewLoopManager(this.projectRoot).recordFixRun({
      loopId: reviewFix.loop.loop_id,
      runId: record.run_id,
      status: record.status
    });

    return {
      loop_id: update.state.loop_id,
      status: update.state.status,
      reviewers: update.state.reviewers,
      integration: update.state.integration,
      next_review_queue_item_id: update.next_review_queue_item_id
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function formatCreateTaskResult(result: CreateTaskResult): string {
  return [
    "Kairon task created.",
    `task_id=${result.task_id}`,
    `task_path=${result.task_path}`,
    `status=${result.status}`,
    `persona=${result.persona}`
  ].join("\n");
}

export function formatRunTaskResult(result: RunTaskResult): string {
  return [
    taskRunHeadline(result.status),
    `task_id=${result.task_id}`,
    `queue_item_id=${result.queue_item_id}`,
    `run_id=${result.run_id}`,
    `agent=${result.agent}`,
    `persona=${result.persona}`,
    `status=${result.status}`,
    `command=${result.command}`,
    `command_available=${result.command_available}`,
    `runner=${result.runner_metadata_path}`,
    `outbox=${result.outbox_path}`,
    `applied_events=${result.applied_event_ids.length}`,
    result.review_loop === undefined ? null : `review_loop=${result.review_loop.loop_id}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function taskRunHeadline(status: CliSessionRunRecord["status"]): string {
  if (status === "completed") {
    return "Kairon task run completed.";
  }

  if (status === "setup_required") {
    return "Kairon task run setup required.";
  }

  if (status === "permission_required") {
    return "Kairon task run permission required.";
  }

  if (status === "rate_limited") {
    return "Kairon task run rate limited.";
  }

  if (status === "timeout") {
    return "Kairon task run timed out.";
  }

  if (status === "no_output") {
    return "Kairon task run produced no output.";
  }

  return "Kairon task run failed.";
}

function taskPath(projectRoot: string, taskId: string): string {
  return resolveInside(getKaironPaths(projectRoot).tasksDir, taskId, "task.json");
}

function runOutboxPath(projectRoot: string, runId: string): string {
  return resolveInside(getKaironPaths(projectRoot).runsDir, runId, "outbox.json");
}

function assertTaskId(taskId: string): void {
  if (!/^TASK-\d{4}$/.test(taskId)) {
    throw new Error("Invalid task id. Expected format: TASK-0001.");
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].filter((value) => value.length > 0);
}

function buildTestScope(tags: string[], now: Date): QueueTestScope | undefined {
  const matchedTags = tags.filter((tag) => tag === "operation-test" || tag === "manual-test");
  if (matchedTags.length === 0) {
    return undefined;
  }

  return {
    kind: matchedTags.includes("manual-test") ? "manual_test" : "operation_test",
    tags: matchedTags,
    expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  };
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
