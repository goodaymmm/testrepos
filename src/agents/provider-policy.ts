import { access } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { getLocalDateKey } from "../runtime/schedule-engine.js";
import type { CliRunClassificationStatus } from "./cli-classification.js";
import { agentIds, type AgentId } from "./types.js";

export type ProviderFailureCategory =
  | "quota"
  | "rate_limit"
  | "auth"
  | "setup"
  | "compliance"
  | "unknown";

export type ProviderPolicy = {
  unattended_allowed: boolean;
  max_concurrent: number;
  cooldown_seconds: number;
  daily_run_limit: number;
};

export type ProviderPolicyHealthStatus =
  | "ready"
  | "cooldown"
  | "daily_limit_reached"
  | "suspended";

export type ProviderPolicyHealth = {
  schema_version: string;
  kind: "provider_policy_health";
  agent: AgentId;
  status: ProviderPolicyHealthStatus;
  available: boolean;
  failure_category: ProviderFailureCategory | null;
  suspended: boolean;
  suspended_reason: string | null;
  suspended_by: string | null;
  next_retry_at: string | null;
  daily_date: string;
  daily_run_count: number;
  active_run_ids: string[];
  last_run_id: string | null;
  last_run_status: CliRunClassificationStatus | null;
  last_reason: string | null;
  policy: ProviderPolicy;
  created_at: string;
  updated_at: string;
};

export type ProviderRunResult = {
  agent: AgentId;
  date: string;
  runId: string;
  status: CliRunClassificationStatus;
  reason?: string;
  retryAfter?: string;
  now?: Date;
};

type AgentsConfig = {
  provider_policies?: Partial<Record<AgentId, Partial<ProviderPolicy>>>;
};

type ScheduleConfig = {
  timezone: string;
};

const defaultPolicies: Record<AgentId, ProviderPolicy> = {
  codex: {
    unattended_allowed: true,
    max_concurrent: 1,
    cooldown_seconds: 300,
    daily_run_limit: 100
  },
  claude: {
    unattended_allowed: true,
    max_concurrent: 1,
    cooldown_seconds: 300,
    daily_run_limit: 100
  },
  gemini: {
    unattended_allowed: true,
    max_concurrent: 1,
    cooldown_seconds: 300,
    daily_run_limit: 50
  }
};

export class ProviderPolicyBlockedError extends Error {
  constructor(
    readonly agent: AgentId,
    readonly status: ProviderPolicyHealthStatus,
    readonly reason: string
  ) {
    super(`Provider policy blocked ${agent}: ${reason}`);
    this.name = "ProviderPolicyBlockedError";
  }
}

export async function getProviderPolicy(
  projectRoot: string,
  agent: AgentId
): Promise<ProviderPolicy> {
  const config = await loadConfigFile<AgentsConfig>(projectRoot, "agents.json");
  return { ...defaultPolicies[agent], ...config.provider_policies?.[agent] };
}

export async function getProviderPolicyHealth(
  projectRoot: string,
  agent: AgentId,
  options: { date?: string; now?: Date; persist?: boolean } = {}
): Promise<ProviderPolicyHealth> {
  const now = options.now ?? new Date();
  const [date, policy] = await Promise.all([
    options.date === undefined ? providerDate(projectRoot, now) : options.date,
    getProviderPolicy(projectRoot, agent)
  ]);
  const existing = await readHealth(projectRoot, agent);
  let health = existing === null
    ? createHealth(agent, policy, date, now)
    : reconcileHealth(existing, policy, date, now);

  health = { ...health, available: isAvailable(health, true, now) };
  if (options.persist !== false && !sameHealth(existing, health)) {
    await writeJsonFileAtomic(providerHealthPath(projectRoot, agent), health);
  }
  return health;
}

export async function listProviderPolicyHealth(
  projectRoot: string,
  options: { date?: string; now?: Date; persist?: boolean } = {}
): Promise<ProviderPolicyHealth[]> {
  return Promise.all(
    agentIds.map((agent) => getProviderPolicyHealth(projectRoot, agent, options))
  );
}

export async function beginProviderRun(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    runId: string;
    unattended: boolean;
    now?: Date;
  }
): Promise<ProviderPolicyHealth> {
  const now = input.now ?? new Date();
  const health = await getProviderPolicyHealth(projectRoot, input.agent, {
    date: input.date,
    now
  });
  const blockReason = providerBlockReason(health, input.unattended, now);
  if (blockReason !== null) {
    await appendAudit(projectRoot, {
      event: "provider.run_blocked",
      agent: input.agent,
      run_id: input.runId,
      reason: blockReason,
      status: health.status,
      actor: "kairon-dispatcher",
      created_at: now.toISOString()
    });
    throw new ProviderPolicyBlockedError(input.agent, health.status, blockReason);
  }

  const activeRunIds = [...new Set([...health.active_run_ids, input.runId])];
  const dailyRunCount = health.daily_run_count + 1;
  const updated: ProviderPolicyHealth = {
    ...health,
    available:
      health.policy.unattended_allowed &&
      dailyRunCount < health.policy.daily_run_limit &&
      activeRunIds.length < health.policy.max_concurrent,
    daily_run_count: dailyRunCount,
    active_run_ids: activeRunIds,
    last_run_id: input.runId,
    updated_at: now.toISOString()
  };
  await writeJsonFileAtomic(providerHealthPath(projectRoot, input.agent), updated);
  return updated;
}

export async function finishProviderRun(
  projectRoot: string,
  input: ProviderRunResult
): Promise<ProviderPolicyHealth> {
  const now = input.now ?? new Date();
  const health = await getProviderPolicyHealth(projectRoot, input.agent, {
    date: input.date,
    now
  });
  const activeRunIds = health.active_run_ids.filter((runId) => runId !== input.runId);
  const failureCategory = providerFailureCategory(input.status, input.reason);
  let updated: ProviderPolicyHealth = {
    ...health,
    active_run_ids: activeRunIds,
    last_run_id: input.runId,
    last_run_status: input.status,
    last_reason: input.reason ?? null,
    updated_at: now.toISOString()
  };

  if (health.suspended) {
    updated = {
      ...updated,
      status: "suspended",
      available: false,
      failure_category: health.failure_category,
      suspended: true,
      suspended_reason: health.suspended_reason,
      suspended_by: health.suspended_by,
      next_retry_at: null
    };
  } else if (input.status === "completed") {
    const dailyLimitReached = updated.daily_run_count >= updated.policy.daily_run_limit;
    updated = {
      ...updated,
      status: dailyLimitReached ? "daily_limit_reached" : "ready",
      available:
        !dailyLimitReached &&
        updated.policy.unattended_allowed &&
        updated.active_run_ids.length < updated.policy.max_concurrent,
      failure_category: null,
      next_retry_at: null
    };
  } else if (failureCategory === "quota" || failureCategory === "rate_limit") {
    const nextRetryAt = retryAt(input.retryAfter, health.policy.cooldown_seconds, now);
    updated = {
      ...updated,
      status: "cooldown",
      available: false,
      failure_category: failureCategory,
      suspended: false,
      suspended_reason: null,
      suspended_by: null,
      next_retry_at: nextRetryAt
    };
  } else {
    updated = {
      ...updated,
      status: "suspended",
      available: false,
      failure_category: failureCategory,
      suspended: true,
      suspended_reason: input.reason ?? `provider_${failureCategory}`,
      suspended_by: "kairon-runner",
      next_retry_at: null
    };
  }

  await writeJsonFileAtomic(providerHealthPath(projectRoot, input.agent), updated);
  await appendAudit(projectRoot, {
    event: "provider.run_finished",
    agent: input.agent,
    run_id: input.runId,
    run_status: input.status,
    failure_category: failureCategory,
    provider_status: updated.status,
    reason: input.reason ?? null,
    actor: "kairon-runner",
    created_at: now.toISOString()
  });
  return updated;
}

export async function suspendProvider(
  projectRoot: string,
  input: { agent: AgentId; reason: string; actor?: string; now?: Date }
): Promise<ProviderPolicyHealth> {
  const now = input.now ?? new Date();
  const reason = requireReason(input.reason);
  const health = await getProviderPolicyHealth(projectRoot, input.agent, { now });
  const updated: ProviderPolicyHealth = {
    ...health,
    status: "suspended",
    available: false,
    failure_category: "compliance",
    suspended: true,
    suspended_reason: reason,
    suspended_by: input.actor ?? "local-cli",
    next_retry_at: null,
    updated_at: now.toISOString()
  };
  await writeJsonFileAtomic(providerHealthPath(projectRoot, input.agent), updated);
  await appendAudit(projectRoot, {
    event: "provider.suspended",
    agent: input.agent,
    reason,
    actor: input.actor ?? "local-cli",
    created_at: now.toISOString()
  });
  return updated;
}

export async function resumeProvider(
  projectRoot: string,
  input: { agent: AgentId; reason: string; actor?: string; now?: Date }
): Promise<ProviderPolicyHealth> {
  const now = input.now ?? new Date();
  const reason = requireReason(input.reason);
  const health = await getProviderPolicyHealth(projectRoot, input.agent, { now });
  const updated: ProviderPolicyHealth = {
    ...health,
    status:
      health.daily_run_count >= health.policy.daily_run_limit
        ? "daily_limit_reached"
        : "ready",
    available:
      health.daily_run_count < health.policy.daily_run_limit &&
      health.policy.unattended_allowed &&
      health.active_run_ids.length < health.policy.max_concurrent,
    failure_category: null,
    suspended: false,
    suspended_reason: null,
    suspended_by: null,
    next_retry_at: null,
    active_run_ids: [],
    last_reason: `manual_resume: ${reason}`,
    updated_at: now.toISOString()
  };
  await writeJsonFileAtomic(providerHealthPath(projectRoot, input.agent), updated);
  await appendAudit(projectRoot, {
    event: "provider.resumed",
    agent: input.agent,
    reason,
    actor: input.actor ?? "local-cli",
    created_at: now.toISOString()
  });
  return updated;
}

export function providerFailureCategory(
  status: CliRunClassificationStatus,
  reason?: string
): ProviderFailureCategory | null {
  if (status === "completed") {
    return null;
  }
  if (status === "rate_limited") {
    return "rate_limit";
  }
  if (status === "usage_limited") {
    return "quota";
  }
  if (reason === "cli_login_required" || reason?.includes("auth") === true) {
    return "auth";
  }
  if (
    reason === "cli_terms_acceptance_required" ||
    status === "permission_required"
  ) {
    return "compliance";
  }
  if (status === "setup_required") {
    return "setup";
  }
  return "unknown";
}

export function isProviderRunAllowed(
  health: ProviderPolicyHealth,
  unattended: boolean,
  now: Date
): boolean {
  return providerBlockReason(health, unattended, now) === null;
}

export function providerHealthPath(projectRoot: string, agent: AgentId): string {
  return resolveInside(getKaironPaths(projectRoot).runtimeDir, "agents", `${agent}-health.json`);
}

export function providerHealthArtifactPath(projectRoot: string, agent: AgentId): string {
  return toPosixPath(path.relative(projectRoot, providerHealthPath(projectRoot, agent)));
}

export function providerPolicyAuditPath(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "audit", "provider-policy.jsonl");
}

function createHealth(
  agent: AgentId,
  policy: ProviderPolicy,
  date: string,
  now: Date
): ProviderPolicyHealth {
  return {
    schema_version: "0.1",
    kind: "provider_policy_health",
    agent,
    status: "ready",
    available: policy.unattended_allowed,
    failure_category: null,
    suspended: false,
    suspended_reason: null,
    suspended_by: null,
    next_retry_at: null,
    daily_date: date,
    daily_run_count: 0,
    active_run_ids: [],
    last_run_id: null,
    last_run_status: null,
    last_reason: null,
    policy,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

function reconcileHealth(
  current: ProviderPolicyHealth,
  policy: ProviderPolicy,
  date: string,
  now: Date
): ProviderPolicyHealth {
  let health = { ...current, policy };
  if (health.daily_date !== date) {
    health = {
      ...health,
      daily_date: date,
      daily_run_count: 0,
      active_run_ids: [],
      status:
        health.suspended
          ? "suspended"
          : health.status === "daily_limit_reached"
            ? "ready"
            : health.status,
      next_retry_at: health.suspended ? null : health.next_retry_at,
      updated_at: now.toISOString()
    };
  }
  if (
    health.status === "cooldown" &&
    health.next_retry_at !== null &&
    Date.parse(health.next_retry_at) <= now.getTime()
  ) {
    health = {
      ...health,
      status: "ready",
      failure_category: null,
      next_retry_at: null,
      updated_at: now.toISOString()
    };
  }
  if (!health.suspended && health.daily_run_count >= policy.daily_run_limit) {
    health = { ...health, status: "daily_limit_reached", updated_at: now.toISOString() };
  }
  return health;
}

function providerBlockReason(
  health: ProviderPolicyHealth,
  unattended: boolean,
  now: Date
): string | null {
  if (unattended && !health.policy.unattended_allowed) {
    return "unattended_not_allowed";
  }
  if (health.suspended || health.status === "suspended") {
    return health.suspended_reason ?? "provider_suspended";
  }
  if (
    health.status === "cooldown" &&
    (health.next_retry_at === null || Date.parse(health.next_retry_at) > now.getTime())
  ) {
    return `provider_cooldown_until_${health.next_retry_at ?? "manual_resume"}`;
  }
  if (health.daily_run_count >= health.policy.daily_run_limit) {
    return "daily_run_limit_reached";
  }
  if (health.active_run_ids.length >= health.policy.max_concurrent) {
    return "max_concurrent_reached";
  }
  return null;
}

function isAvailable(health: ProviderPolicyHealth, unattended: boolean, now: Date): boolean {
  return isProviderRunAllowed(health, unattended, now);
}

function retryAt(value: string | undefined, fallbackSeconds: number, now: Date): string {
  if (value !== undefined && /^\d+$/.test(value)) {
    return new Date(now.getTime() + Number(value) * 1_000).toISOString();
  }
  if (value !== undefined) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > now.getTime()) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(now.getTime() + fallbackSeconds * 1_000).toISOString();
}

async function readHealth(
  projectRoot: string,
  agent: AgentId
): Promise<ProviderPolicyHealth | null> {
  const filePath = providerHealthPath(projectRoot, agent);
  try {
    await access(filePath);
    return await readJsonFile<ProviderPolicyHealth>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function appendAudit(
  projectRoot: string,
  event: Record<string, unknown>
): Promise<void> {
  await appendJsonLine(providerPolicyAuditPath(projectRoot), {
    schema_version: "0.1",
    ...event
  });
}

function requireReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length === 0) {
    throw new Error("Provider policy operation requires a non-empty reason.");
  }
  return normalized
    .replace(
      /(api[_-]?key|api[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*["']?[^"',;\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

async function providerDate(projectRoot: string, now: Date): Promise<string> {
  const schedule = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  return getLocalDateKey(now, schedule.timezone);
}

function sameHealth(
  left: ProviderPolicyHealth | null,
  right: ProviderPolicyHealth
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}
