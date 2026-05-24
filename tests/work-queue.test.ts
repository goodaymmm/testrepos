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
