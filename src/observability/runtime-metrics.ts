import { performance } from "node:perf_hooks";
import type { RuntimeTickAction } from "../runtime/runtime-loop.js";
import type { ScheduleMode, QueueItem, QueueItemType } from "../queue/work-queue.js";
import { WorkQueue } from "../queue/work-queue.js";
import {
  appendRuntimeMetric,
  type RuntimeMetricName
} from "./metrics-store.js";

export type RuntimeMetricTimer = {
  elapsedMilliseconds(): number;
};

export function startRuntimeMetricTimer(): RuntimeMetricTimer {
  const started = performance.now();
  return {
    elapsedMilliseconds: () => Math.max(0, performance.now() - started)
  };
}

export async function readOldestReadyQueueAge(
  projectRoot: string,
  now: Date
): Promise<number | undefined> {
  const ready = (await new WorkQueue(projectRoot).list("ready"))
    .map((item) => Date.parse(item.created_at))
    .filter(Number.isFinite);
  if (ready.length === 0) {
    return undefined;
  }
  return Math.max(0, now.getTime() - Math.min(...ready));
}

export async function recordRuntimeTickMetrics(
  projectRoot: string,
  input: {
    recordedAt: Date;
    durationMilliseconds: number;
    mode: ScheduleMode;
    action: RuntimeTickAction;
    oldestReadyAgeMilliseconds?: number;
    processedItemId?: string;
  }
): Promise<void> {
  await appendRuntimeMetric(projectRoot, {
    metric: "runtime_tick_duration_ms",
    value: input.durationMilliseconds,
    labels: { mode: input.mode, action: input.action },
    recordedAt: input.recordedAt
  });
  if (input.oldestReadyAgeMilliseconds !== undefined) {
    await appendRuntimeMetric(projectRoot, {
      metric: "queue_ready_age_ms",
      value: input.oldestReadyAgeMilliseconds,
      labels: { mode: input.mode },
      recordedAt: input.recordedAt
    });
  }

  if (input.processedItemId !== undefined) {
    const item = (await new WorkQueue(projectRoot).list()).find(
      (candidate) => candidate.id === input.processedItemId
    );
    if (item !== undefined) {
      for (const metric of terminalQueueItemMetrics(item)) {
        await appendRuntimeMetric(projectRoot, {
          ...metric,
          recordedAt: input.recordedAt
        });
      }
    }
  }
}

export async function recordNotificationResult(
  projectRoot: string,
  input: {
    provider: "discord" | "other";
    result: "success" | "failed";
    recordedAt?: Date;
  }
): Promise<void> {
  await appendRuntimeMetric(projectRoot, {
    metric: "notification_result",
    value: input.result === "success" ? 1 : 0,
    labels: { provider: input.provider, result: input.result },
    recordedAt: input.recordedAt
  });
}

export async function recordRemoteReadiness(
  projectRoot: string,
  input: {
    provider: "discord" | "board" | "github" | "other";
    result: "ready" | "unreachable" | "setup_required" | "unknown";
    recordedAt?: Date;
  }
): Promise<void> {
  await appendRuntimeMetric(projectRoot, {
    metric: "remote_readiness",
    value: input.result === "ready" ? 1 : 0,
    labels: { provider: input.provider, result: input.result },
    recordedAt: input.recordedAt
  });
}

function terminalQueueItemMetrics(
  item: QueueItem
): Array<{
  metric: RuntimeMetricName;
  value: number;
  labels: Record<string, string>;
}> {
  const terminalAt = Date.parse(item.completed_at ?? item.failed_at ?? "");
  const claimedAt = Date.parse(item.claimed_at ?? "");
  const createdAt = Date.parse(item.created_at);
  const result = item.status === "completed" ? "completed" : "failed";
  const transition =
    item.status === "completed" ? "claimed_to_completed" : "claimed_to_failed";
  const writes: Array<{
    metric: RuntimeMetricName;
    value: number;
    labels: Record<string, string>;
  }> = [
    {
      metric: "workflow_transition_total",
      value: 1,
      labels: {
        item_type: normalizeItemType(item.type),
        result,
        transition
      }
    }
  ];
  if (Number.isFinite(terminalAt) && Number.isFinite(claimedAt)) {
    writes.push({
      metric: "queue_claim_duration_ms",
      value: Math.max(0, terminalAt - claimedAt),
      labels: { item_type: normalizeItemType(item.type), result }
    });
  }
  if (
    Number.isFinite(terminalAt) &&
    Number.isFinite(createdAt) &&
    isRunLikeItem(item.type)
  ) {
    writes.push({
      metric: "run_latency_ms",
      value: Math.max(0, terminalAt - createdAt),
      labels: { item_type: normalizeItemType(item.type), result }
    });
  }
  return writes;
}

function isRunLikeItem(itemType: QueueItemType): boolean {
  return ["agent.run", "review.run", "git.transaction"].includes(itemType);
}

function normalizeItemType(itemType: QueueItemType): QueueItemType {
  return itemType;
}

export type { RuntimeMetricName };
