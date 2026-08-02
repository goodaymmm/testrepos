import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  RUNTIME_ALREADY_RUNNING_EXIT_CODE,
  startRuntime
} from "../src/cli/commands/start.js";
import { stopRuntime } from "../src/cli/commands/stop.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
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
    expect(text).toContain("runtime.daemon.log=.kairon/runtime/daemon/");
    await expect(readRuntimeLockStatus(root)).resolves.toMatchObject({
      locked: false
    });
  });

  it("runs safe runtime recovery before acquiring the runtime lock", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const gatewayPath = path.join(root, ".kairon", "runtime", "discord", "gateway.json");
    await writeJsonFileAtomic(gatewayPath, {
      schema_version: "0.1",
      status: "starting",
      updated_at: "2026-06-01T00:00:00.000Z"
    });

    try {
      await startRuntime(root);

      await expect(readJsonFile(gatewayPath)).resolves.toMatchObject({
        status: "stopped",
        error_code: "discord_gateway_starting_stale"
      });
    } finally {
      await releaseRuntimeLock(root);
    }
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
