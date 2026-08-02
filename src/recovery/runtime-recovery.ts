import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { ApprovalQueue } from "../approvals/approval-queue.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { recoverExpiredResourceLocks } from "../core/fs/resource-lock.js";
import { nextId } from "../core/ids/counter.js";
import { WorkQueue, type QueueItem } from "../queue/work-queue.js";
import {
  isRuntimeLockOwnerProcessAlive,
  readRuntimeLockStatus,
  releaseRuntimeLock
} from "../runtime/runtime-lock.js";
import { StateApplier } from "../state/state-applier.js";
import {
  attachIncidentResource,
  updateIncidentResource,
  type IncidentArtifact
} from "../incidents/store.js";
import { readActiveUpdateTransaction } from "../update/transaction.js";

export type RuntimeRecoveryOptions = {
  now?: Date;
  claimTimeoutMs?: number;
  runnerStaleMs?: number;
  heartbeatStaleMs?: number;
  gatewayStartingStaleMs?: number;
  gitTransactionStaleMs?: number;
  safeOnly?: boolean;
  writeNoopArtifact?: boolean;
  targetFingerprints?: string[];
};

export type RuntimeRecoveryResolutionAction = "resolved" | "acknowledged";

export type RuntimeRecoveryResolution = {
  schema_version: "0.1";
  fingerprint: string;
  target_id: string;
  target_type: RuntimeRecoveryIssue["target_type"];
  issue_kind: RuntimeRecoveryIssue["kind"];
  severity: RuntimeRecoveryIssue["severity"];
  action: RuntimeRecoveryResolutionAction;
  reason: string;
  created_at: string;
  issue: RuntimeRecoveryIssue;
  resolved_by?: {
    source: "local-cli";
  };
  acknowledged_by?: {
    source: "local-cli";
  };
};

export type RuntimeRecoveryResult = {
  schema_version: "0.1";
  recovery_id: string;
  created_at: string;
  artifact_path: string;
  summary: {
    scanned_queue_items: number;
    scanned_runs: number;
    scanned_git_transactions: number;
    stale_locks_cleared: number;
    resource_locks_cleared: number;
    gateway_artifacts_recovered: number;
    requeued_items: number;
    approvals_requested: number;
    approvals_existing: number;
    git_transaction_issues: number;
    state_compaction_issues: number;
    state_backup_restore_issues: number;
    update_transaction_issues: number;
  };
  actions: RuntimeRecoveryAction[];
};

export type RuntimeRecoveryInspection = {
  schema_version: "0.1";
  generated_at: string;
  summary: {
    targets: number;
    stale_locks: number;
    expired_claims: number;
    run_issues: number;
    gateway_issues: number;
    git_transaction_issues: number;
    state_compaction_issues: number;
    state_backup_restore_issues: number;
    update_transaction_issues: number;
    resolved_targets: number;
  };
  issues: RuntimeRecoveryIssue[];
};

export type RuntimeRecoveryAction =
  | {
      type: "stale_lock_cleared";
      lock_path: string;
      reason: string;
    }
  | {
      type: "stale_resource_lock_cleared";
      lock_path: string;
      resource: string;
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
    }
  | {
      type: "gateway_starting_recovered";
      gateway_path: string;
      reason: string;
    };

export type RuntimeRecoveryIssue = {
  fingerprint: string;
  kind:
    | "stale_lock"
    | "claimed_timeout"
    | "running_runner"
    | "missing_outbox"
    | "partial_outbox"
    | "discord_gateway_starting"
    | "git_transaction_mid_state"
    | "state_compaction_mid_state"
    | "state_backup_restore_mid_state"
    | "update_transaction_mid_state";
  target_id: string;
  target_type:
    | "runtime_lock"
    | "queue_item"
    | "run"
    | "discord_gateway"
    | "git_transaction"
    | "state_compaction"
    | "state_backup_restore"
    | "update_transaction";
  reason: string;
  severity: "medium" | "high";
  run_id?: string;
  task_id?: string;
  item_type?: string;
  outbox_path?: string;
  gateway_path?: string;
  transaction_id?: string;
  transaction_status?: string;
  checkpoint_id?: string;
  compaction_status?: string;
  compaction_marker_path?: string;
  moved_segments?: number;
  snapshot_id?: string;
  backup_id?: string;
  restore_status?: string;
  restore_marker_path?: string;
  restored_files?: number;
  deleted_files?: number;
  pre_restore_snapshot_id?: string;
};

type RuntimeRecoveryIssueInput = Omit<RuntimeRecoveryIssue, "fingerprint">;

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

type GitTransactionRecoveryRecord = {
  transaction_id?: string;
  status?: string;
  task_id?: string;
  run_id?: string;
  updated_at?: string;
  created_at?: string;
};

const defaultClaimTimeoutMs = 5 * 60 * 1000;
const defaultRunnerStaleMs = 15 * 60 * 1000;
const defaultGatewayStartingStaleMs = 5 * 60 * 1000;
const defaultGitTransactionStaleMs = 15 * 60 * 1000;
const recoveryApprovalType = "runtime_recovery";
const gitTransactionMidStates = new Set([
  "planned",
  "prepared",
  "checked",
  "reviewed",
  "committing",
  "pushing"
]);

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
  const gitTransactions = await readGitTransactions(projectRoot);
  const resolvedFingerprints = await readResolvedRecoveryFingerprints(projectRoot);

  const staleLockAction = await recoverStaleRuntimeLock(projectRoot, now, options);
  if (staleLockAction !== null) {
    actions.push(staleLockAction);
  }

  for (const recoveredLock of await recoverExpiredResourceLocks(projectRoot, { now })) {
    actions.push({
      type: "stale_resource_lock_cleared",
      lock_path: recoveredLock.lock_path,
      resource: recoveredLock.resource,
      reason: "Expired resource-level state lock was cleared."
    });
  }

  for (const item of queueItems.filter((candidate) => candidate.status === "claimed")) {
    if (!isClaimExpired(item, now, options.claimTimeoutMs ?? defaultClaimTimeoutMs)) {
      continue;
    }

    const issue = createRecoveryIssue({
      kind: "claimed_timeout",
      target_id: item.id,
      target_type: "queue_item",
      item_type: item.type,
      task_id: item.task_id,
      severity: isSafeToRequeue(item) ? "medium" : "high",
      reason: isSafeToRequeue(item)
        ? "Expired non-code-producing queue claim can be safely requeued."
        : "Expired claimed item may have side effects and requires manual recovery approval."
    });
    if (!isSelectedRecoveryIssue(issue, options)) {
      continue;
    }

    if (isSafeToRequeue(item)) {
      await syncRecoveryIncident(projectRoot, issue, "open", now);
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
      await syncRecoveryIncident(projectRoot, issue, "resolved", now);
      continue;
    }

    if (options.safeOnly === true) {
      continue;
    }

    if (resolvedFingerprints.has(issue.fingerprint)) {
      continue;
    }

    actions.push(await requestRecoveryApproval(projectRoot, issue, now));
  }

  if (options.safeOnly !== true) {
    for (const issue of await findRunIssues(projectRoot, runs, now, options)) {
      if (!isSelectedRecoveryIssue(issue, options)) {
        continue;
      }
      if (resolvedFingerprints.has(issue.fingerprint)) {
        continue;
      }
      actions.push(await requestRecoveryApproval(projectRoot, issue, now));
    }
  }

  const gatewayAction = await recoverStaleDiscordGateway(projectRoot, now, options);
  if (gatewayAction !== null) {
    actions.push(gatewayAction);
  }

  if (options.safeOnly !== true) {
    for (const issue of findStaleGitTransactionIssues(gitTransactions, now, options)) {
      if (!isSelectedRecoveryIssue(issue, options)) {
        continue;
      }
      if (resolvedFingerprints.has(issue.fingerprint)) {
        continue;
      }
      actions.push(await requestRecoveryApproval(projectRoot, issue, now));
    }

    const compactionIssue = await findStateCompactionIssue(projectRoot);
    if (
      compactionIssue !== null &&
      isSelectedRecoveryIssue(compactionIssue, options) &&
      !resolvedFingerprints.has(compactionIssue.fingerprint)
    ) {
      actions.push(await requestRecoveryApproval(projectRoot, compactionIssue, now));
    }

    const backupRestoreIssue = await findStateBackupRestoreIssue(projectRoot);
    if (
      backupRestoreIssue !== null &&
      isSelectedRecoveryIssue(backupRestoreIssue, options) &&
      !resolvedFingerprints.has(backupRestoreIssue.fingerprint)
    ) {
      actions.push(await requestRecoveryApproval(projectRoot, backupRestoreIssue, now));
    }

    const updateTransactionIssue = await findUpdateTransactionIssue(projectRoot);
    if (
      updateTransactionIssue !== null &&
      isSelectedRecoveryIssue(updateTransactionIssue, options) &&
      !resolvedFingerprints.has(updateTransactionIssue.fingerprint)
    ) {
      actions.push(
        await requestRecoveryApproval(projectRoot, updateTransactionIssue, now)
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
      scanned_git_transactions: gitTransactions.length,
      stale_locks_cleared: actions.filter((action) => action.type === "stale_lock_cleared")
        .length,
      resource_locks_cleared: actions.filter(
        (action) => action.type === "stale_resource_lock_cleared"
      ).length,
      gateway_artifacts_recovered: actions.filter(
        (action) => action.type === "gateway_starting_recovered"
      ).length,
      requeued_items: actions.filter((action) => action.type === "queue_item_requeued").length,
      approvals_requested: actions.filter((action) => action.type === "approval_requested").length,
      approvals_existing: actions.filter((action) => action.type === "approval_existing").length,
      git_transaction_issues: actions.filter(
        (action) =>
          (action.type === "approval_requested" || action.type === "approval_existing") &&
          action.issue.kind === "git_transaction_mid_state"
      ).length,
      state_compaction_issues: actions.filter(
        (action) =>
          (action.type === "approval_requested" || action.type === "approval_existing") &&
          action.issue.kind === "state_compaction_mid_state"
      ).length,
      state_backup_restore_issues: actions.filter(
        (action) =>
          (action.type === "approval_requested" || action.type === "approval_existing") &&
          action.issue.kind === "state_backup_restore_mid_state"
      ).length,
      update_transaction_issues: actions.filter(
        (action) =>
          (action.type === "approval_requested" || action.type === "approval_existing") &&
          action.issue.kind === "update_transaction_mid_state"
      ).length
    },
    actions
  };

  if (actions.length > 0 || options.writeNoopArtifact !== false) {
    await writeJsonFileAtomic(recoveryArtifactPath(projectRoot, recoveryId), result);
  }
  return result;
}

export function formatRuntimeRecoveryResult(result: RuntimeRecoveryResult): string {
  return [
    "Kairon runtime recovery completed.",
    `recovery_id=${result.recovery_id}`,
    `artifact=${result.artifact_path}`,
    `stale_locks_cleared=${result.summary.stale_locks_cleared}`,
    `resource_locks_cleared=${result.summary.resource_locks_cleared}`,
    `gateway_artifacts_recovered=${result.summary.gateway_artifacts_recovered}`,
    `requeued_items=${result.summary.requeued_items}`,
    `approvals_requested=${result.summary.approvals_requested}`,
    `approvals_existing=${result.summary.approvals_existing}`,
    `git_transaction_issues=${result.summary.git_transaction_issues}`,
    `state_compaction_issues=${result.summary.state_compaction_issues}`,
    `state_backup_restore_issues=${result.summary.state_backup_restore_issues}`,
    `update_transaction_issues=${result.summary.update_transaction_issues}`
  ].join("\n");
}

export async function inspectRuntimeRecoveryTargets(
  projectRoot: string,
  options: RuntimeRecoveryOptions = {}
): Promise<RuntimeRecoveryInspection> {
  const now = options.now ?? new Date();
  const queue = new WorkQueue(projectRoot);
  const [lock, queueItems, runs, gitTransactions] = await Promise.all([
    readRuntimeLockStatus(projectRoot, {
      now,
      heartbeatStaleMs: options.heartbeatStaleMs
    }),
    queue.list(),
    readRunnerMetadata(projectRoot),
    readGitTransactions(projectRoot)
  ]);
  const issues: RuntimeRecoveryIssue[] = [];

  if (lock.locked && lock.stale) {
    issues.push(createRecoveryIssue({
      kind: "stale_lock",
      target_id: "runtime-lock",
      target_type: "runtime_lock",
      severity: "medium",
      reason: "Runtime lock is stale and can be cleared before startup."
    }));
  }

  for (const item of queueItems.filter((candidate) => candidate.status === "claimed")) {
    if (!isClaimExpired(item, now, options.claimTimeoutMs ?? defaultClaimTimeoutMs)) {
      continue;
    }

    issues.push(createRecoveryIssue({
      kind: "claimed_timeout",
      target_id: item.id,
      target_type: "queue_item",
      item_type: item.type,
      task_id: item.task_id,
      severity: isSafeToRequeue(item) ? "medium" : "high",
      reason: isSafeToRequeue(item)
        ? "Expired non-code-producing queue claim can be safely requeued."
        : "Expired claimed item may have side effects and requires manual recovery approval."
    }));
  }

  issues.push(...(await findRunIssues(projectRoot, runs, now, options)));

  const gatewayIssue = await findStaleDiscordGatewayIssue(projectRoot, now, options);
  if (gatewayIssue !== null) {
    issues.push(gatewayIssue.issue);
  }

  issues.push(...findStaleGitTransactionIssues(gitTransactions, now, options));
  const compactionIssue = await findStateCompactionIssue(projectRoot);
  if (compactionIssue !== null) {
    issues.push(compactionIssue);
  }
  const backupRestoreIssue = await findStateBackupRestoreIssue(projectRoot);
  if (backupRestoreIssue !== null) {
    issues.push(backupRestoreIssue);
  }
  const updateTransactionIssue = await findUpdateTransactionIssue(projectRoot);
  if (updateTransactionIssue !== null) {
    issues.push(updateTransactionIssue);
  }
  const resolvedFingerprints = await readResolvedRecoveryFingerprints(projectRoot);
  const unresolvedIssues = issues.filter(
    (issue) => !resolvedFingerprints.has(issue.fingerprint)
  );
  const resolvedTargets = issues.length - unresolvedIssues.length;

  return {
    schema_version: "0.1",
    generated_at: now.toISOString(),
    summary: {
      targets: unresolvedIssues.length,
      stale_locks: unresolvedIssues.filter((issue) => issue.kind === "stale_lock").length,
      expired_claims: unresolvedIssues.filter((issue) => issue.kind === "claimed_timeout").length,
      run_issues: unresolvedIssues.filter((issue) =>
        ["running_runner", "missing_outbox", "partial_outbox"].includes(issue.kind)
      ).length,
      gateway_issues: unresolvedIssues.filter(
        (issue) => issue.kind === "discord_gateway_starting"
      ).length,
      git_transaction_issues: unresolvedIssues.filter(
        (issue) => issue.kind === "git_transaction_mid_state"
      ).length,
      state_compaction_issues: unresolvedIssues.filter(
        (issue) => issue.kind === "state_compaction_mid_state"
      ).length,
      state_backup_restore_issues: unresolvedIssues.filter(
        (issue) => issue.kind === "state_backup_restore_mid_state"
      ).length,
      update_transaction_issues: unresolvedIssues.filter(
        (issue) => issue.kind === "update_transaction_mid_state"
      ).length,
      resolved_targets: resolvedTargets
    },
    issues: unresolvedIssues
  };
}

export async function listRuntimeRecoveryTargets(
  projectRoot: string,
  options: RuntimeRecoveryOptions = {}
): Promise<RuntimeRecoveryIssue[]> {
  return (await inspectRuntimeRecoveryTargets(projectRoot, options)).issues;
}

export async function showRuntimeRecoveryTarget(
  projectRoot: string,
  targetIdOrFingerprint: string,
  options: RuntimeRecoveryOptions = {}
): Promise<RuntimeRecoveryIssue> {
  const issue = (await listRuntimeRecoveryTargets(projectRoot, options)).find(
    (candidate) =>
      candidate.target_id === targetIdOrFingerprint ||
      candidate.fingerprint === targetIdOrFingerprint
  );

  if (issue === undefined) {
    throw new Error(`Runtime recovery target was not found: ${targetIdOrFingerprint}`);
  }

  return issue;
}

export async function resolveRuntimeRecoveryTarget(
  projectRoot: string,
  targetIdOrFingerprint: string,
  options: {
    action: RuntimeRecoveryResolutionAction;
    reason: string;
    now?: Date;
  }
): Promise<{
  target: RuntimeRecoveryIssue;
  resolution: RuntimeRecoveryResolution;
  resolution_path: string;
}> {
  const reason = options.reason.trim();
  if (reason.length === 0) {
    throw new Error("Runtime recovery resolution reason is required.");
  }

  const target = await showRuntimeRecoveryTarget(projectRoot, targetIdOrFingerprint, {
    now: options.now
  });
  const now = options.now ?? new Date();
  const resolution: RuntimeRecoveryResolution = {
    schema_version: "0.1",
    fingerprint: target.fingerprint,
    target_id: target.target_id,
    target_type: target.target_type,
    issue_kind: target.kind,
    severity: target.severity,
    action: options.action,
    reason,
    created_at: now.toISOString(),
    issue: target,
    ...(options.action === "resolved"
      ? { resolved_by: { source: "local-cli" as const } }
      : { acknowledged_by: { source: "local-cli" as const } })
  };
  const resolutionPath = recoveryResolutionPath(projectRoot, target.fingerprint);
  await writeJsonFileAtomic(resolutionPath, resolution);
  await updateIncidentResource(projectRoot, {
    kind: "recovery_target",
    id: target.target_id,
    fingerprint: target.fingerprint,
    status: options.action === "resolved" ? "resolved" : "open",
    details: {
      acknowledged: options.action === "acknowledged",
      resolution_action: options.action
    },
    now
  });

  return {
    target,
    resolution,
    resolution_path: toProjectPath(projectRoot, resolutionPath)
  };
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

  if (
    !status.locked ||
    !status.stale ||
    isRuntimeLockOwnerProcessAlive(status.data)
  ) {
    return null;
  }
  const issue = createRecoveryIssue({
    kind: "stale_lock",
    target_id: "runtime-lock",
    target_type: "runtime_lock",
    severity: "medium",
    reason: "Runtime lock is stale and can be cleared before startup."
  });
  if (!isSelectedRecoveryIssue(issue, options)) {
    return null;
  }

  await syncRecoveryIncident(projectRoot, issue, "open", now);
  await releaseRuntimeLock(projectRoot);
  await syncRecoveryIncident(projectRoot, issue, "resolved", now);
  return {
    type: "stale_lock_cleared",
    lock_path: toProjectPath(projectRoot, status.path),
    reason: "Runtime lock was stale and was cleared by recovery."
  };
}

async function requestRecoveryApproval(
  projectRoot: string,
  issue: RuntimeRecoveryIssue,
  now: Date
): Promise<Extract<RuntimeRecoveryAction, { type: "approval_requested" | "approval_existing" }>> {
  const incident = await syncRecoveryIncident(
    projectRoot,
    issue,
    "open",
    now
  );
  const existing = await findExistingRecoveryApproval(projectRoot, issue);
  if (existing !== undefined) {
    await attachRecoveryApproval(projectRoot, incident, existing, "pending", now);
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
        recovery_fingerprint: issue.fingerprint,
        recovery_issue: issue,
        incident_id: incident.incident_id,
        correlation_id: incident.correlation_id
      }
    }
  });
  await attachRecoveryApproval(projectRoot, incident, approvalId, "pending", now);

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
  const fingerprint = issue.fingerprint;
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

async function findRunIssues(
  projectRoot: string,
  runs: Array<{
    directory_name: string;
    run_id?: string;
    metadata: RunnerMetadata;
    outbox_path: string;
    outbox_project_path: string;
  }>,
  now: Date,
  options: RuntimeRecoveryOptions
): Promise<RuntimeRecoveryIssue[]> {
  const issues: RuntimeRecoveryIssue[] = [];

  for (const run of runs) {
    if (isRunnerStale(run, now, options.runnerStaleMs ?? defaultRunnerStaleMs)) {
      issues.push(createRecoveryIssue({
        kind: "running_runner",
        target_id: run.run_id ?? run.directory_name,
        target_type: "run",
        run_id: run.run_id ?? run.directory_name,
        task_id: run.metadata.task_id,
        severity: "high",
        reason: "Runner metadata is still running past the recovery threshold."
      }));
    }

    const health = await readOutboxHealth(projectRoot, run);
    if (health.status === "missing" && run.metadata.status === "completed") {
      issues.push(createRecoveryIssue({
        kind: "missing_outbox",
        target_id: run.run_id ?? run.directory_name,
        target_type: "run",
        run_id: run.run_id ?? run.directory_name,
        task_id: run.metadata.task_id,
        severity: "medium",
        outbox_path: run.outbox_project_path,
        reason: health.reason
      }));
    }

    if (health.status === "partial") {
      issues.push(createRecoveryIssue({
        kind: "partial_outbox",
        target_id: run.run_id ?? run.directory_name,
        target_type: "run",
        run_id: run.run_id ?? run.directory_name,
        task_id: run.metadata.task_id,
        severity: "high",
        outbox_path: run.outbox_project_path,
        reason: health.reason
      }));
    }
  }

  return issues;
}

async function recoverStaleDiscordGateway(
  projectRoot: string,
  now: Date,
  options: RuntimeRecoveryOptions
): Promise<Extract<RuntimeRecoveryAction, { type: "gateway_starting_recovered" }> | null> {
  const candidate = await findStaleDiscordGatewayIssue(projectRoot, now, options);
  if (
    candidate === null ||
    !isSelectedRecoveryIssue(candidate.issue, options)
  ) {
    return null;
  }

  await syncRecoveryIncident(projectRoot, candidate.issue, "open", now);
  await writeJsonFileAtomic(candidate.gateway_path, {
    ...sanitizeRecord(candidate.gateway),
    status: "stopped",
    error_code: "discord_gateway_starting_stale",
    operation: "runtime_recovery",
    commands_registered: false,
    recovered_at: now.toISOString(),
    updated_at: now.toISOString(),
    next_action: "Restart Kairon runtime after verifying Discord gateway config."
  });
  await syncRecoveryIncident(projectRoot, candidate.issue, "resolved", now);

  return {
    type: "gateway_starting_recovered",
    gateway_path: candidate.issue.gateway_path ?? candidate.issue.target_id,
    reason: candidate.issue.reason
  };
}

async function findStaleDiscordGatewayIssue(
  projectRoot: string,
  now: Date,
  options: RuntimeRecoveryOptions
): Promise<{
  issue: RuntimeRecoveryIssue;
  gateway: Record<string, unknown>;
  gateway_path: string;
} | null> {
  const gatewayPath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "discord",
    "gateway.json"
  );
  const gateway = await readOptionalJson<Record<string, unknown>>(gatewayPath);
  if (gateway === null || gateway.status !== "starting") {
    return null;
  }

  const timestamp = readTimestamp(gateway.updated_at) ?? readTimestamp(gateway.created_at);
  if (
    timestamp === undefined ||
    timestamp + (options.gatewayStartingStaleMs ?? defaultGatewayStartingStaleMs) >
      now.getTime()
  ) {
    return null;
  }

  const projectPath = toProjectPath(projectRoot, gatewayPath);
  return {
    gateway,
    gateway_path: gatewayPath,
    issue: createRecoveryIssue({
      kind: "discord_gateway_starting",
      target_id: projectPath,
      target_type: "discord_gateway",
      severity: "medium",
      gateway_path: projectPath,
      reason: "Discord gateway artifact is stuck in starting state past the recovery threshold."
    })
  };
}

async function readGitTransactions(
  projectRoot: string
): Promise<Array<{ file_name: string; record: GitTransactionRecoveryRecord }>> {
  const transactionsDir = resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "git",
    "transactions"
  );
  const entries = await readDirectoryEntries(transactionsDir);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => ({
        file_name: entry.name,
        record: await readJsonFile<GitTransactionRecoveryRecord>(
          resolveInside(transactionsDir, entry.name)
        )
      }))
  );

  return records;
}

function findStaleGitTransactionIssues(
  transactions: Array<{ file_name: string; record: GitTransactionRecoveryRecord }>,
  now: Date,
  options: RuntimeRecoveryOptions
): RuntimeRecoveryIssue[] {
  return transactions.flatMap(({ file_name, record }) => {
    if (record.status === undefined || !gitTransactionMidStates.has(record.status)) {
      return [];
    }

    const timestamp = readTimestamp(record.updated_at) ?? readTimestamp(record.created_at);
    if (
      timestamp === undefined ||
      timestamp + (options.gitTransactionStaleMs ?? defaultGitTransactionStaleMs) >
        now.getTime()
    ) {
      return [];
    }

    const transactionId =
      record.transaction_id ?? file_name.replace(/\.json$/i, "");
    return [
      createRecoveryIssue({
        kind: "git_transaction_mid_state",
        target_id: transactionId,
        target_type: "git_transaction",
        transaction_id: transactionId,
        transaction_status: record.status,
        run_id: record.run_id,
        task_id: record.task_id,
        severity: ["committing", "pushing"].includes(record.status) ? "high" : "medium",
        reason:
          "Git transaction stopped in a mid-state and requires manual recovery to avoid duplicate commit or push."
      })
    ];
  });
}

async function findStateCompactionIssue(
  projectRoot: string
): Promise<RuntimeRecoveryIssue | null> {
  const markerPath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "state-compaction.json"
  );
  const marker = await readOptionalJson<Record<string, unknown>>(markerPath);
  if (marker === null) {
    return null;
  }

  const checkpointId =
    typeof marker.checkpoint_id === "string" &&
    /^ECP-EVT-\d+-[0-9a-f]{12}$/u.test(marker.checkpoint_id)
      ? marker.checkpoint_id
      : "unknown-checkpoint";
  const status =
    typeof marker.status === "string" &&
    ["snapshot_created", "moving_segments", "archive_written"].includes(marker.status)
      ? marker.status
      : "unknown";
  const snapshot =
    marker.snapshot !== null &&
    typeof marker.snapshot === "object" &&
    !Array.isArray(marker.snapshot)
      ? marker.snapshot as Record<string, unknown>
      : {};
  const movedSegments = Array.isArray(marker.moved_segments)
    ? marker.moved_segments.filter((item) => typeof item === "string").length
    : 0;
  const markerProjectPath = toProjectPath(projectRoot, markerPath);

  return createRecoveryIssue({
    kind: "state_compaction_mid_state",
    target_id: checkpointId,
    target_type: "state_compaction",
    checkpoint_id: checkpointId,
    compaction_status: status,
    compaction_marker_path: markerProjectPath,
    moved_segments: movedSegments,
    snapshot_id:
      typeof snapshot.snapshot_id === "string" &&
      /^SNP-[A-Z0-9][A-Z0-9_-]{2,80}$/u.test(snapshot.snapshot_id)
        ? snapshot.snapshot_id
        : undefined,
    severity: "high",
    reason:
      "Event log compaction stopped before checkpoint completion. Verify the snapshot and moved segments, then choose manual roll-forward or rollback."
  });
}

async function findStateBackupRestoreIssue(
  projectRoot: string
): Promise<RuntimeRecoveryIssue | null> {
  const markerPath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "state-backup-restore.json"
  );
  const marker = await readOptionalJson<Record<string, unknown>>(markerPath);
  if (marker === null) {
    return null;
  }

  const backupId =
    typeof marker.backup_id === "string" &&
    /^BKP-\d{17}-[0-9a-f]{12}$/u.test(marker.backup_id)
      ? marker.backup_id
      : "unknown-backup";
  const restoreStatus =
    typeof marker.status === "string" &&
    [
      "pre_restore_snapshot_created",
      "restoring",
      "validating",
      "restore_failed"
    ].includes(marker.status)
      ? marker.status
      : "unknown";
  const snapshotId =
    typeof marker.pre_restore_snapshot_id === "string" &&
    /^SNP-[A-Z0-9][A-Z0-9_-]{2,80}$/u.test(marker.pre_restore_snapshot_id)
      ? marker.pre_restore_snapshot_id
      : undefined;
  const restoredFiles = readSafeCount(marker.restored_files);
  const deletedFiles = readSafeCount(marker.deleted_files);
  const markerProjectPath = toProjectPath(projectRoot, markerPath);

  return createRecoveryIssue({
    kind: "state_backup_restore_mid_state",
    target_id: backupId,
    target_type: "state_backup_restore",
    backup_id: backupId,
    restore_status: restoreStatus,
    restore_marker_path: markerProjectPath,
    restored_files: restoredFiles,
    deleted_files: deletedFiles,
    pre_restore_snapshot_id: snapshotId,
    snapshot_id: snapshotId,
    severity: "high",
    reason:
      "State backup restore stopped before completion. Verify the backup and use the pre-restore snapshot for an explicit rollback or resume decision."
  });
}

async function findUpdateTransactionIssue(
  projectRoot: string
): Promise<RuntimeRecoveryIssue | null> {
  try {
    const transaction = await readActiveUpdateTransaction(projectRoot);
    if (transaction === null) {
      return null;
    }
    return createRecoveryIssue({
      kind: "update_transaction_mid_state",
      target_id: transaction.transaction_id,
      target_type: "update_transaction",
      transaction_id: transaction.transaction_id,
      transaction_status: transaction.status,
      severity: "high",
      reason:
        transaction.status === "recovery_required"
          ? "Update rollback did not complete conclusively. Inspect the transaction and incident before any retry."
          : "Update transaction was interrupted. Verify the active package, project state, and rollback artifact before resuming."
    });
  } catch {
    return createRecoveryIssue({
      kind: "update_transaction_mid_state",
      target_id: "update-transaction-marker",
      target_type: "update_transaction",
      transaction_status: "invalid",
      severity: "high",
      reason:
        "Update transaction marker is invalid. Do not apply another update until the active package and project state are verified."
    });
  }
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

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readSafeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      /api[_-]?key|token|secret|password/i.test(key)
        ? "[redacted]"
        : sanitizeRecordValue(value)
    ])
  );
}

function sanitizeRecordValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecordValue(item));
  }

  return sanitizeRecord(value as Record<string, unknown>);
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

async function readResolvedRecoveryFingerprints(projectRoot: string): Promise<Set<string>> {
  const resolutions = await readRecoveryResolutions(projectRoot);
  return new Set(
    resolutions
      .filter((resolution) => resolution.action === "resolved")
      .map((resolution) => resolution.fingerprint)
  );
}

async function readRecoveryResolutions(projectRoot: string): Promise<RuntimeRecoveryResolution[]> {
  const directoryPath = recoveryResolutionsDir(projectRoot);
  const entries = await readDirectoryEntries(directoryPath);
  const resolutions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        readJsonFile<RuntimeRecoveryResolution>(resolveInside(directoryPath, entry.name))
      )
  );

  return resolutions.filter(
    (resolution) =>
      typeof resolution.fingerprint === "string" &&
      (resolution.action === "resolved" || resolution.action === "acknowledged")
  );
}

function createRecoveryIssue(issue: RuntimeRecoveryIssueInput): RuntimeRecoveryIssue {
  return {
    ...issue,
    fingerprint: recoveryFingerprint(issue)
  };
}

function isSelectedRecoveryIssue(
  issue: RuntimeRecoveryIssue,
  options: RuntimeRecoveryOptions
): boolean {
  return (
    options.targetFingerprints === undefined ||
    options.targetFingerprints.includes(issue.fingerprint)
  );
}

async function syncRecoveryIncident(
  projectRoot: string,
  issue: RuntimeRecoveryIssue,
  status: "open" | "resolved",
  now: Date
): Promise<IncidentArtifact> {
  if (status === "resolved") {
    const updated = await updateIncidentResource(projectRoot, {
      kind: "recovery_target",
      id: issue.target_id,
      fingerprint: issue.fingerprint,
      status,
      now
    });
    if (updated !== null) {
      return updated;
    }
  }
  return attachIncidentResource(projectRoot, {
    fingerprint: issue.fingerprint,
    severity: issue.severity === "high" ? "high" : "warning",
    title: `Runtime recovery: ${issue.kind}`,
    summary: issue.reason,
    resource: {
      kind: "recovery_target",
      id: issue.target_id,
      status,
      fingerprint: issue.fingerprint,
      severity: issue.severity === "high" ? "high" : "warning",
      details: {
        issue_kind: issue.kind,
        target_type: issue.target_type
      }
    },
    now
  });
}

async function attachRecoveryApproval(
  projectRoot: string,
  incident: IncidentArtifact,
  approvalId: string,
  status: string,
  now: Date
): Promise<void> {
  await attachIncidentResource(projectRoot, {
    fingerprint: incident.fingerprint,
    severity: incident.severity,
    title: incident.title,
    summary: incident.summary,
    resource: {
      kind: "approval",
      id: approvalId,
      status,
      artifactPath: `.kairon/approvals/${approvalId}.json`,
      details: { approval_type: recoveryApprovalType }
    },
    now
  });
}

function recoveryFingerprint(issue: RuntimeRecoveryIssueInput): string {
  return `${issue.kind}:${issue.target_type}:${issue.target_id}`;
}

function recoveryArtifactId(now: Date): string {
  return `REC-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "")}`;
}

function recoveryArtifactPath(projectRoot: string, recoveryId: string): string {
  return resolveInside(getKaironPaths(projectRoot).recoveryDir, `${recoveryId}.json`);
}

function recoveryResolutionPath(projectRoot: string, fingerprint: string): string {
  return resolveInside(recoveryResolutionsDir(projectRoot), `${safeFileName(fingerprint)}.json`);
}

function recoveryResolutionsDir(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).recoveryDir, "resolutions");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
