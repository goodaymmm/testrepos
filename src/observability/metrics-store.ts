import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { withResourceLock } from "../core/fs/resource-lock.js";

export const runtimeMetricNames = [
  "runtime_tick_duration_ms",
  "queue_ready_age_ms",
  "queue_claim_duration_ms",
  "run_latency_ms",
  "workflow_transition_total",
  "notification_result",
  "notification_policy_decision_total",
  "remote_readiness"
] as const;

export type RuntimeMetricName = (typeof runtimeMetricNames)[number];

export type RuntimeMetricSample = {
  schema_version: "0.1";
  artifact_kind: "runtime_metric_sample";
  metric: RuntimeMetricName;
  value: number;
  unit: "milliseconds" | "count" | "ratio";
  labels: Record<string, string>;
  recorded_at: string;
};

export type RuntimeMetricAggregate = {
  metric: RuntimeMetricName;
  unit: RuntimeMetricSample["unit"];
  samples: number;
  minimum: number;
  maximum: number;
  average: number;
  p50: number;
  p95: number;
  latest: number;
};

export type RuntimeMetricsSnapshot = {
  schema_version: "0.1";
  artifact_kind: "runtime_metrics_snapshot";
  generated_at: string;
  window: {
    start: string;
    end: string;
    minutes: number;
  };
  source_files: number;
  valid_samples: number;
  corrupt_samples: number;
  metrics: Partial<Record<RuntimeMetricName, RuntimeMetricAggregate>>;
};

export type RuntimeMetricsReport = {
  schema_version: "0.1";
  artifact_kind: "runtime_metrics_report";
  period: "daily" | "weekly";
  period_key: string;
  generated_at: string;
  snapshot: RuntimeMetricsSnapshot;
};

export type AppendRuntimeMetricInput = {
  metric: RuntimeMetricName;
  value: number;
  labels?: Record<string, string>;
  recordedAt?: Date;
};

const metricUnits: Record<RuntimeMetricName, RuntimeMetricSample["unit"]> = {
  runtime_tick_duration_ms: "milliseconds",
  queue_ready_age_ms: "milliseconds",
  queue_claim_duration_ms: "milliseconds",
  run_latency_ms: "milliseconds",
  workflow_transition_total: "count",
  notification_result: "ratio",
  notification_policy_decision_total: "count",
  remote_readiness: "ratio"
};

const allowedLabelValues: Record<string, readonly string[]> = {
  mode: ["active_work", "standby_work", "maintenance"],
  action: [
    "processed-command",
    "processed-item",
    "maintenance-run",
    "maintenance-skipped",
    "idle"
  ],
  item_type: [
    "agent.run",
    "health.check",
    "review.run",
    "git.transaction",
    "approval.command",
    "schedule.command",
    "maintenance.run"
  ],
  result: [
    "completed",
    "failed",
    "success",
    "setup_required",
    "unreachable",
    "ready",
    "unknown",
    "send",
    "defer",
    "suppress",
    "aggregate"
  ],
  provider: ["discord", "board", "github", "runtime", "other"],
  reason: [
    "none",
    "quiet_hours",
    "maintenance_window",
    "reminder_interval",
    "daily_budget",
    "below_minimum_severity",
    "local_audit_only"
  ],
  transition: [
    "queued_to_claimed",
    "claimed_to_completed",
    "claimed_to_failed",
    "started_to_completed",
    "started_to_failed",
    "other"
  ]
};

export async function appendRuntimeMetric(
  projectRoot: string,
  input: AppendRuntimeMetricInput
): Promise<RuntimeMetricSample> {
  const recordedAt = input.recordedAt ?? new Date();
  const sample: RuntimeMetricSample = {
    schema_version: "0.1",
    artifact_kind: "runtime_metric_sample",
    metric: input.metric,
    value: normalizeMetricValue(input.metric, input.value),
    unit: metricUnits[input.metric],
    labels: normalizeMetricLabels(input.labels ?? {}),
    recorded_at: recordedAt.toISOString()
  };
  const root = metricsRoot(projectRoot);
  const filePath = resolveInside(
    rawMetricsDirectory(projectRoot),
    `${sample.recorded_at.slice(0, 10)}.jsonl`
  );

  await withResourceLock(
    projectRoot,
    root,
    { owner: "runtime-metrics-append", ttlMs: 30_000 },
    async () => appendJsonLine(filePath, sample)
  );
  return sample;
}

export async function createRuntimeMetricsSnapshot(
  projectRoot: string,
  options: {
    now?: Date;
    windowMinutes?: number;
    persist?: boolean;
  } = {}
): Promise<RuntimeMetricsSnapshot> {
  const now = options.now ?? new Date();
  const windowMinutes = normalizeWindowMinutes(options.windowMinutes ?? 60);
  const start = new Date(now.getTime() - windowMinutes * 60_000);
  const collected = await collectMetricSamples(projectRoot, start, now);
  const metrics: RuntimeMetricsSnapshot["metrics"] = {};

  for (const metric of runtimeMetricNames) {
    const samples = collected.samples.filter((sample) => sample.metric === metric);
    if (samples.length === 0) {
      continue;
    }
    const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
    metrics[metric] = {
      metric,
      unit: metricUnits[metric],
      samples: values.length,
      minimum: values[0] ?? 0,
      maximum: values.at(-1) ?? 0,
      average: round(values.reduce((total, value) => total + value, 0) / values.length),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      latest: samples
        .slice()
        .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0]
        ?.value ?? 0
    };
  }

  const snapshot: RuntimeMetricsSnapshot = {
    schema_version: "0.1",
    artifact_kind: "runtime_metrics_snapshot",
    generated_at: now.toISOString(),
    window: {
      start: start.toISOString(),
      end: now.toISOString(),
      minutes: windowMinutes
    },
    source_files: collected.sourceFiles,
    valid_samples: collected.samples.length,
    corrupt_samples: collected.corruptSamples,
    metrics
  };

  if (options.persist !== false) {
    await writeJsonFileAtomic(latestMetricsSnapshotPath(projectRoot), snapshot);
  }
  return snapshot;
}

export async function createRuntimeMetricsReport(
  projectRoot: string,
  options: {
    period?: "daily" | "weekly";
    now?: Date;
  } = {}
): Promise<{ report: RuntimeMetricsReport; path: string }> {
  const now = options.now ?? new Date();
  const period = options.period ?? "daily";
  const windowMinutes = period === "daily" ? 24 * 60 : 7 * 24 * 60;
  const snapshot = await createRuntimeMetricsSnapshot(projectRoot, {
    now,
    windowMinutes,
    persist: false
  });
  const periodKey =
    period === "daily" ? now.toISOString().slice(0, 10) : isoWeekKey(now);
  const report: RuntimeMetricsReport = {
    schema_version: "0.1",
    artifact_kind: "runtime_metrics_report",
    period,
    period_key: periodKey,
    generated_at: now.toISOString(),
    snapshot
  };
  const reportPath = resolveInside(
    metricsRollupsDirectory(projectRoot),
    period,
    `${periodKey}.json`
  );
  await writeJsonFileAtomic(reportPath, report);
  return { report, path: toProjectPath(projectRoot, reportPath) };
}

export function metricsRoot(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "metrics");
}

export function rawMetricsDirectory(projectRoot: string): string {
  return resolveInside(metricsRoot(projectRoot), "raw");
}

export function metricsRollupsDirectory(projectRoot: string): string {
  return resolveInside(metricsRoot(projectRoot), "rollups");
}

export function latestMetricsSnapshotPath(projectRoot: string): string {
  return resolveInside(metricsRoot(projectRoot), "snapshots", "latest.json");
}

async function collectMetricSamples(
  projectRoot: string,
  start: Date,
  end: Date
): Promise<{
  samples: RuntimeMetricSample[];
  corruptSamples: number;
  sourceFiles: number;
}> {
  const directory = rawMetricsDirectory(projectRoot);
  const entries = await readDirectory(directory);
  const samples: RuntimeMetricSample[] = [];
  let corruptSamples = 0;
  let sourceFiles = 0;

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name)) {
      continue;
    }
    sourceFiles += 1;
    const text = await readFile(resolveInside(directory, entry.name), "utf8");
    for (const line of text.split(/\r?\n/u).filter((value) => value.trim().length > 0)) {
      try {
        const sample = parseRuntimeMetricSample(JSON.parse(line) as unknown);
        const timestamp = Date.parse(sample.recorded_at);
        if (timestamp >= start.getTime() && timestamp <= end.getTime()) {
          samples.push(sample);
        }
      } catch {
        corruptSamples += 1;
      }
    }
  }
  return { samples, corruptSamples, sourceFiles };
}

function parseRuntimeMetricSample(value: unknown): RuntimeMetricSample {
  if (value === null || typeof value !== "object") {
    throw new Error("metric sample must be an object");
  }
  const candidate = value as Partial<RuntimeMetricSample>;
  if (
    candidate.schema_version !== "0.1" ||
    candidate.artifact_kind !== "runtime_metric_sample" ||
    !runtimeMetricNames.includes(candidate.metric as RuntimeMetricName) ||
    typeof candidate.value !== "number" ||
    !Number.isFinite(candidate.value) ||
    candidate.unit !== metricUnits[candidate.metric as RuntimeMetricName] ||
    typeof candidate.recorded_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.recorded_at))
  ) {
    throw new Error("invalid metric sample");
  }
  return {
    schema_version: "0.1",
    artifact_kind: "runtime_metric_sample",
    metric: candidate.metric as RuntimeMetricName,
    value: normalizeMetricValue(candidate.metric as RuntimeMetricName, candidate.value),
    unit: candidate.unit,
    labels: normalizeMetricLabels(candidate.labels ?? {}),
    recorded_at: candidate.recorded_at
  };
}

function normalizeMetricValue(metric: RuntimeMetricName, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Metric ${metric} requires a finite non-negative value.`);
  }
  if (
    (metric === "notification_result" || metric === "remote_readiness") &&
    value > 1
  ) {
    throw new Error(`Metric ${metric} requires a ratio between 0 and 1.`);
  }
  return round(value);
}

function normalizeMetricLabels(labels: Record<string, string>): Record<string, string> {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const allowed = allowedLabelValues[key];
    if (allowed === undefined) {
      throw new Error(`Metric label is not allowed: ${key}`);
    }
    const value = String(rawValue);
    if (!allowed.includes(value)) {
      throw new Error(`Metric label value is not allowed: ${key}=${value}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeWindowMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 525_600) {
    throw new Error(`Invalid metrics window minutes: ${value}`);
  }
  return value;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return round(sorted[index] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function isoWeekKey(value: Date): string {
  const date = new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate()
  ));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
