import { createHash } from "node:crypto";

export type WatchdogSeverity = "info" | "warning" | "high" | "critical";

export type WatchdogRuleId =
  | "stale_heartbeat"
  | "fatal_runtime_error"
  | "restart_loop"
  | "queue_backlog"
  | "failed_notifications"
  | "provider_suspended"
  | "task_scheduler_missing"
  | "remote_external_unreachable"
  | "remote_identity_bypass"
  | "remote_url_drift"
  | "remote_tunnel_disconnected";

export type WatchdogRulePolicy = {
  enabled: boolean;
  severity: WatchdogSeverity;
  threshold: number;
  window_seconds?: number;
  cooldown_seconds?: number;
};

export type WatchdogPolicy = {
  enabled: boolean;
  cooldown_seconds: number;
  rules: Record<WatchdogRuleId, WatchdogRulePolicy>;
};

export type WatchdogRuleInput = {
  project_id: string;
  now: string;
  runtime: {
    locked: boolean;
    mode?: string;
    heartbeat_at?: string;
    stale?: boolean;
    daemon_status?: string;
    fatal_error_count: number;
    last_error_code?: string;
  };
  daemon_start_times: string[];
  queue: {
    ready: number;
  };
  failed_notification_times: string[];
  providers: Array<{
    id: string;
    status: string;
    reason?: string;
  }>;
  task_scheduler?: {
    status: "registered" | "missing" | "disabled" | "error" | "unknown";
  };
  remote?: {
    configured: boolean;
    external_unreachable: boolean;
    identity_bypass: boolean;
    url_drift: boolean;
    tunnel_disconnected: boolean;
  };
};

export type WatchdogFinding = {
  rule: WatchdogRuleId;
  resource: string;
  fingerprint: string;
  severity: WatchdogSeverity;
  title: string;
  summary: string;
  evidence: Record<string, string | number | boolean | null>;
  cooldown_seconds: number;
};

export const defaultWatchdogPolicy: WatchdogPolicy = {
  enabled: true,
  cooldown_seconds: 900,
  rules: {
    stale_heartbeat: {
      enabled: true,
      severity: "critical",
      threshold: 120
    },
    fatal_runtime_error: {
      enabled: true,
      severity: "critical",
      threshold: 1
    },
    restart_loop: {
      enabled: true,
      severity: "high",
      threshold: 3,
      window_seconds: 300
    },
    queue_backlog: {
      enabled: true,
      severity: "warning",
      threshold: 20
    },
    failed_notifications: {
      enabled: true,
      severity: "high",
      threshold: 3,
      window_seconds: 300
    },
    provider_suspended: {
      enabled: true,
      severity: "high",
      threshold: 1
    },
    task_scheduler_missing: {
      enabled: true,
      severity: "warning",
      threshold: 1
    },
    remote_external_unreachable: {
      enabled: true,
      severity: "high",
      threshold: 1
    },
    remote_identity_bypass: {
      enabled: true,
      severity: "critical",
      threshold: 1
    },
    remote_url_drift: {
      enabled: true,
      severity: "high",
      threshold: 1
    },
    remote_tunnel_disconnected: {
      enabled: true,
      severity: "critical",
      threshold: 1
    }
  }
};

export function evaluateWatchdogRules(
  input: WatchdogRuleInput,
  policy: WatchdogPolicy
): WatchdogFinding[] {
  if (!policy.enabled) {
    return [];
  }

  const findings: WatchdogFinding[] = [];
  const nowMs = parseTime(input.now);
  const heartbeatPolicy = policy.rules.stale_heartbeat;
  const heartbeatAt = optionalTime(input.runtime.heartbeat_at);
  const heartbeatAgeSeconds =
    heartbeatAt === undefined ? undefined : Math.max(0, (nowMs - heartbeatAt) / 1_000);
  if (
    heartbeatPolicy.enabled &&
    input.runtime.locked &&
    input.runtime.mode === "daemon" &&
    (input.runtime.stale === true ||
      heartbeatAgeSeconds === undefined ||
      heartbeatAgeSeconds >= heartbeatPolicy.threshold)
  ) {
    findings.push(
      finding(input, policy, "stale_heartbeat", "runtime:daemon", {
        title: "Runtime daemon heartbeat is stale",
        summary: "The daemon lock exists but its heartbeat is outside the allowed age.",
        evidence: {
          locked: input.runtime.locked,
          stale: input.runtime.stale === true,
          heartbeat_age_seconds:
            heartbeatAgeSeconds === undefined ? null : Math.floor(heartbeatAgeSeconds),
          threshold_seconds: heartbeatPolicy.threshold
        }
      })
    );
  }

  const fatalPolicy = policy.rules.fatal_runtime_error;
  if (
    fatalPolicy.enabled &&
    (input.runtime.daemon_status === "fatal_error" ||
      input.runtime.fatal_error_count >= fatalPolicy.threshold)
  ) {
    findings.push(
      finding(input, policy, "fatal_runtime_error", "runtime:daemon", {
        title: "Runtime daemon reported a fatal error",
        summary: "The latest daemon state contains one or more fatal runtime errors.",
        evidence: {
          fatal_error_count: input.runtime.fatal_error_count,
          threshold: fatalPolicy.threshold,
          last_error_code: input.runtime.last_error_code ?? null
        }
      })
    );
  }

  const restartPolicy = policy.rules.restart_loop;
  const recentStarts = countInsideWindow(
    input.daemon_start_times,
    nowMs,
    restartPolicy.window_seconds ?? 300
  );
  if (restartPolicy.enabled && recentStarts >= restartPolicy.threshold) {
    findings.push(
      finding(input, policy, "restart_loop", "runtime:daemon", {
        title: "Runtime daemon restart loop detected",
        summary: "Daemon start frequency exceeded the configured restart threshold.",
        evidence: {
          restart_count: recentStarts,
          threshold: restartPolicy.threshold,
          window_seconds: restartPolicy.window_seconds ?? 300
        }
      })
    );
  }

  const queuePolicy = policy.rules.queue_backlog;
  if (queuePolicy.enabled && input.queue.ready >= queuePolicy.threshold) {
    findings.push(
      finding(input, policy, "queue_backlog", "queue:ready", {
        title: "Work queue backlog exceeded its threshold",
        summary: "Ready work items are accumulating faster than they are processed.",
        evidence: {
          ready_items: input.queue.ready,
          threshold: queuePolicy.threshold
        }
      })
    );
  }

  const notificationPolicy = policy.rules.failed_notifications;
  const recentNotificationFailures = countInsideWindow(
    input.failed_notification_times,
    nowMs,
    notificationPolicy.window_seconds ?? 300
  );
  if (
    notificationPolicy.enabled &&
    recentNotificationFailures >= notificationPolicy.threshold
  ) {
    findings.push(
      finding(input, policy, "failed_notifications", "notification:discord", {
        title: "Discord notification failures exceeded their threshold",
        summary: "Recent Discord notification attempts have repeatedly failed.",
        evidence: {
          failed_notifications: recentNotificationFailures,
          threshold: notificationPolicy.threshold,
          window_seconds: notificationPolicy.window_seconds ?? 300
        }
      })
    );
  }

  const providerPolicy = policy.rules.provider_suspended;
  const suspendedProviders = input.providers.filter(
    (candidate) => candidate.status === "suspended"
  );
  if (
    providerPolicy.enabled &&
    suspendedProviders.length >= providerPolicy.threshold
  ) {
    for (const provider of suspendedProviders) {
      findings.push(
        finding(input, policy, "provider_suspended", `provider:${provider.id}`, {
          title: `Provider ${provider.id} is suspended`,
          summary: "A provider is blocked until an operator reviews and resumes it.",
          evidence: {
            provider: provider.id,
            status: provider.status,
            reason: provider.reason ?? null,
            suspended_providers: suspendedProviders.length,
            threshold: providerPolicy.threshold
          }
        })
      );
    }
  }

  const schedulerPolicy = policy.rules.task_scheduler_missing;
  if (
    schedulerPolicy.enabled &&
    input.task_scheduler !== undefined &&
    ["missing", "disabled", "error"].includes(input.task_scheduler.status)
  ) {
    findings.push(
      finding(input, policy, "task_scheduler_missing", "scheduler:kairon-runtime", {
        title: "Windows daemon task is not operational",
        summary: "Task Scheduler registration health is separate from daemon process health.",
        evidence: {
          scheduler_status: input.task_scheduler.status
        }
      })
    );
  }

  const remote = input.remote;
  if (remote?.configured === true) {
    if (
      policy.rules.remote_external_unreachable.enabled &&
      remote.external_unreachable
    ) {
      findings.push(
        finding(
          input,
          policy,
          "remote_external_unreachable",
          "remote:external-endpoints",
          {
            title: "Stable remote endpoint is unreachable",
            summary:
              "The latest remote doctor probe could not reach one or more external endpoints.",
            evidence: {
              external_unreachable: true,
              threshold: policy.rules.remote_external_unreachable.threshold
            }
          }
        )
      );
    }
    if (
      policy.rules.remote_identity_bypass.enabled &&
      remote.identity_bypass
    ) {
      findings.push(
        finding(
          input,
          policy,
          "remote_identity_bypass",
          "remote:board-identity",
          {
            title: "Remote Board identity enforcement can be bypassed",
            summary:
              "The latest unauthenticated probe reached the Board without an identity challenge.",
            evidence: {
              identity_bypass: true,
              threshold: policy.rules.remote_identity_bypass.threshold
            }
          }
        )
      );
    }
    if (policy.rules.remote_url_drift.enabled && remote.url_drift) {
      findings.push(
        finding(input, policy, "remote_url_drift", "remote:configured-urls", {
          title: "Stable remote URL drift detected",
          summary:
            "A running remote endpoint does not match the configured fixed HTTPS URL.",
          evidence: {
            url_drift: true,
            threshold: policy.rules.remote_url_drift.threshold
          }
        })
      );
    }
    if (
      policy.rules.remote_tunnel_disconnected.enabled &&
      remote.tunnel_disconnected
    ) {
      findings.push(
        finding(
          input,
          policy,
          "remote_tunnel_disconnected",
          "remote:tunnel",
          {
            title: "Stable remote tunnel is disconnected",
            summary:
              "Discord interactions and Board endpoints were both unreachable in the latest probe.",
            evidence: {
              tunnel_disconnected: true,
              threshold: policy.rules.remote_tunnel_disconnected.threshold
            }
          }
        )
      );
    }
  }

  return findings.sort((left, right) =>
    `${left.rule}:${left.resource}`.localeCompare(`${right.rule}:${right.resource}`)
  );
}

export function watchdogFingerprint(
  projectId: string,
  rule: WatchdogRuleId,
  resource: string
): string {
  return createHash("sha256")
    .update(`${projectId}\n${rule}\n${resource}`, "utf8")
    .digest("hex");
}

export function compareWatchdogSeverity(
  left: WatchdogSeverity,
  right: WatchdogSeverity
): number {
  return severityRank(left) - severityRank(right);
}

function finding(
  input: WatchdogRuleInput,
  policy: WatchdogPolicy,
  rule: WatchdogRuleId,
  resource: string,
  detail: Pick<WatchdogFinding, "title" | "summary" | "evidence">
): WatchdogFinding {
  const rulePolicy = policy.rules[rule];
  return {
    rule,
    resource,
    fingerprint: watchdogFingerprint(input.project_id, rule, resource),
    severity: rulePolicy.severity,
    title: detail.title,
    summary: detail.summary,
    evidence: detail.evidence,
    cooldown_seconds: rulePolicy.cooldown_seconds ?? policy.cooldown_seconds
  };
}

function countInsideWindow(
  timestamps: string[],
  nowMs: number,
  windowSeconds: number
): number {
  const start = nowMs - windowSeconds * 1_000;
  return timestamps.filter((timestamp) => {
    const value = optionalTime(timestamp);
    return value !== undefined && value >= start && value <= nowMs;
  }).length;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Watchdog rule input contains an invalid current timestamp.");
  }
  return parsed;
}

function optionalTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function severityRank(severity: WatchdogSeverity): number {
  return {
    info: 0,
    warning: 1,
    high: 2,
    critical: 3
  }[severity];
}
