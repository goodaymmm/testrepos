import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { RuntimeLoop, type RuntimeTickResult } from "../src/runtime/runtime-loop.js";
import {
  getScheduleStatus,
  type ScheduleConfig
} from "../src/runtime/schedule-engine.js";
import { createTempProject } from "./test-utils.js";

const schedule: ScheduleConfig = {
  schema_version: "0.1",
  timezone: "UTC",
  active_work_time: [{ start: "07:00", end: "18:00" }],
  standby_work_time: [{ start: "18:00", end: "01:00" }],
  maintenance_time: [{ start: "01:00", end: "07:00" }]
};

describe("RuntimeLoop", () => {
  it("processes ready queue items during active work", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      schedule_mode: "active_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T08:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ ran: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: item.id
      }
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: item.id, result: { ran: true } }
    ]);
  });

  it("keeps active work blocked during standby and processes standby-safe items", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const activeItem = await queue.enqueue({ type: "agent.run" });
    const standbyItem = await queue.enqueue({
      type: "maintenance.run",
      priority: 40,
      schedule_mode: "standby_work"
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z"),
      handlers: {
        items: {
          "maintenance.run": async () => ({ maintained: true })
        }
      }
    }).runTick();

    expect(result).toMatchObject({
      mode: "standby_work",
      action: "processed-item",
      queue_result: {
        status: "processed-item",
        item_id: standbyItem.id
      }
    });
    await expect(queue.list("ready")).resolves.toMatchObject([
      { id: activeItem.id }
    ]);
  });

  it("allows approved work during standby", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      payload: { approved: true }
    });

    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z"),
      handlers: {
        items: {
          "agent.run": async () => ({ ran_after_approval: true })
        }
      }
    }).runTick();

    expect(result.queue_result).toMatchObject({
      status: "processed-item",
      item_id: item.id
    });
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: item.id, result: { ran_after_approval: true } }
    ]);
  });

  it("runs maintenance once per local maintenance date", async () => {
    const root = await createInitializedProject();
    const loop = new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T02:00:00.000Z")
    });

    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "maintenance-run",
      maintenance: {
        date: "2026-05-25",
        handoff_count: 3
      }
    });
    await expect(loop.runTick()).resolves.toMatchObject({
      mode: "maintenance",
      action: "maintenance-skipped",
      maintenance: {
        date: "2026-05-25"
      }
    });
  });

  it("applies leave commands before processing queue items", async () => {
    const root = await createInitializedProject();
    const queue = new WorkQueue(root);
    await queue.enqueue({ type: "agent.run" });
    await new CommandInbox(root).enqueue({
      type: "schedule.close_active_work",
      date: "2026-05-25",
      reason: "test"
    });

    const now = new Date("2026-05-25T08:00:00.000Z");
    const result = await new RuntimeLoop(root, { now: () => now }).runTick();

    expect(result).toMatchObject({
      mode: "active_work",
      action: "processed-command"
    });
    await expect(getScheduleStatus(root, now)).resolves.toMatchObject({
      mode: "standby_work",
      activeWorkClosed: true
    });
    await expect(queue.list("ready")).resolves.toHaveLength(1);
  });

  it("records the last tick under the runtime directory", async () => {
    const root = await createInitializedProject();
    const result = await new RuntimeLoop(root, {
      now: () => new Date("2026-05-25T20:00:00.000Z")
    }).runTick();

    await expect(
      readJsonFile<RuntimeTickResult>(
        path.join(root, ".kairon", "runtime", "last-tick.json")
      )
    ).resolves.toMatchObject({
      mode: result.mode,
      action: result.action
    });
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "config", "schedule.json"),
    schedule
  );
  return root;
}
