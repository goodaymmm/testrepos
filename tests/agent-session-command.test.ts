import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileSessionHost,
  type SessionRunStatus,
  type SessionRunUpdate
} from "../src/agents/session-host.js";
import {
  listAgentSessionsCommand,
  resumeAgentCommand,
  resetAgentSessionCommand,
  showAgentHealthCommand,
  suspendAgentCommand,
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
    expect(showOutput).toContain("health_status=blocked");
    expect(showOutput).toContain("health_last_reason=cli_command_missing");
    expect(showOutput).toContain(
      "health_path=.kairon/sessions/2026-05-25/gemini/health.json"
    );
  });

  it("records bounded retry health and resets consecutive failures after recovery", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    let now = new Date("2026-05-25T01:00:00.000Z");
    const host = new FileSessionHost(root, {
      commandAvailability: async () => true,
      now: () => now
    });

    await host.openSession("codex", "2026-05-25");
    await host.markRunFinished(
      "codex",
      "2026-05-25",
      runUpdate("RUN-0010", "setup_required", "cli_login_required")
    );
    now = new Date("2026-05-25T01:05:00.000Z");
    await host.markRunFinished(
      "codex",
      "2026-05-25",
      runUpdate("RUN-0011", "setup_required", "cli_login_required")
    );

    const healthPath = path.join(
      root,
      ".kairon",
      "sessions",
      "2026-05-25",
      "codex",
      "health.json"
    );
    await expect(readJsonFile(healthPath)).resolves.toMatchObject({
      kind: "agent_session_health",
      status: "blocked",
      consecutive_failures: 2,
      retry_backoff_seconds: 600,
      next_retry_at: "2026-05-25T01:15:00.000Z",
      setup_required_count: 2,
      history_entries: 3
    });

    const blockedOutput = await showAgentSessionCommand(root, "codex", {
      date: "2026-05-25",
      now: () => new Date("2026-05-25T01:06:00.000Z")
    });
    expect(blockedOutput).toContain("health_status=blocked");
    expect(blockedOutput).toContain("health_consecutive_failures=2");
    expect(blockedOutput).toContain("health_retry_ready=false");

    now = new Date("2026-05-25T01:20:00.000Z");
    await host.markRunFinished(
      "codex",
      "2026-05-25",
      runUpdate("RUN-0012", "completed")
    );

    await expect(readJsonFile(healthPath)).resolves.toMatchObject({
      status: "healthy",
      consecutive_failures: 0,
      retry_backoff_seconds: 0,
      next_retry_at: null,
      last_observed_status: "completed",
      setup_required_count: 2,
      history_entries: 4
    });
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

  it("shows provider health and audits manual suspend and resume", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const now = () => new Date("2026-07-16T05:00:00.000Z");

    const initial = await showAgentHealthCommand(root, { agent: "codex", now });
    expect(initial).toContain("Kairon agent provider health.");
    expect(initial).toContain("agent=codex");
    expect(initial).toContain("status=ready");
    expect(initial).toContain(
      "health_path=.kairon/runtime/agents/codex-health.json"
    );

    const suspended = await suspendAgentCommand(root, {
      agent: "codex",
      reason: "manual compliance review",
      now
    });
    expect(suspended).toContain("Kairon agent provider suspended.");
    expect(suspended).toContain("status=suspended");
    expect(suspended).toContain("audit=.kairon/audit/provider-policy.jsonl");

    const resumed = await resumeAgentCommand(root, {
      agent: "codex",
      reason: "review completed",
      now
    });
    expect(resumed).toContain("Kairon agent provider resumed.");
    expect(resumed).toContain("status=ready");
  });
});

function runUpdate(
  runId: string,
  status: SessionRunStatus,
  failureReason?: string
): SessionRunUpdate {
  return {
    kind: "job",
    run_id: runId,
    task_id: `TASK-${runId.slice(4)}`,
    persona: "smoke",
    context_path: `.kairon/runs/${runId}/context.md`,
    outbox_path: `.kairon/runs/${runId}/outbox.json`,
    runner_metadata_path: `.kairon/runs/${runId}/runner.json`,
    status,
    failure_reason: failureReason
  };
}
