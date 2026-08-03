import { loadConfigFile } from "../core/config/load-config.js";
import {
  compareWatchdogSeverity,
  type WatchdogSeverity
} from "../runtime/watchdog-rules.js";
import {
  isValidTimeZone,
  isWithinTimeRanges,
  nextTimeRangeExit,
  type TimeRange
} from "../runtime/schedule-engine.js";
import type {
  WatchdogAlert,
  WatchdogPendingNotification
} from "../runtime/watchdog.js";

export type AlertPolicyProvider = "discord" | "local_audit";
export type AlertPolicyDecisionKind = "send" | "defer" | "suppress" | "aggregate";
export type AlertPolicyReason =
  | "none"
  | "quiet_hours"
  | "maintenance_window"
  | "reminder_interval"
  | "daily_budget"
  | "below_minimum_severity"
  | "local_audit_only";

export type AlertPolicyRoute = {
  id: string;
  provider: AlertPolicyProvider;
  minimum_severity: WatchdogSeverity;
};

export type AlertPolicyConfig = {
  enabled?: boolean;
  timezone?: string;
  routes?: AlertPolicyRoute[];
  quiet_hours?: TimeRange[];
  maintenance_windows?: TimeRange[];
  reminder_interval_seconds?: number;
  daily_budget?: number;
};

export type AlertPolicy = {
  enabled: boolean;
  timezone: string;
  routes: AlertPolicyRoute[];
  quiet_hours: TimeRange[];
  maintenance_windows: TimeRange[];
  reminder_interval_seconds: number;
  daily_budget: number;
};

export type AlertPolicyIssue =
  | "invalid_timezone"
  | "duplicate_route"
  | "daily_budget_zero"
  | "maintenance_window_conflict";

export type PreparedAlertPolicy = {
  policy: AlertPolicy;
  issues: AlertPolicyIssue[];
};

export type AlertPolicyDecision = {
  decision: AlertPolicyDecisionKind;
  reason: AlertPolicyReason;
  route_id?: string;
  defer_until?: string;
};

export type AlertPolicyNotificationInput = {
  severity: WatchdogSeverity;
  event: WatchdogPendingNotification["event"];
  last_notified_at?: string;
  suppression_reason?: AlertPolicyReason;
};

type NotificationsAlertPolicyConfig = {
  alert_policy?: AlertPolicyConfig;
};

export const defaultAlertPolicy: AlertPolicy = {
  enabled: true,
  timezone: "Asia/Tokyo",
  routes: [
    {
      id: "watchdog-discord",
      provider: "discord",
      minimum_severity: "warning"
    }
  ],
  quiet_hours: [],
  maintenance_windows: [],
  reminder_interval_seconds: 3_600,
  daily_budget: 50
};

export async function resolveAlertPolicy(
  projectRoot: string
): Promise<PreparedAlertPolicy> {
  const config = await loadConfigFile<NotificationsAlertPolicyConfig>(
    projectRoot,
    "notifications.json"
  );
  return prepareAlertPolicy(config.alert_policy);
}

export function prepareAlertPolicy(
  configured: AlertPolicyConfig | undefined
): PreparedAlertPolicy {
  const requestedTimezone = configured?.timezone ?? defaultAlertPolicy.timezone;
  const timezoneValid = isValidTimeZone(requestedTimezone);
  const policy: AlertPolicy = {
    enabled: configured?.enabled ?? defaultAlertPolicy.enabled,
    timezone: timezoneValid ? requestedTimezone : "UTC",
    routes: configured?.routes ?? structuredClone(defaultAlertPolicy.routes),
    quiet_hours:
      configured?.quiet_hours ?? structuredClone(defaultAlertPolicy.quiet_hours),
    maintenance_windows:
      configured?.maintenance_windows ??
      structuredClone(defaultAlertPolicy.maintenance_windows),
    reminder_interval_seconds:
      configured?.reminder_interval_seconds ??
      defaultAlertPolicy.reminder_interval_seconds,
    daily_budget: configured?.daily_budget ?? defaultAlertPolicy.daily_budget
  };
  const issues = new Set<AlertPolicyIssue>();
  if (!timezoneValid) {
    issues.add("invalid_timezone");
  }
  if (hasDuplicateRoute(policy.routes)) {
    issues.add("duplicate_route");
  }
  if (policy.daily_budget === 0) {
    issues.add("daily_budget_zero");
  }
  if (hasOverlappingRanges(policy.maintenance_windows)) {
    issues.add("maintenance_window_conflict");
  }
  return {
    policy,
    issues: [...issues]
  };
}

export function evaluateAlertPolicy(
  policy: AlertPolicy,
  alert: WatchdogAlert,
  pending: WatchdogPendingNotification,
  input: {
    now: Date;
    sent_today: number;
  }
): AlertPolicyDecision {
  return evaluateAlertPolicyNotification(policy, {
    severity: alert.severity,
    event: pending.event,
    last_notified_at: alert.last_notified_at,
    suppression_reason: pending.suppression_reason
  }, input);
}

export function evaluateAlertPolicyNotification(
  policy: AlertPolicy,
  notification: AlertPolicyNotificationInput,
  input: {
    now: Date;
    sent_today: number;
  }
): AlertPolicyDecision {
  if (!policy.enabled) {
    return { decision: "send", reason: "none" };
  }

  const bypassSuppression =
    notification.event === "resolved" ||
    (notification.severity === "critical" &&
      (notification.event === "open" ||
        notification.event === "escalated"));
  const route = bypassSuppression
    ? policy.routes.find((candidate) => candidate.provider === "discord")
    : selectDiscordRoute(policy.routes, notification.severity);
  if (route === undefined) {
    const hasLocalRoute = policy.routes.some(
      (candidate) =>
        candidate.provider === "local_audit" &&
        meetsMinimumSeverity(
          notification.severity,
          candidate.minimum_severity
        )
    );
    return {
      decision: "suppress",
      reason: hasLocalRoute ? "local_audit_only" : "below_minimum_severity"
    };
  }

  if (!bypassSuppression) {
    const reminderUntil = reminderDeferUntil(
      policy,
      notification,
      input.now
    );
    if (reminderUntil !== undefined) {
      return {
        decision: "defer",
        reason: "reminder_interval",
        route_id: route.id,
        defer_until: reminderUntil
      };
    }
    const maintenanceUntil = windowDeferUntil(
      policy.maintenance_windows,
      policy.timezone,
      input.now
    );
    if (maintenanceUntil !== undefined) {
      return {
        decision: "defer",
        reason: "maintenance_window",
        route_id: route.id,
        defer_until: maintenanceUntil
      };
    }
    const quietUntil = windowDeferUntil(
      policy.quiet_hours,
      policy.timezone,
      input.now
    );
    if (quietUntil !== undefined) {
      return {
        decision: "defer",
        reason: "quiet_hours",
        route_id: route.id,
        defer_until: quietUntil
      };
    }
  }

  if (!bypassSuppression && input.sent_today >= policy.daily_budget) {
    return {
      decision: "aggregate",
      reason: "daily_budget",
      route_id: route.id
    };
  }
  return {
    decision: "send",
    reason: "none",
    route_id: route.id
  };
}

export function isMaintenanceRelease(
  pending: WatchdogPendingNotification,
  decision: AlertPolicyDecision
): boolean {
  return (
    pending.suppression_reason === "maintenance_window" &&
    decision.reason !== "maintenance_window" &&
    decision.decision !== "defer"
  );
}

function selectDiscordRoute(
  routes: AlertPolicyRoute[],
  severity: WatchdogSeverity
): AlertPolicyRoute | undefined {
  return routes.find(
    (route) =>
      route.provider === "discord" &&
      meetsMinimumSeverity(severity, route.minimum_severity)
  );
}

function meetsMinimumSeverity(
  actual: WatchdogSeverity,
  minimum: WatchdogSeverity
): boolean {
  return compareWatchdogSeverity(actual, minimum) >= 0;
}

function reminderDeferUntil(
  policy: AlertPolicy,
  notification: Pick<
    AlertPolicyNotificationInput,
    "event" | "last_notified_at"
  >,
  now: Date
): string | undefined {
  if (
    notification.event !== "reminder" ||
    notification.last_notified_at === undefined
  ) {
    return undefined;
  }
  const deferUntil =
    Date.parse(notification.last_notified_at) +
    policy.reminder_interval_seconds * 1_000;
  return deferUntil > now.getTime()
    ? new Date(deferUntil).toISOString()
    : undefined;
}

function windowDeferUntil(
  ranges: TimeRange[],
  timezone: string,
  now: Date
): string | undefined {
  if (!isWithinTimeRanges(ranges, now, timezone)) {
    return undefined;
  }
  return nextTimeRangeExit(ranges, now, timezone)?.toISOString();
}

function hasDuplicateRoute(routes: AlertPolicyRoute[]): boolean {
  const ids = new Set<string>();
  const signatures = new Set<string>();
  for (const route of routes) {
    const signature = `${route.provider}:${route.minimum_severity}`;
    if (ids.has(route.id) || signatures.has(signature)) {
      return true;
    }
    ids.add(route.id);
    signatures.add(signature);
  }
  return false;
}

function hasOverlappingRanges(ranges: TimeRange[]): boolean {
  const occupied = new Set<number>();
  for (const range of ranges) {
    for (const minute of expandRange(range)) {
      if (occupied.has(minute)) {
        return true;
      }
      occupied.add(minute);
    }
  }
  return false;
}

function expandRange(range: TimeRange): number[] {
  const start = parseMinute(range.start);
  const end = parseMinute(range.end);
  if (start === end) {
    return Array.from({ length: 1_440 }, (_, index) => index);
  }
  if (start < end) {
    return Array.from({ length: end - start }, (_, index) => start + index);
  }
  return [
    ...Array.from({ length: 1_440 - start }, (_, index) => start + index),
    ...Array.from({ length: end }, (_, index) => index)
  ];
}

function parseMinute(value: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) {
    return -1;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
