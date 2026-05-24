import { describe, expect, it } from "vitest";
import path from "node:path";
import { FileSessionHost } from "../src/agents/session-host.js";
import { defaultAgentAdapters } from "../src/agents/adapters/index.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("FileSessionHost", () => {
  it("creates and attaches session metadata without starting a process", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async (command) => command === "codex",
      now: () => new Date("2026-05-25T00:00:00.000Z")
    });

    const session = await host.openSession("codex", "2026-05-25");

    expect(session).toMatchObject({
      session_id: "SESSION-2026-05-25-codex",
      agent: "codex",
      command_available: true,
      status: "ready"
    });
    await expect(host.attachSession("codex", "2026-05-25")).resolves.toMatchObject({
      session_id: session.session_id
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "session.json"))
    ).resolves.toMatchObject({
      active_run_id: null,
      native: { resume_supported: true }
    });
  });

  it("marks session setup required when CLI command is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async () => false
    });

    await expect(host.openSession("gemini", "2026-05-25")).resolves.toMatchObject({
      agent: "gemini",
      command_available: false,
      status: "setup_required"
    });
  });

  it("exposes all MVP CLI adapter definitions", () => {
    expect(defaultAgentAdapters.codex.command).toBe("codex");
    expect(defaultAgentAdapters.claude.command).toBe("claude");
    expect(defaultAgentAdapters.gemini.command).toBe("gemini");
    expect(defaultAgentAdapters.gemini.supports.multimodal).toBe(true);
  });
});
