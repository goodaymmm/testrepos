import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { ApprovalQueue } from "../approvals/approval-queue.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { WorkQueue, type QueueItem } from "../queue/work-queue.js";
import {
  readRuntimeLockStatus,
  releaseRuntimeLock
} from "../runtime/runtime-lock.js";
import { StateApplier } from "../state/state-applier.js";

export type RuntimeRecoveryOptions = {
  now?: Date;
  claimTimeoutMs?: number;
  runnerStaleMs?: number;
  heartbeatStaleMs?: number;
};

export type RuntimeRecoveryResult = {
  schema_version: "0.1";
  recovery_id: string;
  created_at: string;
  artifact_path: string;
  summary: {
    scanned_queue_items: number;
    scanned_runs: number;
    stale_locks_cleared: number;
    requeued_items: number;
    approvals_requested: number;
    approvals_existing: number;
  };
  actions: RuntimeRecoveryAction[];
};

export type RuntimeRecoveryAction =
  | {
      type: "stale_lock_cleared";
      lock_path: string;
      reason: string;
    }
  | {
      type: "queue_item_requeued";
      item_id: string;
      item_type: string;
      reason: string;
    }
  | {
      type: "approval_requested";
      approval_id: string;
      issue: RuntimeRecoveryIssue;
    }
  | {
      type: "approval_existing";
      approval_id: string;
      issue: RuntimeRecoveryIssue;
    };

export type RuntimeRecoveryIssue = {
  kind:
    | "claimed_timeout"
    | "running_runner"
    | "missing_outbox"
    | "partial_outbox";
  target_id: string;
  target_type: "queue_item" | "run";
  reason: string;
  severity: "medium" | "high";
  run_id?: string;
  task_id?: string;
  item_type?: string;
  outbox_path?: string;
};

type RunnerMetadata = {
  run_id?: string;
  task_id?: string;
  status?: string;
  kind?: string;
  outbox_path?: string;
  created_at?: string;
  finished_at?: string;
};

type OutboxHealth =
  | { status: "valid" }
  | { status: "missing"; reason: string }
  | { status: "partial"; reason: string };

const defaultClaimTimeoutMs = 5 * 60 * 1000;
const defaultRunnerStaleMs = 15 * 60 * 1000;
const recoveryApprovalType = "runtime_recovery";

export async function runRuntimeRecovery(
  projectRoot: string,
  options: RuntimeRecoveryOptions = {}
): Promise<RuntimeRecoveryResult> {
  const now = options.now ?? new Date();
  const recoveryId = recoveryArtifactId(now);
  const actions: RuntimeRecoveryAction[] = [];
  const queue = new WorkQueue(projectRoot);
  const queueItems = await queue.list();
  const runs = await readRunnerMetadata(projectRoot);

  const staleLockAction = await recoverStaleRuntimeLock(projectRoot, now, options);
  if (staleLockAction !== null) {
    actions.push(staleLockAction);
  }

  for (const item of queueItems.filter((candidate) => candidate.status === "claimed")) {
    if (!isClaimExpired(item, now, options.claimTimeoutMs ?? defaultClaimTimeoutMs)) {
      continue;
    }

    if (isSafeToRequeue(item)) {
      await queue.requeueClaim(item.id, {
        now,
        reason: "Expired non-code-producing queue claim was safely requeued.",
        code: "runtime_recovery_safe_requeue"
      });
      actions.push({
        type: "queue_item_requeued",
        item_id: item.id,
        item_type: item.type,
        reason: "Expired non-code-producing queue claim was safely requeued."
      });
      continue;
    }

    actions.push(
      await requestRecoveryApproval(projectRoot, {
        kind: "claimed_timeout",
        target_id: item.id,
        target_type: "queue_item",
        item_type: item.type,
        task_id: item.task_id,
        severity: "high",
        reason: "Expired claimed item may have side effects and requires manual recovery approval."
      })
    );
  }

  for (const run of runs) {
    if (isRunnerStale(run, now, options.runnerStaleMs ?? defaultRunnerStaleMs)) {
      actions.push(
        await requestRecoveryApproval(projectRoot, {
          kind: "running_runner",
          target_id: run.run_id ?? run.directory_name,
          target_type: "run",
          run_id: run.run_id ?? run.directory_name,
          task_id: run.metadata.task_id,
          severity: "high",
          reason: "Runner metadata is still running past the recovery threshold."
        })
      );
    }

    const health = await readOutboxHealth(projectRoot, run);
    if (health.status === "missing" && run.metadata.status === "completed") {
      actions.push(
        await requestRecoveryApproval(projectRoot, {
          kind: "missing_outbox",
          target_id: run.run_id ?? run.directory_name,
          target_type: "run",
          run_id: run.run_id ?? run.directory_name,
          task_id: run.metadata.task_id,
          severity: "medium",
          outbox_path: run.outbox_project_path,
          reason: health.reason
        })
      );
    }

    if (health.status === "partial") {
      actions.push(
        await requestRecoveryApproval(projectRoot, {
          kind: "partial_outbox",
          target_id: run.run_id ?? run.directory_name,
          target_type: "run",
          run_id: run.run_id ?? run.directory_name,
          task_id: run.metadata.task_id,
          severity: "high",
          outbox_path: run.outbox_project_path,
          reason: health.reason
        })
      );
    }
  }

  const result: RuntimeRecoveryResult = {
    schema_version: "0.1",
    recovery_id: recoveryId,
    created_at: now.toISOString(),
    artifact_path: toProjectPath(projectRoot, recoveryArtifactPath(projectRoot, recoveryId)),
    summary: {
      scanned_queue_items: queueItems.length,
      scanned_runs: runs.length,
      stale_locks_cleared: actions.filter((action) => action.type === "stale_lock_cleared").length,
      requeued_items: actions.filter((action) => action.type === "queue_item_requeued").length,
      approvals_requested: actions.filter((action) => action.type === "approval_requested").length,
      approvals_existing: actions.filter((action) => action.type === "approval_existing").length
    },
    actions
  };

  await writeJsonFileAtomic(recoveryArtifactPath(projectRoot, recoveryId), result);
  return result;
}

export function formatRuntimeRecoveryResult(result: RuntimeRecoveryResult): string {
  return [
    "Kairon runtime recovery completed.",
    `recovery_id=${result.recovery_id}`,
    `artifact=${result.artifact_path}`,
    `stale_locks_cleared=${result.summary.stale_locks_cleared}`,
    `requeued_items=${result.summary.requeued_items}`,
    `approvals_requested=${result.summary.approvals_requested}`,
    `approvals_existing=${result.summary.approvals_existing}`
  ].join("\n");
}

async function recoverStaleRuntimeLock(
  projectRoot: string,
  now: Date,
  options: RuntimeRecoveryOptions
): Promise<RuntimeRecoveryAction | null> {
  const status = await readRuntimeLockStatus(projectRoot, {
    now,
    heartbeatStaleMs: options.heartbeatStaleMs
  });

  if (!status.locked || !status.stale) {
    return null;
  }

  await releaseRuntimeLock(projectRoot);
  return {
    type: "stale_lock_cleared",
    lock_path: toProjectPath(projectRoot, status.path),
    reason: "Runtime lock was stale and was cleared by recovery."
  };
}

async function requestRecoveryApproval(
  projectRoot: string,
  issue: RuntimeRecoveryIssue
): Promise<Extract<RuntimeRecoveryAction, { type: "approval_requested" | "approval_existing" }>> {
  const existing = await findExistingRecoveryApproval(projectRoot, issue);
  if (existing !== undefined) {
    return {
      type: "approval_existing",
      approval_id: existing,
      issue
    };
  }

  const approvalId = await nextId(projectRoot, "approval");
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    task_id: issue.task_id,
    run_id: issue.run_id,
    actor: "runtime-recovery",
    payload: {
      approval: {
        id: approvalId,
        type: recoveryApprovalType,
        title: `Runtime recovery required: ${issue.kind} ${issue.target_id}`,
        actions: ["approve", "reject", "request_changes", "snooze"],
        recovery_fingerprint: recoveryFingerprint(issue),
        recovery_issue: issue
      }
    }
  });

  return {
    type: "approval_requested",
    approval_id: approvalId,
    issue
  };
}

async function findExistingRecoveryApproval(
  projectRoot: string,
  issue: RuntimeRecoveryIssue
): Promise<string | undefined> {
  const fingerprint = recoveryFingerprint(issue);
  const approvals = await new ApprovalQueue(projectRoot).list({ status: "all" });
  return approvals.find((approval) =>
    approval.type === recoveryApprovalType &&
    approval.recovery_fingerprint === fingerprint &&
    ["pending", "snoozed"].includes(approval.status)
  )?.id;
}

async function readRunnerMetadata(projectRoot: string): Promise<Array<{
  directory_name: string;
  run_id?: string;
  metadata: RunnerMetadata;
  runner_path: string;
  outbox_path: string;
  outbox_project_path: string;
}>> {
  const paths = getKaironPaths(projectRoot);
  const entries = await readDirectoryEntries(paths.runsDir);
  const runners = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runDir = resolveInside(paths.runsDir, entry.name);
        const runnerPath = resolveInside(runDir, "runner.json");
        const metadata = await readOptionalJson<RunnerMetadata>(runnerPath);
        if (metadata === null) {
          return null;
        }

        const outboxProjectPath =
          metadata.outbox_path ?? `.kairon/runs/${entry.name}/outbox.json`;
        const outboxPath = resolveInside(paths.root, outboxProjectPath);
        return {
          directory_name: entry.name,
          run_id: metadata.run_id,
          metadata,
          runner_path: runnerPath,
          outbox_path: outboxPath,
          outbox_project_path: toProjectPath(paths.root, outboxPath)
        };
      })
  );

  return runners.filter((runner): runner is NonNullable<typeof runner> => runner !== null);
}

async function readOutboxHealth(
  projectRoot: string,
  run: {
    outbox_path: string;
    outbox_project_path: string;
  }
): Promise<OutboxHealth> {
  try {
    await access(run.outbox_path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        reason: `Expected outbox is missing: ${run.outbox_project_path}`
      };
    }

    throw error;
  }

  let outbox: unknown;
  try {
    outbox = await readJsonFile<unknown>(run.outbox_path);
  } catch {
    return {
      status: "partial",
      reason: `Outbox is not valid JSON: ${run.outbox_project_path}`
    };
  }

  if (outbox === null || typeof outbox !== "object" || Array.isArray(outbox)) {
    return {
      status: "partial",
      reason: `Outbox is not a JSON object: ${run.outbox_project_path}`
    };
  }

  const record = outbox as Record<string, unknown>;
  const missing = ["schema_version", "run_id", "status"].filter(
    (key) => typeof record[key] !== "string" || String(record[key]).length === 0
  );
  if (missing.length > 0) {
    return {
      status: "partial",
      reason: `Outbox is missing required fields (${missing.join(", ")}): ${run.outbox_project_path}`
    };
  }

  return { status: "valid" };
}

function isClaimExpired(item: QueueItem, now: Date, fallbackTimeoutMs: number): boolean {
  const expiresAt = Date.parse(item.claim_expires_at ?? "");
  if (Number.isFinite(expiresAt)) {
    return expiresAt <= now.getTime();
  }

  const claimedAt = Date.parse(item.claimed_at ?? item.updated_at);
  return Number.isFinite(claimedAt) && claimedAt + fallbackTimeoutMs <= now.getTime();
}

function isSafeToRequeue(item: QueueItem): boolean {
  if (!["agent.run", "maintenance.run"].includes(item.type)) {
    return false;
  }

  const payload = item.payload ?? {};
  return (
    payload.code_producing !== true &&
    payload.commit_requested !== true &&
    payload.approval_required !== true
  );
}

function isRunnerStale(
  run: { metadata: RunnerMetadata },
  now: Date,
  runnerStaleMs: number
): boolean {
  if (run.metadata.status !== "running") {
    return false;
  }

  const createdAt = Date.parse(run.metadata.created_at ?? "");
  return Number.isFinite(createdAt) && createdAt + runnerStaleMs <= now.getTime();
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    await mkdir(directoryPath, { recursive: true });
    return readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function recoveryFingerprint(issue: RuntimeRecoveryIssue): string {
  return `${issue.kind}:${issue.target_type}:${issue.target_id}`;
}

function recoveryArtifactId(now: Date): string {
  return `REC-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "")}`;
}

function recoveryArtifactPath(projectRoot: string, recoveryId: string): string {
  return resolveInside(getKaironPaths(projectRoot).recoveryDir, `${recoveryId}.json`);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
