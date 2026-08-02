import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { createTempProject } from "./test-utils.js";

describe("CommandInbox", () => {
  it("stores approval, snooze, and close active work commands", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const inbox = new CommandInbox(root);

    await inbox.enqueue({
      type: "approval.decide",
      approval_id: "APR-0001",
      decision: "approve"
    });
    await inbox.enqueue({
      type: "approval.snooze",
      approval_id: "APR-0001",
      until: "2026-05-25T09:00:00.000Z"
    });
    await inbox.enqueue({
      type: "schedule.close_active_work",
      date: "2026-05-25",
      reason: "leave"
    });
    await inbox.enqueue({
      type: "runtime.status",
      reason: "status"
    });

    await expect(inbox.list("queued")).resolves.toHaveLength(4);
  });

  it("deduplicates commands by idempotency key", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const inbox = new CommandInbox(root);

    const first = await inbox.enqueue(
      {
        type: "approval.decide",
        approval_id: "APR-0001",
        decision: "approve"
      },
      { idempotencyKey: "discord:interaction:1" }
    );
    const second = await inbox.enqueue(
      {
        type: "approval.decide",
        approval_id: "APR-0001",
        decision: "approve"
      },
      { idempotencyKey: "discord:interaction:1" }
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.envelope.command_id).toBe(first.envelope.command_id);
    await expect(inbox.list()).resolves.toHaveLength(1);
  });

  it("claims, completes, and fails commands", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const inbox = new CommandInbox(root);

    const first = await inbox.enqueue({
      type: "approval.decide",
      approval_id: "APR-0001",
      decision: "approve"
    });
    const second = await inbox.enqueue({
      type: "schedule.close_active_work",
      date: "2026-05-25",
      reason: "leave"
    });

    await expect(inbox.claim("worker-1")).resolves.toMatchObject({
      command_id: first.envelope.command_id,
      status: "claimed"
    });
    await inbox.complete(first.envelope.command_id, { applied: true });
    await inbox.fail(second.envelope.command_id, { message: "failed" });

    await expect(inbox.list("completed")).resolves.toHaveLength(1);
    await expect(inbox.list("failed")).resolves.toHaveLength(1);
  });
});
