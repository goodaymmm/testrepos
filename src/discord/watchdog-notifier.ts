import { createHash } from "node:crypto";
import type { DiscordApprovalChannel } from "./approval-notifier.js";
import {
  getWatchdogAlert,
  listWatchdogAlerts,
  markWatchdogNotification,
  readWatchdogAuditRecords,
  recordWatchdogNotificationPolicy,
  type WatchdogAlert,
  type WatchdogNotificationEvent,
  type WatchdogPendingNotification
} from "../runtime/watchdog.js";
import {
  evaluateAlertPolicy,
  isMaintenanceRelease,
  resolveAlertPolicy,
  type AlertPolicyDecision,
  type AlertPolicyReason
} from "../notifications/alert-policy.js";
import { getLocalDateKey } from "../runtime/schedule-engine.js";
import { recordNotificationResult } from "../observability/runtime-metrics.js";
import { sanitizeDiscordAuditText } from "./decision-audit.js";

export type DiscordWatchdogNotificationResult = {
  scanned: number;
  sent: number;
  skipped: number;
  deferred: number;
  suppressed: number;
  aggregated: number;
  failed: number;
  failures: Array<{
    alert_id: string;
    reason: string;
  }>;
};

type PendingAlert = {
  alert: WatchdogAlert;
  pending: WatchdogPendingNotification;
  decision: AlertPolicyDecision;
  idempotencyKey: string;
};

export async function notifyPendingDiscordWatchdogAlerts(
  projectRoot: string,
  channel: DiscordApprovalChannel,
  options: { now?: () => Date } = {}
): Promise<DiscordWatchdogNotificationResult> {
  const now = options.now?.() ?? new Date();
  const [{ policy }, alerts, audit] = await Promise.all([
    resolveAlertPolicy(projectRoot),
    listWatchdogAlerts(projectRoot),
    readWatchdogAuditRecords(projectRoot)
  ]);
  const result: DiscordWatchdogNotificationResult = {
    scanned: alerts.length,
    sent: 0,
    skipped: 0,
    deferred: 0,
    suppressed: 0,
    aggregated: 0,
    failed: 0,
    failures: []
  };
  let sentToday = countSentNotifications(audit, now, policy.timezone);
  const maintenanceReleased: PendingAlert[] = [];
  const ready: PendingAlert[] = [];

  for (const alert of alerts) {
    const pending = alert.pending_notification;
    if (pending === undefined) {
      result.skipped += 1;
      continue;
    }
    const decision = evaluateAlertPolicy(policy, alert, pending, {
      now,
      sent_today: sentToday
    });
    const candidate = {
      alert,
      pending,
      decision,
      idempotencyKey: notificationIdempotencyKey(alert, pending)
    };
    if (decision.decision === "defer") {
      await persistPolicyDecision(projectRoot, candidate, now);
      result.deferred += 1;
      continue;
    }
    if (decision.decision === "suppress") {
      await persistPolicyDecision(projectRoot, candidate, now);
      await markWatchdogNotification(projectRoot, alert.alert_id, {
        event: pending.event,
        status: "suppressed",
        reason: decision.reason,
        now
      });
      result.suppressed += 1;
      continue;
    }
    if (isMaintenanceRelease(pending, decision)) {
      maintenanceReleased.push(candidate);
      continue;
    }
    ready.push(candidate);
  }

  if (maintenanceReleased.length > 0) {
    const sent = await sendAggregate(
      projectRoot,
      channel,
      maintenanceReleased,
      "maintenance_window",
      now,
      result
    );
    sentToday += sent ? 1 : 0;
  }

  const budgetAggregate: PendingAlert[] = [];
  for (const candidate of ready) {
    const decision = evaluateAlertPolicy(
      policy,
      await getWatchdogAlert(projectRoot, candidate.alert.alert_id),
      candidate.pending,
      {
        now,
        sent_today: sentToday
      }
    );
    const current = { ...candidate, decision };
    if (decision.decision === "aggregate") {
      budgetAggregate.push(current);
      continue;
    }
    if (decision.decision === "defer") {
      await persistPolicyDecision(projectRoot, current, now);
      result.deferred += 1;
      continue;
    }
    if (decision.decision === "suppress") {
      await persistPolicyDecision(projectRoot, current, now);
      await markWatchdogNotification(projectRoot, current.alert.alert_id, {
        event: current.pending.event,
        status: "suppressed",
        reason: decision.reason,
        now
      });
      result.suppressed += 1;
      continue;
    }
    const sent = await sendSingle(projectRoot, channel, current, now, result);
    sentToday += sent ? 1 : 0;
  }

  if (budgetAggregate.length > 0) {
    await sendAggregate(
      projectRoot,
      channel,
      budgetAggregate,
      "daily_budget",
      now,
      result
    );
  }
  return result;
}

async function sendSingle(
  projectRoot: string,
  channel: DiscordApprovalChannel,
  candidate: PendingAlert,
  now: Date,
  result: DiscordWatchdogNotificationResult
): Promise<boolean> {
  await persistPolicyDecision(projectRoot, candidate, now);
  try {
    const message = await channel.send(
      withIdempotency(
        buildWatchdogMessage(candidate.alert, candidate.pending.event),
        candidate.idempotencyKey
      )
    );
    await markWatchdogNotification(projectRoot, candidate.alert.alert_id, {
      event: candidate.pending.event,
      status: "sent",
      messageId: message.id,
      now
    });
    await recordDeliveryMetric(projectRoot, "success", now);
    result.sent += 1;
    return true;
  } catch (error) {
    await recordNotificationFailure(
      projectRoot,
      candidate,
      error,
      now,
      result
    );
    return false;
  }
}

async function sendAggregate(
  projectRoot: string,
  channel: DiscordApprovalChannel,
  candidates: PendingAlert[],
  reason: Extract<AlertPolicyReason, "maintenance_window" | "daily_budget">,
  now: Date,
  result: DiscordWatchdogNotificationResult
): Promise<boolean> {
  const aggregateKey = candidates
    .map((candidate) => candidate.idempotencyKey)
    .sort()
    .join("|");
  const aggregateCandidates = candidates.map((candidate) => ({
    ...candidate,
    decision: {
      decision: "aggregate" as const,
      reason,
      route_id: candidate.decision.route_id
    }
  }));
  for (const candidate of aggregateCandidates) {
    await persistPolicyDecision(projectRoot, candidate, now);
  }

  try {
    const message = await channel.send(
      withIdempotency(buildAggregateMessage(aggregateCandidates, reason, now), aggregateKey)
    );
    for (const candidate of aggregateCandidates) {
      await markWatchdogNotification(projectRoot, candidate.alert.alert_id, {
        event: candidate.pending.event,
        status: "sent",
        messageId: message.id,
        now
      });
    }
    await recordDeliveryMetric(projectRoot, "success", now);
    result.sent += 1;
    result.aggregated += aggregateCandidates.length;
    return true;
  } catch (error) {
    for (const candidate of aggregateCandidates) {
      await recordNotificationFailure(
        projectRoot,
        candidate,
        error,
        now,
        result
      );
    }
    return false;
  }
}

async function persistPolicyDecision(
  projectRoot: string,
  candidate: PendingAlert,
  now: Date
): Promise<void> {
  await recordWatchdogNotificationPolicy(projectRoot, candidate.alert.alert_id, {
    event: candidate.pending.event,
    decision: candidate.decision.decision,
    reason: candidate.decision.reason,
    idempotencyKey: candidate.idempotencyKey,
    routeId: candidate.decision.route_id,
    deferUntil: candidate.decision.defer_until,
    now
  });
}

async function recordNotificationFailure(
  projectRoot: string,
  candidate: PendingAlert,
  error: unknown,
  now: Date,
  result: DiscordWatchdogNotificationResult
): Promise<void> {
  const reason =
    sanitizeDiscordAuditText(String(error)) ?? "watchdog_notification_failed";
  await markWatchdogNotification(projectRoot, candidate.alert.alert_id, {
    event: candidate.pending.event,
    status: "failed",
    reason,
    now
  });
  await recordDeliveryMetric(projectRoot, "failed", now);
  result.failed += 1;
  result.failures.push({
    alert_id: candidate.alert.alert_id,
    reason
  });
}

async function recordDeliveryMetric(
  projectRoot: string,
  result: "success" | "failed",
  now: Date
): Promise<void> {
  try {
    await recordNotificationResult(projectRoot, {
      provider: "discord",
      result,
      recordedAt: now
    });
  } catch {
    // Metrics are derived diagnostics and must not block notification delivery.
  }
}

function buildWatchdogMessage(
  alert: WatchdogAlert,
  event: WatchdogNotificationEvent
): Record<string, unknown> {
  const action = {
    open: "opened",
    escalated: "escalated",
    reminder: "remains open",
    resolved: "resolved"
  }[event];
  return {
    content: `Watchdog alert ${action}: ${alert.alert_id}`,
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: alert.title,
        description: alert.summary,
        color: alertColor(alert),
        fields: [
          { name: "Alert", value: alert.alert_id, inline: true },
          { name: "Status", value: alert.status, inline: true },
          { name: "Severity", value: alert.severity, inline: true },
          { name: "Rule", value: alert.rule, inline: true },
          { name: "Resource", value: alert.resource, inline: true },
          {
            name: "Occurrences",
            value: String(alert.occurrence_count),
            inline: true
          }
        ],
        timestamp: alert.updated_at
      }
    ]
  };
}

function buildAggregateMessage(
  candidates: PendingAlert[],
  reason: Extract<AlertPolicyReason, "maintenance_window" | "daily_budget">,
  now: Date
): Record<string, unknown> {
  const alertIds = candidates
    .map((candidate) => candidate.alert.alert_id)
    .sort();
  const title =
    reason === "maintenance_window"
      ? "Watchdog maintenance summary"
      : "Watchdog notification budget summary";
  return {
    content: `${title}: ${candidates.length} alert transition(s)`,
    allowedMentions: { parse: [] },
    embeds: [
      {
        title,
        description:
          reason === "maintenance_window"
            ? "Deferred alert transitions were aggregated after maintenance."
            : "Alert transitions beyond the daily notification budget were aggregated.",
        color: highestAlertColor(candidates.map((candidate) => candidate.alert)),
        fields: [
          { name: "Transitions", value: String(candidates.length), inline: true },
          {
            name: "Alerts",
            value: alertIds.slice(0, 20).join(", ") || "-",
            inline: false
          }
        ],
        timestamp: now.toISOString()
      }
    ]
  };
}

function withIdempotency(
  payload: Record<string, unknown>,
  idempotencyKey: string
): Record<string, unknown> {
  return {
    ...payload,
    nonce: createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 24),
    enforceNonce: true
  };
}

function notificationIdempotencyKey(
  alert: WatchdogAlert,
  pending: WatchdogPendingNotification
): string {
  return (
    pending.idempotency_key ??
    `watchdog:${alert.alert_id}:${pending.event}:${pending.queued_at}`
  );
}

function countSentNotifications(
  records: Record<string, unknown>[],
  now: Date,
  timezone: string
): number {
  const localDate = getLocalDateKey(now, timezone);
  const messageIds = new Set<string>();
  for (const record of records) {
    if (record.event !== "notification.sent") {
      continue;
    }
    const createdAt =
      typeof record.created_at === "string" ? new Date(record.created_at) : undefined;
    if (
      createdAt === undefined ||
      !Number.isFinite(createdAt.getTime()) ||
      getLocalDateKey(createdAt, timezone) !== localDate
    ) {
      continue;
    }
    const messageId =
      typeof record.message_id === "string"
        ? record.message_id
        : `${String(record.alert_id)}:${String(record.notification_event)}:${record.created_at}`;
    messageIds.add(messageId);
  }
  return messageIds.size;
}

function alertColor(alert: WatchdogAlert): number {
  if (alert.status === "resolved") {
    return 0x2e7d32;
  }
  return {
    info: 0x1976d2,
    warning: 0xf9a825,
    high: 0xef6c00,
    critical: 0xc62828
  }[alert.severity];
}

function highestAlertColor(alerts: WatchdogAlert[]): number {
  if (alerts.some((alert) => alert.severity === "critical")) {
    return 0xc62828;
  }
  if (alerts.some((alert) => alert.severity === "high")) {
    return 0xef6c00;
  }
  if (alerts.some((alert) => alert.severity === "warning")) {
    return 0xf9a825;
  }
  return 0x1976d2;
}
