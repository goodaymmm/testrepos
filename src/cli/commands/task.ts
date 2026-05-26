import {
  formatCreateTaskResult,
  formatRunTaskResult,
  TaskRunner
} from "../../tasks/task-runner.js";
import type { ScheduleMode } from "../../queue/work-queue.js";

export type CreateTaskCommandOptions = {
  title?: string;
  persona?: string;
  description?: string;
  capability?: string[];
  tag?: string[];
  approvalRequired?: boolean;
  codeProducing?: boolean;
  commitRequested?: boolean;
  priority?: string;
  scheduleMode?: string;
};

export type RunTaskCommandOptions = {
  timeoutMs?: string;
  workerId?: string;
};

export async function createTaskCommand(
  projectRoot: string,
  options: CreateTaskCommandOptions
): Promise<string> {
  if (options.title === undefined || options.title.trim().length === 0) {
    throw new Error("--title is required.");
  }
  if (options.persona === undefined || options.persona.trim().length === 0) {
    throw new Error("--persona is required.");
  }

  const result = await new TaskRunner(projectRoot).createTask({
    title: options.title,
    persona: options.persona,
    description: options.description,
    capabilities: options.capability,
    tags: options.tag,
    approvalRequired: options.approvalRequired,
    codeProducing: options.codeProducing,
    commitRequested: options.commitRequested,
    priority:
      options.priority === undefined
        ? undefined
        : parsePositiveInteger(options.priority, "--priority"),
    scheduleMode:
      options.scheduleMode === undefined
        ? undefined
        : parseScheduleMode(options.scheduleMode)
  });

  return formatCreateTaskResult(result);
}

export async function runTaskCommand(
  projectRoot: string,
  taskId: string,
  options: RunTaskCommandOptions
): Promise<string> {
  const result = await new TaskRunner(projectRoot).runTask({
    taskId,
    timeoutMs:
      options.timeoutMs === undefined
        ? undefined
        : parsePositiveInteger(options.timeoutMs, "--timeout-ms"),
    workerId: options.workerId
  });

  return formatRunTaskResult(result);
}

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseScheduleMode(value: string): ScheduleMode {
  if (["active_work", "standby_work", "maintenance"].includes(value)) {
    return value as ScheduleMode;
  }

  throw new Error("--schedule-mode must be active_work, standby_work, or maintenance.");
}
