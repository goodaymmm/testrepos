import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  acquireResourceLock,
  releaseResourceLock
} from "../src/core/fs/resource-lock.js";
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
      now: new Date("2026-05-26T00:00:10.000Z"),
      tickCount: 3,
      idleCount: 2,
      lastAction: "idle",
      nextTickAt: "2026-05-26T00:00:15.000Z",
      lastError: {
        code: "previous_error",
        message: "Previous error",
        at: "2026-05-26T00:00:09.000Z"
      }
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
        stop_requested_at: "2026-05-26T00:00:20.000Z",
        tick_count: 3,
        idle_count: 2,
        last_action: "idle",
        next_tick_at: "2026-05-26T00:00:15.000Z",
        last_error: {
          code: "previous_error",
          message: "Previous error",
          at: "2026-05-26T00:00:09.000Z"
        }
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

  it("guards runtime lock updates with a resource-level lock", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root);
    const runtimeLockPath = path.join(root, ".kairon", "runtime", "lock.json");
    const blocker = await acquireResourceLock(root, runtimeLockPath, {
      owner: "manual-runtime-lock-test"
    });

    const refresh = refreshRuntimeHeartbeat(root);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await releaseResourceLock(blocker);
    await expect(refresh).resolves.toMatchObject({
      owner: "kairon-runtime",
      pid: process.pid
    });

    await releaseRuntimeLock(root);
  });

  it("does not reclaim a stale heartbeat while the daemon pid is alive", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runtimeLockPath = path.join(root, ".kairon", "runtime", "lock.json");
    await writeJsonFileAtomic(runtimeLockPath, {
      owner: "kairon-runtime",
      pid: process.pid,
      created_at: "2026-05-26T00:00:00.000Z",
      expires_at: "2026-05-26T00:00:01.000Z",
      mode: "daemon",
      heartbeat_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z"
    });

    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: true,
      stale: true
    });
    await expect(acquireRuntimeLock(root, { mode: "daemon" })).rejects.toThrow(
      /Lock already exists/
    );

    await releaseRuntimeLock(root);
  });

  it("retries runtime acquisition while its resource lock is briefly busy", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runtimeLockPath = path.join(root, ".kairon", "runtime", "lock.json");
    const blocker = await acquireResourceLock(root, runtimeLockPath, {
      owner: "manual-runtime-acquire-test"
    });

    const acquisition = acquireRuntimeLock(root, { mode: "daemon" });
    await new Promise((resolve) => setTimeout(resolve, 125));
    await releaseResourceLock(blocker);

    await expect(acquisition).resolves.toMatchObject({
      locked: true,
      data: {
        owner: "kairon-runtime",
        pid: process.pid
      }
    });
    await releaseRuntimeLock(root);
  });

  it("preserves a concurrent stop request during heartbeat serialization", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, { mode: "daemon" });

    const [heartbeat, stop] = await Promise.all([
      refreshRuntimeHeartbeat(root, { tickCount: 9, lastAction: "idle" }),
      requestRuntimeStop(root)
    ]);

    expect(heartbeat.tick_count).toBe(9);
    expect(stop).toMatchObject({ stop_requested: true });
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: true,
      data: {
        tick_count: 9,
        stop_requested: true
      }
    });

    await releaseRuntimeLock(root);
  });

  it("rejects heartbeat writes after runtime ownership changes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, { mode: "daemon" });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runtime", "lock.json"), {
      owner: "kairon-runtime",
      pid: process.pid + 100_000,
      created_at: "2026-05-26T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
      mode: "daemon",
      heartbeat_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z"
    });

    await expect(refreshRuntimeHeartbeat(root)).rejects.toThrow(
      /Runtime lock ownership was lost/
    );
    await releaseRuntimeLock(root);
  });

  it("serializes a stop request with runtime lock release", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, { mode: "daemon" });

    await Promise.all([requestRuntimeStop(root), releaseRuntimeLock(root)]);

    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });
  });
});
