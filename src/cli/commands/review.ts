import {
  formatReviewLoopExecutionResult,
  ReviewLoopExecutor
} from "../../review/review-loop-executor.js";
import { createAntigravityPtySessionRunner } from "../../agents/pty-session-runner.js";

export type ReviewRunCommandOptions = {
  timeoutMs?: string;
};

export async function runReviewLoopCommand(
  projectRoot: string,
  loopId: string,
  options: ReviewRunCommandOptions = {}
): Promise<string> {
  const timeoutMs =
    options.timeoutMs === undefined
      ? undefined
      : parsePositiveInteger(options.timeoutMs, "--timeout-ms");
  const result = await new ReviewLoopExecutor(projectRoot, {
    interactiveSessionRunner: createAntigravityPtySessionRunner()
  }).run({
    loopId,
    timeoutMs
  });

  return formatReviewLoopExecutionResult(result);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}
