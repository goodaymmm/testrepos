import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { ApprovalQueue, type ApprovalRecord } from "../approvals/approval-queue.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { sanitizeSupportText } from "../diagnostics/support-redaction.js";
import {
  attachIncidentResource,
  type IncidentArtifact,
  type IncidentSeverity,
  type IncidentTimelineEvent
} from "../incidents/store.js";
import {
  executeRagRebuild,
  planRagRebuild,
  verifyRagIndex
} from "../rag/integrity.js";
import { StateApplier } from "../state/state-applier.js";
import {
  authorizeWatchdogNotificationRetry,
  listWatchdogAlerts
} from "../runtime/watchdog.js";
import {
  executeWorkflowCheckpointRebuild,
  planWorkflowCheckpointRebuild,
  verifyWorkflowCheckpointStore
} from "../workflow/checkpoint-manager.js";
import {
  inspectRuntimeRecoveryTargets,
  type RuntimeRecoveryIssue
} from "./runtime-recovery.js";
import {
  isSelfHealingRunbookId,
  resolveSelfHealingPolicy,
  selfHealingRiskRequiresApproval,
  selfHealingRunbookIds,
  type SelfHealingPolicy,
  type SelfHealingRisk,
  type SelfHealingRunbookId
} from "./self-healing-policy.js";

export type SelfHealingRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "suspended"
  | "failed";

export type SelfHealingInspectionStatus =
  | "eligible"
  | "ineligible"
  | "ambiguous";

export type SelfHealingInspection = {
  runbook_id: SelfHealingRunbookId;
  status: SelfHealingInspectionStatus;
  reason: string;
  target_id: string;
  incident_fingerprint: string;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  source_digest: string;
  before_digest: string;
  details: Record<string, string | number | boolean>;
};

export type SelfHealingAttempt = {
  attempt: number;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at?: string;
  before_digest: string;
  after_digest?: string;
  reason?: string;
};

export type SelfHealingRunArtifact = {
  schema_version: "0.1";
  artifact_kind: "self_healing_runbook";
  run_id: string;
  runbook_id: SelfHealingRunbookId;
  incident_id: string;
  correlation_id: string;
  incident_fingerprint: string;
  status: SelfHealingRunStatus;
  mode: SelfHealingPolicy["mode"];
  risk: SelfHealingRisk;
  target_id: string;
  source_digest: string;
  before_digest: string;
  idempotency_key: string;
  dry_run: boolean;
  action: {
    type: SelfHealingRunbookId;
    side_effect: string;
    stop_condition: string;
    rollback_hint: string;
  };
  policy: {
    max_attempts: number;
    cooldown_seconds: number;
    time_budget_seconds: number;
    approval_threshold: SelfHealingRisk;
  };
  precondition: {
    status: SelfHealingInspectionStatus;
    reason: string;
    details: Record<string, string | number | boolean>;
  };
  postcondition?: {
    status: "passed" | "failed";
    after_digest?: string;
    reason: string;
  };
  attempts: SelfHealingAttempt[];
  approval_required: boolean;
  approval_id?: string;
  suspension_reason?: string;
  created_at: string;
  updated_at: string;
};

export type SelfHealingTickResult = {
  status:
    | "disabled"
    | "idle"
    | "planned"
    | "running"
    | "completed"
    | "suspended"
    | "failed";
  run_id?: string;
  runbook_id?: SelfHealingRunbookId;
  reason?: string;
};

export type SelfHealingDependencies = {
  inspect?: (
    projectRoot: string,
    runbookId: SelfHealingRunbookId,
    targetId: string | undefined,
    now: Date,
    env: NodeJS.ProcessEnv
  ) => Promise<SelfHealingInspection>;
  execute?: (
    projectRoot: string,
    run: SelfHealingRunArtifact,
    inspection: SelfHealingInspection,
    now: Date,
    env: NodeJS.ProcessEnv
  ) => Promise<{
    success: boolean;
    reason: string;
    after_digest: string;
  }>;
};

type RunbookDefinition = {
  id: SelfHealingRunbookId;
  risk: SelfHealingRisk;
  sideEffect: string;
  stopCondition: string;
  rollbackHint: string;
};

const definitions: Record<SelfHealingRunbookId, RunbookDefinition> = {
  workflow_checkpoint_index_rebuild: {
    id: "workflow_checkpoint_index_rebuild",
    risk: "low",
    sideEffect: "replace derived SQLite workflow checkpoint index",
    stopCondition: "canonical checkpoint verification must remain valid",
    rollbackHint: "discard the derived SQLite index and rebuild from canonical files"
  },
  rag_index_verified_rebuild: {
    id: "rag_index_verified_rebuild",
    risk: "low",
    sideEffect: "replace derived local RAG index after candidate verification",
    stopCondition: "candidate integrity or query comparison must not regress",
    rollbackHint: "restore the prior derived index or rebuild from canonical sources"
  },
  discord_notification_retry: {
    id: "discord_notification_retry",
    risk: "low",
    sideEffect: "authorize one retry of one failed Discord watchdog notification",
    stopCondition: "only the first failed attempt is retryable",
    rollbackHint: "remove retry authorization and leave the notification pending"
  },
  stale_runtime_lock_recovery_plan: {
    id: "stale_runtime_lock_recovery_plan",
    risk: "low",
    sideEffect: "write a local recovery plan without clearing the runtime lock",
    stopCondition: "runtime lock ownership must remain unchanged",
    rollbackHint: "delete the derived plan artifact"
  },
  read_only_helper_health_plan: {
    id: "read_only_helper_health_plan",
    risk: "low",
    sideEffect: "write a local health plan without starting Board or HTTP helpers",
    stopCondition: "no helper process may be started",
    rollbackHint: "delete the derived plan artifact"
  }
};

const approvalType = "self_healing";
const runIdPattern = /^SHR-[0-9a-f]{20}$/u;

export async function inspectSelfHealingRunbook(
  projectRoot: string,
  runbookId: string,
  options: {
    targetId?: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  } = {},
  dependencies: SelfHealingDependencies = {}
): Promise<SelfHealingInspection> {
  if (!isSelfHealingRunbookId(runbookId)) {
    throw new Error(`Unknown self-healing runbook: ${runbookId}`);
  }
  const now = options.now ?? new Date();
  return (dependencies.inspect ?? inspectInternalRunbook)(
    projectRoot,
    runbookId,
    options.targetId,
    now,
    options.env ?? process.env
  );
}

export async function planSelfHealingRunbook(
  projectRoot: string,
  runbookId: string,
  options: {
    targetId?: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  } = {},
  dependencies: SelfHealingDependencies = {}
): Promise<SelfHealingRunArtifact> {
  if (!isSelfHealingRunbookId(runbookId)) {
    throw new Error(`Unknown self-healing runbook: ${runbookId}`);
  }
  const now = options.now ?? new Date();
  const policy = await resolveSelfHealingPolicy(projectRoot);
  const actionPolicy = policy.actions[runbookId];
  if (!actionPolicy.enabled) {
    throw new Error(`Self-healing runbook is disabled by policy: ${runbookId}`);
  }
  const inspection = await inspectSelfHealingRunbook(
    projectRoot,
    runbookId,
    options,
    dependencies
  );
  if (inspection.status === "ineligible") {
    throw new Error(
      `Self-healing precondition is not eligible: ${runbookId} (${inspection.reason})`
    );
  }

  const definition = definitions[runbookId];
  const idempotencyKey = hashValue(
    [
      inspection.incident_fingerprint,
      runbookId,
      inspection.target_id,
      inspection.source_digest
    ].join(":")
  );
  const runId = `SHR-${idempotencyKey.slice(0, 20)}`;
  const existing = await readOptionalSelfHealingRun(projectRoot, runId);
  if (existing !== null) {
    return existing;
  }

  const incident = await attachIncidentResource(projectRoot, {
    fingerprint: inspection.incident_fingerprint,
    severity: inspection.severity,
    title: inspection.title,
    summary: inspection.summary,
    resource: {
      kind: "self_healing_runbook",
      id: runId,
      status: "discovered",
      artifactPath: selfHealingRunProjectPath(runId),
      fingerprint: idempotencyKey,
      details: {
        runbook_id: runbookId,
        target_id: inspection.target_id,
        risk: definition.risk
      }
    },
    event:
      inspection.status === "ambiguous"
        ? "self_healing.suspended"
        : "self_healing.planned",
    now
  });

  const priorRuns = (await listSelfHealingRuns(projectRoot)).filter(
    (run) =>
      run.incident_id === incident.incident_id &&
      run.runbook_id === runbookId
  );
  const priorAttempts = priorRuns.reduce(
    (total, run) => total + run.attempts.length,
    0
  );
  const latestAttempt = priorRuns
    .flatMap((run) => run.attempts)
    .sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
  const cooldownActive =
    latestAttempt !== undefined &&
    now.getTime() <
      Date.parse(latestAttempt.started_at) +
        actionPolicy.cooldown_seconds * 1_000;
  const budgetExceeded = priorAttempts >= actionPolicy.max_attempts;
  const riskApproval = selfHealingRiskRequiresApproval(
    definition.risk,
    policy.approval_threshold
  );
  const approvalRequired =
    inspection.status === "ambiguous" ||
    cooldownActive ||
    budgetExceeded ||
    riskApproval;
  const suspensionReason =
    inspection.status === "ambiguous"
      ? "ambiguous_precondition"
      : budgetExceeded
        ? "attempt_budget_exceeded"
        : cooldownActive
          ? "cooldown_active"
          : riskApproval
            ? "risk_approval_required"
            : undefined;
  const approval = approvalRequired
    ? await createSelfHealingApproval(
        projectRoot,
        incident,
        runId,
        runbookId,
        inspection.source_digest,
        suspensionReason ?? "approval_required",
        now
      )
    : undefined;
  const status: SelfHealingRunStatus = approvalRequired
    ? "suspended"
    : "planned";
  const run: SelfHealingRunArtifact = {
    schema_version: "0.1",
    artifact_kind: "self_healing_runbook",
    run_id: runId,
    runbook_id: runbookId,
    incident_id: incident.incident_id,
    correlation_id: incident.correlation_id,
    incident_fingerprint: inspection.incident_fingerprint,
    status,
    mode: policy.mode,
    risk: definition.risk,
    target_id: inspection.target_id,
    source_digest: inspection.source_digest,
    before_digest: inspection.before_digest,
    idempotency_key: idempotencyKey,
    dry_run: true,
    action: {
      type: runbookId,
      side_effect: definition.sideEffect,
      stop_condition: definition.stopCondition,
      rollback_hint: definition.rollbackHint
    },
    policy: {
      max_attempts: actionPolicy.max_attempts,
      cooldown_seconds: actionPolicy.cooldown_seconds,
      time_budget_seconds: actionPolicy.time_budget_seconds,
      approval_threshold: policy.approval_threshold
    },
    precondition: {
      status: inspection.status,
      reason: inspection.reason,
      details: inspection.details
    },
    attempts: [],
    approval_required: approvalRequired,
    approval_id: approval?.id,
    suspension_reason: status === "suspended" ? suspensionReason : undefined,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  await writeSelfHealingRun(projectRoot, run);
  await persistRunAndIncident(
    projectRoot,
    run,
    run.status === "suspended"
      ? "self_healing.suspended"
      : "self_healing.planned",
    now
  );
  if (approval !== undefined) {
    await attachIncidentResource(projectRoot, {
      fingerprint: inspection.incident_fingerprint,
      severity: inspection.severity,
      title: inspection.title,
      summary: inspection.summary,
      resource: {
        kind: "approval",
        id: approval.id,
        status: approval.status,
        artifactPath: `.kairon/approvals/${approval.id}.json`,
        details: { approval_type: approvalType, run_id: runId }
      },
      now
    });
  }
  return run;
}

export async function executeSelfHealingRunbook(
  projectRoot: string,
  runId: string,
  input: {
    confirm: string;
    approvalId?: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  },
  dependencies: SelfHealingDependencies = {}
): Promise<SelfHealingRunArtifact> {
  assertRunId(runId);
  if (input.confirm !== runId) {
    throw new Error(`Self-healing confirmation must exactly match ${runId}.`);
  }
  const now = input.now ?? new Date();
  let run = await readSelfHealingRun(projectRoot, runId);
  if (run.status === "completed") {
    return run;
  }
  if (run.status === "running") {
    return suspendInterruptedRun(projectRoot, run, now);
  }

  const policy = await resolveSelfHealingPolicy(projectRoot);
  const actionPolicy = policy.actions[run.runbook_id];
  if (policy.mode !== "bounded_auto") {
    return suspendRun(projectRoot, run, "notify_only", now);
  }
  if (!actionPolicy.enabled) {
    return suspendRun(projectRoot, run, "action_disabled", now);
  }
  if (
    run.attempts.length >= actionPolicy.max_attempts &&
    !run.approval_required
  ) {
    const approval = await createSelfHealingApprovalForRun(
      projectRoot,
      run,
      "attempt_budget_exceeded",
      now
    );
    return suspendRun(
      projectRoot,
      {
        ...run,
        approval_required: true,
        approval_id: approval.id
      },
      "attempt_budget_exceeded",
      now
    );
  }
  const latestAttempt = run.attempts.at(-1);
  const cooldownUntil =
    latestAttempt === undefined
      ? undefined
      : Date.parse(latestAttempt.started_at) +
        actionPolicy.cooldown_seconds * 1_000;
  if (
    !run.approval_required &&
    cooldownUntil !== undefined &&
    now.getTime() < cooldownUntil
  ) {
    return suspendRun(projectRoot, run, "cooldown_active", now);
  }
  if (run.approval_required) {
    await assertSelfHealingApproval(
      projectRoot,
      run,
      input.approvalId ?? run.approval_id
    );
  }

  const inspection = await inspectSelfHealingRunbook(
    projectRoot,
    run.runbook_id,
    {
      targetId: run.target_id,
      now,
      env: input.env
    },
    dependencies
  );
  if (
    inspection.status !== "eligible" ||
    inspection.source_digest !== run.source_digest ||
    inspection.before_digest !== run.before_digest
  ) {
    const approval = await createSelfHealingApprovalForRun(
      projectRoot,
      run,
      "precondition_drift",
      now
    );
    return suspendRun(
      projectRoot,
      {
        ...run,
        approval_required: true,
        approval_id: approval.id
      },
      "precondition_drift",
      now
    );
  }

  const attempt: SelfHealingAttempt = {
    attempt: run.attempts.length + 1,
    status: "running",
    started_at: now.toISOString(),
    before_digest: inspection.before_digest
  };
  run = {
    ...run,
    status: "running",
    dry_run: false,
    attempts: [...run.attempts, attempt],
    updated_at: now.toISOString(),
    suspension_reason: undefined
  };
  await persistRunAndIncident(projectRoot, run, "self_healing.running", now);

  const startedAt = Date.now();
  try {
    const outcome = await (dependencies.execute ?? executeInternalRunbook)(
      projectRoot,
      run,
      inspection,
      now,
      input.env ?? process.env
    );
    const elapsedSeconds = Math.ceil((Date.now() - startedAt) / 1_000);
    const passed =
      outcome.success && elapsedSeconds <= actionPolicy.time_budget_seconds;
    const finishedAt = new Date(
      Math.max(now.getTime(), Date.now())
    ).toISOString();
    const completedAttempt: SelfHealingAttempt = {
      ...attempt,
      status: passed ? "completed" : "failed",
      finished_at: finishedAt,
      after_digest: outcome.after_digest,
      reason: passed
        ? undefined
        : elapsedSeconds > actionPolicy.time_budget_seconds
          ? "time_budget_exceeded"
          : normalizeReason(projectRoot, outcome.reason)
    };
    run = {
      ...run,
      status: passed ? "completed" : "failed",
      postcondition: {
        status: passed ? "passed" : "failed",
        after_digest: outcome.after_digest,
        reason:
          elapsedSeconds > actionPolicy.time_budget_seconds
            ? "time_budget_exceeded"
            : normalizeReason(projectRoot, outcome.reason)
      },
      attempts: [...run.attempts.slice(0, -1), completedAttempt],
      updated_at: finishedAt
    };
    await persistRunAndIncident(
      projectRoot,
      run,
      passed ? "self_healing.completed" : "self_healing.failed",
      new Date(finishedAt)
    );
    return run;
  } catch (error) {
    const finishedAt = new Date(
      Math.max(now.getTime(), Date.now())
    ).toISOString();
    const reason = normalizeReason(projectRoot, String(error));
    run = {
      ...run,
      status: "failed",
      postcondition: {
        status: "failed",
        reason
      },
      attempts: [
        ...run.attempts.slice(0, -1),
        {
          ...attempt,
          status: "failed",
          finished_at: finishedAt,
          reason
        }
      ],
      updated_at: finishedAt
    };
    await persistRunAndIncident(
      projectRoot,
      run,
      "self_healing.failed",
      new Date(finishedAt)
    );
    return run;
  }
}

export async function runBoundedSelfHealingTick(
  projectRoot: string,
  options: {
    now?: Date;
    env?: NodeJS.ProcessEnv;
  } = {},
  dependencies: SelfHealingDependencies = {}
): Promise<SelfHealingTickResult> {
  const policy = await resolveSelfHealingPolicy(projectRoot);
  if (policy.mode !== "bounded_auto") {
    return { status: "disabled", reason: "notify_only" };
  }
  const now = options.now ?? new Date();
  for (const runbookId of selfHealingRunbookIds) {
    if (!policy.actions[runbookId].enabled) {
      continue;
    }
    const inspection = await inspectSelfHealingRunbook(
      projectRoot,
      runbookId,
      { now, env: options.env },
      dependencies
    );
    if (inspection.status === "ineligible") {
      continue;
    }
    const run = await planSelfHealingRunbook(
      projectRoot,
      runbookId,
      {
        targetId: inspection.target_id,
        now,
        env: options.env
      },
      dependencies
    );
    if (run.status === "completed") {
      continue;
    }
    if (run.status === "suspended" || run.approval_required) {
      return {
        status: "suspended",
        run_id: run.run_id,
        runbook_id: run.runbook_id,
        reason: run.suspension_reason ?? "approval_required"
      };
    }
    const executed = await executeSelfHealingRunbook(
      projectRoot,
      run.run_id,
      {
        confirm: run.run_id,
        now,
        env: options.env
      },
      dependencies
    );
    return {
      status: executed.status,
      run_id: executed.run_id,
      runbook_id: executed.runbook_id,
      reason:
        executed.postcondition?.reason ?? executed.suspension_reason
    };
  }
  return { status: "idle" };
}

export async function listSelfHealingRuns(
  projectRoot: string
): Promise<SelfHealingRunArtifact[]> {
  const directory = selfHealingDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => runIdPattern.test(path.basename(entry, ".json")))
      .map((entry) =>
        readJsonFile<SelfHealingRunArtifact>(resolveInside(directory, entry))
      )
  );
  return runs.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at)
  );
}

export async function readSelfHealingRun(
  projectRoot: string,
  runId: string
): Promise<SelfHealingRunArtifact> {
  assertRunId(runId);
  return readJsonFile<SelfHealingRunArtifact>(
    selfHealingRunPath(projectRoot, runId)
  );
}

export function formatSelfHealingInspection(
  inspection: SelfHealingInspection
): string {
  return [
    "Kairon self-healing runbook inspection.",
    `runbook_id=${inspection.runbook_id}`,
    `status=${inspection.status}`,
    `reason=${inspection.reason}`,
    `target_id=${inspection.target_id}`,
    `source_digest=${inspection.source_digest}`,
    `details=${JSON.stringify(inspection.details)}`
  ].join("\n");
}

export function formatSelfHealingRun(run: SelfHealingRunArtifact): string {
  return [
    run.status === "planned"
      ? "Kairon self-healing runbook planned."
      : "Kairon self-healing runbook result.",
    `run_id=${run.run_id}`,
    `runbook_id=${run.runbook_id}`,
    `incident_id=${run.incident_id}`,
    `status=${run.status}`,
    `mode=${run.mode}`,
    `risk=${run.risk}`,
    `target_id=${run.target_id}`,
    `dry_run=${run.dry_run}`,
    `approval_required=${run.approval_required}`,
    `approval_id=${run.approval_id ?? "none"}`,
    `attempts=${run.attempts.length}`,
    `confirm=${run.run_id}`,
    `suspension_reason=${run.suspension_reason ?? "none"}`,
    `postcondition=${run.postcondition?.status ?? "pending"}`
  ].join("\n");
}

async function inspectInternalRunbook(
  projectRoot: string,
  runbookId: SelfHealingRunbookId,
  targetId: string | undefined,
  now: Date,
  env: NodeJS.ProcessEnv
): Promise<SelfHealingInspection> {
  switch (runbookId) {
    case "workflow_checkpoint_index_rebuild":
      return inspectWorkflowCheckpointRunbook(projectRoot, now, env);
    case "rag_index_verified_rebuild":
      return inspectRagRunbook(projectRoot, now);
    case "discord_notification_retry":
      return inspectDiscordRetryRunbook(projectRoot, targetId);
    case "stale_runtime_lock_recovery_plan":
      return inspectStaleLockRunbook(projectRoot, targetId, now);
    case "read_only_helper_health_plan":
      return inspectHelperHealthRunbook(projectRoot, targetId);
  }
}

async function executeInternalRunbook(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  _inspection: SelfHealingInspection,
  now: Date,
  env: NodeJS.ProcessEnv
): Promise<{ success: boolean; reason: string; after_digest: string }> {
  switch (run.runbook_id) {
    case "workflow_checkpoint_index_rebuild": {
      const planned = await planWorkflowCheckpointRebuild(projectRoot, env, {
        now: () => now
      });
      await executeWorkflowCheckpointRebuild(
        projectRoot,
        planned.rebuild_id,
        env,
        { now: () => now }
      );
      const verification = await verifyWorkflowCheckpointStore(
        projectRoot,
        env,
        { now: () => now }
      );
      return {
        success: verification.status === "verified",
        reason:
          verification.status === "verified"
            ? "checkpoint_index_verified"
            : "checkpoint_postcondition_failed",
        after_digest: hashObject(checkpointDigestInput(verification))
      };
    }
    case "rag_index_verified_rebuild": {
      const planned = await planRagRebuild(projectRoot, { now });
      if (planned.status !== "ready") {
        return {
          success: false,
          reason: "rag_candidate_blocked",
          after_digest: hashObject({
            status: planned.status,
            reasons: planned.comparison.reasons
          })
        };
      }
      await executeRagRebuild(projectRoot, planned.rebuild_id, {
        confirm: planned.rebuild_id,
        now
      });
      const verification = await verifyRagIndex(projectRoot, {
        now,
        writeArtifact: true
      });
      return {
        success: verification.status === "PASS",
        reason:
          verification.status === "PASS"
            ? "rag_index_verified"
            : "rag_postcondition_failed",
        after_digest: hashObject(ragDigestInput(verification))
      };
    }
    case "discord_notification_retry": {
      const alert = await authorizeWatchdogNotificationRetry(
        projectRoot,
        run.target_id,
        { authorizationId: run.run_id, now }
      );
      return {
        success:
          alert.pending_notification?.retry_authorization_id === run.run_id,
        reason: "discord_retry_authorized",
        after_digest: hashObject({
          alert_id: alert.alert_id,
          event: alert.pending_notification?.event,
          attempts: alert.pending_notification?.attempts,
          retry_authorization_id:
            alert.pending_notification?.retry_authorization_id
        })
      };
    }
    case "stale_runtime_lock_recovery_plan":
    case "read_only_helper_health_plan":
      return {
        success: true,
        reason: "local_plan_created",
        after_digest: hashObject({
          run_id: run.run_id,
          target_id: run.target_id,
          side_effect: "none"
        })
      };
  }
}

async function inspectWorkflowCheckpointRunbook(
  projectRoot: string,
  now: Date,
  env: NodeJS.ProcessEnv
): Promise<SelfHealingInspection> {
  try {
    const verification = await verifyWorkflowCheckpointStore(
      projectRoot,
      env,
      { now: () => now, persistHealth: false }
    );
    const digestInput = checkpointDigestInput(verification);
    return inspection({
      runbookId: "workflow_checkpoint_index_rebuild",
      status:
        verification.status === "mismatch" && verification.rebuild_required
          ? "eligible"
          : verification.status === "failed"
            ? "ambiguous"
            : "ineligible",
      reason:
        verification.status === "mismatch" && verification.rebuild_required
          ? "derived_index_mismatch"
          : verification.status === "failed"
            ? "canonical_checkpoint_integrity_failed"
            : "checkpoint_index_healthy",
      targetId: "workflow-checkpoint-sqlite",
      fingerprint: "self-healing:workflow-checkpoint-sqlite",
      severity: verification.status === "failed" ? "high" : "warning",
      title: "Workflow checkpoint mirror recovery",
      summary:
        "Derived workflow checkpoint mirror requires bounded verification.",
      digestInput,
      details: {
        status: verification.status,
        rebuild_required: verification.rebuild_required,
        issues: verification.summary.issues,
        canonical_errors: verification.summary.canonical_errors
      }
    });
  } catch {
    return ambiguousInspection(
      "workflow_checkpoint_index_rebuild",
      "workflow-checkpoint-sqlite",
      "self-healing:workflow-checkpoint-sqlite",
      "checkpoint_inspection_failed"
    );
  }
}

async function inspectRagRunbook(
  projectRoot: string,
  now: Date
): Promise<SelfHealingInspection> {
  const config = await loadConfigFile<{ enabled?: boolean }>(
    projectRoot,
    "rag.json"
  );
  if (config.enabled !== true) {
    return ineligibleInspection(
      "rag_index_verified_rebuild",
      "local-rag-index",
      "self-healing:local-rag-index",
      "rag_disabled"
    );
  }
  const verification = await verifyRagIndex(projectRoot, {
    now,
    writeArtifact: false
  });
  const digestInput = ragDigestInput(verification);
  return inspection({
    runbookId: "rag_index_verified_rebuild",
    status:
      verification.status === "UNPASSED"
        ? "eligible"
        : verification.status === "SETUP_REQUIRED"
          ? "ambiguous"
          : "ineligible",
    reason:
      verification.status === "UNPASSED"
        ? "derived_rag_index_unpassed"
        : verification.status === "SETUP_REQUIRED"
          ? "rag_setup_required"
          : "rag_index_healthy",
    targetId: "local-rag-index",
    fingerprint: "self-healing:local-rag-index",
    severity: verification.status === "SETUP_REQUIRED" ? "high" : "warning",
    title: "Local RAG index recovery",
    summary: "Derived RAG index requires a verified bounded rebuild.",
    digestInput,
    details: {
      status: verification.status,
      issue_count: verification.issue_count,
      source_count: verification.source_count,
      chunk_count: verification.chunk_count
    }
  });
}

async function inspectDiscordRetryRunbook(
  projectRoot: string,
  targetId: string | undefined
): Promise<SelfHealingInspection> {
  const alerts = await listWatchdogAlerts(projectRoot);
  const alert =
    targetId === undefined
      ? alerts.find(
          (candidate) =>
            candidate.pending_notification?.attempts === 1 &&
            candidate.pending_notification.last_error !== undefined &&
            candidate.pending_notification.retry_authorized_at === undefined
        )
      : alerts.find((candidate) => candidate.alert_id === targetId);
  if (alert === undefined) {
    return ineligibleInspection(
      "discord_notification_retry",
      targetId ?? "none",
      "self-healing:discord-notification:none",
      "no_failed_notification"
    );
  }
  const pending = alert.pending_notification;
  const eligible =
    pending?.attempts === 1 &&
    pending.last_error !== undefined &&
    pending.retry_authorized_at === undefined;
  const digestInput = {
    alert_id: alert.alert_id,
    event: pending?.event ?? "none",
    attempts: pending?.attempts ?? 0,
    has_error: pending?.last_error !== undefined,
    retry_authorized: pending?.retry_authorized_at !== undefined
  };
  return inspection({
    runbookId: "discord_notification_retry",
    status: eligible ? "eligible" : "ineligible",
    reason: eligible ? "first_delivery_failed" : "retry_not_eligible",
    targetId: alert.alert_id,
    fingerprint: alert.fingerprint,
    severity: alert.severity,
    title: "Discord watchdog notification retry",
    summary: "One failed watchdog notification is eligible for one retry.",
    digestInput,
    details: {
      attempts: pending?.attempts ?? 0,
      has_error: pending?.last_error !== undefined,
      retry_authorized: pending?.retry_authorized_at !== undefined
    }
  });
}

async function inspectStaleLockRunbook(
  projectRoot: string,
  targetId: string | undefined,
  now: Date
): Promise<SelfHealingInspection> {
  const inspectionResult = await inspectRuntimeRecoveryTargets(projectRoot, {
    now
  });
  const issue = inspectionResult.issues.find(
    (candidate) =>
      candidate.kind === "stale_lock" &&
      (targetId === undefined ||
        candidate.target_id === targetId ||
        candidate.fingerprint === targetId)
  );
  if (issue === undefined) {
    return ineligibleInspection(
      "stale_runtime_lock_recovery_plan",
      targetId ?? "runtime-lock",
      "self-healing:runtime-lock",
      "no_stale_runtime_lock"
    );
  }
  return staleLockInspection(issue);
}

async function inspectHelperHealthRunbook(
  projectRoot: string,
  targetId: string | undefined
): Promise<SelfHealingInspection> {
  const helpers = targetId === undefined
    ? ["board", "discord-http"]
    : [targetId];
  for (const helper of helpers) {
    const statusPath =
      helper === "board"
        ? resolveInside(
            getKaironPaths(projectRoot).runtimeDir,
            "board",
            "server.json"
          )
        : helper === "discord-http"
          ? resolveInside(
              getKaironPaths(projectRoot).runtimeDir,
              "discord",
              "http-server.json"
            )
          : null;
    if (statusPath === null) {
      continue;
    }
    const status = await readOptionalRecord(statusPath);
    const state =
      typeof status?.status === "string" ? status.status : "missing";
    if (!["ready", "running"].includes(state)) {
      return inspection({
        runbookId: "read_only_helper_health_plan",
        status: "eligible",
        reason: "read_only_helper_stopped",
        targetId: helper,
        fingerprint: `self-healing:helper:${helper}`,
        severity: "info",
        title: "Read-only helper health plan",
        summary: "A stopped local read-only helper has a local health plan.",
        digestInput: { helper, state },
        details: { helper, state }
      });
    }
  }
  return ineligibleInspection(
    "read_only_helper_health_plan",
    targetId ?? "helpers",
    `self-healing:helper:${targetId ?? "all"}`,
    "read_only_helpers_healthy"
  );
}

function staleLockInspection(issue: RuntimeRecoveryIssue): SelfHealingInspection {
  return inspection({
    runbookId: "stale_runtime_lock_recovery_plan",
    status: "eligible",
    reason: "stale_runtime_lock_detected",
    targetId: issue.target_id,
    fingerprint: issue.fingerprint,
    severity: issue.severity === "medium" ? "warning" : issue.severity,
    title: "Stale runtime lock recovery plan",
    summary:
      "A stale runtime lock requires an operator-verifiable recovery plan.",
    digestInput: {
      fingerprint: issue.fingerprint,
      kind: issue.kind,
      severity: issue.severity
    },
    details: {
      kind: issue.kind,
      severity: issue.severity
    }
  });
}

function checkpointDigestInput(verification: {
  status: string;
  configured_store: string;
  canonical_records: number;
  indexed_records: number;
  rebuild_required: boolean;
  summary: {
    issues: number;
    missing_rows: number;
    orphan_rows: number;
    mismatched_rows: number;
    canonical_errors: number;
  };
  issues: Array<{ kind: string }>;
}): Record<string, unknown> {
  return {
    status: verification.status,
    configured_store: verification.configured_store,
    canonical_records: verification.canonical_records,
    indexed_records: verification.indexed_records,
    rebuild_required: verification.rebuild_required,
    summary: verification.summary,
    issue_kinds: verification.issues.map((issue) => issue.kind).sort()
  };
}

function ragDigestInput(verification: {
  status: string;
  index_checksum?: string;
  source_manifest_checksum?: string;
  source_count: number;
  chunk_count: number;
  issues: Array<{ code: string }>;
}): Record<string, unknown> {
  return {
    status: verification.status,
    index_checksum: verification.index_checksum ?? "none",
    source_manifest_checksum:
      verification.source_manifest_checksum ?? "none",
    source_count: verification.source_count,
    chunk_count: verification.chunk_count,
    issue_codes: verification.issues.map((issue) => issue.code).sort()
  };
}

function inspection(input: {
  runbookId: SelfHealingRunbookId;
  status: SelfHealingInspectionStatus;
  reason: string;
  targetId: string;
  fingerprint: string;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  digestInput: Record<string, unknown>;
  details: Record<string, string | number | boolean>;
}): SelfHealingInspection {
  const digest = hashObject(input.digestInput);
  return {
    runbook_id: input.runbookId,
    status: input.status,
    reason: input.reason,
    target_id: input.targetId,
    incident_fingerprint: input.fingerprint,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    source_digest: digest,
    before_digest: digest,
    details: input.details
  };
}

function ineligibleInspection(
  runbookId: SelfHealingRunbookId,
  targetId: string,
  fingerprint: string,
  reason: string
): SelfHealingInspection {
  return inspection({
    runbookId,
    status: "ineligible",
    reason,
    targetId,
    fingerprint,
    severity: "info",
    title: "Self-healing runbook",
    summary: "No eligible bounded recovery target was found.",
    digestInput: { runbookId, targetId, reason },
    details: { eligible: false }
  });
}

function ambiguousInspection(
  runbookId: SelfHealingRunbookId,
  targetId: string,
  fingerprint: string,
  reason: string
): SelfHealingInspection {
  return inspection({
    runbookId,
    status: "ambiguous",
    reason,
    targetId,
    fingerprint,
    severity: "high",
    title: "Self-healing inspection requires operator review",
    summary: "The bounded recovery precondition could not be verified.",
    digestInput: { runbookId, targetId, reason },
    details: { ambiguous: true }
  });
}

async function persistRunAndIncident(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  event: Extract<
    IncidentTimelineEvent["event"],
    | "self_healing.planned"
    | "self_healing.running"
    | "self_healing.completed"
    | "self_healing.suspended"
    | "self_healing.failed"
  >,
  now: Date
): Promise<void> {
  await writeSelfHealingRun(projectRoot, run);
  await attachIncidentResource(projectRoot, {
    fingerprint: run.incident_fingerprint,
    severity: toIncidentSeverity(run.risk),
    title: `Self-healing: ${run.runbook_id}`,
    summary: `Bounded self-healing runbook is ${run.status}.`,
    resource: {
      kind: "self_healing_runbook",
      id: run.run_id,
      status: run.status,
      artifactPath: selfHealingRunProjectPath(run.run_id),
      fingerprint: run.idempotency_key,
      details: {
        runbook_id: run.runbook_id,
        target_id: run.target_id,
        attempts: run.attempts.length,
        postcondition: run.postcondition?.status ?? "pending"
      }
    },
    event,
    now
  });
}

async function suspendInterruptedRun(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  now: Date
): Promise<SelfHealingRunArtifact> {
  const approval = await createSelfHealingApprovalForRun(
    projectRoot,
    run,
    "interrupted_run",
    now
  );
  return suspendRun(
    projectRoot,
    { ...run, approval_required: true, approval_id: approval.id },
    "interrupted_run",
    now
  );
}

async function suspendRun(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  reason: string,
  now: Date
): Promise<SelfHealingRunArtifact> {
  const suspended: SelfHealingRunArtifact = {
    ...run,
    status: "suspended",
    suspension_reason: reason,
    updated_at: now.toISOString()
  };
  await persistRunAndIncident(
    projectRoot,
    suspended,
    "self_healing.suspended",
    now
  );
  return suspended;
}

async function createSelfHealingApprovalForRun(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  reason: string,
  now: Date
): Promise<ApprovalRecord> {
  const incident: IncidentArtifact = {
    schema_version: "0.1",
    artifact_kind: "incident",
    incident_id: run.incident_id,
    fingerprint: run.incident_fingerprint,
    correlation_id: run.correlation_id,
    status: "recovering",
    severity: toIncidentSeverity(run.risk),
    title: `Self-healing: ${run.runbook_id}`,
    summary: `Bounded self-healing runbook requires approval: ${reason}.`,
    resources: [],
    recurrence_count: 0,
    created_at: run.created_at,
    updated_at: now.toISOString()
  };
  return createSelfHealingApproval(
    projectRoot,
    incident,
    run.run_id,
    run.runbook_id,
    run.source_digest,
    reason,
    now
  );
}

async function createSelfHealingApproval(
  projectRoot: string,
  incident: IncidentArtifact,
  runId: string,
  runbookId: SelfHealingRunbookId,
  sourceDigest: string,
  reason: string,
  now: Date
): Promise<ApprovalRecord> {
  const queue = new ApprovalQueue(projectRoot);
  const existing = (await queue.list({ status: "all" })).find(
    (approval) =>
      approval.type === approvalType &&
      approval.self_healing_run_id === runId &&
      ["pending", "snoozed", "decided"].includes(approval.status)
  );
  if (existing !== undefined) {
    return existing;
  }
  const approvalId = await nextId(projectRoot, "approval");
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    actor: "self-healing",
    payload: {
      approval: {
        id: approvalId,
        type: approvalType,
        title: `Self-healing approval: ${runbookId}`,
        actions: ["approve", "reject", "request_changes", "snooze"],
        incident_id: incident.incident_id,
        correlation_id: incident.correlation_id,
        self_healing_run_id: runId,
        self_healing_runbook_id: runbookId,
        self_healing_source_digest: sourceDigest,
        self_healing_reason: reason,
        created_at: now.toISOString()
      }
    }
  });
  return queue.show(approvalId);
}

async function assertSelfHealingApproval(
  projectRoot: string,
  run: SelfHealingRunArtifact,
  approvalId: string | undefined
): Promise<void> {
  if (approvalId === undefined) {
    throw new Error(`Self-healing approval is required: ${run.run_id}`);
  }
  const approval = await new ApprovalQueue(projectRoot).show(approvalId);
  if (
    approval.status !== "decided" ||
    approval.decision !== "approve" ||
    approval.type !== approvalType ||
    approval.self_healing_run_id !== run.run_id ||
    approval.self_healing_runbook_id !== run.runbook_id ||
    approval.self_healing_source_digest !== run.source_digest
  ) {
    throw new Error(`Self-healing approval is not valid: ${approvalId}`);
  }
}

async function writeSelfHealingRun(
  projectRoot: string,
  run: SelfHealingRunArtifact
): Promise<void> {
  await mkdir(selfHealingDirectory(projectRoot), { recursive: true });
  await writeJsonFileAtomic(selfHealingRunPath(projectRoot, run.run_id), run);
}

async function readOptionalSelfHealingRun(
  projectRoot: string,
  runId: string
): Promise<SelfHealingRunArtifact | null> {
  try {
    return await readSelfHealingRun(projectRoot, runId);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      String(error).includes("ENOENT")
    ) {
      return null;
    }
    throw error;
  }
}

async function readOptionalRecord(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonFile<Record<string, unknown>>(filePath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      String(error).includes("ENOENT")
    ) {
      return null;
    }
    throw error;
  }
}

function selfHealingDirectory(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).recoveryDir,
    "self-healing"
  );
}

function selfHealingRunPath(projectRoot: string, runId: string): string {
  assertRunId(runId);
  return resolveInside(selfHealingDirectory(projectRoot), `${runId}.json`);
}

function selfHealingRunProjectPath(runId: string): string {
  assertRunId(runId);
  return `.kairon/recovery/self-healing/${runId}.json`;
}

function assertRunId(value: string): void {
  if (!runIdPattern.test(value)) {
    throw new Error(`Invalid self-healing run id: ${value}`);
  }
}

function hashObject(value: unknown): string {
  return hashValue(JSON.stringify(value));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeReason(projectRoot: string, reason: string): string {
  return sanitizeSupportText(reason, { projectRoot }).slice(0, 240);
}

function toIncidentSeverity(risk: SelfHealingRisk): IncidentSeverity {
  return risk === "low"
    ? "warning"
    : risk === "medium"
      ? "high"
      : risk;
}
