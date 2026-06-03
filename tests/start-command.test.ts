import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  RUNTIME_ALREADY_RUNNING_EXIT_CODE,
  startRuntime
} from "../src/cli/commands/start.js";
import { stopRuntime } from "../src/cli/commands/stop.js";
import {
  acquireRuntimeLock,
  readRuntimeLockStatus,
  releaseRuntimeLock
} from "../src/runtime/runtime-lock.js";
import { createTempProject } from "./test-utils.js";

describe("startRuntime", () => {
  it("returns exit code 3 when runtime lock already exists", async () => {
    const root = await createTempProject();
    const previousExitCode = process.exitCode;

    try {
      await initializeProject({ projectRoot: root });
      await expect(startRuntime(root)).resolves.toContain(
        "Kairon runtime started."
      );
      await expect(startRuntime(root)).resolves.toContain(
        "Kairon runtime is already running."
      );
      expect(process.exitCode).toBe(RUNTIME_ALREADY_RUNNING_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("runs daemon mode for multiple ticks and releases the lock", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const text = await startRuntime(root, {
      daemon: true,
      intervalMs: 0,
      maxTicks: 2
    });

    expect(text).toContain("Kairon runtime daemon stopped.");
    expect(text).toContain("runtime.daemon.ticks=2");
    expect(text).toContain("runtime.daemon.stopReason=max_ticks");
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });
  });

  it("requests daemon stop without removing an active daemon lock", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, { mode: "daemon" });

    await expect(stopRuntime(root)).resolves.toContain(
      "Kairon runtime stop requested."
    );
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: true,
      data: {
        mode: "daemon",
        stop_requested: true
      }
    });

    await releaseRuntimeLock(root);
  });
});
