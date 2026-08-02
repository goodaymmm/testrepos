import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { closeActiveWork } from "../src/cli/commands/leave.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { CommandInbox } from "../src/queue/command-inbox.js";
import { createTempProject } from "./test-utils.js";

describe("closeActiveWork", () => {
  it("enqueues and applies schedule close command", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(closeActiveWork(root)).resolves.toBe(
      "Active Work closed for today."
    );

    await expect(new CommandInbox(root).list("queued")).resolves.toHaveLength(0);
    await expect(new CommandInbox(root).list("completed")).resolves.toHaveLength(
      1
    );
    await expect(
      readJsonFile(path.join(root, ".kairon", "state", "schedule_override.json"))
    ).resolves.toMatchObject({
      active_work_closed: true,
      reason: "user_leave_command"
    });
  });

  it("is idempotent per day", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await closeActiveWork(root);
    await expect(closeActiveWork(root)).resolves.toBe(
      "Active Work is already closed for today."
    );
    await expect(new CommandInbox(root).list()).resolves.toHaveLength(1);
  });
});
