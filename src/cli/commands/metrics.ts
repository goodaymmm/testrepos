import {
  createRuntimeMetricsReport,
  createRuntimeMetricsSnapshot
} from "../../observability/metrics-store.js";
import { checkRuntimeSlo } from "../../observability/slo.js";

export async function metricsSnapshotCommand(
  projectRoot: string,
  options: { windowMinutes?: string } = {}
): Promise<string> {
  const snapshot = await createRuntimeMetricsSnapshot(projectRoot, {
    windowMinutes: parsePositiveInteger(
      options.windowMinutes,
      "window minutes",
      60
    )
  });
  return [
    "Kairon metrics snapshot created.",
    `status=${snapshot.corrupt_samples > 0 ? "corrupt_data" : "completed"}`,
    `window_minutes=${snapshot.window.minutes}`,
    `valid_samples=${snapshot.valid_samples}`,
    `corrupt_samples=${snapshot.corrupt_samples}`,
    `metrics=${Object.keys(snapshot.metrics).length}`
  ].join("\n");
}

export async function metricsReportCommand(
  projectRoot: string,
  options: { period?: string } = {}
): Promise<string> {
  const period =
    options.period === undefined || options.period === "daily"
      ? "daily"
      : options.period === "weekly"
        ? "weekly"
        : undefined;
  if (period === undefined) {
    throw new Error(`Invalid metrics report period: ${options.period}`);
  }
  const result = await createRuntimeMetricsReport(projectRoot, { period });
  return [
    "Kairon metrics report created.",
    `period=${result.report.period}`,
    `period_key=${result.report.period_key}`,
    `valid_samples=${result.report.snapshot.valid_samples}`,
    `corrupt_samples=${result.report.snapshot.corrupt_samples}`,
    `report=${result.path}`
  ].join("\n");
}

export async function metricsSloCheckCommand(
  projectRoot: string
): Promise<string> {
  const summary = await checkRuntimeSlo(projectRoot);
  return [
    "Kairon metrics SLO check completed.",
    `status=${summary.status}`,
    `evaluated_at=${summary.evaluated_at}`,
    `window_minutes=${summary.window.minutes}`,
    `minimum_samples=${summary.minimum_samples}`,
    `corrupt_samples=${summary.corrupt_samples}`,
    ...Object.values(summary.objectives).map(
      (objective) =>
        `objective.${objective.objective}=${objective.status} samples=${objective.samples}` +
        (objective.value === undefined ? "" : ` value=${objective.value}`)
    )
  ].join("\n");
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}
