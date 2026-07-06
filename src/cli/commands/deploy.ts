import {
  createDryRunApproval,
  formatDryRunApprovalResult,
  parseDryRunCheck,
  type DryRunCheck
} from "../../deploy/dry-run.js";

export type MergeDryRunCommandOptions = {
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

export async function mergeDryRunCommand(
  projectRoot: string,
  options: MergeDryRunCommandOptions
): Promise<string> {
  const result = await createDryRunApproval(projectRoot, {
    operation: "merge",
    sourceBranch: requiredOption(options.source, "--source"),
    targetBranch: requiredOption(options.target, "--target"),
    commitRange: options.commitRange,
    checks: parseChecks(options.check),
    rollbackHint: options.rollbackHint,
    reason: options.reason
  });

  return formatDryRunApprovalResult(result);
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

function parseChecks(values: string[] | undefined): DryRunCheck[] {
  return (values ?? []).map(parseDryRunCheck);
}

function requiredOption(value: string | undefined, optionName: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${optionName} is required`);
  }

  return value;
}
