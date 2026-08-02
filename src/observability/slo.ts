import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside } from "../core/fs/paths.js";
import {
  createRuntimeMetricsSnapshot,
  metricsRoot,
  type RuntimeMetricAggregate,
  type RuntimeMetricName,
  type RuntimeMetricsSnapshot
} from "./metrics-store.js";

export type SloStatus =
  | "PASS"
  | "WARNING"
  | "CRITICAL"
  | "INSUFFICIENT_DATA"
  | "CORRUPT_DATA";

export type SloObjectiveName =
  | "tick_duration"
  | "queue_ready_age"
  | "run_latency"
  | "notification_success"
  | "remote_readiness";

export type SloThreshold = {
  warning: number;
  critical: number;
};

export type SloPolicy = {
  window_minutes: number;
  minimum_samples: number;
  objectives: Record<SloObjectiveName, SloThreshold & { enabled: boolean }>;
};

export type SloObjectiveResult = {
  objective: SloObjectiveName;
  metric: RuntimeMetricName;
  status: Exclude<SloStatus, "CORRUPT_DATA">;
  samples: number;
  statistic: "p95" | "success_ratio";
  value?: number;
  warning_threshold: number;
  critical_threshold: number;
};

export type RuntimeSloSummary = {
  schema_version: "0.1";
  artifact_kind: "runtime_slo_summary";
  evaluated_at: string;
  status: SloStatus;
  window: RuntimeMetricsSnapshot["window"];
  minimum_samples: number;
  corrupt_samples: number;
  objectives: Record<SloObjectiveName, SloObjectiveResult>;
};

type RuntimeObservabilityConfig = {
  observability?: {
    enabled?: boolean;
    slo?: {
      window_minutes?: number;
      minimum_samples?: number;
      objectives?: Partial<
        Record<
          SloObjectiveName,
          Partial<SloThreshold> & { enabled?: boolean }
        >
      >;
    };
  };
};

export const defaultSloPolicy: SloPolicy = {
  window_minutes: 60,
  minimum_samples: 5,
  objectives: {
    tick_duration: { enabled: true, warning: 1_000, critical: 5_000 },
    queue_ready_age: { enabled: true, warning: 300_000, critical: 900_000 },
    run_latency: { enabled: true, warning: 600_000, critical: 1_800_000 },
    notification_success: { enabled: true, warning: 0.9, critical: 0.75 },
    remote_readiness: { enabled: true, warning: 0.98, critical: 0.9 }
  }
};

const objectiveMetric: Record<SloObjectiveName, RuntimeMetricName> = {
  tick_duration: "runtime_tick_duration_ms",
  queue_ready_age: "queue_ready_age_ms",
  run_latency: "run_latency_ms",
  notification_success: "notification_result",
  remote_readiness: "remote_readiness"
};

export async function resolveSloPolicy(projectRoot: string): Promise<SloPolicy> {
  const runtime = await loadConfigFile<RuntimeObservabilityConfig>(
    projectRoot,
    "runtime.json"
  );
  const configured = runtime.observability?.slo;
  return {
    window_minutes:
      configured?.window_minutes ?? defaultSloPolicy.window_minutes,
    minimum_samples:
      configured?.minimum_samples ?? defaultSloPolicy.minimum_samples,
    objectives: Object.fromEntries(
      (Object.keys(defaultSloPolicy.objectives) as SloObjectiveName[]).map(
        (objective) => [
          objective,
          {
            ...defaultSloPolicy.objectives[objective],
            ...(configured?.objectives?.[objective] ?? {})
          }
        ]
      )
    ) as SloPolicy["objectives"]
  };
}

export async function checkRuntimeSlo(
  projectRoot: string,
  options: {
    now?: Date;
    policy?: SloPolicy;
    snapshot?: RuntimeMetricsSnapshot;
    persist?: boolean;
  } = {}
): Promise<RuntimeSloSummary> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? (await resolveSloPolicy(projectRoot));
  const snapshot =
    options.snapshot ??
    (await createRuntimeMetricsSnapshot(projectRoot, {
      now,
      windowMinutes: policy.window_minutes
    }));
  const objectives = Object.fromEntries(
    (Object.keys(policy.objectives) as SloObjectiveName[]).map((objective) => [
      objective,
      evaluateObjective(
        objective,
        snapshot.metrics[objectiveMetric[objective]],
        policy
      )
    ])
  ) as RuntimeSloSummary["objectives"];
  const status =
    snapshot.corrupt_samples > 0
      ? "CORRUPT_DATA"
      : overallStatus(Object.values(objectives));
  const summary: RuntimeSloSummary = {
    schema_version: "0.1",
    artifact_kind: "runtime_slo_summary",
    evaluated_at: now.toISOString(),
    status,
    window: snapshot.window,
    minimum_samples: policy.minimum_samples,
    corrupt_samples: snapshot.corrupt_samples,
    objectives
  };
  if (options.persist !== false) {
    await writeJsonFileAtomic(latestSloSummaryPath(projectRoot), summary);
  }
  return summary;
}

export async function readLatestSloSummary(
  projectRoot: string
): Promise<RuntimeSloSummary | undefined> {
  try {
    return await readJsonFile<RuntimeSloSummary>(latestSloSummaryPath(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function latestSloSummaryPath(projectRoot: string): string {
  return resolveInside(metricsRoot(projectRoot), "slo", "latest.json");
}

function evaluateObjective(
  objective: SloObjectiveName,
  aggregate: RuntimeMetricAggregate | undefined,
  policy: SloPolicy
): SloObjectiveResult {
  const threshold = policy.objectives[objective];
  const metric = objectiveMetric[objective];
  const statistic =
    objective === "notification_success" || objective === "remote_readiness"
      ? "success_ratio"
      : "p95";
  if (!threshold.enabled) {
    return {
      objective,
      metric,
      status: "PASS",
      samples: aggregate?.samples ?? 0,
      statistic,
      value: aggregate === undefined
        ? undefined
        : statistic === "success_ratio"
          ? aggregate.average
          : aggregate.p95,
      warning_threshold: threshold.warning,
      critical_threshold: threshold.critical
    };
  }
  if (aggregate === undefined || aggregate.samples < policy.minimum_samples) {
    return {
      objective,
      metric,
      status: "INSUFFICIENT_DATA",
      samples: aggregate?.samples ?? 0,
      statistic,
      warning_threshold: threshold.warning,
      critical_threshold: threshold.critical
    };
  }
  const value = statistic === "success_ratio" ? aggregate.average : aggregate.p95;
  const lowerIsWorse = statistic === "success_ratio";
  const status = lowerIsWorse
    ? value <= threshold.critical
      ? "CRITICAL"
      : value <= threshold.warning
        ? "WARNING"
        : "PASS"
    : value >= threshold.critical
      ? "CRITICAL"
      : value >= threshold.warning
        ? "WARNING"
        : "PASS";
  return {
    objective,
    metric,
    status,
    samples: aggregate.samples,
    statistic,
    value,
    warning_threshold: threshold.warning,
    critical_threshold: threshold.critical
  };
}

function overallStatus(
  objectives: SloObjectiveResult[]
): Exclude<SloStatus, "CORRUPT_DATA"> {
  if (objectives.some((objective) => objective.status === "CRITICAL")) {
    return "CRITICAL";
  }
  if (objectives.some((objective) => objective.status === "WARNING")) {
    return "WARNING";
  }
  if (objectives.some((objective) => objective.status === "INSUFFICIENT_DATA")) {
    return "INSUFFICIENT_DATA";
  }
  return "PASS";
}
