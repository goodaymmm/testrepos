import path from "node:path";
import { CliSessionRunner, type CliSessionRunRecord } from "./cli-session-runner.js";
import type { CommandAvailabilityChecker } from "./session-host.js";
import type { AgentId } from "./types.js";
import type { CommandRunner } from "./command-runner.js";
import type { InteractiveSessionRunner } from "./interactive-session-runner.js";
import { nextId } from "../core/ids/counter.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type AgentSmokeRequest = {
  agent: AgentId;
  date?: string;
  timeoutMs?: number;
};

export type AgentSmokeResult = {
  schema_version: string;
  kind: "agent_smoke";
  agent: AgentId;
  status: CliSessionRunRecord["status"];
  run_id: string;
  task_id: string;
  date: string;
  runner_metadata_path: string;
  outbox_path: string;
  stdout_log: string;
  stderr_log: string;
  command: string;
  args: string[];
  command_available: boolean;
};

export async function runAgentSmoke(
  projectRoot: string,
  request: AgentSmokeRequest,
  options: {
    commandAvailability?: CommandAvailabilityChecker;
    commandRunner?: CommandRunner;
    interactiveSessionRunner?: InteractiveSessionRunner;
    now?: () => Date;
  } = {}
): Promise<AgentSmokeResult> {
  const now = options.now?.() ?? new Date();
  const date = request.date ?? localDateKey(now);
  const runId = await nextId(projectRoot, "run");
  const taskId = await nextId(projectRoot, "task");

  await writeSmokeTask(projectRoot, {
    agent: request.agent,
    date,
    runId,
    taskId,
    createdAt: now.toISOString()
  });

  const record = await new CliSessionRunner(projectRoot, {
    commandAvailability: options.commandAvailability,
    commandRunner: options.commandRunner,
    interactiveSessionRunner: options.interactiveSessionRunner,
    now: options.now
  }).runAgentJob({
    agent: request.agent,
    date,
    runId,
    taskId,
    persona: "smoke",
    timeoutMs: request.timeoutMs,
    capabilities: ["json.output", "smoke_test"]
  });

  return {
    schema_version: "0.1",
    kind: "agent_smoke",
    agent: request.agent,
    status: record.status,
    run_id: runId,
    task_id: taskId,
    date,
    runner_metadata_path: record.runner_metadata_path,
    outbox_path: record.outbox_path ?? toProjectPath(projectRoot, outboxPath(projectRoot, runId)),
    stdout_log: record.stdout_log,
    stderr_log: record.stderr_log,
    command: record.command,
    args: record.args,
    command_available: record.command_available
  };
}

export function formatAgentSmokeResult(result: AgentSmokeResult): string {
  const headline =
    result.status === "setup_required"
      ? "Kairon agent smoke setup required."
      : result.status === "completed"
        ? "Kairon agent smoke completed."
        : "Kairon agent smoke failed.";

  return [
    headline,
    `agent=${result.agent}`,
    `status=${result.status}`,
    `run_id=${result.run_id}`,
    `task_id=${result.task_id}`,
    `date=${result.date}`,
    `command=${result.command}`,
    `command_available=${result.command_available}`,
    `runner=${result.runner_metadata_path}`,
    `outbox=${result.outbox_path}`,
    `stdout=${result.stdout_log}`,
    `stderr=${result.stderr_log}`
  ].join("\n");
}

async function writeSmokeTask(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    runId: string;
    taskId: string;
    createdAt: string;
  }
): Promise<void> {
  const taskPath = resolveInside(
    getKaironPaths(projectRoot).tasksDir,
    input.taskId,
    "task.json"
  );
  const expectedOutboxPath = toProjectPath(projectRoot, outboxPath(projectRoot, input.runId));

  await writeJsonFileAtomic(taskPath, {
    schema_version: "0.1",
    task_id: input.taskId,
    title: `Kairon agent smoke for ${input.agent}`,
    kind: "agent_smoke",
    status: "ready",
    agent: input.agent,
    run_id: input.runId,
    date: input.date,
    objective: "Verify that the configured official CLI can receive a prompt and write the required outbox.",
    instructions: [
      "Do not modify project source files.",
      `Write a valid JSON outbox to ${expectedOutboxPath}.`,
      "Use status=completed when the smoke prompt is understood.",
      "Include a short message.created event that confirms the CLI smoke completed."
    ],
    expected_outbox: {
      path: expectedOutboxPath,
      schema_version: "0.1",
      run_id: input.runId,
      task_id: input.taskId,
      agent: input.agent,
      persona: "smoke",
      status: "completed"
    },
    created_at: input.createdAt
  });
}

function outboxPath(projectRoot: string, runId: string): string {
  return resolveInside(getKaironPaths(projectRoot).runsDir, runId, "outbox.json");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
