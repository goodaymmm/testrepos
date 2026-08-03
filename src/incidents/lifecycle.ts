import { createHash } from "node:crypto";
import path from "node:path";
import { ApprovalQueue, type ApprovalRecord } from "../approvals/approval-queue.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import {
  createSupportBundle,
  planSupportBundle,
  type SupportBundleDependencies,
  type SupportBundleResult
} from "../diagnostics/support-bundle.js";
import {
  inspectRuntimeRecoveryTargets,
  runRuntimeRecovery,
  type RuntimeRecoveryIssue,
  type RuntimeRecoveryResult
} from "../recovery/runtime-recovery.js";
import {
  getWatchdogAlert,
  listWatchdogAlerts,
  type WatchdogAlert
} from "../runtime/watchdog.js";
import { StateApplier } from "../state/state-applier.js";
import {
  acknowledgeIncident as acknowledgeIncidentStore,
  attachIncidentResource,
  getIncident,
  incidentArtifactPath,
  listIncidents,
  readIncidentTimeline,
  resolveIncident as resolveIncidentStore,
  updateIncidentRecovery,
  updateIncidentResource,
  type IncidentArtifact,
  type IncidentSeverity,
  type IncidentTimelineEvent
} from "./store.js";

export type IncidentRecoveryAction = {
  fingerprint: string;
  target_id: string;
  target_type: RuntimeRecoveryIssue["target_type"];
  issue_kind: RuntimeRecoveryIssue["kind"];
  severity: RuntimeRecoveryIssue["severity"];
  action:
    | "clear_stale_runtime_lock"
    | "requeue_expired_claim"
    | "reset_stale_discord_gateway"
    | "request_manual_recovery";
  risk: "medium" | "high";
};

export type IncidentRecoveryPlan = {
  schema_version: "0.1";
  artifact_kind: "incident_recovery_plan";
  plan_id: string;
  incident_id: string;
  correlation_id: string;
  status: "planned" | "executed";
  source_digest: string;
  target_fingerprints: string[];
  actions: IncidentRecoveryAction[];
  risk: "medium" | "high";
  approval_id: string;
  confirmation: string;
  created_at: string;
  expires_at: string;
  executed_at?: string;
  recovery_id?: string;
  verification_status?: "passed" | "failed";
};

export type IncidentRecoveryExecution = {
  plan: IncidentRecoveryPlan;
  recovery: RuntimeRecoveryResult;
  incident: IncidentArtifact;
  status: "completed" | "partial";
  remaining_fingerprints: string[];
};

export type IncidentBundleResult = {
  incident: IncidentArtifact;
  bundle: SupportBundleResult;
};

export type IncidentDetail = {
  incident: IncidentArtifact;
  timeline: IncidentTimelineEvent[];
};

const incidentRecoveryApprovalType = "incident_recovery";
const incidentRecoveryPlanTtlMs = 30 * 60 * 1000;

export async function reconcileIncidentSources(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<IncidentArtifact[]> {
  const now = options.now ?? new Date();
  const [alerts, recovery] = await Promise.all([
    listWatchdogAlerts(projectRoot),
    inspectRuntimeRecoveryTargets(projectRoot, { now })
  ]);
  const recoveryByFingerprint = new Map(
    recovery.issues.map((issue) => [issue.fingerprint, issue])
  );

  for (const alert of alerts) {
    if (alert.status === "resolved") {
      await updateIncidentResource(projectRoot, {
        kind: "watchdog_alert",
        id: alert.alert_id,
        status: "resolved",
        now
      });
      continue;
    }
    await attachWatchdogAlert(projectRoot, alert, now);
  }

  for (const issue of recovery.issues) {
    await attachRecoveryTarget(projectRoot, issue, now);
  }

  for (const incident of await listIncidents(projectRoot)) {
    for (const resource of incident.resources) {
      if (resource.kind === "watchdog_alert") {
        const alert = alerts.find((candidate) => candidate.alert_id === resource.id);
        await updateIncidentResource(projectRoot, {
          kind: resource.kind,
          id: resource.id,
          status: alert?.status ?? "resolved",
          now
        });
      }
      if (resource.kind === "recovery_target") {
        const active =
          resource.fingerprint === undefined
            ? undefined
            : recoveryByFingerprint.get(resource.fingerprint);
        await updateIncidentResource(projectRoot, {
          kind: resource.kind,
          id: resource.id,
          fingerprint: resource.fingerprint,
          status: active === undefined ? "resolved" : "open",
          now
        });
      }
    }
  }

  return listIncidents(projectRoot);
}

export async function listIncidentLifecycle(
  projectRoot: string,
  options: { status?: IncidentArtifact["status"] | "all"; now?: Date } = {}
): Promise<IncidentArtifact[]> {
  await reconcileIncidentSources(projectRoot, { now: options.now });
  return listIncidents(projectRoot, { status: options.status });
}

export async function showIncidentLifecycle(
  projectRoot: string,
  incidentId: string,
  options: { now?: Date } = {}
): Promise<IncidentDetail> {
  await reconcileIncidentSources(projectRoot, options);
  return {
    incident: await getIncident(projectRoot, incidentId),
    timeline: await readIncidentTimeline(projectRoot, incidentId)
  };
}

export async function acknowledgeIncidentLifecycle(
  projectRoot: string,
  incidentId: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<IncidentArtifact> {
  await reconcileIncidentSources(projectRoot, options);
  return acknowledgeIncidentStore(projectRoot, incidentId, reason, options);
}

export async function resolveIncidentLifecycle(
  projectRoot: string,
  incidentId: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<IncidentArtifact> {
  await reconcileIncidentSources(projectRoot, options);
  const incident = await getIncident(projectRoot, incidentId);
  const blockers = incidentResolutionBlockers(incident);
  if (blockers.length > 0) {
    throw new Error(
      `Incident cannot be resolved while active issues remain: ${blockers.join(", ")}`
    );
  }
  return resolveIncidentStore(projectRoot, incidentId, reason, options);
}

export async function bundleIncidentLifecycle(
  projectRoot: string,
  incidentId: string,
  options: {
    dryRun?: boolean;
    outputDirectory?: string;
    now?: Date;
  } = {},
  dependencies: SupportBundleDependencies = {}
): Promise<IncidentBundleResult> {
  if (options.dryRun !== true) {
    await reconcileIncidentSources(projectRoot, { now: options.now });
  }
  const incident = await getIncident(projectRoot, incidentId);
  const bundleOptions = {
    outputDirectory: options.outputDirectory,
    incidentId
  };
  const bundle =
    options.dryRun === true
      ? await planSupportBundle(projectRoot, bundleOptions, {
          ...dependencies,
          ...(options.now === undefined ? {} : { now: () => options.now! })
        })
      : await createSupportBundle(projectRoot, bundleOptions, {
          ...dependencies,
          ...(options.now === undefined ? {} : { now: () => options.now! })
        });
  if (bundle.plan.status === "completed" && bundle.plan.archive !== undefined) {
    const updated = await attachIncidentResource(projectRoot, {
      fingerprint: incident.fingerprint,
      severity: incident.severity,
      title: incident.title,
      summary: incident.summary,
      resource: {
        kind: "support_bundle",
        id: bundle.plan.bundle_id,
        status: "completed",
        artifactPath: `.kairon/support/plans/${bundle.plan.bundle_id}.json`,
        details: {
          archive_sha256: bundle.plan.archive.sha256,
          archive_size_bytes: bundle.plan.archive.size_bytes
        }
      },
      event: "bundle.created",
      now: options.now
    });
    return { incident: updated, bundle };
  }
  return { incident, bundle };
}

export async function planIncidentRecovery(
  projectRoot: string,
  incidentId: string,
  options: { now?: Date } = {}
): Promise<IncidentRecoveryPlan> {
  const now = options.now ?? new Date();
  await reconcileIncidentSources(projectRoot, { now });
  const incident = await getIncident(projectRoot, incidentId);
  const issues = await currentIncidentRecoveryIssues(projectRoot, incident, now);
  if (issues.length === 0) {
    throw new Error(`Incident has no active recovery targets: ${incidentId}`);
  }

  const actions = issues.map(toRecoveryAction);
  const sourceDigest = recoverySourceDigest(issues);
  const activePlan =
    incident.recovery?.status === "planned"
      ? await readOptionalRecoveryPlan(projectRoot, incident.recovery.plan_id)
      : null;
  if (
    activePlan !== null &&
    activePlan.status === "planned" &&
    activePlan.source_digest === sourceDigest &&
    Date.parse(activePlan.expires_at) > now.getTime()
  ) {
    return activePlan;
  }

  const basePlanId = recoveryPlanId(incidentId, sourceDigest);
  const basePlan = await readOptionalRecoveryPlan(projectRoot, basePlanId);
  const planId =
    basePlan === null
      ? basePlanId
      : recoveryPlanId(
          incidentId,
          createHash("sha256")
            .update(`${sourceDigest}:${now.toISOString()}`)
            .digest("hex")
        );
  const existing = await readOptionalRecoveryPlan(projectRoot, planId);
  if (
    existing !== null &&
    existing.status === "planned" &&
    Date.parse(existing.expires_at) > now.getTime()
  ) {
    return existing;
  }

  const approval = await createIncidentRecoveryApproval(
    projectRoot,
    incident,
    planId,
    sourceDigest,
    issues,
    now
  );
  const plan: IncidentRecoveryPlan = {
    schema_version: "0.1",
    artifact_kind: "incident_recovery_plan",
    plan_id: planId,
    incident_id: incidentId,
    correlation_id: incident.correlation_id,
    status: "planned",
    source_digest: sourceDigest,
    target_fingerprints: issues.map((issue) => issue.fingerprint).sort(),
    actions,
    risk: actions.some((action) => action.risk === "high") ? "high" : "medium",
    approval_id: approval.id,
    confirmation: planId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + incidentRecoveryPlanTtlMs).toISOString()
  };
  await writeJsonFileAtomic(incidentRecoveryPlanPath(projectRoot, planId), plan);
  await attachIncidentResource(projectRoot, {
    fingerprint: incident.fingerprint,
    severity: incident.severity,
    title: incident.title,
    summary: incident.summary,
    resource: {
      kind: "recovery_plan",
      id: planId,
      status: "planned",
      artifactPath: recoveryPlanProjectPath(planId),
      details: {
        source_digest: sourceDigest,
        risk: plan.risk,
        target_count: plan.target_fingerprints.length
      }
    },
    event: "recovery.planned",
    now
  });
  await attachIncidentResource(projectRoot, {
    fingerprint: incident.fingerprint,
    severity: incident.severity,
    title: incident.title,
    summary: incident.summary,
    resource: {
      kind: "approval",
      id: approval.id,
      status: approval.status,
      artifactPath: `.kairon/approvals/${approval.id}.json`,
      details: { approval_type: incidentRecoveryApprovalType }
    },
    now
  });
  await updateIncidentRecovery(
    projectRoot,
    incidentId,
    {
      plan_id: planId,
      status: "planned",
      approval_id: approval.id,
      verification_status: "pending",
      updated_at: now.toISOString()
    },
    "recovery.planned",
    {
      details: {
        source_digest: sourceDigest,
        target_count: plan.target_fingerprints.length
      },
      now
    }
  );
  return plan;
}

export async function executeIncidentRecovery(
  projectRoot: string,
  incidentId: string,
  input: {
    approvalId: string;
    confirm: string;
    now?: Date;
  }
): Promise<IncidentRecoveryExecution> {
  const now = input.now ?? new Date();
  const plan = await readRecoveryPlan(projectRoot, input.confirm);
  if (plan.incident_id !== incidentId || plan.plan_id !== input.confirm) {
    throw new Error("Incident recovery confirmation does not match the planned incident.");
  }
  if (plan.status !== "planned") {
    throw new Error(`Incident recovery plan was already executed: ${plan.plan_id}`);
  }
  if (input.approvalId !== plan.approval_id) {
    throw new Error("Incident recovery approval does not match the plan.");
  }
  if (Date.parse(plan.expires_at) <= now.getTime()) {
    throw new Error(`Incident recovery plan is stale: ${plan.plan_id}`);
  }

  const approval = await new ApprovalQueue(projectRoot).show(input.approvalId);
  assertIncidentRecoveryApproval(approval, plan);
  await reconcileIncidentSources(projectRoot, { now });
  const incident = await getIncident(projectRoot, incidentId);
  const issues = await currentIncidentRecoveryIssues(projectRoot, incident, now);
  if (recoverySourceDigest(issues) !== plan.source_digest) {
    throw new Error(`Incident recovery target freshness check failed: ${plan.plan_id}`);
  }

  await updateIncidentResource(projectRoot, {
    kind: "approval",
    id: approval.id,
    status: approval.status,
    now
  });
  await updateIncidentRecovery(
    projectRoot,
    incidentId,
    {
      plan_id: plan.plan_id,
      status: "running",
      approval_id: approval.id,
      verification_status: "pending",
      updated_at: now.toISOString()
    },
    "recovery.started",
    { now }
  );

  try {
    const recovery = await runRuntimeRecovery(projectRoot, {
      now,
      targetFingerprints: plan.target_fingerprints
    });
    const verificationTime = new Date(now.getTime() + 1);
    await reconcileIncidentSources(projectRoot, { now: verificationTime });
    const current = await getIncident(projectRoot, incidentId);
    const remaining = (
      await currentIncidentRecoveryIssues(projectRoot, current, verificationTime)
    )
      .map((issue) => issue.fingerprint)
      .filter((fingerprint) => plan.target_fingerprints.includes(fingerprint))
      .sort();
    const status = remaining.length === 0 ? "completed" : "partial";
    const executedPlan: IncidentRecoveryPlan = {
      ...plan,
      status: "executed",
      executed_at: verificationTime.toISOString(),
      recovery_id: recovery.recovery_id,
      verification_status: "passed"
    };
    await writeJsonFileAtomic(
      incidentRecoveryPlanPath(projectRoot, plan.plan_id),
      executedPlan
    );
    await attachIncidentResource(projectRoot, {
      fingerprint: current.fingerprint,
      severity: current.severity,
      title: current.title,
      summary: current.summary,
      resource: {
        kind: "recovery_plan",
        id: plan.plan_id,
        status: "executed",
        artifactPath: recoveryPlanProjectPath(plan.plan_id)
      },
      event: status === "completed" ? "recovery.completed" : "recovery.partial",
      now: verificationTime
    });
    await attachIncidentResource(projectRoot, {
      fingerprint: current.fingerprint,
      severity: current.severity,
      title: current.title,
      summary: current.summary,
      resource: {
        kind: "recovery_result",
        id: recovery.recovery_id,
        status,
        artifactPath: recovery.artifact_path,
        details: {
          remaining_fingerprints: remaining,
          actions: recovery.actions.map((action) => action.type)
        }
      },
      event: status === "completed" ? "recovery.completed" : "recovery.partial",
      now: verificationTime
    });
    const updated = await updateIncidentRecovery(
      projectRoot,
      incidentId,
      {
        plan_id: plan.plan_id,
        status,
        approval_id: approval.id,
        recovery_id: recovery.recovery_id,
        verification_status: "passed",
        updated_at: verificationTime.toISOString()
      },
      status === "completed" ? "recovery.completed" : "recovery.partial",
      {
        details: { remaining_fingerprints: remaining },
        now: verificationTime
      }
    );
    return {
      plan: executedPlan,
      recovery,
      incident: updated,
      status,
      remaining_fingerprints: remaining
    };
  } catch (error) {
    await updateIncidentRecovery(
      projectRoot,
      incidentId,
      {
        plan_id: plan.plan_id,
        status: "failed",
        approval_id: approval.id,
        verification_status: "failed",
        updated_at: now.toISOString()
      },
      "recovery.failed",
      {
        reason: error instanceof Error ? error.message : String(error),
        now
      }
    );
    throw error;
  }
}

export async function attachWatchdogAlert(
  projectRoot: string,
  alert: WatchdogAlert,
  now: Date = new Date()
): Promise<IncidentArtifact> {
  return attachIncidentResource(projectRoot, {
    fingerprint: alert.fingerprint,
    severity: watchdogSeverity(alert.severity),
    title: alert.title,
    summary: alert.summary,
    resource: {
      kind: "watchdog_alert",
      id: alert.alert_id,
      status: alert.status,
      artifactPath: `.kairon/watchdog/alerts/${alert.alert_id}.json`,
      fingerprint: alert.fingerprint,
      severity: watchdogSeverity(alert.severity),
      details: { rule: alert.rule, resource: alert.resource }
    },
    now
  });
}

export async function attachRecoveryTarget(
  projectRoot: string,
  issue: RuntimeRecoveryIssue,
  now: Date = new Date()
): Promise<IncidentArtifact> {
  return attachIncidentResource(projectRoot, {
    fingerprint: issue.fingerprint,
    severity: recoverySeverity(issue.severity),
    title: `Runtime recovery: ${issue.kind}`,
    summary: issue.reason,
    resource: {
      kind: "recovery_target",
      id: issue.target_id,
      status: "open",
      fingerprint: issue.fingerprint,
      severity: recoverySeverity(issue.severity),
      details: {
        issue_kind: issue.kind,
        target_type: issue.target_type
      }
    },
    now
  });
}

export function incidentRecoveryPlanPath(
  projectRoot: string,
  planId: string
): string {
  validateRecoveryPlanId(planId);
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "incidents",
    "plans",
    `${planId}.json`
  );
}

function incidentResolutionBlockers(incident: IncidentArtifact): string[] {
  const blockers = incident.resources
    .filter(
      (resource) =>
        (resource.kind === "watchdog_alert" ||
          resource.kind === "recovery_target") &&
        !["resolved", "completed", "passed"].includes(resource.status)
    )
    .map((resource) => `${resource.kind}:${resource.id}:${resource.status}`);
  if (incident.recovery?.verification_status === "failed") {
    blockers.push(`recovery_verification:${incident.recovery.plan_id}:failed`);
  }
  return blockers;
}

async function currentIncidentRecoveryIssues(
  projectRoot: string,
  incident: IncidentArtifact,
  now: Date
): Promise<RuntimeRecoveryIssue[]> {
  const fingerprints = new Set(
    incident.resources
      .filter((resource) => resource.kind === "recovery_target")
      .map((resource) => resource.fingerprint)
      .filter((value): value is string => value !== undefined)
  );
  const inspection = await inspectRuntimeRecoveryTargets(projectRoot, { now });
  return inspection.issues
    .filter((issue) => fingerprints.has(issue.fingerprint))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

async function createIncidentRecoveryApproval(
  projectRoot: string,
  incident: IncidentArtifact,
  planId: string,
  sourceDigest: string,
  issues: RuntimeRecoveryIssue[],
  now: Date
): Promise<ApprovalRecord> {
  const existing = (await new ApprovalQueue(projectRoot).list({ status: "all" })).find(
    (approval) =>
      approval.type === incidentRecoveryApprovalType &&
      approval.incident_id === incident.incident_id &&
      approval.recovery_plan_id === planId &&
      ["pending", "snoozed", "decided"].includes(approval.status)
  );
  if (existing !== undefined) {
    return existing;
  }
  const approvalId = await nextId(projectRoot, "approval");
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    actor: "incident-recovery",
    payload: {
      approval: {
        id: approvalId,
        type: incidentRecoveryApprovalType,
        title: `Incident recovery approval: ${incident.incident_id}`,
        actions: ["approve", "reject", "request_changes", "snooze"],
        incident_id: incident.incident_id,
        correlation_id: incident.correlation_id,
        recovery_plan_id: planId,
        recovery_source_digest: sourceDigest,
        recovery_fingerprints: issues.map((issue) => issue.fingerprint).sort()
      }
    }
  });
  return new ApprovalQueue(projectRoot).show(approvalId);
}

function assertIncidentRecoveryApproval(
  approval: ApprovalRecord,
  plan: IncidentRecoveryPlan
): void {
  if (
    approval.status !== "decided" ||
    approval.decision !== "approve" ||
    approval.type !== incidentRecoveryApprovalType ||
    approval.incident_id !== plan.incident_id ||
    approval.recovery_plan_id !== plan.plan_id ||
    approval.recovery_source_digest !== plan.source_digest
  ) {
    throw new Error(`Incident recovery approval is not valid: ${approval.id}`);
  }
}

function toRecoveryAction(issue: RuntimeRecoveryIssue): IncidentRecoveryAction {
  const action: IncidentRecoveryAction["action"] =
    issue.kind === "stale_lock"
      ? "clear_stale_runtime_lock"
      : issue.kind === "claimed_timeout" && issue.severity === "medium"
        ? "requeue_expired_claim"
        : issue.kind === "discord_gateway_starting"
          ? "reset_stale_discord_gateway"
          : "request_manual_recovery";
  return {
    fingerprint: issue.fingerprint,
    target_id: issue.target_id,
    target_type: issue.target_type,
    issue_kind: issue.kind,
    severity: issue.severity,
    action,
    risk: issue.severity === "high" ? "high" : "medium"
  };
}

function recoverySourceDigest(issues: RuntimeRecoveryIssue[]): string {
  const normalized = issues
    .map((issue) => ({
      fingerprint: issue.fingerprint,
      kind: issue.kind,
      target_id: issue.target_id,
      target_type: issue.target_type,
      severity: issue.severity
    }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function recoveryPlanId(incidentId: string, sourceDigest: string): string {
  return `IRP-${incidentId}-${sourceDigest.slice(0, 12)}`;
}

function recoveryPlanProjectPath(planId: string): string {
  validateRecoveryPlanId(planId);
  return `.kairon/incidents/plans/${planId}.json`;
}

async function readRecoveryPlan(
  projectRoot: string,
  planId: string
): Promise<IncidentRecoveryPlan> {
  try {
    return await readJsonFile<IncidentRecoveryPlan>(
      incidentRecoveryPlanPath(projectRoot, planId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      throw new Error(`Incident recovery plan was not found: ${planId}`);
    }
    throw error;
  }
}

async function readOptionalRecoveryPlan(
  projectRoot: string,
  planId: string
): Promise<IncidentRecoveryPlan | null> {
  try {
    return await readRecoveryPlan(projectRoot, planId);
  } catch (error) {
    if (String(error).includes("was not found")) {
      return null;
    }
    throw error;
  }
}

function validateRecoveryPlanId(value: string): void {
  if (!/^IRP-INC-\d{4}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error(`Invalid incident recovery plan id: ${value}`);
  }
}

function watchdogSeverity(
  value: WatchdogAlert["severity"]
): IncidentSeverity {
  return value;
}

function recoverySeverity(
  value: RuntimeRecoveryIssue["severity"]
): IncidentSeverity {
  return value === "medium" ? "warning" : "high";
}

export function incidentArtifactProjectPath(
  projectRoot: string,
  incidentId: string
): string {
  return toPosixPath(
    path.relative(
      getKaironPaths(projectRoot).root,
      incidentArtifactPath(projectRoot, incidentId)
    )
  );
}
