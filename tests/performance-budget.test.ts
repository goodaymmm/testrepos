import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/main.js";
import {
  calculatePerformanceMetrics,
  performanceEnvironmentFingerprint,
  performanceScenarioCatalog,
  runPerformanceScenario,
  runPerformanceSuite,
  type PerformanceBenchmarkArtifact,
  type PerformanceEnvironment,
  type PerformanceMetrics,
  type PerformanceScenarioResult
} from "../src/performance/benchmark.js";
import {
  comparePerformanceArtifacts,
  formatPerformanceReport,
  performanceBudgetFor
} from "../src/performance/budget.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const generatedAt = "2026-07-27T00:00:00.000Z";

describe("T187 performance budget", () => {
  it("excludes warmup and trims one high and low sample from seven measurements", async () => {
    const elapsedMs = [1, 2, 3, 4, 5, 6, 100];
    const clockValues = elapsedMs.flatMap((elapsed, index) => [
      BigInt(index * 1_000_000_000),
      BigInt(index * 1_000_000_000 + elapsed * 1_000_000)
    ]);
    let clockIndex = 0;
    let executions = 0;
    const result = await runPerformanceScenario(
      {
        ...performanceScenarioCatalog[0]!,
        warmup_iterations: 2,
        iterations: 7
      },
      () => {
        executions += 1;
      },
      {
        clock: () => clockValues[clockIndex++]!,
        memoryUsage: () => 1_000
      }
    );

    expect(executions).toBe(9);
    expect(result.samples).toHaveLength(7);
    expect(result.metrics).toMatchObject({
      sample_count: 7,
      retained_sample_count: 5,
      outliers_removed: 2,
      median_ms: 4,
      p95_ms: 6
    });
  });

  it("requires a stable minimum sample size", () => {
    expect(() =>
      calculatePerformanceMetrics([
        sample(1),
        sample(2),
        sample(3),
        sample(4)
      ])
    ).toThrow("at least 5 samples");
  });

  it("detects same-environment baseline regressions and reports mismatches as UNKNOWN", () => {
    const environment = fakeEnvironment("same");
    const baseline = benchmarkArtifact(
      environment,
      scenarioResult(metrics(100, 120))
    );
    const regressed = benchmarkArtifact(
      environment,
      scenarioResult(metrics(200, 240))
    );
    const comparison = comparePerformanceArtifacts(
      regressed,
      baseline,
      () => new Date(generatedAt)
    );

    expect(comparison.status).toBe("UNPASSED");
    expect(comparison.scenarios[0]).toMatchObject({
      environment_comparable: true,
      ratios: { median: 2, p95: 2 },
      status: "UNPASSED"
    });

    const differentEnvironment = benchmarkArtifact(
      fakeEnvironment("different"),
      scenarioResult(metrics(110, 125))
    );
    const unknown = comparePerformanceArtifacts(
      differentEnvironment,
      baseline
    );
    expect(unknown.status).toBe("UNKNOWN");
    expect(unknown.scenarios[0]?.reasons).toContain(
      "Runtime or machine fingerprint differs from the baseline."
    );
  });

  it("publishes every requested capacity scenario and separates representative from full", () => {
    const fixture = JSON.parse(
      requireFixture("tests/fixtures/performance/scenarios.json")
    ) as { scenarios: Array<{ id: string; size: number }> };
    const catalog = performanceScenarioCatalog.map((entry) => ({
      id: entry.id,
      size: entry.fixture.size
    }));

    expect(catalog).toEqual(fixture.scenarios);
    expect(catalog).toEqual(expect.arrayContaining([
      { id: "queue.list.1k", size: 1_000 },
      { id: "queue.claim.10k", size: 10_000 },
      { id: "workflow.checkpoint_replay.100", size: 100 },
      { id: "workflow.checkpoint_replay.1k", size: 1_000 },
      { id: "rag.lexical_query.10k", size: 10_000 },
      { id: "rag.vector_query.10k", size: 10_000 },
      { id: "rag.hybrid_query.10k", size: 10_000 },
      { id: "projects.supervisor_scan.50", size: 50 }
    ]));
    expect(
      performanceScenarioCatalog.filter((entry) =>
        entry.profiles.includes("representative")
      ).length
    ).toBeLessThan(performanceScenarioCatalog.length);
    expect(performanceScenarioCatalog.every(
      (entry) => entry.scope === "local_runtime"
    )).toBe(true);
  });

  it("writes a source-bound artifact without hostname, username, source text, or credentials", async () => {
    const root = await createTempProject();
    const result = await runPerformanceSuite(
      root,
      {
        scenarioIds: ["projects.supervisor_scan.10"],
        warmupIterations: 0,
        iterations: 5
      },
      {
        sourceCommit,
        environment: fakeEnvironment("sanitized"),
        now: () => new Date(generatedAt),
        execute: () => undefined
      }
    );
    const serialized = await readFile(
      path.join(root, result.output_path),
      "utf8"
    );

    expect(result.artifact.source_commit).toBe(sourceCommit);
    expect(result.artifact.environment.machine).toEqual({
      platform: process.platform,
      arch: process.arch,
      cpu_model: "Deterministic CPU",
      logical_cpu_count: 8,
      node_major: 22
    });
    expect(serialized).not.toContain(os.hostname());
    expect(serialized).not.toContain(os.userInfo().username);
    expect(serialized).not.toMatch(/token|password|authorization/iu);
    expect(serialized).not.toContain("project source content");
  });

  it("registers run, compare, and report under the dedicated performance CLI", () => {
    const performance = createProgram().commands.find(
      (command) => command.name() === "performance"
    );

    expect(performance).toBeDefined();
    expect(performance?.commands.map((command) => command.name())).toEqual([
      "run",
      "compare",
      "report"
    ]);
  });

  it("renders benchmark and comparison reports without machine identity", () => {
    const benchmark = benchmarkArtifact(
      fakeEnvironment("report"),
      scenarioResult(metrics(10, 15))
    );
    const report = formatPerformanceReport(benchmark);
    const comparison = formatPerformanceReport(
      comparePerformanceArtifacts(benchmark, benchmark)
    );

    expect(report).toContain("# Kairon Performance Benchmark");
    expect(report).toContain("queue.list.1k");
    expect(comparison).toContain("# Kairon Performance Comparison");
    expect(report).not.toContain(os.hostname());
    expect(comparison).not.toContain(os.userInfo().username);
  });
});

function sample(elapsedMs: number) {
  return {
    iteration: elapsedMs,
    elapsed_ms: elapsedMs,
    heap_delta_bytes: elapsedMs * 100
  };
}

function metrics(medianMs: number, p95Ms: number): PerformanceMetrics {
  return {
    sample_count: 7,
    retained_sample_count: 5,
    outliers_removed: 2,
    median_ms: medianMs,
    p95_ms: p95Ms,
    max_heap_delta_bytes: 1_024
  };
}

function scenarioResult(value: PerformanceMetrics): PerformanceScenarioResult {
  const definition = performanceScenarioCatalog[0]!;
  return {
    id: definition.id,
    subsystem: definition.subsystem,
    operation: definition.operation,
    scope: definition.scope,
    fixture: definition.fixture,
    warmup_iterations: 2,
    iterations: 7,
    samples: Array.from({ length: 7 }, (_, index) => sample(index + 1)),
    metrics: value,
    budget: {
      status: "PASS",
      limits: performanceBudgetFor(definition.id),
      exceeded: []
    },
    status: "PASS"
  };
}

function benchmarkArtifact(
  environment: PerformanceEnvironment,
  result: PerformanceScenarioResult
): PerformanceBenchmarkArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "performance_benchmark_result",
    run_id: `PERF-${environment.fingerprint}`,
    profile: "representative",
    status: result.status,
    source_commit: sourceCommit,
    environment,
    generated_at: generatedAt,
    scenarios: [result],
    summary: {
      PASS: result.status === "PASS" ? 1 : 0,
      UNPASSED: result.status === "UNPASSED" ? 1 : 0,
      UNKNOWN: result.status === "UNKNOWN" ? 1 : 0,
      total: 1
    }
  };
}

function fakeEnvironment(label: string): PerformanceEnvironment {
  const machine = {
    platform: process.platform,
    arch: process.arch,
    cpu_model: "Deterministic CPU",
    logical_cpu_count: 8,
    node_major: 22
  } as const;
  return {
    runtime_version: "22.17.0",
    machine,
    fingerprint:
      label === "same"
        ? performanceEnvironmentFingerprint(machine)
        : performanceEnvironmentFingerprint({
            ...machine,
            cpu_model: `Deterministic CPU ${label}`
          })
  };
}

function requireFixture(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}
