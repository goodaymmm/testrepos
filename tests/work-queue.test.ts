import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("WorkQueue", () => {
  it("claims ready items by priority and creation order", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);

    await queue.enqueue({
      type: "agent.run",
      priority: 10,
      created_at: "2026-05-25T01:00:00.000Z"
    });
    const high = await queue.enqueue({
      type: "review.run",
      priority: 80,
      created_at: "2026-05-25T01:01:00.000Z"
    });

    await expect(queue.claim("worker-1")).resolves.toMatchObject({
      id: high.id,
      status: "claimed",
      attempts: 1
    });
  });

  it("recovers expired claims before claiming again", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);

    const item = await queue.enqueue({ type: "agent.run" });
    await queue.claim("worker-1", {
      now: new Date("2026-05-25T01:00:00.000Z"),
      claimTtlMs: 1000
    });

    await expect(
      queue.claim("worker-2", {
        now: new Date("2026-05-25T01:00:02.000Z")
      })
    ).resolves.toMatchObject({
      id: item.id,
      status: "claimed",
      attempts: 2,
      claimed_by: "worker-2"
    });
  });

  it("expires stale test queue items before dispatch", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);

    const stale = await queue.enqueue({
      type: "agent.run",
      test_scope: {
        kind: "operation_test",
        tags: ["operation-test"],
        expires_at: "2026-05-25T01:00:00.000Z"
      }
    });
    const fresh = await queue.enqueue({
      type: "agent.run",
      test_scope: {
        kind: "operation_test",
        tags: ["operation-test"],
        expires_at: "2026-05-25T03:00:00.000Z"
      }
    });

    await expect(
      queue.expireStaleTestItems(new Date("2026-05-25T02:00:00.000Z"))
    ).resolves.toMatchObject([
      {
        id: stale.id,
        status: "failed",
        error: { code: "stale_test_queue_item" }
      }
    ]);
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: stale.id, status: "failed" }
    ]);
    await expect(queue.list("ready")).resolves.toMatchObject([
      { id: fresh.id, status: "ready" }
    ]);
  });

  it("expires legacy operation-test payload queue items after the compatibility ttl", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const item = await queue.enqueue({
      type: "agent.run",
      payload: { tags: ["operation-test"] },
      created_at: "2026-05-25T01:00:00.000Z"
    });

    await expect(
      queue.expireStaleTestItems(new Date("2026-05-26T01:00:00.000Z"))
    ).resolves.toMatchObject([
      {
        id: item.id,
        status: "failed",
        error: { code: "stale_test_queue_item" }
      }
    ]);
  });

  it("completes and fails claimed items", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);

    const completeItem = await queue.enqueue({ type: "agent.run" });
    const failItem = await queue.enqueue({ type: "review.run" });

    await queue.complete(completeItem.id, { ok: true });
    await queue.fail(failItem.id, { message: "failed" });

    await expect(queue.list("completed")).resolves.toMatchObject([
      { id: completeItem.id, status: "completed", result: { ok: true } }
    ]);
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: failItem.id, status: "failed", error: { message: "failed" } }
    ]);
  });
});
