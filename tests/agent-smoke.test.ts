import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSmoke } from "../src/agents/smoke-runner.js";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import type { AgentId } from "../src/agents/types.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("runAgentSmoke", () => {
  it("invokes all configured official CLIs and records smoke artifacts", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];

    for (const agent of ["codex", "claude"] satisfies AgentId[]) {
      const result = await runAgentSmoke(
        root,
        {
          agent,
          date: "2026-05-26",
          timeoutMs: 30_000
        },
        {
          commandAvailability: async () => true,
          commandRunner: async (invocation) => {
            invocations.push(invocation);
            const prompt = promptFromInvocation(invocation);
            const runId = /KAIRON_JOB_START (RUN-\d+)/.exec(prompt)?.[1];
            const taskId = /Task: (TASK-\d+)/.exec(prompt)?.[1];
            const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1];
            if (runId === undefined || taskId === undefined || outboxPath === undefined) {
              throw new Error("Smoke prompt is missing run, task, or outbox path.");
            }

            await writeJsonFileAtomic(path.join(root, outboxPath), {
              schema_version: "0.1",
              run_id: runId,
              task_id: taskId,
              agent,
              persona: "smoke",
              status: "completed",
              events: [
                {
                  type: "message.created",
                  payload: { message_type: "agent.smoke.completed" }
                }
              ]
            });

            return commandResult(invocation, { stdout: `${agent} smoke ok\n` });
          }
        }
      );

      expect(result).toMatchObject({
        agent,
        status: "completed",
        command_available: true,
        outbox_path: `.kairon/runs/${result.run_id}/outbox.json`,
        runner_metadata_path: `.kairon/runs/${result.run_id}/runner.json`
      });
      await expect(
        readJsonFile(path.join(root, ".kairon", "tasks", result.task_id, "task.json"))
      ).resolves.toMatchObject({
        kind: "agent_smoke",
        agent,
        expected_outbox: { path: result.outbox_path }
      });
      await expect(
        readJsonFile(path.join(root, ".kairon", "runs", result.run_id, "outbox.json"))
      ).resolves.toMatchObject({
        run_id: result.run_id,
        task_id: result.task_id,
        agent,
        persona: "smoke",
        status: "completed"
      });
    }

    const geminiResult = await runAgentSmoke(
      root,
      {
        agent: "gemini",
        date: "2026-05-26",
        timeoutMs: 30_000
      },
      {
        commandAvailability: async () => true,
        commandRunner: async (invocation) => {
          invocations.push(invocation);
          return commandResult(invocation);
        }
      }
    );

    expect(geminiResult).toMatchObject({
      agent: "gemini",
      command: "agy",
      command_available: true,
      status: "setup_required"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", geminiResult.run_id, "outbox.json"))
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

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"]
    });
    expect(invocations[1]).toMatchObject({
      command: "claude",
      args: expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose"])
    });
  });

  it("returns setup_required without invoking a missing CLI", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];

    const result = await runAgentSmoke(
      root,
      { agent: "gemini", date: "2026-05-26" },
      {
        commandAvailability: async (command) => command !== "agy",
        commandRunner: async (invocation) => {
          invocations.push(invocation);
          return commandResult(invocation);
        }
      }
    );

    expect(invocations).toEqual([]);
    expect(result).toMatchObject({
      agent: "gemini",
      command: "agy",
      command_available: false,
      status: "setup_required"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", result.run_id, "outbox.json"))
    ).resolves.toMatchObject({
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
});

function promptFromInvocation(invocation: CliInvocation): string {
  if (invocation.stdin !== undefined) {
    return invocation.stdin;
  }

  return invocation.args.join("\n");
}

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
    startedAt: "2026-05-26T00:00:00.000Z",
    finishedAt: "2026-05-26T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}
