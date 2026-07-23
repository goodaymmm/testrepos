import type { DiscordApprovalChannel } from "./approval-notifier.js";
import {
  listWatchdogAlerts,
  markWatchdogNotification,
  type WatchdogAlert,
  type WatchdogNotificationEvent
} from "../runtime/watchdog.js";
import { sanitizeDiscordAuditText } from "./decision-audit.js";

export type DiscordWatchdogNotificationResult = {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  failures: Array<{
    alert_id: string;
    reason: string;
  }>;
};

export async function notifyPendingDiscordWatchdogAlerts(
  projectRoot: string,
  channel: DiscordApprovalChannel,
  options: { now?: () => Date } = {}
): Promise<DiscordWatchdogNotificationResult> {
  const now = options.now?.() ?? new Date();
  const alerts = await listWatchdogAlerts(projectRoot);
  const result: DiscordWatchdogNotificationResult = {
    scanned: alerts.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    failures: []
  };

  for (const alert of alerts) {
    const pending = alert.pending_notification;
    if (pending === undefined) {
      result.skipped += 1;
      continue;
    }

    try {
      const message = await channel.send(buildWatchdogMessage(alert, pending.event));
      await markWatchdogNotification(projectRoot, alert.alert_id, {
        event: pending.event,
        status: "sent",
        messageId: message.id,
        now
      });
      result.sent += 1;
    } catch (error) {
      const reason =
        sanitizeDiscordAuditText(String(error)) ?? "watchdog_notification_failed";
      await markWatchdogNotification(projectRoot, alert.alert_id, {
        event: pending.event,
        status: "failed",
        reason,
        now
      });
      result.failed += 1;
      result.failures.push({
        alert_id: alert.alert_id,
        reason
      });
    }
  }

  return result;
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
