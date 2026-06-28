import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { RuntimeDaemon } from "../src/runtime/runtime-daemon.js";
import type { RuntimeTickResult } from "../src/runtime/runtime-loop.js";
import {
  acquireRuntimeLock,
  readRuntimeLockStatus
} from "../src/runtime/runtime-lock.js";
import { formatRuntimeStatus, getRuntimeStatus } from "../src/runtime/status.js";
import { createTempProject } from "./test-utils.js";

describe("RuntimeDaemon", () => {
  it("records daemon events and releases the runtime lock after max ticks", async () => {
    const root = await createInitializedProject();
    let now = new Date("2026-06-13T00:00:00.000Z");
    let tickCount = 0;
    await acquireRuntimeLock(root, {
      mode: "daemon",
      now,
      ttlMs: 60_000
    });

    const result = await new RuntimeDaemon(root, {
      intervalMs: 1_000,
      maxTicks: 2,
      now: () => now,
      sleep: async (ms) => {
        now = new Date(now.getTime() + ms);
      },
      runTick: async () => {
        tickCount += 1;
        return createTick({
          action: tickCount === 1 ? "idle" : "processed-item",
          createdAt: now.toISOString()
        });
      }
    }).run();

    expect(result).toMatchObject({
      ticks: 2,
      idle_ticks: 0,
      stop_reason: "max_ticks",
      daemon_log_path: ".kairon/runtime/daemon/2026-06-13.jsonl"
    });
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });

    const events = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "daemon", "2026-06-13.jsonl")
    );
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "tick",
      "tick",
      "stopped"
    ]);
    expect(events[2]).toMatchObject({
      event: "tick",
      tick_count: 2,
      idle_count: 0,
      action: "processed-item"
    });
    expect(events[3]).toMatchObject({
      event: "stopped",
      stop_reason: "max_ticks",
      ticks: 2
    });

    const status = await getRuntimeStatus(root);
    expect(status.daemonHealth).toMatchObject({
      status: "stopped",
      ticks: 2,
      idle_ticks: 0,
      processed_ticks: 1,
      fatal_errors: 0,
      stop_reason: "max_ticks",
      last_action: "processed-item"
    });
    expect(formatRuntimeStatus(status)).toContain("daemon.health.status=stopped");
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestDaemonLog=.kairon/runtime/daemon/2026-06-13.jsonl"
    );
  });

  it("records sanitized fatal errors without leaking token-like values", async () => {
    const root = await createInitializedProject();
    const now = new Date("2026-06-13T01:00:00.000Z");
    await acquireRuntimeLock(root, {
      mode: "daemon",
      now,
      ttlMs: 60_000
    });

    const result = await new RuntimeDaemon(root, {
      now: () => now,
      runTick: async () => {
        throw new Error("Discord token=SHOULD_NOT_LEAK failed");
      }
    }).run();

    expect(result.stop_reason).toBe("fatal_error");
    expect(result.last_error?.message).toBe("Discord token=[redacted] failed");
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });

    const events = await readJsonLines<Record<string, unknown>>(
      path.join(root, ".kairon", "runtime", "daemon", "2026-06-13.jsonl")
    );
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("fatal_error");
    expect(serialized).toContain("Discord token=[redacted] failed");
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("Error:");
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function createTick(input: {
  action: RuntimeTickResult["action"];
  createdAt: string;
}): RuntimeTickResult {
  return {
    schema_version: "0.1",
    mode: "active_work",
    base_mode: "active_work",
    active_work_closed: false,
    action: input.action,
    worker_id: "runtime-test",
    created_at: input.createdAt,
    sessions: {
      schema_version: "0.1",
      date: "2026-06-13",
      initialized: 0,
      ready: 0,
      idle: 0,
      busy: 0,
      setup_required: 0,
      permission_required: 0,
      rate_limited: 0,
      usage_limited: 0,
      closed: 0,
      agents: [],
      updated_at: input.createdAt
    }
  };
}
