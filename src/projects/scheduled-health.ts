import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  acquireLockFile,
  LockAlreadyExistsError,
  releaseLockFile
} from "../core/fs/lock-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  evaluateAlertPolicy,
  resolveAlertPolicy,
  type AlertPolicyDecision
} from "../notifications/alert-policy.js";
import type {
  WatchdogAlert,
  WatchdogPendingNotification
} from "../runtime/watchdog.js";
import {
  ProjectSupervisor,
  type ProjectHealth,
  type ProjectHealthStatus,
  type ProjectSupervisorReport
} from "./supervisor.js";

export type ScheduledHealthAlertThreshold = "warning" | "error";

export type ScheduledHealthProfile = {
  schema_version: "0.1";
  interval_minutes: number;
  project_timeout_ms: number;
  concurrency: number;
  retention_days: number;
  alert_threshold: ScheduledHealthAlertThreshold;
  provider_pressure_threshold: number;
};

export type ScheduledProjectHealth = {
  project_id: string;
  status: ProjectHealthStatus;
  issues: string[];
  registered_version: string;
  observed_version?: string;
  runtime: {
    locked?: boolean;
    stale?: boolean;
    mode?: string;
    queue_ready?: number;
    queue_failed?: number;
  };
  endpoints: Array<{
    kind: string;
    status: string;
    external_url?: string;
  }>;
  provider_limits: Record<string, number>;
  alert_policy?: ScheduledHealthAlertPolicyResult;
};

export type ScheduledHealthAlertPolicyResult = {
  decision: AlertPolicyDecision["decision"] | "unavailable";
  reason: AlertPolicyDecision["reason"] | "policy_unavailable";
  route_id?: string;
};

export type ScheduledHealthDiff = {
  previous_snapshot_id?: string;
  added: string[];
  removed: string[];
  changed: Array<{
    project_id: string;
    before: ProjectHealthStatus;
    after: ProjectHealthStatus;
    added_issues: string[];
    removed_issues: string[];
  }>;
};

export type ScheduledHealthSnapshot = {
  schema_version: "0.1";
  snapshot_id: string;
  generated_at: string;
  status: "completed" | "failed";
  ok: boolean;
  summary: ProjectSupervisorReport["summary"];
  projects: ScheduledProjectHealth[];
  conflicts: ProjectSupervisorReport["conflicts"];
  provider_pressure: Array<{
    provider: string;
    aggregate_max_concurrent: number;
    threshold: number;
    status: "normal" | "pressure";
  }>;
  diff: ScheduledHealthDiff;
  failure_reason?: string;
};

export type ScheduledHealthRollup = {
  schema_version: "0.1";
  period: "daily" | "weekly";
  key: string;
  updated_at: string;
  scans: number;
  failed_scans: number;
  latest_snapshot_id: string;
  latest_summary: ProjectSupervisorReport["summary"];
  highest_error_count: number;
  highest_warning_count: number;
};

export type ScheduledHealthPaths = {
  root: string;
  snapshotsDir: string;
  dailyDir: string;
  weeklyDir: string;
  latestPath: string;
  profilePath: string;
  lockPath: string;
  plansDir: string;
  taskStatusPath: string;
};

export type ScheduledHealthScanResult =
  | {
      status: "completed" | "failed";
      snapshot: ScheduledHealthSnapshot;
      snapshot_path: string;
      latest_path: string;
    }
  | {
      status: "busy";
      reason: "scan_lock_held";
      lock_path: string;
    };

export type ScheduledHealthScanOptions = {
  registryPath: string;
  userDataRoot?: string;
  profile?: Partial<Omit<ScheduledHealthProfile, "schema_version">>;
  supervisor?: ProjectSupervisor;
  now?: () => Date;
  alertPolicyEvaluator?: (
    project: ProjectHealth,
    now: Date
  ) => Promise<ScheduledHealthAlertPolicyResult>;
};

export const defaultScheduledHealthProfile: ScheduledHealthProfile = {
  schema_version: "0.1",
  interval_minutes: 60,
  project_timeout_ms: 5_000,
  concurrency: 4,
  retention_days: 30,
  alert_threshold: "warning",
  provider_pressure_threshold: 8
};

export function getScheduledHealthPaths(
  registryPath: string,
  userDataRoot = path.dirname(path.resolve(registryPath))
): ScheduledHealthPaths {
  const root = path.join(path.resolve(userDataRoot), "scheduled-health");
  return {
    root,
    snapshotsDir: path.join(root, "snapshots"),
    dailyDir: path.join(root, "rollups", "daily"),
    weeklyDir: path.join(root, "rollups", "weekly"),
    latestPath: path.join(root, "latest.json"),
    profilePath: path.join(root, "profile.json"),
    lockPath: path.join(root, "scan.lock"),
    plansDir: path.join(root, "plans"),
    taskStatusPath: path.join(root, "task-status.json")
  };
}

export async function scanScheduledProjectHealth(
  options: ScheduledHealthScanOptions
): Promise<ScheduledHealthScanResult> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now();
  const profile = normalizeProfile(options.profile);
  const paths = getScheduledHealthPaths(
    options.registryPath,
    options.userDataRoot
  );
  await mkdir(paths.root, { recursive: true });
  await writeJsonFileAtomic(paths.profilePath, profile);

  let lock;
  try {
    lock = await acquireLockFile(
      paths.lockPath,
      "scheduled-project-health",
      Math.max(profile.project_timeout_ms * 2, 30_000)
    );
  } catch (error) {
    if (error instanceof LockAlreadyExistsError) {
      return {
        status: "busy",
        reason: "scan_lock_held",
        lock_path: paths.lockPath
      };
    }
    throw error;
  }

  try {
    const previous = await readOptionalSnapshot(paths.latestPath);
    const supervisor =
      options.supervisor ??
      new ProjectSupervisor({
        registryPath: options.registryPath,
        persistObservations: false,
        projectTimeoutMs: profile.project_timeout_ms,
        concurrency: profile.concurrency
      });

    let snapshot: ScheduledHealthSnapshot;
    try {
      const report = await supervisor.inspect();
      snapshot = await projectSnapshot(
        report,
        profile,
        generatedAt,
        previous,
        options.alertPolicyEvaluator ?? evaluateProjectAlertPolicy
      );
    } catch (error) {
      snapshot = failedSnapshot(generatedAt, previous, safeFailureReason(error));
    }

    const snapshotPath = path.join(
      paths.snapshotsDir,
      `${snapshot.snapshot_id}.json`
    );
    await writeJsonFileAtomic(snapshotPath, snapshot);
    await writeJsonFileAtomic(paths.latestPath, snapshot);
    await updateRollups(paths, snapshot);
    await applyRetention(paths, generatedAt, profile.retention_days);
    return {
      status: snapshot.status,
      snapshot,
      snapshot_path: snapshotPath,
      latest_path: paths.latestPath
    };
  } finally {
    await releaseLockFile(lock);
  }
}

export async function readLatestScheduledHealth(
  registryPath: string,
  userDataRoot?: string
): Promise<ScheduledHealthSnapshot | undefined> {
  return readOptionalSnapshot(
    getScheduledHealthPaths(registryPath, userDataRoot).latestPath
  );
}

function normalizeProfile(
  configured: ScheduledHealthScanOptions["profile"]
): ScheduledHealthProfile {
  const profile: ScheduledHealthProfile = {
    ...defaultScheduledHealthProfile,
    ...configured,
    schema_version: "0.1"
  };
  for (const [name, value] of Object.entries({
    interval_minutes: profile.interval_minutes,
    project_timeout_ms: profile.project_timeout_ms,
    concurrency: profile.concurrency,
    retention_days: profile.retention_days,
    provider_pressure_threshold: profile.provider_pressure_threshold
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (!["warning", "error"].includes(profile.alert_threshold)) {
    throw new Error(`Invalid alert_threshold: ${profile.alert_threshold}`);
  }
  return profile;
}

async function projectSnapshot(
  report: ProjectSupervisorReport,
  profile: ScheduledHealthProfile,
  now: Date,
  previous: ScheduledHealthSnapshot | undefined,
  alertPolicyEvaluator: (
    project: ProjectHealth,
    now: Date
  ) => Promise<ScheduledHealthAlertPolicyResult>
): Promise<ScheduledHealthSnapshot> {
  const projects: ScheduledProjectHealth[] = [];
  for (const project of report.projects) {
    const alertPolicy = meetsAlertThreshold(
      project.status,
      profile.alert_threshold
    )
      ? await alertPolicyEvaluator(project, now)
      : undefined;
    projects.push(toScheduledProject(project, alertPolicy));
  }
  const generatedAt = now.toISOString();
  return {
    schema_version: "0.1",
    snapshot_id: snapshotId(generatedAt),
    generated_at: generatedAt,
    status: "completed",
    ok: report.ok,
    summary: report.summary,
    projects,
    conflicts: report.conflicts,
    provider_pressure: report.provider_limits.map((provider) => ({
      provider: provider.provider,
      aggregate_max_concurrent: provider.aggregate_max_concurrent,
      threshold: profile.provider_pressure_threshold,
      status:
        provider.aggregate_max_concurrent >= profile.provider_pressure_threshold
          ? "pressure"
          : "normal"
    })),
    diff: diffSnapshots(previous, projects)
  };
}

function toScheduledProject(
  project: ProjectHealth,
  alertPolicy: ScheduledHealthAlertPolicyResult | undefined
): ScheduledProjectHealth {
  return {
    project_id: project.project_id,
    status: project.status,
    issues: [...project.issues],
    registered_version: project.registered_version,
    observed_version: project.observed_version,
    runtime: {
      locked: project.runtime?.locked,
      stale: project.runtime?.stale,
      mode: project.runtime?.mode,
      queue_ready: project.runtime?.queue.ready,
      queue_failed: project.runtime?.queue.failed
    },
    endpoints: project.endpoints.map((endpoint) => ({
      kind: endpoint.kind,
      status: endpoint.status,
      external_url: endpoint.external_url
    })),
    provider_limits: { ...project.provider_limits },
    alert_policy: alertPolicy
  };
}

async function evaluateProjectAlertPolicy(
  project: ProjectHealth,
  now: Date
): Promise<ScheduledHealthAlertPolicyResult> {
  try {
    const prepared = await resolveAlertPolicy(project.root);
    const pending: WatchdogPendingNotification = {
      event: "open",
      queued_at: now.toISOString(),
      attempts: 0
    };
    const alert: WatchdogAlert = {
      schema_version: "0.1",
      alert_id: `supervisor:${project.project_id}`,
      project_id: project.project_id,
      fingerprint: `scheduled-health:${project.project_id}`,
      rule: "slo_breach",
      resource: `project:${project.project_id}`,
      severity: project.status === "error" ? "high" : "warning",
      status: "open",
      title: "Scheduled multi-project health finding",
      summary: project.issues.join(",") || project.status,
      evidence: {
        source: "scheduled_project_health",
        issue_count: project.issues.length
      },
      cooldown_seconds: 0,
      occurrence_count: 1,
      recurrence_count: 0,
      first_detected_at: now.toISOString(),
      last_detected_at: now.toISOString(),
      updated_at: now.toISOString(),
      pending_notification: pending
    };
    const decision = evaluateAlertPolicy(prepared.policy, alert, pending, {
      now,
      sent_today: 0
    });
    return {
      decision: decision.decision,
      reason: decision.reason,
      route_id: decision.route_id
    };
  } catch {
    return {
      decision: "unavailable",
      reason: "policy_unavailable"
    };
  }
}

function meetsAlertThreshold(
  status: ProjectHealthStatus,
  threshold: ScheduledHealthAlertThreshold
): boolean {
  if (threshold === "error") {
    return status === "error";
  }
  return status === "warning" || status === "error";
}

function diffSnapshots(
  previous: ScheduledHealthSnapshot | undefined,
  projects: ScheduledProjectHealth[]
): ScheduledHealthDiff {
  const before = new Map(
    (previous?.projects ?? []).map((project) => [project.project_id, project])
  );
  const after = new Map(projects.map((project) => [project.project_id, project]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.entries()]
    .flatMap(([projectId, current]) => {
      const prior = before.get(projectId);
      if (prior === undefined) {
        return [];
      }
      const addedIssues = current.issues.filter(
        (issue) => !prior.issues.includes(issue)
      );
      const removedIssues = prior.issues.filter(
        (issue) => !current.issues.includes(issue)
      );
      if (
        prior.status === current.status &&
        addedIssues.length === 0 &&
        removedIssues.length === 0
      ) {
        return [];
      }
      return [
        {
          project_id: projectId,
          before: prior.status,
          after: current.status,
          added_issues: addedIssues.sort(),
          removed_issues: removedIssues.sort()
        }
      ];
    })
    .sort((left, right) => left.project_id.localeCompare(right.project_id));
  return {
    previous_snapshot_id: previous?.snapshot_id,
    added,
    removed,
    changed
  };
}

function failedSnapshot(
  now: Date,
  previous: ScheduledHealthSnapshot | undefined,
  reason: string
): ScheduledHealthSnapshot {
  const generatedAt = now.toISOString();
  return {
    schema_version: "0.1",
    snapshot_id: snapshotId(generatedAt),
    generated_at: generatedAt,
    status: "failed",
    ok: false,
    summary: { pass: 0, warning: 0, error: 1 },
    projects: [],
    conflicts: [],
    provider_pressure: [],
    diff: diffSnapshots(previous, []),
    failure_reason: reason
  };
}

async function updateRollups(
  paths: ScheduledHealthPaths,
  snapshot: ScheduledHealthSnapshot
): Promise<void> {
  const generatedAt = new Date(snapshot.generated_at);
  await updateRollup(
    path.join(paths.dailyDir, `${snapshot.generated_at.slice(0, 10)}.json`),
    "daily",
    snapshot.generated_at.slice(0, 10),
    snapshot
  );
  const weekKey = isoWeekKey(generatedAt);
  await updateRollup(
    path.join(paths.weeklyDir, `${weekKey}.json`),
    "weekly",
    weekKey,
    snapshot
  );
}

async function updateRollup(
  filePath: string,
  period: ScheduledHealthRollup["period"],
  key: string,
  snapshot: ScheduledHealthSnapshot
): Promise<void> {
  const current = await readOptionalRollup(filePath);
  const rollup: ScheduledHealthRollup = {
    schema_version: "0.1",
    period,
    key,
    updated_at: snapshot.generated_at,
    scans: (current?.scans ?? 0) + 1,
    failed_scans:
      (current?.failed_scans ?? 0) + (snapshot.status === "failed" ? 1 : 0),
    latest_snapshot_id: snapshot.snapshot_id,
    latest_summary: snapshot.summary,
    highest_error_count: Math.max(
      current?.highest_error_count ?? 0,
      snapshot.summary.error
    ),
    highest_warning_count: Math.max(
      current?.highest_warning_count ?? 0,
      snapshot.summary.warning
    )
  };
  await writeJsonFileAtomic(filePath, rollup);
}

async function applyRetention(
  paths: ScheduledHealthPaths,
  now: Date,
  retentionDays: number
): Promise<void> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let entries;
  try {
    entries = await readdir(paths.snapshotsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(paths.snapshotsDir, entry.name);
    const snapshot = await readOptionalSnapshot(filePath);
    if (
      snapshot !== undefined &&
      Date.parse(snapshot.generated_at) < cutoff
    ) {
      await rm(filePath, { force: true });
    }
  }
}

async function readOptionalSnapshot(
  filePath: string
): Promise<ScheduledHealthSnapshot | undefined> {
  try {
    return await readJsonFile<ScheduledHealthSnapshot>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    return undefined;
  }
}

async function readOptionalRollup(
  filePath: string
): Promise<ScheduledHealthRollup | undefined> {
  try {
    return await readJsonFile<ScheduledHealthRollup>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    return undefined;
  }
}

function snapshotId(generatedAt: string): string {
  return `health-${generatedAt.replace(/\D/gu, "").slice(0, 17)}`;
}

function isoWeekKey(date: Date): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function safeFailureReason(error: unknown): string {
  const name =
    error instanceof Error && error.name.length > 0
      ? error.name
      : "scheduled_health_scan_failed";
  return name.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 80);
}
