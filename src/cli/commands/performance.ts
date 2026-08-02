import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "../../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../../core/fs/paths.js";
import {
  readPerformanceBenchmark,
  runPerformanceSuite,
  writePerformanceReport,
  type PerformanceProfile,
  type PerformanceScenarioId
} from "../../performance/benchmark.js";
import {
  comparePerformanceArtifacts,
  formatPerformanceReport,
  type PerformanceComparisonArtifact
} from "../../performance/budget.js";

export type PerformanceRunCommandOptions = {
  profile?: string;
  scenario?: string[];
  warmupIterations?: string;
  iterations?: string;
  output?: string;
};

export type PerformanceCompareCommandOptions = {
  baseline: string;
  output?: string;
};

export type PerformanceReportCommandOptions = {
  output?: string;
};

export async function performanceRunCommand(
  projectRoot: string,
  options: PerformanceRunCommandOptions = {}
): Promise<{ text: string; passed: boolean }> {
  const result = await runPerformanceSuite(projectRoot, {
    profile: parseProfile(options.profile),
    scenarioIds: options.scenario?.map(
      (value) => value as PerformanceScenarioId
    ),
    warmupIterations: parseNonNegativeInteger(
      options.warmupIterations,
      "warmup iterations"
    ),
    iterations: parsePositiveInteger(options.iterations, "iterations"),
    output: options.output
  });
  return {
    text: [
      "Kairon performance benchmark completed.",
      `status=${result.artifact.status}`,
      `profile=${result.artifact.profile}`,
      `run_id=${result.artifact.run_id}`,
      `scenarios=${result.artifact.scenarios.length}`,
      `source_commit=${result.artifact.source_commit}`,
      `environment=${result.artifact.environment.fingerprint}`,
      `output=${result.output_path}`
    ].join("\n"),
    passed: result.artifact.status === "PASS"
  };
}

export async function performanceCompareCommand(
  projectRoot: string,
  currentPath: string,
  options: PerformanceCompareCommandOptions
): Promise<{ text: string; passed: boolean }> {
  const [current, baseline] = await Promise.all([
    readPerformanceBenchmark(projectRoot, currentPath),
    readPerformanceBenchmark(projectRoot, options.baseline)
  ]);
  const comparison = comparePerformanceArtifacts(current, baseline);
  const output =
    options.output ??
    `.kairon/performance/comparisons/${current.run_id}-vs-${baseline.run_id}.json`;
  const absolute = resolvePath(projectRoot, output);
  await writeJsonFileAtomic(absolute, comparison);
  return {
    text: [
      "Kairon performance comparison completed.",
      `status=${comparison.status}`,
      `environment_comparable=${comparison.environment_comparable}`,
      `current_run_id=${comparison.current_run_id}`,
      `baseline_run_id=${comparison.baseline_run_id}`,
      `output=${toPosixPath(path.relative(projectRoot, absolute))}`
    ].join("\n"),
    passed: comparison.status === "PASS"
  };
}

export async function performanceReportCommand(
  projectRoot: string,
  artifactPath: string,
  options: PerformanceReportCommandOptions = {}
): Promise<string> {
  const absolute = resolvePath(projectRoot, artifactPath);
  const artifact = JSON.parse(
    await readFile(absolute, "utf8")
  ) as Awaited<ReturnType<typeof readPerformanceBenchmark>> | PerformanceComparisonArtifact;
  const output =
    options.output ??
    `.kairon/performance/reports/${path.basename(
      artifactPath,
      path.extname(artifactPath)
    )}.md`;
  const outputPath = await writePerformanceReport(
    projectRoot,
    formatPerformanceReport(artifact),
    output
  );
  return [
    "Kairon performance report created.",
    `status=${artifact.status}`,
    `artifact=${toPosixPath(path.relative(projectRoot, absolute))}`,
    `output=${outputPath}`
  ].join("\n");
}

function parseProfile(value: string | undefined): PerformanceProfile {
  if (value === undefined || value === "representative") {
    return "representative";
  }
  if (value === "full") {
    return value;
  }
  throw new Error(`Invalid performance profile: ${value}`);
}

function parseNonNegativeInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function resolvePath(projectRoot: string, target: string): string {
  return resolveInside(projectRoot, target);
}
