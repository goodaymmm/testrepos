import path from "node:path";
import { mkdir } from "node:fs/promises";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import {
  type ResourceLockHandle,
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import type { KaironEvent } from "../core/events/event-types.js";
import { recordApprovalFollowUp } from "../approvals/follow-up-runner.js";
import { ensureApprovalCorrelation } from "../correlation/store.js";
import { handleGitPushApprovalDecision } from "../git/transaction-approval.js";

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
    case "approval.confirmation_requested":
      await materializeApprovalConfirmationRequested(projectRoot, event);
      return;
    case "approval.decided":
      await materializeApprovalDecided(projectRoot, event);
      return;
    case "approval.snoozed":
      await materializeApprovalSnoozed(projectRoot, event);
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
  const taskPath = resolveInside(taskDir, "task.json");

  await withStateResourceLock(projectRoot, taskPath, async (lock) => {
    await writeJsonFileFenced(lock, taskPath, {
      schema_version: "0.1",
      id,
      status: "ready",
      version: 1,
      created_at: event.created_at,
      updated_at: event.created_at,
      ...task
    });
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
  await withStateResourceLock(projectRoot, approvalPath, async (lock) => {
    await writeJsonFileFenced(lock, approvalPath, {
      schema_version: "0.1",
      id,
      status: "pending",
      created_at: event.created_at,
      updated_at: event.created_at,
      ...approval
    });
  });
  await ensureApprovalCorrelation(projectRoot, {
    ...approval,
    id,
    status: "pending",
    created_at: event.created_at,
    updated_at: event.created_at
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

  let updated: Record<string, unknown>;

  await withStateResourceLock(projectRoot, approvalPath, async (lock) => {
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

    updated = {
      ...current,
      status: "decided",
      decision: event.payload?.decision,
      reason: event.payload?.reason,
      decided_by: event.payload?.actor,
      decided_at: event.created_at,
      confirmation: isRecord(current.confirmation)
        ? {
            ...current.confirmation,
            status: "confirmed",
            confirmed_at: event.created_at
          }
        : current.confirmation,
      updated_at: event.created_at
    };
    await writeJsonFileFenced(lock, approvalPath, updated);
  });

  await ensureApprovalCorrelation(projectRoot, updated!);

  if (
    event.payload?.decision === "approve" ||
    event.payload?.decision === "reject" ||
    event.payload?.decision === "request_changes"
  ) {
    await recordApprovalFollowUp(projectRoot, {
      approval: updated!,
      decision: event.payload.decision,
      decidedAt: event.created_at,
      reason: readString(event.payload.reason)
    });
    await handleGitPushApprovalDecision(projectRoot, updated!, {
      decision: event.payload.decision,
      decidedAt: event.created_at
    });
  }
}

async function materializeApprovalConfirmationRequested(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const approvalId = String(event.payload?.approval_id);

  if (!approvalId || approvalId === "undefined") {
    throw new Error("approval.confirmation_requested requires approval id");
  }

  const approvalPath = path.join(
    getKaironPaths(projectRoot).approvalsDir,
    `${approvalId}.json`
  );

  let updated: Record<string, unknown>;
  await withStateResourceLock(projectRoot, approvalPath, async (lock) => {
    let current: Record<string, unknown> = {
      schema_version: "0.1",
      id: approvalId,
      created_at: event.created_at
    };

    try {
      current = await readJsonFile<Record<string, unknown>>(approvalPath);
    } catch {
      // A missing file is materialized as a minimal confirmation-required approval.
    }

    updated = {
      ...current,
      status: "confirmation_required",
      confirmation: {
        status: "required",
        action: event.payload?.action,
        required_by: event.payload?.confirmation,
        reason: event.payload?.reason,
        source: "discord",
        requested_by: event.payload?.actor,
        requested_at: event.created_at,
        discord: event.payload?.discord
      },
      updated_at: event.created_at
    };
    await writeJsonFileFenced(lock, approvalPath, updated);
  });
  await ensureApprovalCorrelation(projectRoot, updated!);
}

async function materializeApprovalSnoozed(
  projectRoot: string,
  event: KaironEvent
): Promise<void> {
  const approvalId = String(event.payload?.approval_id);

  if (!approvalId || approvalId === "undefined") {
    throw new Error("approval.snoozed requires approval id");
  }

  const approvalPath = path.join(
    getKaironPaths(projectRoot).approvalsDir,
    `${approvalId}.json`
  );

  let updated: Record<string, unknown>;

  await withStateResourceLock(projectRoot, approvalPath, async (lock) => {
    let current: Record<string, unknown> = {
      schema_version: "0.1",
      id: approvalId,
      created_at: event.created_at
    };

    try {
      current = await readJsonFile<Record<string, unknown>>(approvalPath);
    } catch {
      // A missing file is materialized as a minimal snoozed approval for recovery.
    }

    updated = {
      ...current,
      status: "snoozed",
      snooze_until: event.payload?.until,
      reason: event.payload?.reason,
      snoozed_by: event.payload?.actor,
      snoozed_at: event.created_at,
      updated_at: event.created_at
    };
    await writeJsonFileFenced(lock, approvalPath, updated);
  });

  await ensureApprovalCorrelation(projectRoot, updated!);

  await recordApprovalFollowUp(projectRoot, {
    approval: updated!,
    decision: "snooze",
    decidedAt: event.created_at,
    reason: readString(event.payload?.reason),
    dueAt: readString(event.payload?.until)
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
    await withStateResourceLock(projectRoot, taskPath, async (lock) => {
      const current = await readJsonFile<Record<string, unknown>>(taskPath);
      const status = event.payload?.status === "completed" ? "completed" : "failed";
      await writeJsonFileFenced(lock, taskPath, {
        ...current,
        status,
        last_run_id: event.run_id,
        last_run_status: event.payload?.status,
        updated_at: event.created_at
      });
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
  const overridePath = resolveInside(paths.stateDir, "schedule_override.json");
  await withStateResourceLock(projectRoot, overridePath, async (lock) => {
    await writeJsonFileFenced(lock, overridePath, {
      schema_version: "0.1",
      active_work_closed: true,
      created_at: event.created_at,
      ...(event.payload ?? {})
    });
  });
}

async function withStateResourceLock<T>(
  projectRoot: string,
  resourcePath: string,
  run: (handle: ResourceLockHandle) => Promise<T>
): Promise<T> {
  return withResourceLock(projectRoot, resourcePath, { owner: "state-applier" }, run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
