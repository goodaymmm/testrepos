import { AgentDispatcher } from "../../agents/dispatcher.js";
import { isAgentId, type AgentId } from "../../agents/types.js";
import { readJsonFile } from "../../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../../core/fs/paths.js";
import {
  evaluateCapabilityPolicy,
  formatCapabilityDecision
} from "../../policy/trust-policy.js";

export type CapabilityCommandOptions = {
  task?: string;
  agent?: string;
  format?: string;
};

type CapabilityTask = {
  id: string;
  persona: string;
  capabilities?: string[];
  tags?: string[];
};

export async function evaluateCapabilityCommand(
  projectRoot: string,
  options: CapabilityCommandOptions
): Promise<string> {
  return runCapabilityCommand(projectRoot, options, false);
}

export async function explainCapabilityCommand(
  projectRoot: string,
  options: CapabilityCommandOptions
): Promise<string> {
  return runCapabilityCommand(projectRoot, options, true);
}

async function runCapabilityCommand(
  projectRoot: string,
  options: CapabilityCommandOptions,
  explain: boolean
): Promise<string> {
  const taskId = parseTaskId(options.task);
  const task = await readJsonFile<CapabilityTask>(
    resolveInside(getKaironPaths(projectRoot).tasksDir, taskId, "task.json")
  );
  const agent =
    options.agent === undefined
      ? (
          await new AgentDispatcher(projectRoot).decide({
            taskId,
            persona: task.persona,
            requiredCapabilities: task.capabilities,
            tags: task.tags,
            allowInteractiveAgents: true,
            persistProviderHealth: false
          })
        ).agent
      : parseAgent(options.agent);
  const decision = await evaluateCapabilityPolicy(projectRoot, {
    taskId,
    persona: task.persona,
    agent,
    requestedCapabilities: task.capabilities ?? []
  });

  return formatCapabilityDecision(decision, {
    explain,
    format: parseFormat(options.format)
  });
}

function parseTaskId(value: string | undefined): string {
  if (value === undefined || !/^TASK-\d{4}$/u.test(value)) {
    throw new Error("--task must use the TASK-0001 format.");
  }
  return value;
}

function parseAgent(value: string): AgentId {
  if (!isAgentId(value)) {
    throw new Error(`Unsupported agent: ${value}.`);
  }
  return value;
}

function parseFormat(value: string | undefined): "text" | "json" {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error("--format must be text or json.");
}
