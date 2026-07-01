import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  acquireResourceLock,
  recoverExpiredResourceLocks,
  releaseResourceLock,
  ResourceFencingTokenError,
  ResourceLockAlreadyExistsError,
  writeJsonFileFenced
} from "../src/core/fs/resource-lock.js";
import { createTempProject } from "./test-utils.js";

describe("resource-level state locks", () => {
  it("acquires one writer per resource and releases by fencing token", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const resourcePath = path.join(root, ".kairon", "approvals", "APR-0001.json");

    const lock = await acquireResourceLock(root, resourcePath, {
      owner: "test-writer",
      now: new Date("2026-06-01T00:00:00.000Z")
    });

    expect(lock.data).toMatchObject({
      schema_version: "0.1",
      kind: "resource_lock",
      resource: ".kairon/approvals/APR-0001.json",
      owner: "test-writer",
      acquired_at: "2026-06-01T00:00:00.000Z"
    });
    await expect(
      acquireResourceLock(root, resourcePath, {
        now: new Date("2026-06-01T00:00:01.000Z")
      })
    ).rejects.toBeInstanceOf(ResourceLockAlreadyExistsError);

    await releaseResourceLock(lock);
    await expect(acquireResourceLock(root, resourcePath)).resolves.toMatchObject({
      data: {
        resource: ".kairon/approvals/APR-0001.json"
      }
    });
  });

  it("rejects stale writers when a newer fencing token owns the resource", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const resourcePath = path.join(root, ".kairon", "tasks", "TASK-0001", "task.json");

    const now = new Date();
    const stale = await acquireResourceLock(root, resourcePath, {
      owner: "stale-writer",
      now: new Date(now.getTime() - 2_000),
      ttlMs: 1_000
    });
    const current = await acquireResourceLock(root, resourcePath, {
      owner: "current-writer",
      now,
      ttlMs: 30_000
    });

    await expect(
      writeJsonFileFenced(stale, resourcePath, { stale: true })
    ).rejects.toBeInstanceOf(ResourceFencingTokenError);
    await writeJsonFileFenced(current, resourcePath, { current: true });
    await releaseResourceLock(stale);
    await releaseResourceLock(current);

    await expect(readJsonFile(resourcePath)).resolves.toEqual({ current: true });
  });

  it("recovers expired resource locks without touching active locks", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const expiredResource = path.join(root, ".kairon", "approvals", "APR-OLD.json");
    const activeResource = path.join(root, ".kairon", "approvals", "APR-ACTIVE.json");
    const activeLock = await acquireResourceLock(root, activeResource, {
      owner: "active-writer",
      now: new Date("2026-06-01T00:00:00.000Z"),
      ttlMs: 60_000
    });
    await acquireResourceLock(root, expiredResource, {
      owner: "expired-writer",
      now: new Date("2026-06-01T00:00:00.000Z"),
      ttlMs: 1_000
    });

    const recovered = await recoverExpiredResourceLocks(root, {
      now: new Date("2026-06-01T00:00:02.000Z")
    });

    expect(recovered).toMatchObject([
      {
        resource: ".kairon/approvals/APR-OLD.json",
        owner: "expired-writer"
      }
    ]);
    await expect(
      acquireResourceLock(root, activeResource, {
        now: new Date("2026-06-01T00:00:02.000Z")
      })
    ).rejects.toBeInstanceOf(ResourceLockAlreadyExistsError);
    await releaseResourceLock(activeLock);
  });
});
