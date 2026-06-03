import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { acquireRuntimeLock } from "../src/runtime/runtime-lock.js";
import { formatRuntimeStatus, getRuntimeStatus } from "../src/runtime/status.js";
import { createTempProject } from "./test-utils.js";

describe("runtime status", () => {
  it("reports schedule, runtime lock, queue, and approvals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, {
      mode: "daemon",
      now: new Date("2026-05-26T00:00:00.000Z")
    });
    await new WorkQueue(root).enqueue({ type: "agent.run" });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
      schema_version: "0.1",
      id: "APR-0001",
      status: "pending"
    });

    const status = await getRuntimeStatus(root);
    expect(status.runtimeLock.locked).toBe(true);
    expect(status.runtimeLock.mode).toBe("daemon");
    expect(status.runtimeLock.heartbeat_at).toBe("2026-05-26T00:00:00.000Z");
    expect(status.queue.ready).toBe(1);
    expect(status.approvals.pending).toBe(1);
    expect(formatRuntimeStatus(status)).toContain("queue.ready=1");
    expect(formatRuntimeStatus(status)).toContain("runtime.mode=daemon");
  });
});
