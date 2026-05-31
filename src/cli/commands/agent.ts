import {
  formatAgentSmokeResult,
  runAgentSmoke
} from "../../agents/smoke-runner.js";
import { agentCliIdHint } from "../../agents/display.js";
import { createAntigravityPtySessionRunner } from "../../agents/pty-session-runner.js";
import { isAgentId } from "../../agents/types.js";

export type AgentSmokeCommandOptions = {
  agent?: string;
  timeoutMs?: string;
};

export async function runAgentSmokeCommand(
  projectRoot: string,
  options: AgentSmokeCommandOptions
): Promise<string> {
  if (options.agent === undefined || !isAgentId(options.agent)) {
    throw new Error(`Invalid --agent. Use one of: ${agentCliIdHint()}.`);
  }

  const timeoutMs =
    options.timeoutMs === undefined ? undefined : parsePositiveInteger(options.timeoutMs);

  return formatAgentSmokeResult(
    await runAgentSmoke(
      projectRoot,
      {
        agent: options.agent,
        timeoutMs
      },
      {
        interactiveSessionRunner: createAntigravityPtySessionRunner()
      }
    )
  );
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  return parsed;
}
