import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  acquireRuntimeLock,
  readRuntimeLockStatus,
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
});
