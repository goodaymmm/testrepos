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

  it("does not bootstrap Antigravity through a plain child process pipe", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation);
      }
    });

    const record = await runner.bootstrapAgentSession({
      agent: "gemini",
      date: "2026-05-25"
    });

    expect(invocations).toEqual([]);
    expect(record).toMatchObject({
      kind: "daily_bootstrap",
      agent: "gemini",
      command: "agy",
      status: "setup_required"
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

  it("reuses same-day session metadata and records run context checkpoints", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        const prompt = invocation.stdin ?? "";
        const runId = /KAIRON_JOB_START (RUN-\d+)/.exec(prompt)?.[1];
        const taskId = /Task: (TASK-\d+)/.exec(prompt)?.[1];
        const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1];
        if (runId === undefined || taskId === undefined || outboxPath === undefined) {
          throw new Error("Expected outbox path was not included in prompt");
        }
        await writeJsonFileAtomic(path.join(root, outboxPath), {
          schema_version: "0.1",
          run_id: runId,
          task_id: taskId,
          agent: "codex",
          persona: "implementer",
          status: "completed"
        });
        return commandResult(invocation, { stdout: `${runId} done\n` });
      }
    });

    await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0100",
      taskId: "TASK-0100",
      persona: "implementer"
    });
    await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0101",
      taskId: "TASK-0101",
      persona: "implementer"
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "session.json"))
    ).resolves.toMatchObject({
      session_id: "SESSION-2026-05-25-codex",
      terminal_id: "TERM-codex-20260525",
      active_run_id: null,
      last_run_id: "RUN-0101",
      last_task_id: "TASK-0101",
      last_context_path: ".kairon/runs/RUN-0101/context.md",
      last_status: "completed",
      resume_hint: {
        strategy: "native_resume",
        args: ["resume", "--last"]
      }
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
      latest_context_path: ".kairon/runs/RUN-0101/context.md",
      runs: [
        {
          run_id: "RUN-0100",
          status: "completed",
          context_path: ".kairon/runs/RUN-0100/context.md"
        },
        {
          run_id: "RUN-0101",
          status: "completed",
          context_path: ".kairon/runs/RUN-0101/context.md"
        }
      ]
    });
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
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: {
            classification_status: "setup_required",
            reason: "cli_command_missing",
            setup_action: expect.stringContaining("agy")
          }
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

  it("classifies provider rate limits as rate_limited", async () => {
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

    expect(record.status).toBe("rate_limited");
    expect(record.failure_reason).toBe("cli_rate_limited");
    expect(record.exit_code).toBe(1);
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0006", "outbox.json"))
    ).resolves.toMatchObject({
      run_id: "RUN-0006",
      agent: "claude",
      status: "rate_limited",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.rate_limited",
            classification_status: "rate_limited",
            reason: "cli_rate_limited"
          }
        }
      ]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "terminals", "TERM-claude-20260525.json"))
    ).resolves.toMatchObject({
      status: "rate_limited"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "agents", "claude-health.json"))
    ).resolves.toMatchObject({
      status: "cooldown",
      failure_category: "rate_limit",
      last_run_id: "RUN-0006",
      active_run_ids: []
    });
  });

  it("classifies provider usage caps as usage_limited with resume hints", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stdout: "Usage limit reached for this billing period."
        })
    });

    const record = await runner.runAgentJob({
      agent: "claude",
      date: "2026-05-25",
      runId: "RUN-0016",
      taskId: "TASK-0016",
      persona: "smoke"
    });

    expect(record).toMatchObject({
      status: "usage_limited",
      failure_reason: "cli_usage_limited",
      setup_action: expect.stringContaining("provider usage"),
      resume_hint: expect.stringContaining("Pause this agent")
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0016", "outbox.json"))
    ).resolves.toMatchObject({
      status: "usage_limited",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.usage_limited",
            classification_status: "usage_limited",
            reason: "cli_usage_limited",
            resume_hint: expect.stringContaining("Pause this agent")
          }
        }
      ]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "claude", "session.json"))
    ).resolves.toMatchObject({
      last_run_id: "RUN-0016",
      last_status: "usage_limited",
      last_prompt_path: ".kairon/runs/RUN-0016/stdin.md",
      last_stdout_log: ".kairon/runs/RUN-0016/stdout.log",
      last_stderr_log: ".kairon/runs/RUN-0016/stderr.log",
      last_runner_metadata_path: ".kairon/runs/RUN-0016/runner.json",
      pause: {
        status: "usage_limited",
        reason: "cli_usage_limited",
        setup_action: expect.stringContaining("provider usage"),
        resume_hint: expect.stringContaining("Pause this agent"),
        run_id: "RUN-0016",
        task_id: "TASK-0016"
      }
    });
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "sessions",
          "2026-05-25",
          "claude",
          "session_context_manifest.json"
        )
      )
    ).resolves.toMatchObject({
      latest_context_path: ".kairon/runs/RUN-0016/context.md",
      runs: [
        expect.objectContaining({
          run_id: "RUN-0016",
          status: "usage_limited",
          prompt_path: ".kairon/runs/RUN-0016/stdin.md",
          stdout_log: ".kairon/runs/RUN-0016/stdout.log",
          stderr_log: ".kairon/runs/RUN-0016/stderr.log",
          failure_reason: "cli_usage_limited"
        })
      ]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "agents", "claude-health.json"))
    ).resolves.toMatchObject({
      status: "cooldown",
      failure_category: "quota",
      last_run_id: "RUN-0016",
      active_run_ids: []
    });
  });

  it("classifies permission prompts without auto-approval", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stderr: "Approval required: allow this command?"
        })
    });

    const record = await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0010",
      taskId: "TASK-0010",
      persona: "smoke"
    });

    expect(record.status).toBe("permission_required");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0010", "outbox.json"))
    ).resolves.toMatchObject({
      status: "permission_required",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.permission_required",
            reason: "cli_permission_required",
            setup_action: expect.stringContaining("interactive")
          }
        }
      ]
    });
  });

  it("does not treat an echoed Codex fallback contract as a completed run", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stdout: invocation.stdin ?? "",
          stderr: "Approval required: allow this command?"
        })
    });

    const record = await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0010-ECHO",
      taskId: "TASK-0010-ECHO",
      persona: "implementer"
    });

    expect(record).toMatchObject({
      status: "permission_required",
      classification: {
        status: "permission_required",
        reason: "cli_permission_required"
      }
    });
  });

  it("keeps login-required setup pauses in same-day session state", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stderr: "Error: login required. Please log in."
        })
    });

    const record = await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0017",
      taskId: "TASK-0017",
      persona: "smoke"
    });

    expect(record).toMatchObject({
      status: "setup_required",
      failure_reason: "cli_login_required",
      setup_action: expect.stringContaining("codex login")
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "session.json"))
    ).resolves.toMatchObject({
      last_status: "setup_required",
      pause: expect.objectContaining({
        status: "setup_required",
        reason: "cli_login_required",
        resume_hint: "Retry after CLI authentication has been completed."
      })
    });
  });

  it("classifies timed-out CLI runs and preserves artifacts", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          stderr: "still running"
        })
    });

    const record = await runner.runAgentJob({
      agent: "claude",
      date: "2026-05-25",
      runId: "RUN-0011",
      taskId: "TASK-0011",
      persona: "smoke"
    });

    expect(record).toMatchObject({
      status: "timeout",
      failure_reason: "cli_timeout",
      timed_out: true
    });
    await expect(
      readFile(path.join(root, ".kairon", "runs", "RUN-0011", "stderr.log"), "utf8")
    ).resolves.toBe("still running");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0011", "outbox.json"))
    ).resolves.toMatchObject({
      status: "timeout",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.timeout",
            timed_out: true
          }
        }
      ]
    });
  });

  it("classifies successful processes with no outbox and no output as no_output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => commandResult(invocation)
    });

    const record = await runner.runAgentJob({
      agent: "codex",
      date: "2026-05-25",
      runId: "RUN-0012",
      taskId: "TASK-0012",
      persona: "smoke"
    });

    expect(record.status).toBe("no_output");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0012", "outbox.json"))
    ).resolves.toMatchObject({
      status: "no_output",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.no_output",
            reason: "cli_no_output"
          }
        }
      ]
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

  it("reports Antigravity as setup-required until a PTY adapter is configured", async () => {
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
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: {
            classification_status: "setup_required",
            reason: "cli_pty_required"
          }
        }
      ]
    });
  });

  it("runs Antigravity through a configured interactive session runner", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const interactiveRuns: string[] = [];
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      interactiveSessionRunner: async (job) => {
        interactiveRuns.push(job.command);
        await writeJsonFileAtomic(job.outboxPath, {
          schema_version: "0.1",
          run_id: job.runId,
          task_id: job.taskId,
          agent: job.agent,
          persona: job.persona,
          status: "completed",
          events: [
            {
              type: "message.created",
              payload: { message_type: "antigravity.interactive.completed" }
            }
          ]
        });
        return commandResult(
          {
            command: job.command,
            args: ["--prompt-interactive"],
            cwd: job.cwd,
            timeoutMs: job.timeoutMs
          },
          { stdout: "agy interactive ok\n" }
        );
      }
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0007",
      taskId: "TASK-0007",
      persona: "researcher",
      capabilities: ["research", "large.context"],
      tags: ["large_context"]
    });

    expect(interactiveRuns).toEqual(["agy"]);
    expect(record).toMatchObject({
      agent: "gemini",
      command: "agy",
      args: ["--prompt-interactive"],
      status: "completed",
      command_available: true
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runtime", "terminals", "TERM-gemini-20260525.json"))
    ).resolves.toMatchObject({
      status: "ready"
    });
  });

  it("prioritizes a completed Antigravity stdout outbox over echoed permission wording", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      interactiveSessionRunner: async (job) =>
        commandResult(
          {
            command: job.command,
            args: ["--prompt-interactive", job.prompt],
            cwd: job.cwd,
            timeoutMs: job.timeoutMs
          },
          {
            stdout: [
              job.prompt,
              "KAIRON_OUTBOX_JSON_START",
              JSON.stringify({
                schema_version: "0.1",
                run_id: job.runId,
                task_id: job.taskId,
                persona: job.persona,
                status: "completed",
                events: []
              }),
              "KAIRON_OUTBOX_JSON_END"
            ].join("\n")
          }
        )
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0019",
      taskId: "TASK-0019",
      persona: "smoke"
    });

    expect(record).toMatchObject({
      status: "completed",
      classification: {
        status: "completed",
        reason: "stdout_outbox_completed"
      }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0019", "outbox.json"))
    ).resolves.toMatchObject({
      run_id: "RUN-0019",
      status: "completed"
    });
  });

  it("classifies PTY spawn failures as setup-required", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      interactiveSessionRunner: async (job) =>
        commandResult(
          {
            command: job.command,
            args: ["--prompt-interactive", job.prompt],
            cwd: job.cwd,
            timeoutMs: job.timeoutMs
          },
          {
            exitCode: 1,
            stderr: "KAIRON_SETUP_REQUIRED pty_spawn_failed: native binding missing\n"
          }
        )
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0008",
      taskId: "TASK-0008",
      persona: "researcher"
    });

    expect(record.status).toBe("setup_required");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0008", "outbox.json"))
    ).resolves.toMatchObject({
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_pty_unavailable" }
        }
      ]
    });
  });

  it("classifies unresolved PTY commands as setup-required", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new CliSessionRunner(root, {
      commandAvailability: async () => true,
      interactiveSessionRunner: async (job) =>
        commandResult(
          {
            command: job.command,
            args: ["--prompt-interactive", job.prompt],
            cwd: job.cwd,
            timeoutMs: job.timeoutMs
          },
          {
            exitCode: 1,
            stderr: "KAIRON_SETUP_REQUIRED pty_command_unresolved: command=agy searched=\n"
          }
        )
    });

    const record = await runner.runAgentJob({
      agent: "gemini",
      date: "2026-05-25",
      runId: "RUN-0009",
      taskId: "TASK-0009",
      persona: "researcher"
    });

    expect(record.status).toBe("setup_required");
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0009", "outbox.json"))
    ).resolves.toMatchObject({
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_pty_command_unresolved" }
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
