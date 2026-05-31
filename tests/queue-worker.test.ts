import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { QueueWorker } from "../src/queue/queue-worker.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("QueueWorker", () => {
  it("routes command handlers before queue items", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const inbox = new CommandInbox(root);

    await queue.enqueue({ type: "agent.run" });
    const command = await inbox.enqueue({
      type: "schedule.close_active_work",
      date: "2026-05-25",
      reason: "leave"
    });

    const worker = new QueueWorker(root, queue, inbox, {
      commands: {
        "schedule.close_active_work": async () => ({ applied: true })
      },
      items: {
        "agent.run": async () => ({ ran: true })
      }
    });

    await expect(worker.processNext("worker-1")).resolves.toMatchObject({
      status: "processed-command",
      command_id: command.envelope.command_id
    });
    await expect(inbox.list("completed")).resolves.toHaveLength(1);
    await expect(queue.list("ready")).resolves.toHaveLength(1);
  });

  it("records handler failures on queue items", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const inbox = new CommandInbox(root);
    const item = await queue.enqueue({ type: "agent.run" });

    const worker = new QueueWorker(root, queue, inbox, {
      items: {
        "agent.run": async () => {
          throw new Error("boom");
        }
      }
    });

    await expect(worker.processNext("worker-1")).resolves.toMatchObject({
      status: "processed-item",
      item_id: item.id
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: item.id, error: { message: "Error: boom" } }
    ]);
  });

  it("expires stale test items before claiming runtime work", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const inbox = new CommandInbox(root);
    const stale = await queue.enqueue({
      type: "agent.run",
      priority: 100,
      test_scope: {
        kind: "operation_test",
        tags: ["operation-test"],
        expires_at: "2026-05-25T07:59:00.000Z"
      }
    });
    const normal = await queue.enqueue({
      type: "maintenance.run",
      priority: 10
    });

    const worker = new QueueWorker(root, queue, inbox, {
      items: {
        "agent.run": async () => {
          throw new Error("stale test item should not be dispatched");
        },
        "maintenance.run": async () => ({ maintained: true })
      }
    });

    await expect(
      worker.processNext("worker-1", {
        now: new Date("2026-05-25T08:00:00.000Z")
      })
    ).resolves.toMatchObject({
      status: "processed-item",
      item_id: normal.id
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: stale.id, error: { code: "stale_test_queue_item" } }
    ]);
    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: normal.id, result: { maintained: true } }
    ]);
  });

  it("does not dispatch active work items after active work is closed", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "state", "schedule_override.json"), {
      schema_version: "0.1",
      active_work_closed: true
    });

    const queue = new WorkQueue(root);
    const inbox = new CommandInbox(root);
    await queue.enqueue({ type: "agent.run" });
    await queue.enqueue({ type: "review.run", schedule_mode: "active_work" });
    const standby = await queue.enqueue({
      type: "maintenance.run",
      schedule_mode: "standby_work"
    });

    const worker = new QueueWorker(root, queue, inbox, {
      items: {
        "agent.run": async () => ({ ran: true }),
        "maintenance.run": async () => ({ maintained: true })
      }
    });

    await expect(worker.processNext("worker-1")).resolves.toMatchObject({
      status: "processed-item",
      item_id: standby.id
    });
    await expect(queue.list("ready")).resolves.toHaveLength(2);
  });
});
