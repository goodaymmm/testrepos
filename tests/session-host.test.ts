import { describe, expect, it } from "vitest";
import path from "node:path";
import { FileSessionHost } from "../src/agents/session-host.js";
import { initializeSameDaySessions } from "../src/agents/session-host.js";
import { defaultAgentAdapters } from "../src/agents/adapters/index.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readFile } from "node:fs/promises";
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

  it("initializes enabled same-day sessions and exposes dispatcher availability", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const agentsPath = path.join(root, ".kairon", "config", "agents.json");
    const agents = await readJsonFile<Record<string, any>>(agentsPath);
    agents.agents.claude.enabled = false;
    await writeJsonFileAtomic(agentsPath, agents);

    const summary = await initializeSameDaySessions(root, "2026-05-25", {
      commandAvailability: async (command) => command !== "agy",
      now: () => new Date("2026-05-25T01:02:03.000Z")
    });

    expect(summary).toMatchObject({
      date: "2026-05-25",
      initialized: 2,
      ready: 1,
      setup_required: 1
    });
    expect(summary.agents.map((session) => session.agent)).not.toContain("claude");
    expect(summary.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "codex",
          status: "ready",
          dispatcher_status: "ready",
          session_path: ".kairon/sessions/2026-05-25/codex/session.json",
          resume_hint: expect.objectContaining({ strategy: "native_resume" })
        }),
        expect.objectContaining({
          agent: "gemini",
          status: "setup_required",
          dispatcher_status: "missing_cli",
          command_available: false
        })
      ])
    );
  });

  it("updates session metadata, manifest, and scratch checkpoints for runs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async () => true,
      now: () => new Date("2026-05-25T02:00:00.000Z")
    });

    await host.openSession("codex", "2026-05-25");
    await host.markRunStarted("codex", "2026-05-25", {
      kind: "job",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      persona: "implementer",
      context_path: ".kairon/runs/RUN-0001/context.md",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json",
      runner_metadata_path: ".kairon/runs/RUN-0001/runner.json",
      status: "running",
      started_at: "2026-05-25T02:00:00.000Z"
    });
    await host.markRunFinished("codex", "2026-05-25", {
      kind: "job",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      persona: "implementer",
      context_path: ".kairon/runs/RUN-0001/context.md",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json",
      runner_metadata_path: ".kairon/runs/RUN-0001/runner.json",
      status: "completed",
      started_at: "2026-05-25T02:00:00.000Z",
      finished_at: "2026-05-25T02:03:00.000Z"
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "session.json"))
    ).resolves.toMatchObject({
      active_run_id: null,
      last_run_id: "RUN-0001",
      last_status: "completed"
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
      latest_context_path: ".kairon/runs/RUN-0001/context.md",
      runs: [
        expect.objectContaining({
          run_id: "RUN-0001",
          status: "completed"
        })
      ]
    });
    await expect(
      readFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "scratch.md"), "utf8")
    ).resolves.toContain("Run: RUN-0001");
  });

  it("exposes all MVP CLI adapter definitions", () => {
    expect(defaultAgentAdapters.codex.command).toBe("codex");
    expect(defaultAgentAdapters.claude.command).toBe("claude");
    expect(defaultAgentAdapters.gemini.adapter).toBe("antigravity_cli");
    expect(defaultAgentAdapters.gemini.command).toBe("agy");
    expect(defaultAgentAdapters.gemini.supports.multimodal).toBe(true);
  });
});
