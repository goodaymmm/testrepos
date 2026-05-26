import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  createTaskCommand
} from "../src/cli/commands/task.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import { createTempProject } from "./test-utils.js";

describe("TaskRunner", () => {
  it("creates task artifacts with persona, capabilities, and approval metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const result = await new TaskRunner(root, {
      now: () => new Date("2026-05-26T07:00:00.000Z")
    }).createTask({
      title: "Implement task runner",
      persona: "implementer",
      description: "Create the minimal queue to runner path.",
      capabilities: ["coding", "json.output", "coding"],
      tags: ["mvp"],
      approvalRequired: true,
      codeProducing: true,
      commitRequested: true,
      priority: 80,
      scheduleMode: "active_work"
    });

    expect(result).toMatchObject({
      task_id: "TASK-0001",
      task_path: ".kairon/tasks/TASK-0001/task.json",
      status: "ready",
      persona: "implementer"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"))
    ).resolves.toMatchObject({
      id: "TASK-0001",
      title: "Implement task runner",
      persona: "implementer",
      capabilities: ["coding", "json.output"],
      approval_required: true,
      code_producing: true,
      commit_requested: true,
      priority: 80,
      schedule_mode: "active_work"
    });
  });

  it("queues, dispatches, runs, and applies a task outbox", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new TaskRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        const prompt = promptFromInvocation(invocation);
        const runId = /KAIRON_JOB_START (RUN-\d+)/.exec(prompt)?.[1];
        const taskId = /Task: (TASK-\d+)/.exec(prompt)?.[1];
        const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1];
        if (runId === undefined || taskId === undefined || outboxPath === undefined) {
          throw new Error("Task prompt is missing run, task, or outbox path.");
        }

        await writeTaskOutbox(root, {
          outboxPath,
          runId,
          taskId,
          agent: "codex",
          persona: "implementer",
          status: "completed"
        });
        return commandResult(invocation, { stdout: "task complete\n" });
      }
    });
    const task = await runner.createTask({
      title: "Create a feature",
      persona: "implementer",
      capabilities: ["coding"]
    });

    const result = await runner.runTask({ taskId: task.task_id, date: "2026-05-26" });

    expect(result).toMatchObject({
      task_id: "TASK-0001",
      queue_item_id: "JOB-0001",
      run_id: "RUN-0001",
      status: "completed",
      agent: "codex",
      persona: "implementer",
      command_available: true,
      applied_event_ids: expect.any(Array)
    });
    expect(result.applied_event_ids.length).toBeGreaterThan(0);
    expect(invocations[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "--sandbox", "workspace-write", "-"]
    });
    await expect(new WorkQueue(root).list("completed")).resolves.toMatchObject([
      {
        id: "JOB-0001",
        task_id: "TASK-0001",
        result: {
          run_id: "RUN-0001",
          status: "completed",
          agent: "codex"
        }
      }
    ]);
    await expect(
      readJsonLines(path.join(root, ".kairon", "messages", "TASK-0001.jsonl"))
    ).resolves.toHaveLength(1);
    await expect(
      readJsonFile(path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"))
    ).resolves.toMatchObject({
      status: "completed",
      last_run_id: "RUN-0001",
      last_run_status: "completed"
    });
  });

  it("returns setup_required when the selected agent CLI is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const runner = new TaskRunner(root, {
      commandAvailability: async (command) => command !== "agy",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation);
      }
    });
    const task = await runner.createTask({
      title: "Run QA",
      persona: "qa",
      capabilities: ["qa"]
    });

    const result = await runner.runTask({ taskId: task.task_id, date: "2026-05-26" });

    expect(invocations).toEqual([]);
    expect(result).toMatchObject({
      status: "setup_required",
      agent: "gemini",
      command: "agy",
      command_available: false
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", result.run_id, "outbox.json"))
    ).resolves.toMatchObject({
      status: "failed",
      agent: "gemini",
      events: [
        {
          type: "message.created",
          payload: { reason: "cli_command_missing" }
        }
      ]
    });
  });

  it("starts a review loop for code-producing tasks", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const runner = new TaskRunner(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        const prompt = promptFromInvocation(invocation);
        const runId = /KAIRON_JOB_START (RUN-\d+)/.exec(prompt)?.[1] ?? "";
        const taskId = /Task: (TASK-\d+)/.exec(prompt)?.[1] ?? "";
        const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1] ?? "";
        await writeTaskOutbox(root, {
          outboxPath,
          runId,
          taskId,
          agent: "codex",
          persona: "implementer",
          status: "completed"
        });
        return commandResult(invocation);
      }
    });
    const task = await runner.createTask({
      title: "Modify source code",
      persona: "implementer",
      codeProducing: true
    });

    const result = await runner.runTask({ taskId: task.task_id, date: "2026-05-26" });

    expect(result.review_loop).toMatchObject({
      status: "running",
      reviewers: ["claude"]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "reviews", "loops", `${result.review_loop?.loop_id}.json`))
    ).resolves.toMatchObject({
      task_id: task.task_id,
      status: "running",
      code_producing: true
    });
  });

  it("formats create command output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const createText = await createTaskCommand(root, {
      title: "Write docs",
      persona: "maintainer"
    });
    expect(createText).toContain("Kairon task created.");
    expect(createText).toContain("task_id=TASK-0001");
  });
});

async function writeTaskOutbox(
  root: string,
  input: {
    outboxPath: string;
    runId: string;
    taskId: string;
    agent: string;
    persona: string;
    status: string;
  }
): Promise<void> {
  const { writeJsonFileAtomic } = await import("../src/core/fs/json-file.js");
  await writeJsonFileAtomic(path.join(root, input.outboxPath), {
    schema_version: "0.1",
    run_id: input.runId,
    task_id: input.taskId,
    agent: input.agent,
    persona: input.persona,
    status: input.status,
    events: [
      {
        type: "message.created",
        payload: {
          message_type: "task.run.result",
          body: "Task runner smoke completed."
        }
      }
    ]
  });
}

function promptFromInvocation(invocation: CliInvocation): string {
  return invocation.stdin ?? invocation.args.join("\n");
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
