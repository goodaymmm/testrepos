import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { ApprovalRecord } from "../approvals/approval-queue.js";
import {
  computeDeployInputDigest,
  type DryRunArtifact,
  type DryRunOperation
} from "./dry-run.js";
import { loadDeployPolicy, validateDeployPolicySelection } from "./policy.js";

export type ExecutionGuardMode = "preflight" | "execute";
export type ExecutionGuardStatus = "passed" | "failed";
export type ExecutionGuardCheckStatus = "passed" | "failed" | "skipped";

export type ExecutionGuardRequest = {
  operation: DryRunOperation;
  dryRunArtifact: string;
  mode?: ExecutionGuardMode;
  expectedHeadSha?: string;
  actualHeadSha?: string;
  requiredChecks?: string[];
  approvalId?: string;
  confirm?: string;
  provider?: string;
};

export type ExecutionGuardCheck = {
  name: string;
  status: ExecutionGuardCheckStatus;
  detail: string;
};

export type ExecutionGuardPreflight = {
  schema_version: "0.1";
  operation: DryRunOperation;
  mode: ExecutionGuardMode;
  status: ExecutionGuardStatus;
  execution_allowed: boolean;
  dry_run_artifact_path: string;
  approval_id: string;
  target_branch: string;
  source_branch?: string;
  environment?: string;
  provider?: string;
  input_digest?: string;
  expected_head_sha?: string;
  actual_head_sha?: string;
  required_checks: string[];
  rollback_plan: string;
  checks: ExecutionGuardCheck[];
  next_action: string;
};

export class ExecutionGuardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionGuardValidationError";
  }
}

export async function buildExecutionPreflight(
  projectRoot: string,
  request: ExecutionGuardRequest,
  options: { commandRunner?: CommandRunner } = {}
): Promise<ExecutionGuardPreflight> {
  const { artifactPath, artifact } = await loadExecutionDryRunArtifact(
    projectRoot,
    request.dryRunArtifact,
    request.operation
  );

  const approval = await readApprovalRecord(projectRoot, artifact.approval_id);
  const deployPolicy =
    request.operation === "deploy" ? await loadDeployPolicy(projectRoot) : undefined;
  const actualHeadSha =
    request.actualHeadSha ??
    (request.expectedHeadSha === undefined
      ? undefined
      : await readHeadSha(projectRoot, artifact.target_branch, options.commandRunner));
  const requiredChecks = normalizeRequiredChecks(request.requiredChecks);
  const checks = [
    approvalCheck(artifact, approval, request.approvalId),
    approvalDecisionCheck(approval),
    approvalReauthenticationCheck(request, approval),
    requiredApprovalsCheck(artifact),
    deployProviderCheck(request, artifact, deployPolicy),
    deployInputDigestCheck(request, artifact),
    requiredDryRunChecksCheck(artifact, requiredChecks),
    headShaCheck(request.expectedHeadSha, actualHeadSha),
    rollbackPlanCheck(artifact),
    executionConfirmationCheck(request, artifact)
  ];
  const status = checks.every((check) => check.status !== "failed")
    ? "passed"
    : "failed";
  const executionAllowed =
    request.operation === "deploy" &&
    request.mode === "execute" &&
    status === "passed";

  return {
    schema_version: "0.1",
    operation: request.operation,
    mode: request.mode ?? "preflight",
    status,
    execution_allowed: executionAllowed,
    dry_run_artifact_path: toProjectPath(projectRoot, artifactPath),
    approval_id: artifact.approval_id,
    target_branch: artifact.target_branch,
    source_branch: artifact.source_branch,
    environment: artifact.environment,
    provider: artifact.provider,
    input_digest: artifact.input_digest,
    expected_head_sha: request.expectedHeadSha,
    actual_head_sha: actualHeadSha,
    required_checks: requiredChecks,
    rollback_plan: artifact.rollback_hint,
    checks,
    next_action:
      executionAllowed
        ? "Execute the selected deploy provider once and persist the execution artifact."
        : status === "passed"
          ? "Preflight passed; use explicit execute mode and exact confirmation to continue."
        : "Resolve failed preflight checks before requesting execution."
  };
}

export function formatExecutionPreflight(result: ExecutionGuardPreflight): string {
  const header =
    result.mode === "execute"
      ? result.execution_allowed
        ? `Kairon ${result.operation} execution authorized.`
        : `Kairon ${result.operation} execution rejected.`
      : `Kairon ${result.operation} execution preflight.`;
  const reason =
    result.mode === "execute"
      ? [
          result.execution_allowed
            ? "reason=provider_execution_authorized"
            : result.status === "passed"
              ? "reason=execution_not_implemented"
              : "reason=preflight_failed"
        ]
      : [];

  return [
    header,
    `operation=${result.operation}`,
    `mode=${result.mode}`,
    `preflight.status=${result.status}`,
    `execution_allowed=${result.execution_allowed}`,
    ...reason,
    `dry_run_artifact=${result.dry_run_artifact_path}`,
    `approval_id=${result.approval_id}`,
    `target_branch=${result.target_branch}`,
    ...(result.source_branch === undefined
      ? []
      : [`source_branch=${result.source_branch}`]),
    ...(result.environment === undefined ? [] : [`environment=${result.environment}`]),
    ...(result.provider === undefined ? [] : [`provider=${result.provider}`]),
    ...(result.input_digest === undefined
      ? []
      : [`input_digest=${result.input_digest}`]),
    `expected_head_sha=${result.expected_head_sha ?? "not_provided"}`,
    `actual_head_sha=${result.actual_head_sha ?? "not_checked"}`,
    `required_checks=${result.required_checks.length === 0 ? "none" : result.required_checks.join(",")}`,
    `rollback_plan=${sanitizeGuardDetail(result.rollback_plan)}`,
    ...result.checks.map(
      (check) =>
        `check.${check.name}=${check.status} ${sanitizeGuardDetail(check.detail)}`
    ),
    `next_action=${result.next_action}`
  ].join("\n");
}

export async function loadExecutionDryRunArtifact(
  projectRoot: string,
  value: string,
  operation: DryRunOperation
): Promise<{ artifactPath: string; artifact: DryRunArtifact }> {
  const artifactPath = resolveDryRunArtifactPath(projectRoot, value);
  const artifact = await readJsonFile<DryRunArtifact>(artifactPath);
  assertArtifactMatchesRequest(artifact, operation);
  return { artifactPath, artifact };
}

function resolveDryRunArtifactPath(projectRoot: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ExecutionGuardValidationError("--dry-run-artifact is required");
  }

  if (
    trimmed.endsWith(".json") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return resolveInside(projectRoot, trimmed);
  }

  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "deploy",
    "dry-runs",
    `${trimmed}.json`
  );
}

function assertArtifactMatchesRequest(
  artifact: DryRunArtifact,
  operation: DryRunOperation
): void {
  if (artifact.schema_version !== "0.1" || artifact.dry_run !== true) {
    throw new ExecutionGuardValidationError("dry-run artifact is invalid");
  }

  if (artifact.operation !== operation) {
    throw new ExecutionGuardValidationError(
      `dry-run artifact operation mismatch: expected ${operation}, got ${artifact.operation}`
    );
  }

  if (artifact.execution_allowed !== false) {
    throw new ExecutionGuardValidationError("dry-run artifact must not allow execution");
  }
}

async function readApprovalRecord(
  projectRoot: string,
  approvalId: string
): Promise<ApprovalRecord | null> {
  try {
    return await readJsonFile<ApprovalRecord>(
      resolveInside(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function readHeadSha(
  projectRoot: string,
  ref: string,
  commandRunner: CommandRunner = spawnCommandRunner
): Promise<string | undefined> {
  const result = await commandRunner({
    command: "git",
    args: ["rev-parse", ref],
    cwd: projectRoot,
    timeoutMs: 10_000
  });

  if (result.exitCode !== 0 || result.timedOut) {
    return undefined;
  }

  return firstLine(result.stdout);
}

function approvalCheck(
  artifact: DryRunArtifact,
  approval: ApprovalRecord | null,
  requestedApprovalId: string | undefined
): ExecutionGuardCheck {
  if (approval === null) {
    return {
      name: "approval_record",
      status: "failed",
      detail: `missing approval ${artifact.approval_id}`
    };
  }

  if (approval.id !== artifact.approval_id) {
    return {
      name: "approval_record",
      status: "failed",
      detail: `approval id mismatch: artifact=${artifact.approval_id} record=${approval.id}`
    };
  }

  if (
    requestedApprovalId !== undefined &&
    requestedApprovalId !== artifact.approval_id
  ) {
    return {
      name: "approval_record",
      status: "failed",
      detail: `requested approval ${requestedApprovalId} does not match artifact ${artifact.approval_id}`
    };
  }

  const expectedType = `${artifact.operation}_dry_run`;
  if (approval.type !== expectedType) {
    return {
      name: "approval_record",
      status: "failed",
      detail: `approval type ${approval.type ?? "missing"} is not ${expectedType}`
    };
  }

  return {
    name: "approval_record",
    status: "passed",
    detail: `found ${artifact.approval_id}`
  };
}

function approvalDecisionCheck(
  approval: ApprovalRecord | null
): ExecutionGuardCheck {
  if (approval === null) {
    return {
      name: "approval_decision",
      status: "failed",
      detail: "approval record is missing"
    };
  }

  if (approval.status !== "decided" || approval.decision !== "approve") {
    return {
      name: "approval_decision",
      status: "failed",
      detail: `status=${approval.status} decision=${String(approval.decision ?? "none")}`
    };
  }

  return {
    name: "approval_decision",
    status: "passed",
    detail: "decision=approve"
  };
}

function approvalReauthenticationCheck(
  request: ExecutionGuardRequest,
  approval: ApprovalRecord | null
): ExecutionGuardCheck {
  if (request.operation !== "deploy") {
    return {
      name: "local_reauthentication",
      status: "skipped",
      detail: "not required for merge preflight"
    };
  }
  if (approval === null) {
    return {
      name: "local_reauthentication",
      status: "failed",
      detail: "approval record is missing"
    };
  }
  const confirmation = isRecord(approval.confirmation)
    ? approval.confirmation
    : undefined;
  const decidedBy = isRecord(approval.decided_by) ? approval.decided_by : undefined;
  if (
    confirmation?.status !== "confirmed" ||
    decidedBy?.source !== "local-cli"
  ) {
    return {
      name: "local_reauthentication",
      status: "failed",
      detail: `confirmation=${String(confirmation?.status ?? "missing")} source=${String(decidedBy?.source ?? "missing")}`
    };
  }
  return {
    name: "local_reauthentication",
    status: "passed",
    detail: "confirmed through local-cli"
  };
}

function deployProviderCheck(
  request: ExecutionGuardRequest,
  artifact: DryRunArtifact,
  policy: Awaited<ReturnType<typeof loadDeployPolicy>> | undefined
): ExecutionGuardCheck {
  if (request.operation !== "deploy") {
    return {
      name: "deploy_provider_policy",
      status: "skipped",
      detail: "not a deploy operation"
    };
  }
  if (artifact.provider === undefined || artifact.environment === undefined) {
    return {
      name: "deploy_provider_policy",
      status: request.mode === "execute" ? "failed" : "skipped",
      detail: "legacy artifact has no provider binding"
    };
  }
  if (request.provider !== undefined && request.provider !== artifact.provider) {
    return {
      name: "deploy_provider_policy",
      status: "failed",
      detail: `provider mismatch: artifact=${artifact.provider} requested=${request.provider}`
    };
  }
  const errors = validateDeployPolicySelection(
    policy!,
    artifact.provider,
    artifact.environment
  );
  return errors.length === 0
    ? {
        name: "deploy_provider_policy",
        status: "passed",
        detail: `provider=${artifact.provider} environment=${artifact.environment}`
      }
    : {
        name: "deploy_provider_policy",
        status: "failed",
        detail: errors.join("; ")
      };
}

function deployInputDigestCheck(
  request: ExecutionGuardRequest,
  artifact: DryRunArtifact
): ExecutionGuardCheck {
  if (request.operation !== "deploy") {
    return {
      name: "deploy_input_digest",
      status: "skipped",
      detail: "not a deploy operation"
    };
  }
  if (
    artifact.provider === undefined ||
    artifact.environment === undefined ||
    artifact.input_digest === undefined ||
    artifact.approval_binding === undefined
  ) {
    return {
      name: "deploy_input_digest",
      status: request.mode === "execute" ? "failed" : "skipped",
      detail: "legacy artifact has no digest binding"
    };
  }
  const expected = computeDeployInputDigest({
    targetBranch: artifact.target_branch,
    environment: artifact.environment,
    provider: artifact.provider,
    commitRange: artifact.commit_range
  });
  const binding = artifact.approval_binding;
  const valid =
    artifact.input_digest === expected &&
    binding.input_digest === expected &&
    binding.approval_id === artifact.approval_id &&
    binding.provider === artifact.provider &&
    binding.environment === artifact.environment;
  return valid
    ? {
        name: "deploy_input_digest",
        status: "passed",
        detail: expected
      }
    : {
        name: "deploy_input_digest",
        status: "failed",
        detail: "artifact input or approval binding changed after dry-run"
      };
}

function requiredApprovalsCheck(artifact: DryRunArtifact): ExecutionGuardCheck {
  const missing = artifact.required_approvals
    .filter((approval) => !approval.present)
    .map((approval) => approval.type);

  return missing.length === 0
    ? {
        name: "required_approvals",
        status: "passed",
        detail: artifact.required_approvals
          .map((approval) => `${approval.type}:present`)
          .join(",")
      }
    : {
        name: "required_approvals",
        status: "failed",
        detail: `missing=${missing.join(",")}`
      };
}

function requiredDryRunChecksCheck(
  artifact: DryRunArtifact,
  requiredChecks: string[]
): ExecutionGuardCheck {
  const checks = new Map(
    artifact.checks_summary.map((check) => [check.name, check.status])
  );
  const required = requiredChecks.length === 0
    ? artifact.checks_summary.map((check) => check.name)
    : requiredChecks;
  const failed = required.filter((name) => checks.get(name) !== "passed");

  if (required.length === 0) {
    return {
      name: "required_checks",
      status: "skipped",
      detail: "no dry-run checks recorded"
    };
  }

  return failed.length === 0
    ? {
        name: "required_checks",
        status: "passed",
        detail: required.map((name) => `${name}:passed`).join(",")
      }
    : {
        name: "required_checks",
        status: "failed",
        detail: `not_passed=${failed.join(",")}`
      };
}

function headShaCheck(
  expectedHeadSha: string | undefined,
  actualHeadSha: string | undefined
): ExecutionGuardCheck {
  if (expectedHeadSha === undefined) {
    return {
      name: "expected_head_sha",
      status: "skipped",
      detail: "not_provided"
    };
  }

  if (actualHeadSha === undefined) {
    return {
      name: "expected_head_sha",
      status: "failed",
      detail: `expected=${expectedHeadSha} actual=unresolved`
    };
  }

  return expectedHeadSha === actualHeadSha
    ? {
        name: "expected_head_sha",
        status: "passed",
        detail: `expected=${expectedHeadSha} actual=${actualHeadSha}`
      }
    : {
        name: "expected_head_sha",
        status: "failed",
        detail: `expected=${expectedHeadSha} actual=${actualHeadSha}`
      };
}

function rollbackPlanCheck(artifact: DryRunArtifact): ExecutionGuardCheck {
  const rollbackHint = artifact.rollback_hint.trim();
  if (rollbackHint.length === 0) {
    return {
      name: "rollback_plan",
      status: "failed",
      detail: "rollback_hint missing"
    };
  }

  return {
    name: "rollback_plan",
    status: "passed",
    detail: rollbackHint
  };
}

function executionConfirmationCheck(
  request: ExecutionGuardRequest,
  artifact: DryRunArtifact
): ExecutionGuardCheck {
  if (request.mode !== "execute") {
    return {
      name: "local_confirmation",
      status: "skipped",
      detail: "preflight only"
    };
  }

  const expected =
    artifact.operation === "deploy"
      ? artifact.approval_id
      : `EXECUTE ${artifact.operation.toUpperCase()} ${artifact.approval_id}`;
  if (request.confirm !== expected) {
    return {
      name: "local_confirmation",
      status: "failed",
      detail: `expected confirmation phrase: ${expected}`
    };
  }

  return {
    name: "local_confirmation",
    status: "passed",
    detail: "confirmed"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeGuardDetail(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]"
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function normalizeRequiredChecks(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/)[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
