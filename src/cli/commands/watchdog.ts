import {
  getWatchdogAlert,
  listWatchdogAlerts,
  resolveWatchdogAlert,
  runWatchdogCheck,
  type WatchdogAlert,
  type WatchdogAlertStatus
} from "../../runtime/watchdog.js";

export async function watchdogCheckCommand(projectRoot: string): Promise<string> {
  const result = await runWatchdogCheck(projectRoot);
  return [
    "Kairon watchdog check completed.",
    `status=${result.status}`,
    `checked_at=${result.checked_at}`,
    `findings=${result.summary.findings}`,
    `created=${result.summary.created}`,
    `updated=${result.summary.updated}`,
    `reopened=${result.summary.reopened}`,
    `resolved=${result.summary.resolved}`,
    `open=${result.summary.open}`,
    `acknowledged=${result.summary.acknowledged}`,
    `highest_severity=${result.summary.highest_severity}`,
    `notifications_pending=${result.summary.notifications_pending}`,
    `state=${result.state_path}`
  ].join("\n");
}

export async function watchdogListCommand(
  projectRoot: string,
  options: { status?: string } = {}
): Promise<string> {
  const status = parseAlertStatus(options.status);
  const alerts = await listWatchdogAlerts(projectRoot, { status });
  return [
    `Kairon watchdog alerts: ${alerts.length}`,
    ...alerts.map(formatAlertLine)
  ].join("\n");
}

export async function watchdogShowCommand(
  projectRoot: string,
  alertId: string
): Promise<string> {
  const alert = await getWatchdogAlert(projectRoot, alertId);
  return [
    "Kairon watchdog alert:",
    `id=${alert.alert_id}`,
    `status=${alert.status}`,
    `severity=${alert.severity}`,
    `rule=${alert.rule}`,
    `resource=${alert.resource}`,
    `occurrences=${alert.occurrence_count}`,
    `recurrences=${alert.recurrence_count}`,
    `detail=${JSON.stringify(alert, null, 2)}`
  ].join("\n");
}

export async function watchdogResolveCommand(
  projectRoot: string,
  alertId: string,
  reason: string
): Promise<string> {
  const alert = await resolveWatchdogAlert(projectRoot, alertId, reason);
  return [
    "Kairon watchdog alert resolved.",
    `id=${alert.alert_id}`,
    `status=${alert.status}`,
    `reason=${alert.resolution_reason}`,
    `notification_pending=${alert.pending_notification?.event === "resolved"}`
  ].join("\n");
}

function parseAlertStatus(
  value: string | undefined
): WatchdogAlertStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "open" || value === "acknowledged" || value === "resolved") {
    return value;
  }
  throw new Error(`Invalid watchdog alert status: ${value}`);
}

function formatAlertLine(alert: WatchdogAlert): string {
  return [
    `id=${alert.alert_id}`,
    `status=${alert.status}`,
    `severity=${alert.severity}`,
    `rule=${alert.rule}`,
    `resource=${alert.resource}`,
    `occurrences=${alert.occurrence_count}`
  ].join(" ");
}
