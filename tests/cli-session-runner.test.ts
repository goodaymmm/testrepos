import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { CliSessionRunner } from "../src/agents/cli-session-runner.js";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("CliSessionRunner", () => {
  it("bootstraps a Codex session through the official CLI invocation", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new CliSessionRunner(root, {
      commandAvailability: async (command) => command === "codex",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation, { stdout: '{"event":"ready"}\n' });
      }
    });

    const record = await runner.bootstrapAgentSession({
      agent: "codex",
      date: "2026-05-25"
    });

    expect(invocations[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"]
    });
    expect(invocations[0]?.stdin).toContain("KAIRON_DAILY_BOOTSTRAP_START");
    expect(record).toMatchObject({
      kind: "daily_bootstrap",
      status: "completed",
      command_available: true,
      stdout_log: ".kairon/sessions/2026-05-25/codex/bootstrap.stdout.log"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "terminals", "TERM-codex-20260525.json"))
    ).resolves.toMatchObject({
      terminal_id: "TERM-codex-20260525",
      status: "ready"
    });
  });

  it("sends a Codex job prompt and preserves an agent-written outbox", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        const prompt = invocation.stdin ?? "";
        if (prompt.includes("KAIRON_DAILY_BOOTSTRAP_START")) {
          return commandResult(invocation, { stdout: "ready\n" });
        }
        const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1];
        if (outboxPath === undefined) {
          throw new Error("Expected outbox path was not included in prompt");
        }
        await writeJsonFileAtomic(path.join(root, outboxPath), {
          schema_version: "0.1",
          run_id: "RUN-0001",
          task_id: "TASK-0001",
          agent: "codex",
          persona: "implementer",
          status: "completed"
        });
        return commandResult(invocation, { stdout: "done\n" });
      }
    });

    await runner.bootstrapAgentSession({
      agent: "codex",
      date: "2026-05-25"
    });
    const record = await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0001",
      taskId: "TASK-0001",
      persona: "implementer"
    });

    expect(record).toMatchObject({
      kind: "job",
      status: "completed",
      outbox_path: ".kairon/runs/RUN-0001/outbox.json"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0001", "runner.json"))
    ).resolves.toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"]
    });
    await expect(
      readFile(path.join(root, ".kairon", "runs", "RUN-0001", "stdout.log"), "utf8")
    ).resolves.toBe("done\n");
  });

  it("creates a setup-required failure outbox when a CLI is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => false
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0002",
      taskId: "TASK-0002",
      persona: "qa"
    });

    expect(record.status).toBe("setup_required");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0002", "outbox.json"))
    ).resolves.toMatchObject({
      run_id: "RUN-0002",
      agent: "gemini",
      status: "failed",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_command_missing" }
        }
      ]
    });
  });

  it("persists a stdout fallback outbox when file tools are blocked", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stdout: [
            "tool write was blocked",
            "KAIRON_OUTBOX_JSON_START",
            JSON.stringify({
              schema_version: "0.1",
              run_id: "RUN-0005",
              task_id: "TASK-0005",
              agent: "claude",
              persona: "smoke",
              status: "completed",
              events: [
                {
                  type: "message.created",
                  payload: { message_type: "stdout.fallback.completed" }
                }
              ]
            }),
            "KAIRON_OUTBOX_JSON_END"
          ].join("\n")
        })
    });

    const record = await runner.runAgentJob({
      agent: "claude",
      date: "2026-05-25",
      runId: "RUN-0005",
      taskId: "TASK-0005",
      persona: "smoke"
    });

    expect(record.status).toBe("completed");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0005", "outbox.json"))
    ).resolves.toMatchObject({
      run_id: "RUN-0005",
      task_id: "TASK-0005",
      agent: "claude",
      status: "completed"
    });
  });

  it("classifies provider rate limits as setup-required", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            error: "rate_limit",
            result: "You've hit your limit"
          })
        })
    });

    const record = await runner.runAgentJob({
      agent: "claude",
      date: "2026-05-25",
      runId: "RUN-0006",
      taskId: "TASK-0006",
      persona: "smoke"
    });

    expect(record.status).toBe("setup_required");
    expect(record.exit_code).toBe(1);
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0006", "outbox.json"))
    ).resolves.toMatchObject({
      run_id: "RUN-0006",
      agent: "claude",
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_rate_limited" }
        }
      ]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "terminals", "TERM-claude-20260525.json"))
    ).resolves.toMatchObject({
      status: "setup_required"
    });
  });

  it("routes Claude Opus code production into the Codex review path", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0003", "outbox.json"), {
          schema_version: "0.1",
          run_id: "RUN-0003",
          task_id: "TASK-0003",
          agent: "claude",
          persona: "implementer",
          status: "completed"
        });
        return commandResult(invocation);
      }
    });

    const record = await runner.runAgentJob({
      agent: "claude",
      date: "2026-05-25",
      runId: "RUN-0003",
      taskId: "TASK-0003",
      persona: "implementer",
      modelClass: "opus",
      codeProducing: true
    });

    expect(invocations[0]?.args).toContain("--output-format");
    expect(invocations[0]?.args).toContain("stream-json");
    expect(invocations[0]?.args).toContain("--verbose");
    expect(invocations[0]?.args).not.toContain("--bare");
    expect(record.review_loop).toMatchObject({
      reviewers: ["codex"],
      integration: "codex-plugin-cc",
      status: "running"
    });
  });

  it("reports Antigravity/Gemini as setup-required until a PTY adapter is configured", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0004", "outbox.json"), {
          schema_version: "0.1",
          run_id: "RUN-0004",
          task_id: "TASK-0004",
          agent: "gemini",
          persona: "qa",
          status: "completed"
        });
        return commandResult(invocation);
      }
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0004",
      taskId: "TASK-0004",
      persona: "qa",
      capabilities: ["qa", "google_ecosystem", "multimodal"],
      tags: ["google_ecosystem", "multimodal"]
    });

    expect(invocations).toHaveLength(0);
    expect(record).toMatchObject({
      agent: "gemini",
      command: "agy",
      status: "setup_required",
      command_available: true
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0004", "outbox.json"))
    ).resolves.toMatchObject({
      agent: "gemini",
      status: "failed",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_pty_required" }
        }
      ]
    });
  });
});

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-05-25T00:00:00.000Z",
    finishedAt: "2026-05-25T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}
