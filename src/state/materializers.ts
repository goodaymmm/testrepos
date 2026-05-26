import path from "node:path";
import { mkdir } from "node:fs/promises";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import type { KaironEvent } from "../core/events/event-types.js";

export async function materializeEvent(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  switch (event.type) {
    case "task.created":
      await materializeTaskCreated(projectRoot, event);
      return;
    case "message.created":
      await materializeMessageCreated(projectRoot, event);
      return;
    case "approval.requested":
      await materializeApprovalRequested(projectRoot, event);
      return;
    case "approval.decided":
      await materializeApprovalDecided(projectRoot, event);
      return;
    case "run.completed":
      await materializeRunCompleted(projectRoot, event);
      return;
    case "schedule.override.created":
      await materializeScheduleOverride(projectRoot, event);
      return;
    default:
      return;
  }
}

async function materializeTaskCreated(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const task = (event.payload?.task ?? event.payload ?? {}) as Record<string, unknown>;
  const id = String(task.id ?? event.task_id);

  if (!id || id === "undefined") {
    throw new Error("task.created requires task id");
  }

  const paths = getKaironPaths(projectRoot);
  const taskDir = resolveInside(paths.tasksDir, id);
  await mkdir(taskDir, { recursive: true });

  await writeJsonFileAtomic(resolveInside(taskDir, "task.json"), {
    schema_version: "0.1",
    id,
    status: "ready",
    version: 1,
    created_at: event.created_at,
    updated_at: event.created_at,
    ...task
  });
}

async function materializeMessageCreated(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const taskId = String(event.task_id ?? event.payload?.task_id);

  if (!taskId || taskId === "undefined") {
    throw new Error("message.created requires task id");
  }

  const messagePath = path.join(getKaironPaths(projectRoot).messagesDir, `${taskId}.jsonl`);
  await appendJsonLine(messagePath, {
    schema_version: "0.1",
    event_id: event.event_id,
    task_id: taskId,
    created_at: event.created_at,
    ...(event.payload ?? {})
  });
}

async function materializeApprovalRequested(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const approval = (event.payload?.approval ?? event.payload ?? {}) as Record<
    string,
    unknown
  >;
  const id = String(approval.id ?? approval.approval_id);

  if (!id || id === "undefined") {
    throw new Error("approval.requested requires approval id");
  }

  const approvalPath = path.join(getKaironPaths(projectRoot).approvalsDir, `${id}.json`);
  await writeJsonFileAtomic(approvalPath, {
    schema_version: "0.1",
    id,
    status: "pending",
    created_at: event.created_at,
    updated_at: event.created_at,
    ...approval
  });
}

async function materializeApprovalDecided(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const approvalId = String(event.payload?.approval_id);

  if (!approvalId || approvalId === "undefined") {
    throw new Error("approval.decided requires approval id");
  }

  const approvalPath = path.join(
    getKaironPaths(projectRoot).approvalsDir,
    `${approvalId}.json`
  );

  let current: Record<string, unknown> = {
    schema_version: "0.1",
    id: approvalId,
    created_at: event.created_at
  };

  try {
    current = await readJsonFile<Record<string, unknown>>(approvalPath);
  } catch {
    // A missing file is materialized as a minimal decided approval for recovery.
  }

  await writeJsonFileAtomic(approvalPath, {
    ...current,
    status: "decided",
    decision: event.payload?.decision,
    reason: event.payload?.reason,
    decided_by: event.payload?.actor,
    decided_at: event.created_at,
    updated_at: event.created_at
  });
}

async function materializeRunCompleted(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const taskId = String(event.task_id ?? event.payload?.task_id);

  if (!taskId || taskId === "undefined") {
    return;
  }

  const taskPath = resolveInside(getKaironPaths(projectRoot).tasksDir, taskId, "task.json");

  try {
    const current = await readJsonFile<Record<string, unknown>>(taskPath);
    const status = event.payload?.status === "completed" ? "completed" : "failed";
    await writeJsonFileAtomic(taskPath, {
      ...current,
      status,
      last_run_id: event.run_id,
      last_run_status: event.payload?.status,
      updated_at: event.created_at
    });
  } catch (error) {
    if (!String(error).includes("ENOENT")) {
      throw error;
    }
  }
}

async function materializeScheduleOverride(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const paths = getKaironPaths(projectRoot);
  await writeJsonFileAtomic(resolveInside(paths.stateDir, "schedule_override.json"), {
    schema_version: "0.1",
    active_work_closed: true,
    created_at: event.created_at,
    ...(event.payload ?? {})
  });
}
