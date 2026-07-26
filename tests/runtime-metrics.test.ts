import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { createBoardProjection } from "../src/board/projection.js";
import {
  appendRuntimeMetric,
  createRuntimeMetricsReport,
  createRuntimeMetricsSnapshot,
  rawMetricsDirectory
} from "../src/observability/metrics-store.js";
import { checkRuntimeSlo } from "../src/observability/slo.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop } from "../src/runtime/runtime-loop.js";
import { createTempProject } from "./test-utils.js";

describe("runtime metrics", () => {
  it("stores bounded local samples and creates deterministic snapshots and rollups", async () => {
    const root = await createProject();
    const now = new Date("2026-07-26T12:00:00.000Z");
    for (const value of [10, 20, 30, 40, 50]) {
      await appendRuntimeMetric(root, {
        metric: "runtime_tick_duration_ms",
        value,
        labels: { mode: "active_work", action: "idle" },
        recordedAt: new Date(now.getTime() - 1_000)
      });
    }

    const snapshot = await createRuntimeMetricsSnapshot(root, {
      now,
      windowMinutes: 60
    });
    expect(snapshot).toMatchObject({
      valid_samples: 5,
      corrupt_samples: 0,
      metrics: {
        runtime_tick_duration_ms: {
          samples: 5,
          minimum: 10,
          maximum: 50,
          average: 30,
          p50: 30,
          p95: 50
        }
      }
    });

    const report = await createRuntimeMetricsReport(root, {
      now,
      period: "daily"
    });
    expect(report).toMatchObject({
      path: ".kairon/metrics/rollups/daily/2026-07-26.json",
      report: { period_key: "2026-07-26" }
    });
  });

  it("rejects unbounded labels and reports corrupt raw samples", async () => {
    const root = await createProject();
    await expect(
      appendRuntimeMetric(root, {
        metric: "runtime_tick_duration_ms",
        value: 10,
        labels: { task_id: "TASK-SECRET-123" }
      })
    ).rejects.toThrow("Metric label is not allowed");

    const rawPath = path.join(rawMetricsDirectory(root), "2026-07-26.jsonl");
    await appendFile(rawPath, "{\"token\":\"must-not-be-accepted\"}\n", "utf8");
    const snapshot = await createRuntimeMetricsSnapshot(root, {
      now: new Date("2026-07-26T23:59:00.000Z"),
      windowMinutes: 24 * 60
    });
    expect(snapshot).toMatchObject({
      valid_samples: 0,
      corrupt_samples: 1
    });
    expect(await readFile(rawPath, "utf8")).not.toContain("TASK-SECRET-123");
  });

  it("records tick, ready age, claim duration, and run latency without IDs in labels", async () => {
    const root = await createProject();
    const queue = new WorkQueue(root);
    await queue.enqueue({
      type: "agent.run",
      schedule_mode: "active_work",
      created_at: "2026-07-26T07:59:00.000Z"
    });
    await new RuntimeLoop(root, {
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ completed: true })
        }
      }
    }).runTick();

    const snapshot = await createRuntimeMetricsSnapshot(root, {
      now: new Date(),
      windowMinutes: 525_600
    });
    expect(snapshot.metrics.runtime_tick_duration_ms?.samples).toBe(1);
    expect(snapshot.metrics.queue_ready_age_ms?.latest).toBe(60_000);
    expect(snapshot.metrics.queue_claim_duration_ms?.samples).toBe(1);
    expect(snapshot.metrics.run_latency_ms?.samples).toBe(1);
  });

  it("projects only the persisted sanitized SLO summary to Board", async () => {
    const root = await createProject();
    await checkRuntimeSlo(root, {
      now: new Date("2026-07-26T12:00:00.000Z")
    });
    const projection = await createBoardProjection(root, {
      now: () => new Date("2026-07-26T12:01:00.000Z")
    });
    expect(projection.observability).toMatchObject({
      slo_status: "INSUFFICIENT_DATA",
      corrupt_samples: 0
    });
    expect(JSON.stringify(projection.observability)).not.toMatch(
      /task_id|run_id|token|prompt|diff/iu
    );
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}
