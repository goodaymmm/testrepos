import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  RUNTIME_ALREADY_RUNNING_EXIT_CODE,
  startRuntime
} from "../src/cli/commands/start.js";
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
});
