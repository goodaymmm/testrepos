import type {
  PerformanceBenchmarkArtifact,
  PerformanceMetrics,
  PerformanceScenarioId,
  PerformanceStatus
} from "./benchmark.js";

export type PerformanceBudget = {
  max_median_ms: number;
  max_p95_ms: number;
  max_heap_delta_bytes: number;
  max_baseline_ratio: number;
};

export type PerformanceBudgetEvaluation = {
  status: PerformanceStatus;
  limits: PerformanceBudget;
  exceeded: Array<"median_ms" | "p95_ms" | "heap_delta_bytes">;
};

export type PerformanceScenarioComparison = {
  id: PerformanceScenarioId;
  status: PerformanceStatus;
  environment_comparable: boolean;
  current: PerformanceMetrics;
  baseline?: PerformanceMetrics;
  ratios?: {
    median: number;
    p95: number;
  };
  reasons: string[];
};

export type PerformanceComparisonArtifact = {
  schema_version: "0.1";
  artifact_kind: "performance_comparison_result";
  status: PerformanceStatus;
  source_commit: string;
  baseline_source_commit: string;
  environment_comparable: boolean;
  current_run_id: string;
  baseline_run_id: string;
  generated_at: string;
  scenarios: PerformanceScenarioComparison[];
  summary: Record<PerformanceStatus, number> & { total: number };
};

const mebibyte = 1024 * 1024;
const commonBudget: PerformanceBudget = {
  max_median_ms: 750,
  max_p95_ms: 1_500,
  max_heap_delta_bytes: 256 * mebibyte,
  max_baseline_ratio: 1.5
};

const largeBudget: PerformanceBudget = {
  max_median_ms: 2_500,
  max_p95_ms: 5_000,
  max_heap_delta_bytes: 512 * mebibyte,
  max_baseline_ratio: 1.5
};

export function performanceBudgetFor(
  scenarioId: PerformanceScenarioId
): PerformanceBudget {
  return scenarioId.includes("10k") || scenarioId.endsWith(".1k")
    ? { ...largeBudget }
    : { ...commonBudget };
}

export function evaluateAbsolutePerformanceBudget(
  metrics: PerformanceMetrics,
  budget: PerformanceBudget
): PerformanceBudgetEvaluation {
  const exceeded: PerformanceBudgetEvaluation["exceeded"] = [];
  if (metrics.median_ms > budget.max_median_ms) {
    exceeded.push("median_ms");
  }
  if (metrics.p95_ms > budget.max_p95_ms) {
    exceeded.push("p95_ms");
  }
  if (metrics.max_heap_delta_bytes > budget.max_heap_delta_bytes) {
    exceeded.push("heap_delta_bytes");
  }
  return {
    status: exceeded.length === 0 ? "PASS" : "UNPASSED",
    limits: { ...budget },
    exceeded
  };
}

export function comparePerformanceArtifacts(
  current: PerformanceBenchmarkArtifact,
  baseline: PerformanceBenchmarkArtifact,
  now: () => Date = () => new Date()
): PerformanceComparisonArtifact {
  const environmentComparable =
    current.environment.fingerprint === baseline.environment.fingerprint &&
    current.environment.machine.node_major ===
      baseline.environment.machine.node_major;
  const baselineById = new Map(
    baseline.scenarios.map((scenario) => [scenario.id, scenario])
  );
  const scenarios = current.scenarios.map((scenario) => {
    const previous = baselineById.get(scenario.id);
    const absolute = evaluateAbsolutePerformanceBudget(
      scenario.metrics,
      performanceBudgetFor(scenario.id)
    );
    if (previous === undefined) {
      return {
        id: scenario.id,
        status:
          absolute.status === "UNPASSED" ? "UNPASSED" : "UNKNOWN",
        environment_comparable: environmentComparable,
        current: scenario.metrics,
        reasons: [
          ...(absolute.status === "UNPASSED"
            ? ["Absolute performance budget was exceeded."]
            : []),
          "Baseline scenario is missing."
        ]
      } satisfies PerformanceScenarioComparison;
    }
    if (!environmentComparable) {
      return {
        id: scenario.id,
        status:
          absolute.status === "UNPASSED" ? "UNPASSED" : "UNKNOWN",
        environment_comparable: false,
        current: scenario.metrics,
        baseline: previous.metrics,
        reasons: [
          ...(absolute.status === "UNPASSED"
            ? ["Absolute performance budget was exceeded."]
            : []),
          "Runtime or machine fingerprint differs from the baseline."
        ]
      } satisfies PerformanceScenarioComparison;
    }
    const ratios = {
      median: safeRatio(
        scenario.metrics.median_ms,
        previous.metrics.median_ms
      ),
      p95: safeRatio(scenario.metrics.p95_ms, previous.metrics.p95_ms)
    };
    const ratioLimit = performanceBudgetFor(
      scenario.id
    ).max_baseline_ratio;
    const ratioExceeded =
      ratios.median > ratioLimit ||
      ratios.p95 > ratioLimit;
    const status =
      absolute.status === "UNPASSED" || ratioExceeded
        ? "UNPASSED"
        : "PASS";
    return {
      id: scenario.id,
      status,
      environment_comparable: true,
      current: scenario.metrics,
      baseline: previous.metrics,
      ratios,
      reasons: [
        ...(absolute.status === "UNPASSED"
          ? ["Absolute performance budget was exceeded."]
          : []),
        ...(ratioExceeded
          ? ["Same-environment baseline ratio was exceeded."]
          : [])
      ]
    } satisfies PerformanceScenarioComparison;
  });
  const statuses = scenarios.map((scenario) => scenario.status);
  return {
    schema_version: "0.1",
    artifact_kind: "performance_comparison_result",
    status: combinePerformanceStatuses(statuses),
    source_commit: current.source_commit,
    baseline_source_commit: baseline.source_commit,
    environment_comparable: environmentComparable,
    current_run_id: current.run_id,
    baseline_run_id: baseline.run_id,
    generated_at: now().toISOString(),
    scenarios,
    summary: {
      PASS: statuses.filter((status) => status === "PASS").length,
      UNPASSED: statuses.filter((status) => status === "UNPASSED").length,
      UNKNOWN: statuses.filter((status) => status === "UNKNOWN").length,
      total: statuses.length
    }
  };
}

export function formatPerformanceReport(
  artifact: PerformanceBenchmarkArtifact | PerformanceComparisonArtifact
): string {
  if (artifact.artifact_kind === "performance_benchmark_result") {
    return formatBenchmarkReport(artifact);
  }
  const lines = [
    "# Kairon Performance Comparison",
    "",
    `- status: **${artifact.status}**`,
    `- source commit: \`${artifact.source_commit}\``,
    `- baseline source commit: \`${artifact.baseline_source_commit}\``,
    `- environment comparable: \`${artifact.environment_comparable}\``,
    "",
    "| Scenario | Status | Median ratio | p95 ratio | Reasons |",
    "| --- | --- | ---: | ---: | --- |",
    ...artifact.scenarios.map(
      (scenario) =>
        `| ${scenario.id} | ${scenario.status} | ${formatRatio(
          scenario.ratios?.median
        )} | ${formatRatio(scenario.ratios?.p95)} | ${
          scenario.reasons.join(" ") || "-"
        } |`
    ),
    ""
  ];
  return lines.join("\n");
}

function formatBenchmarkReport(artifact: PerformanceBenchmarkArtifact): string {
  return [
    "# Kairon Performance Benchmark",
    "",
    `- status: **${artifact.status}**`,
    `- run: \`${artifact.run_id}\``,
    `- source commit: \`${artifact.source_commit}\``,
    `- profile: \`${artifact.profile}\``,
    `- runtime: \`Node ${artifact.environment.runtime_version}\``,
    `- environment fingerprint: \`${artifact.environment.fingerprint}\``,
    "",
    "| Scenario | Status | Fixture | Median ms | p95 ms | Heap delta bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...artifact.scenarios.map(
      (scenario) =>
        `| ${scenario.id} | ${scenario.status} | ${scenario.fixture.size} | ` +
        `${scenario.metrics.median_ms} | ${scenario.metrics.p95_ms} | ` +
        `${scenario.metrics.max_heap_delta_bytes} |`
    ),
    ""
  ].join("\n");
}

function safeRatio(current: number, baseline: number): number {
  if (baseline === 0) {
    return current === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return Math.round((current / baseline) * 1_000) / 1_000;
}

function combinePerformanceStatuses(
  statuses: readonly PerformanceStatus[]
): PerformanceStatus {
  if (statuses.some((status) => status === "UNPASSED")) {
    return "UNPASSED";
  }
  if (statuses.some((status) => status === "UNKNOWN")) {
    return "UNKNOWN";
  }
  return "PASS";
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(3)}x`;
}
