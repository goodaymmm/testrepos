import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  acquireRuntimeLock,
  readRuntimeLockStatus,
  refreshRuntimeHeartbeat,
  requestRuntimeStop,
  releaseRuntimeLock
} from "../src/runtime/runtime-lock.js";
import { createTempProject } from "./test-utils.js";

describe("runtime lock", () => {
  it("acquires, reports, and releases runtime lock", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(acquireRuntimeLock(root)).resolves.toMatchObject({
      locked: true,
      stale: false
    });
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: true,
      stale: false
    });
    await expect(acquireRuntimeLock(root)).rejects.toThrow(/Lock already exists/);

    await releaseRuntimeLock(root);
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });
  });

  it("records daemon heartbeat and stop requests", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      acquireRuntimeLock(root, {
        mode: "daemon",
        now: new Date("2026-05-26T00:00:00.000Z")
      })
    ).resolves.toMatchObject({
      locked: true,
      data: {
        mode: "daemon",
        heartbeat_at: "2026-05-26T00:00:00.000Z",
        updated_at: "2026-05-26T00:00:00.000Z"
      }
    });

    await refreshRuntimeHeartbeat(root, {
      now: new Date("2026-05-26T00:00:10.000Z")
    });
    await requestRuntimeStop(root, {
      now: new Date("2026-05-26T00:00:20.000Z")
    });

    await expect(
      readRuntimeLockStatus(root, {
        now: new Date("2026-05-26T00:00:20.000Z")
      })
    ).resolves.toMatchObject({
      locked: true,
      stale: false,
      data: {
        mode: "daemon",
        heartbeat_at: "2026-05-26T00:00:10.000Z",
        stop_requested: true,
        stop_requested_at: "2026-05-26T00:00:20.000Z"
      }
    });

    await releaseRuntimeLock(root);
  });

  it("treats dead daemon lock pids as stale and recovers on acquire", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runtime", "lock.json"), {
      owner: "kairon-runtime",
      pid: -1,
      created_at: "2026-05-26T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      mode: "daemon",
      heartbeat_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z"
    });

    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: true,
      stale: true
    });
    await expect(acquireRuntimeLock(root, { mode: "daemon" })).resolves.toMatchObject({
      locked: true,
      stale: false,
      data: {
        mode: "daemon",
        pid: process.pid
      }
    });

    await releaseRuntimeLock(root);
  });
});
