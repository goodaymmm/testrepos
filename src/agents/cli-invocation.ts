import type { CliInvocation } from "./command-runner.js";
import type { AgentId } from "./types.js";

export type AgentCliInvocationRequest = {
  agent: AgentId;
  command: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
};

const runPrompt =
  "Execute the Kairon run described in the prompt. Produce the required outbox.";

export function buildAgentCliInvocation(
  request: AgentCliInvocationRequest
): CliInvocation {
  if (request.agent === "codex") {
    return {
      command: request.command,
      args: ["exec", "--json", "--sandbox", "workspace-write", "-"],
      cwd: request.cwd,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs
    };
  }

  if (request.agent === "claude") {
    return {
      command: request.command,
      args: ["-p", request.prompt, "--output-format", "stream-json"],
      cwd: request.cwd,
      timeoutMs: request.timeoutMs
    };
  }

  return {
    command: request.command,
    args: ["--sandbox", "--print", `${runPrompt}\n\n${request.prompt}`],
    cwd: request.cwd,
    timeoutMs: request.timeoutMs
  };
}
