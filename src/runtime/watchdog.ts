import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { listProviderPolicyHealth } from "../agents/provider-policy.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { appendJsonLine, readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { withResourceLock } from "../core/fs/resource-lock.js";
import { nextId } from "../core/ids/counter.js";
import {
  sanitizeSupportText,
  sanitizeSupportValue
} from "../diagnostics/support-redaction.js";
import { WorkQueue } from "../queue/work-queue.js";
import { attachIncidentResource } from "../incidents/store.js";
import { readRuntimeLockStatus } from "./runtime-lock.js";
import { getStoredStableRemoteStatus } from "../remote/status.js";
import { readLatestSloSummary } from "../observability/slo.js";
import { recordAlertPolicyDecision } from "../observability/runtime-metrics.js";
import type {
  AlertPolicyDecisionKind,
  AlertPolicyReason
} from "../notifications/alert-policy.js";
import {
  compareWatchdogSeverity,
  defaultWatchdogPolicy,
  evaluateWatchdogRules,
  type WatchdogFinding,
  type WatchdogPolicy,
  type WatchdogRuleId,
  type WatchdogRuleInput,
  type WatchdogRulePolicy,
  type WatchdogSeverity
} from "./watchdog-rules.js";

export type WatchdogAlertStatus = "open" | "acknowledged" | "resolved";
export type WatchdogNotificationEvent = "open" | "escalated" | "reminder" | "resolved";

export type WatchdogPendingNotification = {
  event: WatchdogNotificationEvent;
  queued_at: string;
  attempts: number;
  last_error?: string;
  retry_authorized_at?: string;
  retry_authorization_id?: string;
  idempotency_key?: string;
  policy_decision?: AlertPolicyDecisionKind;
  suppression_reason?: AlertPolicyReason;
  route_id?: string;
  defer_until?: string;
};

export type WatchdogNotificationPolicyRecord = {
  event: WatchdogNotificationEvent;
  decision: AlertPolicyDecisionKind;
  reason: AlertPolicyReason;
  evaluated_at: string;
  idempotency_key: string;
  route_id?: string;
  defer_until?: string;
};

export type WatchdogAlert = {
  schema_version: "0.1";
  alert_id: string;
  project_id: string;
  fingerprint: string;
  rule: WatchdogRuleId;
  resource: string;
  severity: WatchdogSeverity;
  status: WatchdogAlertStatus;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  cooldown_seconds: number;
  occurrence_count: number;
  recurrence_count: number;
  first_detected_at: string;
  last_detected_at: string;
  updated_at: string;
  last_notified_at?: string;
  cooldown_until?: string;
  pending_notification?: WatchdogPendingNotification;
  last_notification_policy?: WatchdogNotificationPolicyRecord;
  acknowledged_at?: string;
  resolved_at?: string;
  resolution_reason?: string;
};

export type WatchdogState = {
  schema_version: "0.1";
  check_count: number;
  active_fingerprints: Record<string, string>;
  last_checked_at?: string;
  last_result?: WatchdogCheckSummary;
};

export type WatchdogCheckSummary = {
  findings: number;
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
  open: number;
  acknowledged: number;
  highest_severity: WatchdogSeverity | "none";
  notifications_pending: number;
};

export type WatchdogCheckResult = {
  schema_version: "0.1";
  status: "completed" | "disabled";
  checked_at: string;
  summary: WatchdogCheckSummary;
  alerts: WatchdogAlert[];
  state_path: string;
};

export type WatchdogAlertSummary = {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  highest_severity: WatchdogSeverity | "none";
  notifications_pending: number;
  last_checked_at?: string;
};

export type WatchdogRuntimeConfig = {
  watchdog?: {
    enabled?: boolean;
    cooldown_seconds?: number;
    rules?: Partial<
      Record<
        WatchdogRuleId,
        Partial<WatchdogRulePolicy> & {
          threshold_seconds?: number;
        }
      >
    >;
  };
};

export type WatchdogCheckOptions = {
  now?: Date;
  input?: WatchdogRuleInput;
  policy?: WatchdogPolicy;
};

const emptyCheckSummary: WatchdogCheckSummary = {
  findings: 0,
  created: 0,
  updated: 0,
  reopened: 0,
  resolved: 0,
  open: 0,
  acknowledged: 0,
  highest_severity: "none",
  notifications_pending: 0
};

export async function runWatchdogCheck(
  projectRoot: string,
  options: WatchdogCheckOptions = {}
): Promise<WatchdogCheckResult> {
  const now = options.now ?? new Date();
  const policy =
    options.policy ??
    normalizeWatchdogPolicy(
      await loadConfigFile<WatchdogRuntimeConfig>(projectRoot, "runtime.json")
    );
  if (!policy.enabled) {
    return {
      schema_version: "0.1",
      status: "disabled",
      checked_at: now.toISOString(),
      summary: await currentCheckSummary(projectRoot, emptyCheckSummary),
      alerts: [],
      state_path: toProjectPath(projectRoot, watchdogStatePath(projectRoot))
    };
  }

  const input = options.input ?? (await collectWatchdogRuleInput(projectRoot, now));
  const findings = evaluateWatchdogRules(input, policy);
  return applyWatchdogFindings(projectRoot, input.project_id, findings, now);
}

export async function listWatchdogAlerts(
  projectRoot: string,
  options: { status?: WatchdogAlertStatus } = {}
): Promise<WatchdogAlert[]> {
  const directory = watchdogAlertsDirectory(projectRoot);
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const alerts = await Promise.all(
    entries
      .filter((entry) => /^ALT-\d{4,}\.json$/u.test(entry))
      .map((entry) => readJsonFile<WatchdogAlert>(resolveInside(directory, entry)))
  );
  return alerts
    .filter((alert) => options.status === undefined || alert.status === options.status)
    .sort(compareAlerts);
}

export async function getWatchdogAlert(
  projectRoot: string,
  alertId: string
): Promise<WatchdogAlert> {
  assertAlertId(alertId);
  return readJsonFile<WatchdogAlert>(watchdogAlertPath(projectRoot, alertId));
}

export async function resolveWatchdogAlert(
  projectRoot: string,
  alertId: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<WatchdogAlert> {
  assertAlertId(alertId);
  const normalizedReason = sanitizeSupportText(reason.trim(), { projectRoot });
  if (normalizedReason.length === 0) {
    throw new Error("Watchdog resolve reason is required.");
  }
  const now = options.now ?? new Date();

  return withWatchdogLock(projectRoot, now, async () => {
    const alert = await getWatchdogAlert(projectRoot, alertId);
    if (alert.status === "resolved") {
      return alert;
    }
    const updated: WatchdogAlert = {
      ...alert,
      status: "resolved",
      updated_at: now.toISOString(),
      resolved_at: now.toISOString(),
      resolution_reason: normalizedReason,
      pending_notification: queueNotification("resolved", now, alertId)
    };
    await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), updated);
    await syncWatchdogIncident(projectRoot, updated, now);
    await appendWatchdogAudit(projectRoot, {
      event: "alert.resolved",
      alert_id: alertId,
      rule: alert.rule,
      resource: alert.resource,
      actor: "local-cli",
      reason: normalizedReason,
      created_at: now.toISOString()
    });
    return updated;
  });
}

export async function recordWatchdogNotificationPolicy(
  projectRoot: string,
  alertId: string,
  input: {
    event: WatchdogNotificationEvent;
    decision: AlertPolicyDecisionKind;
    reason: AlertPolicyReason;
    idempotencyKey: string;
    routeId?: string;
    deferUntil?: string;
    now?: Date;
  }
): Promise<WatchdogAlert> {
  assertAlertId(alertId);
  const now = input.now ?? new Date();
  return withWatchdogLock(projectRoot, now, async () => {
    const alert = await getWatchdogAlert(projectRoot, alertId);
    const pending = alert.pending_notification;
    if (pending === undefined || pending.event !== input.event) {
      return alert;
    }
    const record: WatchdogNotificationPolicyRecord = {
      event: input.event,
      decision: input.decision,
      reason: input.reason,
      evaluated_at: now.toISOString(),
      idempotency_key: input.idempotencyKey,
      ...(input.routeId === undefined ? {} : { route_id: input.routeId }),
      ...(input.deferUntil === undefined
        ? {}
        : { defer_until: input.deferUntil })
    };
    const unchanged =
      pending.policy_decision === input.decision &&
      pending.suppression_reason === input.reason &&
      pending.route_id === input.routeId &&
      pending.defer_until === input.deferUntil &&
      pending.idempotency_key === input.idempotencyKey;
    if (unchanged) {
      return alert;
    }
    const updated: WatchdogAlert = {
      ...alert,
      updated_at: now.toISOString(),
      pending_notification: {
        ...pending,
        idempotency_key: input.idempotencyKey,
        policy_decision: input.decision,
        suppression_reason: input.reason,
        route_id: input.routeId,
        defer_until: input.deferUntil
      },
      last_notification_policy: record
    };
    await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), updated);
    await syncWatchdogIncident(projectRoot, updated, now, "notification.policy");
    await appendWatchdogAudit(projectRoot, {
      event: "notification.policy",
      alert_id: alertId,
      notification_event: input.event,
      decision: input.decision,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
      route_id: input.routeId,
      defer_until: input.deferUntil,
      created_at: now.toISOString()
    });
    try {
      await recordAlertPolicyDecision(projectRoot, {
        decision: input.decision,
        reason: input.reason,
        recordedAt: now
      });
    } catch {
      // Metrics are derived diagnostics and must not block canonical alert state.
    }
    return updated;
  });
}

export async function markWatchdogNotification(
  projectRoot: string,
  alertId: string,
  input: {
    event: WatchdogNotificationEvent;
    status: "sent" | "failed" | "suppressed";
    messageId?: string;
    reason?: string;
    now?: Date;
  }
): Promise<WatchdogAlert> {
  assertAlertId(alertId);
  const now = input.now ?? new Date();
  return withWatchdogLock(projectRoot, now, async () => {
    const alert = await getWatchdogAlert(projectRoot, alertId);
    const pending = alert.pending_notification;
    if (pending === undefined || pending.event !== input.event) {
      return alert;
    }

    const updated: WatchdogAlert =
      input.status === "sent"
        ? {
            ...alert,
            updated_at: now.toISOString(),
            last_notified_at: now.toISOString(),
            cooldown_until: new Date(
              now.getTime() + watchdogCooldownSeconds(alert) * 1_000
            ).toISOString(),
            pending_notification: undefined
          }
        : input.status === "suppressed"
          ? {
              ...alert,
              updated_at: now.toISOString(),
              pending_notification: undefined
            }
          : {
            ...alert,
            updated_at: now.toISOString(),
            pending_notification: {
              ...pending,
              attempts: pending.attempts + 1,
              retry_authorized_at: undefined,
              retry_authorization_id: undefined,
              last_error: sanitizeSupportText(input.reason ?? "notification_failed", {
                projectRoot
              })
            }
          };
    await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), updated);
    await appendWatchdogAudit(projectRoot, {
      event: `notification.${input.status}`,
      alert_id: alertId,
      notification_event: input.event,
      message_id: input.messageId,
      reason:
        input.reason === undefined
          ? undefined
          : sanitizeSupportText(input.reason, { projectRoot }),
      created_at: now.toISOString()
    });
    return updated;
  });
}

export async function authorizeWatchdogNotificationRetry(
  projectRoot: string,
  alertId: string,
  input: {
    authorizationId: string;
    now?: Date;
  }
): Promise<WatchdogAlert> {
  assertAlertId(alertId);
  const now = input.now ?? new Date();
  return withWatchdogLock(projectRoot, now, async () => {
    const alert = await getWatchdogAlert(projectRoot, alertId);
    const pending = alert.pending_notification;
    if (
      pending === undefined ||
      pending.attempts !== 1 ||
      pending.last_error === undefined
    ) {
      throw new Error(
        `Watchdog notification is not eligible for one bounded retry: ${alertId}`
      );
    }
    const authorizationId = sanitizeSupportText(input.authorizationId, {
      projectRoot
    });
    if (
      pending.retry_authorization_id === authorizationId &&
      pending.retry_authorized_at !== undefined
    ) {
      return alert;
    }
    const updated: WatchdogAlert = {
      ...alert,
      updated_at: now.toISOString(),
      pending_notification: {
        ...pending,
        retry_authorized_at: now.toISOString(),
        retry_authorization_id: authorizationId
      }
    };
    await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), updated);
    await appendWatchdogAudit(projectRoot, {
      event: "notification.retry_authorized",
      alert_id: alertId,
      notification_event: pending.event,
      authorization_id: authorizationId,
      created_at: now.toISOString()
    });
    return updated;
  });
}

export async function readWatchdogAuditRecords(
  projectRoot: string
): Promise<Record<string, unknown>[]> {
  try {
    return await readJsonLines<Record<string, unknown>>(
      watchdogAuditPath(projectRoot)
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

export async function readWatchdogAlertSummary(
  projectRoot: string
): Promise<WatchdogAlertSummary> {
  const [alerts, state] = await Promise.all([
    listWatchdogAlerts(projectRoot),
    readWatchdogState(projectRoot)
  ]);
  return {
    total: alerts.length,
    open: alerts.filter((alert) => alert.status === "open").length,
    acknowledged: alerts.filter((alert) => alert.status === "acknowledged").length,
    resolved: alerts.filter((alert) => alert.status === "resolved").length,
    highest_severity: highestSeverity(
      alerts.filter((alert) => alert.status !== "resolved")
    ),
    notifications_pending: alerts.filter(
      (alert) => alert.pending_notification !== undefined
    ).length,
    last_checked_at: state.last_checked_at
  };
}

export function normalizeWatchdogPolicy(
  runtimeConfig: WatchdogRuntimeConfig
): WatchdogPolicy {
  const configured = runtimeConfig.watchdog;
  const rules = Object.fromEntries(
    (Object.keys(defaultWatchdogPolicy.rules) as WatchdogRuleId[]).map((rule) => {
      const override = configured?.rules?.[rule];
      const threshold =
        override?.threshold_seconds ??
        override?.threshold ??
        defaultWatchdogPolicy.rules[rule].threshold;
      return [
        rule,
        {
          ...defaultWatchdogPolicy.rules[rule],
          ...override,
          threshold
        }
      ];
    })
  ) as Record<WatchdogRuleId, WatchdogRulePolicy>;

  return {
    enabled: configured?.enabled ?? defaultWatchdogPolicy.enabled,
    cooldown_seconds:
      configured?.cooldown_seconds ?? defaultWatchdogPolicy.cooldown_seconds,
    rules
  };
}

export function sanitizeWatchdogError(
  projectRoot: string,
  error: unknown
): { code?: string; message: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? sanitizeSupportText(String((error as { code?: unknown }).code), { projectRoot })
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: sanitizeSupportText(message, { projectRoot })
  };
}

async function collectWatchdogRuleInput(
  projectRoot: string,
  now: Date
): Promise<WatchdogRuleInput> {
  const [
    project,
    lock,
    queueItems,
    providers,
    daemonEvents,
    notificationRecords,
    scheduler,
    remoteStatus,
    sloSummary
  ] =
    await Promise.all([
      loadConfigFile<{ project_id?: string }>(projectRoot, "project.json"),
      readRuntimeLockStatus(projectRoot, { now }),
      new WorkQueue(projectRoot).list(),
      listProviderPolicyHealth(projectRoot, { now, persist: false }),
      readRecentDaemonEvents(projectRoot),
      readNotificationRecords(projectRoot),
      readTaskSchedulerStatus(projectRoot),
      getStoredStableRemoteStatus(projectRoot),
      readLatestSloSummary(projectRoot)
    ]);
  const latestDaemonEvent = daemonEvents
    .slice()
    .sort((left, right) => eventTime(right) - eventTime(left))[0];
  const daemonStatus =
    latestDaemonEvent?.event === "fatal_error" ||
    (latestDaemonEvent?.event === "stopped" &&
      latestDaemonEvent.stop_reason === "fatal_error")
      ? "fatal_error"
      : latestDaemonEvent?.event === "started" || latestDaemonEvent?.event === "tick"
        ? "running"
        : latestDaemonEvent?.event === "stopped"
          ? "stopped"
          : "unknown";

  return {
    project_id: project.project_id ?? path.basename(projectRoot),
    now: now.toISOString(),
    runtime: {
      locked: lock.locked,
      mode: lock.locked ? lock.data.mode : undefined,
      heartbeat_at: lock.locked ? lock.data.heartbeat_at : undefined,
      stale: lock.locked ? lock.stale : undefined,
      daemon_status: daemonStatus,
      fatal_error_count: daemonStatus === "fatal_error" ? 1 : 0,
      last_error_code:
        latestDaemonEvent?.event === "fatal_error"
          ? optionalNestedString(latestDaemonEvent, ["error", "code"])
          : optionalNestedString(latestDaemonEvent, ["last_error", "code"])
    },
    daemon_start_times: daemonEvents
      .filter((event) => event.event === "started")
      .map((event) => optionalString(event.created_at))
      .filter((value): value is string => value !== undefined),
    queue: {
      ready: queueItems.filter((item) => item.status === "ready").length
    },
    failed_notification_times: notificationRecords
      .filter((record) => record.status === "failed")
      .map((record) =>
        optionalString(record.recorded_at) ??
        optionalString(record.created_at) ??
        optionalString(record.updated_at)
      )
      .filter((value): value is string => value !== undefined),
    providers: providers.map((provider) => ({
      id: provider.agent,
      status: provider.status,
      reason: provider.suspended_reason ?? provider.last_reason ?? undefined
    })),
    task_scheduler: scheduler,
    remote:
      remoteStatus === undefined
        ? undefined
        : {
            configured: remoteStatus.profile !== "disabled",
            external_unreachable:
              remoteStatus.discord.external_readiness === "unreachable" ||
              remoteStatus.board.external_readiness === "unreachable",
            identity_bypass: remoteStatus.identity.status === "bypass_detected",
            url_drift:
              remoteStatus.discord.url_drift || remoteStatus.board.url_drift,
            tunnel_disconnected: remoteStatus.tunnel.status === "disconnected"
          },
    slo:
      sloSummary === undefined
        ? undefined
        : {
            status: sloSummary.status,
            evaluated_at: sloSummary.evaluated_at
          }
  };
}

async function applyWatchdogFindings(
  projectRoot: string,
  projectId: string,
  findings: WatchdogFinding[],
  now: Date
): Promise<WatchdogCheckResult> {
  return withWatchdogLock(projectRoot, now, async () => {
    const state = await readWatchdogState(projectRoot);
    const foundFingerprints = new Set(findings.map((finding) => finding.fingerprint));
    const changedAlerts: WatchdogAlert[] = [];
    const counts = {
      created: 0,
      updated: 0,
      reopened: 0,
      resolved: 0
    };

    for (const finding of findings) {
      const existingId = state.active_fingerprints[finding.fingerprint];
      const existing =
        existingId === undefined
          ? undefined
          : await readOptionalAlert(projectRoot, existingId);
      if (existing === undefined) {
        const alertId = await nextId(projectRoot, "watchdog_alert");
        const created = createAlert(projectRoot, projectId, alertId, finding, now);
        state.active_fingerprints[finding.fingerprint] = alertId;
        await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), created);
        await syncWatchdogIncident(projectRoot, created, now);
        changedAlerts.push(created);
        counts.created += 1;
        continue;
      }

      const wasResolved = existing.status === "resolved";
      const severityEscalated =
        compareWatchdogSeverity(finding.severity, existing.severity) > 0;
      const reminderDue =
        !wasResolved &&
        !severityEscalated &&
        existing.pending_notification === undefined &&
        existing.cooldown_until !== undefined &&
        Date.parse(existing.cooldown_until) <= now.getTime();
      const updated: WatchdogAlert = {
        ...existing,
        status: wasResolved ? "open" : existing.status,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        evidence: sanitizeEvidence(projectRoot, finding.evidence),
        cooldown_seconds: finding.cooldown_seconds,
        occurrence_count: existing.occurrence_count + 1,
        recurrence_count: existing.recurrence_count + (wasResolved ? 1 : 0),
        last_detected_at: now.toISOString(),
        updated_at: now.toISOString(),
        resolved_at: wasResolved ? undefined : existing.resolved_at,
        resolution_reason: wasResolved ? undefined : existing.resolution_reason,
        pending_notification: wasResolved
          ? queueNotification("open", now, existing.alert_id)
          : severityEscalated
            ? queueNotification("escalated", now, existing.alert_id)
            : reminderDue
              ? queueNotification("reminder", now, existing.alert_id)
              : existing.pending_notification
      };
      await writeJsonFileAtomic(watchdogAlertPath(projectRoot, existing.alert_id), updated);
      await syncWatchdogIncident(projectRoot, updated, now);
      changedAlerts.push(updated);
      counts.updated += 1;
      counts.reopened += wasResolved ? 1 : 0;
    }

    for (const [fingerprint, alertId] of Object.entries(state.active_fingerprints)) {
      if (foundFingerprints.has(fingerprint)) {
        continue;
      }
      const alert = await readOptionalAlert(projectRoot, alertId);
      if (alert === undefined || alert.status === "resolved") {
        continue;
      }
      const resolved: WatchdogAlert = {
        ...alert,
        status: "resolved",
        resolved_at: now.toISOString(),
        resolution_reason: "condition_recovered",
        updated_at: now.toISOString(),
        pending_notification: queueNotification("resolved", now, alertId)
      };
      await writeJsonFileAtomic(watchdogAlertPath(projectRoot, alertId), resolved);
      await syncWatchdogIncident(projectRoot, resolved, now);
      changedAlerts.push(resolved);
      counts.resolved += 1;
    }

    const alerts = await listWatchdogAlerts(projectRoot);
    const summary = summarizeCheck(alerts, findings.length, counts);
    const nextState: WatchdogState = {
      ...state,
      check_count: state.check_count + 1,
      last_checked_at: now.toISOString(),
      last_result: summary
    };
    await writeJsonFileAtomic(watchdogStatePath(projectRoot), nextState);
    await appendWatchdogAudit(projectRoot, {
      event: "watchdog.checked",
      ...summary,
      created_at: now.toISOString()
    });

    return {
      schema_version: "0.1",
      status: "completed",
      checked_at: now.toISOString(),
      summary,
      alerts: changedAlerts.sort(compareAlerts),
      state_path: toProjectPath(projectRoot, watchdogStatePath(projectRoot))
    };
  });
}

function createAlert(
  projectRoot: string,
  projectId: string,
  alertId: string,
  finding: WatchdogFinding,
  now: Date
): WatchdogAlert {
  return {
    schema_version: "0.1",
    alert_id: alertId,
    project_id: projectId,
    fingerprint: finding.fingerprint,
    rule: finding.rule,
    resource: finding.resource,
    severity: finding.severity,
    status: "open",
    title: sanitizeSupportText(finding.title, { projectRoot }),
    summary: sanitizeSupportText(finding.summary, { projectRoot }),
    evidence: sanitizeEvidence(projectRoot, finding.evidence),
    cooldown_seconds: finding.cooldown_seconds,
    occurrence_count: 1,
    recurrence_count: 0,
    first_detected_at: now.toISOString(),
    last_detected_at: now.toISOString(),
    updated_at: now.toISOString(),
    pending_notification: queueNotification("open", now, alertId)
  };
}

async function syncWatchdogIncident(
  projectRoot: string,
  alert: WatchdogAlert,
  now: Date,
  event?: "notification.policy"
): Promise<void> {
  await attachIncidentResource(projectRoot, {
    fingerprint: alert.fingerprint,
    severity: alert.severity,
    title: alert.title,
    summary: alert.summary,
    resource: {
      kind: "watchdog_alert",
      id: alert.alert_id,
      status: alert.status,
      artifactPath: `.kairon/watchdog/alerts/${alert.alert_id}.json`,
      fingerprint: alert.fingerprint,
      severity: alert.severity,
      details: {
        rule: alert.rule,
        resource: alert.resource,
        ...(alert.last_notification_policy === undefined
          ? {}
          : {
              notification_event: alert.last_notification_policy.event,
              notification_decision: alert.last_notification_policy.decision,
              notification_reason: alert.last_notification_policy.reason,
              defer_until: alert.last_notification_policy.defer_until
            })
      }
    },
    event,
    now
  });
}

function sanitizeEvidence(
  projectRoot: string,
  evidence: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = sanitizeSupportValue(evidence, { projectRoot }).value;
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function queueNotification(
  event: WatchdogNotificationEvent,
  now: Date,
  alertId: string
): WatchdogPendingNotification {
  const queuedAt = now.toISOString();
  return {
    event,
    queued_at: queuedAt,
    attempts: 0,
    idempotency_key: `watchdog:${alertId}:${event}:${queuedAt}`
  };
}

async function currentCheckSummary(
  projectRoot: string,
  base: WatchdogCheckSummary
): Promise<WatchdogCheckSummary> {
  const alerts = await listWatchdogAlerts(projectRoot);
  return summarizeCheck(alerts, base.findings, {
    created: base.created,
    updated: base.updated,
    reopened: base.reopened,
    resolved: base.resolved
  });
}

function summarizeCheck(
  alerts: WatchdogAlert[],
  findings: number,
  counts: {
    created: number;
    updated: number;
    reopened: number;
    resolved: number;
  }
): WatchdogCheckSummary {
  const active = alerts.filter((alert) => alert.status !== "resolved");
  return {
    findings,
    ...counts,
    open: alerts.filter((alert) => alert.status === "open").length,
    acknowledged: alerts.filter((alert) => alert.status === "acknowledged").length,
    highest_severity: highestSeverity(active),
    notifications_pending: alerts.filter(
      (alert) => alert.pending_notification !== undefined
    ).length
  };
}

function highestSeverity(alerts: WatchdogAlert[]): WatchdogSeverity | "none" {
  return alerts.reduce<WatchdogSeverity | "none">((highest, alert) => {
    if (highest === "none") {
      return alert.severity;
    }
    return compareWatchdogSeverity(alert.severity, highest) > 0
      ? alert.severity
      : highest;
  }, "none");
}

async function readWatchdogState(projectRoot: string): Promise<WatchdogState> {
  try {
    return await readJsonFile<WatchdogState>(watchdogStatePath(projectRoot));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    return {
      schema_version: "0.1",
      check_count: 0,
      active_fingerprints: {}
    };
  }
}

async function readOptionalAlert(
  projectRoot: string,
  alertId: string
): Promise<WatchdogAlert | undefined> {
  try {
    return await getWatchdogAlert(projectRoot, alertId);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readRecentDaemonEvents(
  projectRoot: string
): Promise<Record<string, unknown>[]> {
  const directory = resolveInside(getKaironPaths(projectRoot).runtimeDir, "daemon");
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort().slice(-2);
  const records = await Promise.all(
    files.map((entry) => readJsonLines<Record<string, unknown>>(resolveInside(directory, entry)))
  );
  return records.flat().slice(-2_000);
}

async function readNotificationRecords(
  projectRoot: string
): Promise<Record<string, unknown>[]> {
  const filePath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "discord",
    "approval-notifications.jsonl"
  );
  try {
    await access(filePath);
    return (await readJsonLines<Record<string, unknown>>(filePath)).slice(-2_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readTaskSchedulerStatus(
  projectRoot: string
): Promise<WatchdogRuleInput["task_scheduler"] | undefined> {
  const filePath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "daemon",
    "task-status.json"
  );
  try {
    const artifact = await readJsonFile<{ status?: string }>(filePath);
    const status = artifact.status;
    if (
      status === "registered" ||
      status === "missing" ||
      status === "disabled" ||
      status === "error" ||
      status === "unknown"
    ) {
      return { status };
    }
    return { status: "unknown" };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function withWatchdogLock<T>(
  projectRoot: string,
  now: Date,
  run: () => Promise<T>
): Promise<T> {
  return withResourceLock(
    projectRoot,
    watchdogStatePath(projectRoot),
    {
      owner: "watchdog",
      now,
      ttlMs: 30_000
    },
    run
  );
}

function watchdogRoot(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "watchdog");
}

function watchdogAlertsDirectory(projectRoot: string): string {
  return resolveInside(watchdogRoot(projectRoot), "alerts");
}

function watchdogStatePath(projectRoot: string): string {
  return resolveInside(watchdogRoot(projectRoot), "state.json");
}

function watchdogAlertPath(projectRoot: string, alertId: string): string {
  return resolveInside(watchdogAlertsDirectory(projectRoot), `${alertId}.json`);
}

function watchdogAuditPath(projectRoot: string): string {
  return resolveInside(watchdogRoot(projectRoot), "audit.jsonl");
}

async function appendWatchdogAudit(
  projectRoot: string,
  record: Record<string, unknown> & { created_at: string }
): Promise<void> {
  await mkdir(watchdogRoot(projectRoot), { recursive: true });
  await appendJsonLine(watchdogAuditPath(projectRoot), {
    schema_version: "0.1",
    ...record
  });
}

function assertAlertId(alertId: string): void {
  if (!/^ALT-\d{4,}$/u.test(alertId)) {
    throw new Error(`Invalid watchdog alert id: ${alertId}`);
  }
}

function compareAlerts(left: WatchdogAlert, right: WatchdogAlert): number {
  const severity = compareWatchdogSeverity(right.severity, left.severity);
  return severity !== 0
    ? severity
    : right.last_detected_at.localeCompare(left.last_detected_at);
}

function eventTime(event: Record<string, unknown>): number {
  const parsed = Date.parse(optionalString(event.created_at) ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNestedString(
  value: Record<string, unknown>,
  keys: string[]
): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return optionalString(current);
}

function isMissingFileError(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    String(error).includes("ENOENT")
  );
}

function watchdogCooldownSeconds(alert: WatchdogAlert): number {
  return Math.max(0, alert.cooldown_seconds ?? defaultWatchdogPolicy.cooldown_seconds);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
