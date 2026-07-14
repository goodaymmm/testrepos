import type { AgentId } from "./types.js";

export type AgentSessionHealthStatus = "healthy" | "degraded" | "blocked";

export type SessionHealthObservedStatus =
  | "ready"
  | "completed"
  | "failed"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited"
  | "timeout"
  | "no_output";

export type SessionHealthObservation = {
  status: SessionHealthObservedStatus;
  reason: string;
  run_id?: string;
  task_id?: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
};

export type AgentSessionHealthEvent = SessionHealthObservation & {
  health_status: AgentSessionHealthStatus;
  consecutive_failure_number: number;
  retry_backoff_seconds: number;
  next_retry_at: string | null;
  observed_at: string;
};

export type AgentSessionHealthArtifact = {
  schema_version: string;
  kind: "agent_session_health";
  session_id: string;
  date: string;
  agent: AgentId;
  status: AgentSessionHealthStatus;
  consecutive_failures: number;
  retry_backoff_seconds: number;
  next_retry_at: string | null;
  last_observed_status: SessionHealthObservedStatus;
  last_reason: string;
  history_entries: number;
  setup_required_count: number;
  history: AgentSessionHealthEvent[];
  created_at: string;
  updated_at: string;
};

export type AgentSessionHealthSummary = Pick<
  AgentSessionHealthArtifact,
  | "status"
  | "consecutive_failures"
  | "retry_backoff_seconds"
  | "next_retry_at"
  | "last_observed_status"
  | "last_reason"
  | "history_entries"
  | "setup_required_count"
  | "updated_at"
>;

const MAX_HEALTH_HISTORY = 25;

export function createAgentSessionHealth(input: {
  sessionId: string;
  date: string;
  agent: AgentId;
  commandAvailable: boolean;
  now: Date;
}): AgentSessionHealthArtifact {
  const timestamp = input.now.toISOString();
  const initial: AgentSessionHealthArtifact = {
    schema_version: "0.1",
    kind: "agent_session_health",
    session_id: input.sessionId,
    date: input.date,
    agent: input.agent,
    status: "healthy",
    consecutive_failures: 0,
    retry_backoff_seconds: 0,
    next_retry_at: null,
    last_observed_status: "ready",
    last_reason: "cli_command_available",
    history_entries: 0,
    setup_required_count: 0,
    history: [],
    created_at: timestamp,
    updated_at: timestamp
  };

  return recordAgentSessionHealth(
    initial,
    input.commandAvailable
      ? { status: "ready", reason: "cli_command_available" }
      : { status: "setup_required", reason: "cli_command_missing" },
    input.now
  );
}

export function reconcileAgentCommandHealth(
  current: AgentSessionHealthArtifact,
  commandAvailable: boolean,
  now: Date
): AgentSessionHealthArtifact {
  if (!commandAvailable) {
    return recordAgentSessionHealth(
      current,
      { status: "setup_required", reason: "cli_command_missing" },
      now
    );
  }

  if (current.last_reason === "cli_command_missing") {
    return recordAgentSessionHealth(
      current,
      { status: "ready", reason: "cli_command_available" },
      now
    );
  }

  return current;
}

export function recordAgentSessionHealth(
  current: AgentSessionHealthArtifact,
  observation: SessionHealthObservation,
  now: Date
): AgentSessionHealthArtifact {
  const previous = current.history.at(-1);
  if (sameObservation(previous, observation)) {
    return current;
  }

  const healthStatus = healthStatusFor(observation.status);
  const consecutiveFailures = healthStatus === "healthy"
    ? 0
    : current.consecutive_failures + 1;
  const retry = retryWindow(
    observation.status,
    consecutiveFailures,
    observation.retry_after,
    now
  );
  const event: AgentSessionHealthEvent = {
    ...observation,
    health_status: healthStatus,
    consecutive_failure_number: consecutiveFailures,
    retry_backoff_seconds: retry.seconds,
    next_retry_at: retry.nextRetryAt,
    observed_at: now.toISOString()
  };
  const history = [...current.history, event].slice(-MAX_HEALTH_HISTORY);

  return {
    ...current,
    status: healthStatus,
    consecutive_failures: consecutiveFailures,
    retry_backoff_seconds: retry.seconds,
    next_retry_at: retry.nextRetryAt,
    last_observed_status: observation.status,
    last_reason: observation.reason,
    history_entries: history.length,
    setup_required_count:
      current.setup_required_count + (observation.status === "setup_required" ? 1 : 0),
    history,
    updated_at: now.toISOString()
  };
}

export function summarizeAgentSessionHealth(
  health: AgentSessionHealthArtifact
): AgentSessionHealthSummary {
  return {
    status: health.status,
    consecutive_failures: health.consecutive_failures,
    retry_backoff_seconds: health.retry_backoff_seconds,
    next_retry_at: health.next_retry_at,
    last_observed_status: health.last_observed_status,
    last_reason: health.last_reason,
    history_entries: health.history_entries,
    setup_required_count: health.setup_required_count,
    updated_at: health.updated_at
  };
}

export function isAgentSessionRetryReady(
  health: AgentSessionHealthSummary,
  now: Date
): boolean {
  if (health.status === "healthy" || health.next_retry_at === null) {
    return true;
  }

  const nextRetryAt = Date.parse(health.next_retry_at);
  return Number.isFinite(nextRetryAt) && nextRetryAt <= now.getTime();
}

function healthStatusFor(
  status: SessionHealthObservedStatus
): AgentSessionHealthStatus {
  if (status === "ready" || status === "completed") {
    return "healthy";
  }

  if (
    status === "setup_required" ||
    status === "permission_required" ||
    status === "rate_limited" ||
    status === "usage_limited"
  ) {
    return "blocked";
  }

  return "degraded";
}

function retryWindow(
  status: SessionHealthObservedStatus,
  failureNumber: number,
  retryAfter: string | undefined,
  now: Date
): { seconds: number; nextRetryAt: string | null } {
  if (status === "ready" || status === "completed") {
    return { seconds: 0, nextRetryAt: null };
  }

  const explicit = explicitRetryWindow(retryAfter, now);
  if (explicit !== null) {
    return explicit;
  }

  const { base, maximum } = retryPolicy(status);
  const seconds = Math.min(maximum, base * 2 ** Math.max(0, failureNumber - 1));
  return {
    seconds,
    nextRetryAt: new Date(now.getTime() + seconds * 1_000).toISOString()
  };
}

function explicitRetryWindow(
  retryAfter: string | undefined,
  now: Date
): { seconds: number; nextRetryAt: string } | null {
  if (retryAfter === undefined) {
    return null;
  }

  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    return {
      seconds,
      nextRetryAt: new Date(now.getTime() + seconds * 1_000).toISOString()
    };
  }

  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    return null;
  }

  return {
    seconds: Math.ceil((timestamp - now.getTime()) / 1_000),
    nextRetryAt: new Date(timestamp).toISOString()
  };
}

function retryPolicy(
  status: SessionHealthObservedStatus
): { base: number; maximum: number } {
  if (status === "usage_limited") {
    return { base: 3_600, maximum: 86_400 };
  }

  if (status === "setup_required" || status === "permission_required") {
    return { base: 300, maximum: 3_600 };
  }

  if (status === "rate_limited") {
    return { base: 60, maximum: 3_600 };
  }

  return { base: 30, maximum: 900 };
}

function sameObservation(
  previous: AgentSessionHealthEvent | undefined,
  current: SessionHealthObservation
): boolean {
  if (previous === undefined || previous.status !== current.status) {
    return false;
  }

  if (current.run_id !== undefined || previous.run_id !== undefined) {
    return previous.run_id === current.run_id;
  }

  return previous.reason === current.reason;
}
