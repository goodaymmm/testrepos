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
      terminal_id: "TERM-codex-20260525",
      resume_hint: {
        strategy: "native_resume",
        command: "codex",
        args: ["resume", "--last"]
      },
      native: { resume_supported: true },
      session_context_manifest:
        ".kairon/sessions/2026-05-25/codex/session_context_manifest.json"
    });
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "sessions",
          "2026-05-25",
          "codex",
          "session_context_manifest.json"
        )
      )
    ).resolves.toMatchObject({
      kind: "session_context_manifest",
      session_id: "SESSION-2026-05-25-codex",
      latest_context_path: null,
      runs: []
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
    expect(defaultAgentAdapters.gemini.adapter).toBe("antigravity_cli");
    expect(defaultAgentAdapters.gemini.command).toBe("agy");
    expect(defaultAgentAdapters.gemini.supports.multimodal).toBe(true);
  });
});
