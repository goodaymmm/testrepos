import { appendFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  appendRuntimeMetric,
  createRuntimeMetricsSnapshot,
  rawMetricsDirectory
} from "../src/observability/metrics-store.js";
import {
  checkRuntimeSlo,
  defaultSloPolicy,
  readLatestSloSummary
} from "../src/observability/slo.js";
import { evaluateWatchdogRules, defaultWatchdogPolicy } from "../src/runtime/watchdog-rules.js";
import { createTempProject } from "./test-utils.js";

describe("runtime SLO", () => {
  it("uses INSUFFICIENT_DATA instead of PASS below the minimum sample count", async () => {
    const root = await createProject();
    await appendRuntimeMetric(root, {
      metric: "runtime_tick_duration_ms",
      value: 10,
      recordedAt: new Date("2026-07-26T11:59:00.000Z")
    });
    const summary = await checkRuntimeSlo(root, {
      now: new Date("2026-07-26T12:00:00.000Z")
    });
    expect(summary.status).toBe("INSUFFICIENT_DATA");
    expect(summary.objectives.tick_duration).toMatchObject({
      status: "INSUFFICIENT_DATA",
      samples: 1
    });
    await expect(readLatestSloSummary(root)).resolves.toMatchObject({
      status: "INSUFFICIENT_DATA"
    });
  });

  it("distinguishes warning and critical upper and lower thresholds", async () => {
    const root = await createProject();
    const now = new Date("2026-07-26T12:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await appendRuntimeMetric(root, {
        metric: "runtime_tick_duration_ms",
        value: 6_000,
        recordedAt: new Date(now.getTime() - index * 1_000)
      });
      await appendRuntimeMetric(root, {
        metric: "notification_result",
        value: index === 0 ? 1 : 0,
        labels: {
          provider: "discord",
          result: index === 0 ? "success" : "failed"
        },
        recordedAt: new Date(now.getTime() - index * 1_000)
      });
    }
    const snapshot = await createRuntimeMetricsSnapshot(root, {
      now,
      windowMinutes: 60
    });
    const summary = await checkRuntimeSlo(root, {
      now,
      snapshot,
      policy: {
        ...structuredClone(defaultSloPolicy),
        objectives: {
          ...structuredClone(defaultSloPolicy.objectives),
          queue_ready_age: {
            ...defaultSloPolicy.objectives.queue_ready_age,
            enabled: false
          },
          run_latency: {
            ...defaultSloPolicy.objectives.run_latency,
            enabled: false
          },
          remote_readiness: {
            ...defaultSloPolicy.objectives.remote_readiness,
            enabled: false
          }
        }
      }
    });
    expect(summary.status).toBe("CRITICAL");
    expect(summary.objectives.tick_duration.status).toBe("CRITICAL");
    expect(summary.objectives.notification_success).toMatchObject({
      status: "CRITICAL",
      value: 0.2
    });
  });

  it("reports corrupt metric data separately and lets watchdog use the persisted status", async () => {
    const root = await createProject();
    await appendFile(
      path.join(rawMetricsDirectory(root), "2026-07-26.jsonl"),
      "not-json\n",
      "utf8"
    );
    const summary = await checkRuntimeSlo(root, {
      now: new Date("2026-07-26T12:00:00.000Z")
    });
    expect(summary.status).toBe("CORRUPT_DATA");

    const findings = evaluateWatchdogRules(
      {
        project_id: "project",
        now: "2026-07-26T12:01:00.000Z",
        runtime: {
          locked: false,
          fatal_error_count: 0
        },
        daemon_start_times: [],
        queue: { ready: 0 },
        failed_notification_times: [],
        providers: [],
        slo: {
          status: summary.status,
          evaluated_at: summary.evaluated_at
        }
      },
      defaultWatchdogPolicy
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "slo_breach",
        resource: "observability:slo"
      })
    ]);
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}
