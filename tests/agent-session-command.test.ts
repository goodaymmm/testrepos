import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionHost } from "../src/agents/session-host.js";
import {
  listAgentSessionsCommand,
  resetAgentSessionCommand,
  showAgentSessionCommand
} from "../src/cli/commands/agent.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("agent session commands", () => {
  it("lists sessions and explains missing CLI setup requirements", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async (command) => command !== "agy",
      now: () => new Date("2026-05-25T00:00:00.000Z")
    });

    await host.openSession("codex", "2026-05-25");
    await host.openSession("gemini", "2026-05-25");

    const listOutput = await listAgentSessionsCommand(root, {
      date: "2026-05-25"
    });
    expect(listOutput).toContain("Kairon agent sessions.");
    expect(listOutput).toContain("sessions=2");
    expect(listOutput).toContain("agent=gemini");
    expect(listOutput).toContain("dispatcher_status=missing_cli");
    expect(listOutput).toContain("reason=cli_command_missing");

    const showOutput = await showAgentSessionCommand(root, "gemini", {
      date: "2026-05-25"
    });
    expect(showOutput).toContain("status=setup_required");
    expect(showOutput).toContain("setup_reason=cli_command_missing");
    expect(showOutput).toContain("Install or expose agy on PATH");
    expect(showOutput).toContain(
      "session_path=.kairon/sessions/2026-05-25/gemini/session.json"
    );
  });

  it("shows paused setup_required details from the latest run", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async () => true,
      now: () => new Date("2026-05-25T01:00:00.000Z")
    });

    await host.openSession("claude", "2026-05-25");
    await host.markRunFinished("claude", "2026-05-25", {
      kind: "job",
      run_id: "RUN-0009",
      task_id: "TASK-0009",
      persona: "reviewer",
      context_path: ".kairon/runs/RUN-0009/context.md",
      outbox_path: ".kairon/runs/RUN-0009/outbox.json",
      prompt_path: ".kairon/runs/RUN-0009/stdin.md",
      stdout_log: ".kairon/runs/RUN-0009/stdout.log",
      stderr_log: ".kairon/runs/RUN-0009/stderr.log",
      runner_metadata_path: ".kairon/runs/RUN-0009/runner.json",
      status: "permission_required",
      failure_reason: "cli_permission_prompt",
      setup_action: "Approve the CLI permission prompt manually.",
      resume_hint: "Retry after permission is granted.",
      matched_pattern: "permission"
    });

    const output = await showAgentSessionCommand(root, "claude", {
      date: "2026-05-25"
    });

    expect(output).toContain("status=permission_required");
    expect(output).toContain("dispatcher_status=permission_required");
    expect(output).toContain("setup_reason=cli_permission_prompt");
    expect(output).toContain("setup_action=Approve the CLI permission prompt manually.");
    expect(output).toContain("resume_hint=Retry after permission is granted.");
    expect(output).toContain("matched_pattern=permission");
  });

  it("archives sessions on reset without deleting evidence", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const host = new FileSessionHost(root, {
      commandAvailability: async () => true,
      now: () => new Date("2026-05-25T02:00:00.000Z")
    });

    await host.openSession("codex", "2026-05-25");

    const output = await resetAgentSessionCommand(root, "codex", {
      date: "2026-05-25",
      now: () => new Date("2026-05-25T03:04:05.000Z")
    });

    expect(output).toContain("Kairon agent session reset.");
    expect(output).toContain("status=archived");
    expect(output).toContain(
      "archived_path=.kairon/sessions/2026-05-25/codex.archived-20260525T030405Z"
    );
    await expect(
      access(path.join(root, ".kairon", "sessions", "2026-05-25", "codex"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "sessions",
          "2026-05-25",
          "codex.archived-20260525T030405Z",
          "session.json"
        )
      )
    ).resolves.toMatchObject({
      agent: "codex",
      session_id: "SESSION-2026-05-25-codex"
    });
  });
});
