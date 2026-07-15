import {
  createDryRunApproval,
  formatDryRunApprovalResult,
  parseDryRunCheck,
  type DryRunCheck
} from "../../deploy/dry-run.js";
import {
  buildExecutionPreflight,
  formatExecutionPreflight,
  type ExecutionGuardMode,
  type ExecutionGuardRequest
} from "../../deploy/execution-guard.js";

export type MergeDryRunCommandOptions = {
  candidateId?: string;
  source?: string;
  target?: string;
  commitRange?: string;
  check?: string[];
  rollbackHint?: string;
  reason?: string;
};

export type DeployDryRunCommandOptions = {
  target?: string;
  environment?: string;
  commitRange?: string;
  check?: string[];
  rollbackHint?: string;
  reason?: string;
};

export type ExecutionGuardCommandOptions = {
  dryRunArtifact?: string;
  preflight?: boolean;
  execute?: boolean;
  expectedHeadSha?: string;
  actualHeadSha?: string;
  requiredCheck?: string[];
  approvalId?: string;
  confirm?: string;
};

export async function mergeDryRunCommand(
  projectRoot: string,
  options: MergeDryRunCommandOptions
): Promise<string> {
  const result = await createDryRunApproval(projectRoot, {
    operation: "merge",
    candidateId: options.candidateId,
    sourceBranch: requiredOption(options.source, "--source"),
    targetBranch: requiredOption(options.target, "--target"),
    commitRange: options.commitRange,
    checks: parseChecks(options.check),
    rollbackHint: options.rollbackHint,
    reason: options.reason
  });

  return formatDryRunApprovalResult(result);
}

export async function mergeExecuteCommand(
  projectRoot: string,
  options: ExecutionGuardCommandOptions
): Promise<string> {
  return executeGuardCommand(projectRoot, {
    operation: "merge",
    dryRunArtifact: requiredOption(options.dryRunArtifact, "--dry-run-artifact"),
    mode: resolveGuardMode(options),
    expectedHeadSha: options.expectedHeadSha,
    actualHeadSha: options.actualHeadSha,
    requiredChecks: options.requiredCheck,
    approvalId: options.approvalId,
    confirm: options.confirm
  });
}

export async function deployDryRunCommand(
  projectRoot: string,
  options: DeployDryRunCommandOptions
): Promise<string> {
  const result = await createDryRunApproval(projectRoot, {
    operation: "deploy",
    targetBranch: requiredOption(options.target, "--target"),
    environment: options.environment,
    commitRange: options.commitRange,
    checks: parseChecks(options.check),
    rollbackHint: options.rollbackHint,
    reason: options.reason
  });

  return formatDryRunApprovalResult(result);
}

export async function deployExecuteCommand(
  projectRoot: string,
  options: ExecutionGuardCommandOptions
): Promise<string> {
  return executeGuardCommand(projectRoot, {
    operation: "deploy",
    dryRunArtifact: requiredOption(options.dryRunArtifact, "--dry-run-artifact"),
    mode: resolveGuardMode(options),
    expectedHeadSha: options.expectedHeadSha,
    actualHeadSha: options.actualHeadSha,
    requiredChecks: options.requiredCheck,
    approvalId: options.approvalId,
    confirm: options.confirm
  });
}

function parseChecks(values: string[] | undefined): DryRunCheck[] {
  return (values ?? []).map(parseDryRunCheck);
}

async function executeGuardCommand(
  projectRoot: string,
  request: ExecutionGuardRequest
): Promise<string> {
  const preflight = await buildExecutionPreflight(projectRoot, request);
  return formatExecutionPreflight(preflight);
}

function resolveGuardMode(options: ExecutionGuardCommandOptions): ExecutionGuardMode {
  if (options.execute === true) {
    return "execute";
  }

  return "preflight";
}

function requiredOption(value: string | undefined, optionName: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${optionName} is required`);
  }

  return value;
}
