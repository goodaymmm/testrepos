import { readdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../core/events/event-log.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import {
  buildExecutionPreflight,
  type ExecutionGuardPreflight
} from "../deploy/execution-guard.js";
import { type QueueItem, WorkQueue } from "../queue/work-queue.js";
import { acquireStateLock, releaseStateLock } from "../state/state-lock.js";

export type ApprovalFollowUpDecision =
  | "approve"
  | "reject"
  | "request_changes"
  | "snooze";

export type ApprovalFollowUpStatus =
  | "pending"
  | "snoozed"
  | "not_required"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type ApprovalFollowUpExecutionRecord = {
  attempt: number;
  mode: "execute";
  status: Exclude<ApprovalFollowUpStatus, "pending" | "snoozed" | "not_required">;
  started_at: string;
  finished_at?: string;
  execution_performed: boolean;
  summary: string;
  queue_item_id?: string;
  details?: Record<string, unknown>;
};

export type ApprovalFollowUpArtifact = {
  schema_version: "0.1";
  artifact_kind: "approval_follow_up";
  id: string;
  idempotency_key: string;
  approval_id: string;
  approval_type?: string;
  decision: ApprovalFollowUpDecision;
  action_type: string;
  status: ApprovalFollowUpStatus;
  risk_level: "high" | "medium" | "low";
  task_id?: string;
  run_id?: string;
  transaction_id?: string;
  queue_item_type?: string;
  queue_payload_preview?: Record<string, unknown>;
  queue_item_id?: string;
  command_hint: string;
  reason?: string;
  due_at?: string;
  attempts?: number;
  last_execution?: ApprovalFollowUpExecutionRecord;
  execution_history?: ApprovalFollowUpExecutionRecord[];
  completed_at?: string;
  failed_at?: string;
  skipped_at?: string;
  error?: { code: string; message: string };
  source_approval_path: string;
  created_at: string;
  updated_at: string;
};

export type RecordApprovalFollowUpInput = {
  approval: Record<string, unknown>;
  decision: ApprovalFollowUpDecision;
  decidedAt: string;
  reason?: string;
  dueAt?: string;
};

export type ApprovalFollowUpListOptions = {
  status?: string;
};

export type ApprovalFollowUpRunOptions = {
  dryRun?: boolean;
  confirm?: string;
  now?: () => Date;
};

export type ApprovalFollowUpRunResult = {
  schema_version: "0.1";
  follow_up_id: string;
  approval_id: string;
  action_type: string;
  mode: "dry_run" | "execute";
  status: "planned" | ApprovalFollowUpStatus;
  supported: boolean;
  readiness: "ready" | "passed" | "failed" | "not_applicable";
  confirmation_required: boolean;
  execution_performed: boolean;
  idempotent: boolean;
  queue_item_id?: string;
  details?: Record<string, unknown>;
  event_id?: string;
};

type ApprovalFollowUpPlan = {
  action_type: string;
  status: ApprovalFollowUpStatus;
  risk_level: "high" | "medium" | "low";
  queue_item_type?: string;
  queue_payload_preview?: Record<string, unknown>;
  command_hint: string;
};

type FollowUpExecutionPlan = {
  supported: boolean;
  readiness: ApprovalFollowUpRunResult["readiness"];
  confirmation_required: boolean;
  executor: "git_resume_queue" | "merge_preflight" | "deploy_preflight" | "manual";
  queueItem?: QueueItem;
  preflight?: ExecutionGuardPreflight;
  details: Record<string, unknown>;
};

type FollowUpExecutionOutcome = {
  status: "running" | "completed" | "failed" | "skipped";
  executionPerformed: boolean;
  summary: string;
  queueItemId?: string;
  details?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export class ApprovalFollowUpNotFoundError extends Error {
  constructor(readonly followUpId: string) {
    super(`Approval follow-up not found: ${followUpId}`);
    this.name = "ApprovalFollowUpNotFoundError";
  }
}

export class ApprovalFollowUpConfirmationError extends Error {
  constructor(readonly followUpId: string) {
    super(`Follow-up confirmation does not match. Expected --confirm ${followUpId}.`);
    this.name = "ApprovalFollowUpConfirmationError";
  }
}

export async function recordApprovalFollowUp(
  projectRoot: string,
  input: RecordApprovalFollowUpInput
): Promise<ApprovalFollowUpArtifact> {
  const approvalId = readString(input.approval.id ?? input.approval.approval_id);
  if (approvalId === undefined) {
    throw new Error("Approval follow-up requires approval id.");
  }

  const approvalType = readString(input.approval.type);
  const plan = planApprovalFollowUp(input.approval, input.decision);
  const idempotencyKey = `${approvalId}:${input.decision}:${plan.action_type}`;
  const id = `FUP-${safeId(approvalId)}-${safeId(input.decision)}-${safeId(plan.action_type)}`;
  const followUpPath = approvalFollowUpPath(projectRoot, id);
  const existing = await readExistingFollowUp(followUpPath);
  const createdAt = existing?.created_at ?? input.decidedAt;
  const preserveExecution =
    existing?.idempotency_key === idempotencyKey &&
    ["running", "completed", "failed", "skipped"].includes(existing.status);
  const artifact: ApprovalFollowUpArtifact = {
    ...(preserveExecution ? existing : {}),
    schema_version: "0.1",
    artifact_kind: "approval_follow_up",
    id,
    idempotency_key: idempotencyKey,
    approval_id: approvalId,
    approval_type: approvalType,
    decision: input.decision,
    action_type: plan.action_type,
    status: preserveExecution ? existing!.status : plan.status,
    risk_level: plan.risk_level,
    task_id: readString(input.approval.task_id),
    run_id: readString(input.approval.run_id),
    transaction_id: readString(input.approval.transaction_id),
    queue_item_type: plan.queue_item_type,
    queue_payload_preview: sanitizeMetadata(plan.queue_payload_preview),
    command_hint: sanitizeInline(plan.command_hint),
    reason: sanitizeOptional(input.reason ?? readString(input.approval.reason)),
    due_at: input.dueAt,
    source_approval_path: toProjectPath(
      projectRoot,
      path.join(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
    ),
    created_at: createdAt,
    updated_at: input.decidedAt
  };

  await writeJsonFileAtomic(followUpPath, artifact);
  return artifact;
}

export async function listApprovalFollowUps(
  projectRoot: string,
  options: ApprovalFollowUpListOptions = {}
): Promise<ApprovalFollowUpArtifact[]> {
  const dir = approvalFollowUpsDir(projectRoot);
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJsonFile<ApprovalFollowUpArtifact>(resolveInside(dir, entry)))
  );

  return artifacts
    .filter((artifact) => artifact.artifact_kind === "approval_follow_up")
    .filter(
      (artifact) => options.status === undefined || artifact.status === options.status
    )
    .sort(compareFollowUpsDesc);
}

export async function showApprovalFollowUp(
  projectRoot: string,
  followUpId: string
): Promise<ApprovalFollowUpArtifact> {
  assertFollowUpId(followUpId);
  try {
    return await readJsonFile<ApprovalFollowUpArtifact>(
      approvalFollowUpPath(projectRoot, followUpId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      throw new ApprovalFollowUpNotFoundError(followUpId);
    }
    throw error;
  }
}

export async function runApprovalFollowUp(
  projectRoot: string,
  followUpId: string,
  options: ApprovalFollowUpRunOptions = {}
): Promise<ApprovalFollowUpRunResult> {
  if (options.dryRun === true && options.confirm !== undefined) {
    throw new Error("Use either --dry-run or --confirm, not both.");
  }
  if (options.dryRun !== true && options.confirm === undefined) {
    throw new Error(`Follow-up run requires --dry-run or --confirm ${followUpId}.`);
  }

  const artifact = await showApprovalFollowUp(projectRoot, followUpId);
  if (options.dryRun === true) {
    const plan = await buildFollowUpExecutionPlan(projectRoot, artifact);
    return runResultFromPlan(artifact, plan);
  }
  if (options.confirm !== followUpId) {
    throw new ApprovalFollowUpConfirmationError(followUpId);
  }

  const now = options.now?.() ?? new Date();
  const followUpPath = approvalFollowUpPath(projectRoot, followUpId);
  const execution = await withResourceLock(
    projectRoot,
    followUpPath,
    { owner: "approval-follow-up-runner", now },
    async (lock) => {
      const current = await readJsonFile<ApprovalFollowUpArtifact>(followUpPath);
      if (current.status === "completed" || current.status === "skipped") {
        return {
          changed: false,
          artifact: current,
          result: runResultFromArtifact(current, true)
        };
      }

      const attempt = (current.attempts ?? 0) + 1;
      const startedAt = now.toISOString();
      const plan = await buildFollowUpExecutionPlan(projectRoot, current);
      const running: ApprovalFollowUpArtifact = {
        ...current,
        status: plan.supported ? "running" : current.status,
        attempts: attempt,
        updated_at: startedAt
      };
      if (plan.supported) {
        await writeJsonFileFenced(lock, followUpPath, running);
      }

      let outcome: FollowUpExecutionOutcome;
      try {
        outcome = await executeFollowUpPlan(projectRoot, current, plan, now);
      } catch (error) {
        outcome = {
          status: "failed",
          executionPerformed: false,
          summary: "Follow-up execution failed.",
          error: {
            code: "follow_up_execution_failed",
            message: sanitizeInline(String(error))
          }
        };
      }

      const finishedAt = (options.now?.() ?? new Date()).toISOString();
      const record: ApprovalFollowUpExecutionRecord = {
        attempt,
        mode: "execute",
        status: outcome.status,
        started_at: startedAt,
        finished_at: outcome.status === "running" ? undefined : finishedAt,
        execution_performed: outcome.executionPerformed,
        summary: sanitizeInline(outcome.summary),
        queue_item_id: outcome.queueItemId,
        details: sanitizeMetadata(outcome.details)
      };
      const updated: ApprovalFollowUpArtifact = {
        ...running,
        status: outcome.status,
        queue_item_id: outcome.queueItemId ?? current.queue_item_id,
        attempts: attempt,
        last_execution: record,
        execution_history: [...(current.execution_history ?? []), record].slice(-20),
        completed_at: outcome.status === "completed" ? finishedAt : current.completed_at,
        failed_at: outcome.status === "failed" ? finishedAt : undefined,
        skipped_at: outcome.status === "skipped" ? finishedAt : current.skipped_at,
        error: outcome.error,
        updated_at: finishedAt
      };
      await writeJsonFileFenced(lock, followUpPath, updated);

      return {
        changed: true,
        artifact: updated,
        result: runResultFromArtifact(updated, false)
      };
    }
  );

  if (!execution.changed) {
    return execution.result;
  }

  const eventId = await appendFollowUpEvent(projectRoot, execution.artifact);
  return { ...execution.result, event_id: eventId };
}

export function formatApprovalFollowUpList(
  followUps: ApprovalFollowUpArtifact[]
): string {
  if (followUps.length === 0) {
    return "No approval follow-ups found.";
  }
  return [
    "Kairon approval follow-ups:",
    ...followUps.map((followUp) =>
      [
        `id=${followUp.id}`,
        `status=${followUp.status}`,
        `action=${followUp.action_type}`,
        `risk=${followUp.risk_level}`,
        `approval=${followUp.approval_id}`,
        `attempts=${followUp.attempts ?? 0}`
      ].join(" ")
    )
  ].join("\n");
}

export function formatApprovalFollowUpDetail(
  followUp: ApprovalFollowUpArtifact
): string {
  return [
    "Kairon approval follow-up:",
    `id=${followUp.id}`,
    `status=${followUp.status}`,
    `action=${followUp.action_type}`,
    `risk=${followUp.risk_level}`,
    `approval_id=${followUp.approval_id}`,
    `detail=${JSON.stringify(sanitizeForDisplay(followUp), null, 2)}`
  ].join("\n");
}

export function formatApprovalFollowUpRun(
  result: ApprovalFollowUpRunResult
): string {
  return [
    result.mode === "dry_run"
      ? "Kairon approval follow-up dry-run."
      : "Kairon approval follow-up executed.",
    `follow_up_id=${result.follow_up_id}`,
    `approval_id=${result.approval_id}`,
    `action=${result.action_type}`,
    `mode=${result.mode}`,
    `status=${result.status}`,
    `supported=${result.supported}`,
    `readiness=${result.readiness}`,
    `confirmation_required=${result.confirmation_required}`,
    `execution_performed=${result.execution_performed}`,
    `idempotent=${result.idempotent}`,
    ...(result.queue_item_id === undefined
      ? []
      : [`queue_item_id=${result.queue_item_id}`]),
    ...(result.event_id === undefined ? [] : [`event_id=${result.event_id}`]),
    ...(result.details === undefined
      ? []
      : [`details=${JSON.stringify(sanitizeForDisplay(result.details))}`])
  ].join("\n");
}

export function approvalFollowUpsDir(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "follow-ups");
}

async function buildFollowUpExecutionPlan(
  projectRoot: string,
  artifact: ApprovalFollowUpArtifact
): Promise<FollowUpExecutionPlan> {
  if (artifact.action_type === "git.resume_push") {
    const queueItem = await findGitResumeQueueItem(projectRoot, artifact.approval_id);
    const transactionId = artifact.transaction_id;
    return {
      supported: transactionId !== undefined,
      readiness:
        transactionId === undefined
          ? "failed"
          : queueItem?.status === "completed"
            ? "passed"
            : "ready",
      confirmation_required: true,
      executor: "git_resume_queue",
      queueItem,
      details: compact({
        transaction_id: transactionId,
        queue_item_id: queueItem?.id,
        queue_status: queueItem?.status,
        next_action:
          queueItem === undefined || queueItem.status === "failed"
            ? "Enqueue one approved git transaction resume item."
            : "Reconcile the existing git transaction resume item."
      })
    };
  }

  if (
    artifact.action_type === "merge.execute_preflight" ||
    artifact.action_type === "deploy.execute_preflight"
  ) {
    const operation = artifact.action_type.startsWith("merge.")
      ? "merge"
      : "deploy";
    try {
      const approval = await readSourceApproval(projectRoot, artifact.approval_id);
      const dryRunArtifact = readString(approval.artifact_path);
      if (dryRunArtifact === undefined) {
        throw new Error("Approval does not reference a dry-run artifact.");
      }
      const preflight = await buildExecutionPreflight(projectRoot, {
        operation,
        dryRunArtifact,
        mode: "preflight",
        approvalId: artifact.approval_id
      });
      return {
        supported: true,
        readiness: preflight.status === "passed" ? "passed" : "failed",
        confirmation_required: true,
        executor: operation === "merge" ? "merge_preflight" : "deploy_preflight",
        preflight,
        details: preflightDetails(preflight)
      };
    } catch (error) {
      return {
        supported: true,
        readiness: "failed",
        confirmation_required: true,
        executor: operation === "merge" ? "merge_preflight" : "deploy_preflight",
        details: {
          preflight_status: "failed",
          reason: sanitizeInline(String(error)),
          execution_allowed: false
        }
      };
    }
  }

  return {
    supported: false,
    readiness: "not_applicable",
    confirmation_required: true,
    executor: "manual",
    details: {
      next_action: artifact.command_hint,
      reason: "No automated executor is registered for this follow-up action."
    }
  };
}

async function executeFollowUpPlan(
  projectRoot: string,
  artifact: ApprovalFollowUpArtifact,
  plan: FollowUpExecutionPlan,
  now: Date
): Promise<FollowUpExecutionOutcome> {
  if (!plan.supported || plan.executor === "manual") {
    return {
      status: "skipped",
      executionPerformed: false,
      summary: "Follow-up remains a manual next action.",
      details: plan.details
    };
  }

  if (plan.executor === "git_resume_queue") {
    let queueItem = plan.queueItem;
    let executionPerformed = false;
    if (queueItem === undefined || queueItem.status === "failed") {
      if (artifact.transaction_id === undefined) {
        return {
          status: "failed",
          executionPerformed: false,
          summary: "Git resume queue item cannot be created without transaction id.",
          details: plan.details,
          error: {
            code: "missing_transaction_id",
            message: "Follow-up does not contain transaction_id."
          }
        };
      }
      queueItem = await new WorkQueue(projectRoot).enqueue({
        type: "git.transaction",
        priority: 90,
        task_id: artifact.task_id,
        payload: {
          ...(artifact.queue_payload_preview ?? {}),
          action: "resume_push",
          approved: true,
          approval_decision: "approve",
          transaction_id: artifact.transaction_id,
          approval_id: artifact.approval_id
        },
        created_at: now.toISOString()
      });
      executionPerformed = true;
    }

    return {
      status:
        queueItem.status === "completed"
          ? "completed"
          : queueItem.status === "failed"
            ? "failed"
            : "running",
      executionPerformed,
      summary: `Git resume queue item is ${queueItem.status}.`,
      queueItemId: queueItem.id,
      details: {
        queue_status: queueItem.status,
        transaction_id: artifact.transaction_id,
        execution_scope: "approved_resume_push"
      },
      error:
        queueItem.status === "failed"
          ? {
              code: queueItem.error?.code ?? "git_resume_queue_failed",
              message: sanitizeInline(
                queueItem.error?.message ?? "Git resume queue item failed."
              )
            }
          : undefined
    };
  }

  const passed = plan.preflight?.status === "passed";
  return {
    status: passed ? "completed" : "failed",
    executionPerformed: false,
    summary: passed
      ? "Execution preflight completed; merge or deploy was not executed."
      : "Execution preflight failed; merge or deploy remains blocked.",
    details: plan.details,
    error: passed
      ? undefined
      : {
          code: "execution_preflight_failed",
          message: "One or more execution preflight checks failed."
        }
  };
}

function runResultFromPlan(
  artifact: ApprovalFollowUpArtifact,
  plan: FollowUpExecutionPlan
): ApprovalFollowUpRunResult {
  return {
    schema_version: "0.1",
    follow_up_id: artifact.id,
    approval_id: artifact.approval_id,
    action_type: artifact.action_type,
    mode: "dry_run",
    status: "planned",
    supported: plan.supported,
    readiness: plan.readiness,
    confirmation_required: plan.confirmation_required,
    execution_performed: false,
    idempotent: false,
    queue_item_id: plan.queueItem?.id,
    details: sanitizeMetadata(plan.details)
  };
}

function runResultFromArtifact(
  artifact: ApprovalFollowUpArtifact,
  idempotent: boolean
): ApprovalFollowUpRunResult {
  return {
    schema_version: "0.1",
    follow_up_id: artifact.id,
    approval_id: artifact.approval_id,
    action_type: artifact.action_type,
    mode: "execute",
    status: artifact.status,
    supported: artifact.last_execution?.status !== "skipped",
    readiness:
      artifact.status === "failed"
        ? "failed"
        : artifact.status === "skipped"
          ? "not_applicable"
          : "passed",
    confirmation_required: true,
    execution_performed: artifact.last_execution?.execution_performed ?? false,
    idempotent,
    queue_item_id: artifact.queue_item_id,
    details: artifact.last_execution?.details
  };
}

async function appendFollowUpEvent(
  projectRoot: string,
  artifact: ApprovalFollowUpArtifact
): Promise<string> {
  const lock = await acquireStateLock(projectRoot);
  try {
    const event = await appendEvent(projectRoot, {
      type: "approval.follow_up.updated",
      task_id: artifact.task_id,
      run_id: artifact.run_id,
      actor: "approval-follow-up-runner",
      created_at: artifact.updated_at,
      payload: {
        follow_up_id: artifact.id,
        approval_id: artifact.approval_id,
        action_type: artifact.action_type,
        status: artifact.status,
        attempt: artifact.attempts,
        queue_item_id: artifact.queue_item_id,
        execution_performed: artifact.last_execution?.execution_performed ?? false
      }
    });
    return event.event_id;
  } finally {
    await releaseStateLock(lock);
  }
}

async function findGitResumeQueueItem(
  projectRoot: string,
  approvalId: string
): Promise<QueueItem | undefined> {
  const matches = (await new WorkQueue(projectRoot).list()).filter(
    (item) =>
      item.type === "git.transaction" &&
      item.payload?.action === "resume_push" &&
      item.payload.approval_id === approvalId
  );
  return matches[matches.length - 1];
}

async function readSourceApproval(
  projectRoot: string,
  approvalId: string
): Promise<Record<string, unknown>> {
  return readJsonFile<Record<string, unknown>>(
    resolveInside(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
  );
}

function preflightDetails(
  preflight: ExecutionGuardPreflight
): Record<string, unknown> {
  return {
    preflight_status: preflight.status,
    execution_allowed: false,
    operation: preflight.operation,
    dry_run_artifact_path: preflight.dry_run_artifact_path,
    approval_id: preflight.approval_id,
    checks: preflight.checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: sanitizeInline(check.detail)
    })),
    next_action: preflight.next_action
  };
}

function approvalFollowUpPath(projectRoot: string, followUpId: string): string {
  assertFollowUpId(followUpId);
  return resolveInside(approvalFollowUpsDir(projectRoot), `${followUpId}.json`);
}

async function readExistingFollowUp(
  followUpPath: string
): Promise<ApprovalFollowUpArtifact | null> {
  try {
    return await readJsonFile<ApprovalFollowUpArtifact>(followUpPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function planApprovalFollowUp(
  approval: Record<string, unknown>,
  decision: ApprovalFollowUpDecision
): ApprovalFollowUpPlan {
  const approvalType = readString(approval.type);

  if (decision === "snooze") {
    return {
      action_type: "approval.revisit",
      status: "snoozed",
      risk_level: "low",
      command_hint: "Review the approval again after snooze_until."
    };
  }

  if (decision === "approve" && isGitPushApproval(approvalType)) {
    const transactionId = readString(approval.transaction_id);
    return {
      action_type: "git.resume_push",
      status: "pending",
      risk_level: "high",
      queue_item_type: "git.transaction",
      queue_payload_preview: {
        action: "resume_push",
        transaction_id: transactionId,
        approval_id: readString(approval.id),
        expected_head_sha: readString(approval.expected_head_sha),
        remote: readString(approval.remote),
        remote_ref: readString(approval.remote_ref)
      },
      command_hint:
        transactionId === undefined
          ? "Inspect the git push approval before resuming the transaction."
          : `Resume approved git transaction ${transactionId} through the runtime queue.`
    };
  }

  if (decision === "approve" && isOperationApproval(approvalType, "merge")) {
    return {
      action_type: "merge.execute_preflight",
      status: "pending",
      risk_level: "high",
      command_hint: "Run merge execution preflight before any merge operation."
    };
  }

  if (decision === "approve" && isOperationApproval(approvalType, "deploy")) {
    return {
      action_type: "deploy.execute_preflight",
      status: "pending",
      risk_level: "high",
      command_hint: "Run deploy execution preflight before any deployment operation."
    };
  }

  if (decision === "reject" || decision === "request_changes") {
    return {
      action_type: "approval.rework",
      status: "pending",
      risk_level: "medium",
      command_hint: "Notify the requester, update the related task, and keep dangerous execution blocked."
    };
  }

  return {
    action_type: "approval.review_next_action",
    status: "pending",
    risk_level: "low",
    command_hint: "Review the approval result and decide the next manual action."
  };
}

function isGitPushApproval(approvalType: string | undefined): boolean {
  return approvalType === "git_push" || approvalType === "git_protected_branch_push";
}

function isOperationApproval(
  approvalType: string | undefined,
  operation: "merge" | "deploy"
): boolean {
  return approvalType === operation || approvalType === `${operation}_dry_run`;
}

function compareFollowUpsDesc(
  left: ApprovalFollowUpArtifact,
  right: ApprovalFollowUpArtifact
): number {
  return Date.parse(right.updated_at) - Date.parse(left.updated_at);
}

function sanitizeMetadata(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return sanitizeForDisplay(value) as Record<string, unknown>;
}

function sanitizeForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : sanitizeForDisplay(raw)
      ])
    );
  }
  return typeof value === "string" ? sanitizeInline(value) : value;
}

function sanitizeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeInline(value);
}

function sanitizeInline(value: string): string {
  const collapsed = value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 237)}...`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function assertFollowUpId(followUpId: string): void {
  if (!/^FUP-[A-Za-z0-9][A-Za-z0-9_-]{2,240}$/u.test(followUpId)) {
    throw new Error(`Invalid approval follow-up id: ${followUpId}`);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, raw]) => raw !== undefined)
  ) as T;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

const secretKeyPattern = /(secret|token|password|api[_-]?key|authorization|cookie|credential)/iu;
