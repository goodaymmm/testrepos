import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { StateApplier } from "../state/state-applier.js";
import type { GitPolicy, PoliciesConfig } from "../git/workspace-manager.js";

export type DryRunOperation = "merge" | "deploy";
export type DryRunCheckStatus = "passed" | "failed" | "skipped" | "unknown";

export type DryRunCheck = {
  name: string;
  status: DryRunCheckStatus;
  detail?: string;
};

export type DryRunRequiredApproval = {
  type: DryRunOperation;
  required_by: string;
  present: boolean;
};

export type DryRunRequest = {
  operation: DryRunOperation;
  sourceBranch?: string;
  targetBranch: string;
  commitRange?: string;
  environment?: string;
  checks?: DryRunCheck[];
  rollbackHint?: string;
  reason?: string;
};

export type DryRunArtifact = {
  schema_version: string;
  operation: DryRunOperation;
  dry_run: true;
  execution_allowed: false;
  approval_id: string;
  source_branch?: string;
  target_branch: string;
  commit_range?: string;
  environment?: string;
  checks_summary: DryRunCheck[];
  rollback_hint: string;
  required_approvals: DryRunRequiredApproval[];
  policy: {
    protected_branches: string[];
    require_approval_for: string[];
    rollback_strategy: GitPolicy["rollback_strategy"];
  };
  created_at: string;
};

export type DryRunApprovalResult = {
  operation: DryRunOperation;
  dry_run: true;
  execution_allowed: false;
  approval_id: string;
  approval_path: string;
  artifact_path: string;
  event_id: string;
  artifact: DryRunArtifact;
};

export class DryRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DryRunValidationError";
  }
}

export async function createDryRunApproval(
  projectRoot: string,
  request: DryRunRequest
): Promise<DryRunApprovalResult> {
  validateDryRunRequest(request);

  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  const approvalId = await nextId(projectRoot, "approval");
  const createdAt = new Date().toISOString();
  const artifactPath = dryRunArtifactPath(projectRoot, approvalId);
  const artifactRelativePath = toPosixPath(path.relative(projectRoot, artifactPath));
  const approvalPath = toPosixPath(
    path.relative(
      projectRoot,
      resolveInside(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
    )
  );
  const checks = request.checks ?? [];
  const rollbackHint =
    request.rollbackHint ?? defaultRollbackHint(request.operation, request.targetBranch);
  const requiredApprovals = buildRequiredApprovals(
    request.operation,
    policies.git.require_approval_for
  );
  const artifact: DryRunArtifact = {
    schema_version: "0.1",
    operation: request.operation,
    dry_run: true,
    execution_allowed: false,
    approval_id: approvalId,
    source_branch: request.sourceBranch,
    target_branch: request.targetBranch,
    commit_range: request.commitRange,
    environment: request.environment,
    checks_summary: checks,
    rollback_hint: rollbackHint,
    required_approvals: requiredApprovals,
    policy: {
      protected_branches: policies.git.protected_branches,
      require_approval_for: policies.git.require_approval_for,
      rollback_strategy: policies.git.rollback_strategy
    },
    created_at: createdAt
  };

  await writeJsonFileAtomic(artifactPath, artifact);
  const event = await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    actor: "dry-run",
    payload: {
      approval: {
        id: approvalId,
        type: `${request.operation}_dry_run`,
        title: dryRunApprovalTitle(request),
        actions: ["approve", "reject", "request_changes", "snooze"],
        risk_level: "high",
        dry_run: true,
        execution_allowed: false,
        approval_required_for: request.operation,
        operation: request.operation,
        source_branch: request.sourceBranch,
        target_branch: request.targetBranch,
        commit_range: request.commitRange,
        environment: request.environment,
        checks_summary: checks,
        rollback_hint: rollbackHint,
        required_approvals: requiredApprovals,
        artifact_path: artifactRelativePath,
        reason: request.reason,
        confirmation: {
          status: "required",
          action: "approve",
          required_by: "board",
          reason: `${request.operation}_dry_run_high_risk`
        }
      }
    }
  });

  return {
    operation: request.operation,
    dry_run: true,
    execution_allowed: false,
    approval_id: approvalId,
    approval_path: approvalPath,
    artifact_path: artifactRelativePath,
    event_id: event.event_id,
    artifact
  };
}

export function parseDryRunCheck(value: string): DryRunCheck {
  const [rawName, rawStatus, ...detailParts] = value.split(":");
  const name = rawName?.trim();
  const status = rawStatus?.trim() as DryRunCheckStatus | undefined;

  if (!name || !status) {
    throw new DryRunValidationError(
      `Invalid --check value "${value}". Expected name:status[:detail].`
    );
  }

  if (!isDryRunCheckStatus(status)) {
    throw new DryRunValidationError(
      `Invalid --check status "${status}". Use passed, failed, skipped, or unknown.`
    );
  }

  const detail = detailParts.join(":").trim();
  return {
    name,
    status,
    ...(detail ? { detail } : {})
  };
}

export function formatDryRunApprovalResult(result: DryRunApprovalResult): string {
  return [
    `Kairon ${result.operation} dry-run approval created.`,
    `operation=${result.operation}`,
    "dry_run=true",
    "execution_allowed=false",
    `approval_id=${result.approval_id}`,
    `approval_path=${result.approval_path}`,
    `artifact=${result.artifact_path}`,
    `target_branch=${result.artifact.target_branch}`,
    ...(result.artifact.source_branch
      ? [`source_branch=${result.artifact.source_branch}`]
      : []),
    ...(result.artifact.environment
      ? [`environment=${result.artifact.environment}`]
      : []),
    `required_approvals=${formatRequiredApprovals(result.artifact.required_approvals)}`,
    `event_id=${result.event_id}`
  ].join("\n");
}

function validateDryRunRequest(request: DryRunRequest): void {
  if (!request.targetBranch.trim()) {
    throw new DryRunValidationError("target branch is required");
  }

  if (request.operation === "merge" && !request.sourceBranch?.trim()) {
    throw new DryRunValidationError("source branch is required for merge dry-run");
  }
}

function dryRunArtifactPath(projectRoot: string, approvalId: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "deploy",
    "dry-runs",
    `${approvalId}.json`
  );
}

function buildRequiredApprovals(
  operation: DryRunOperation,
  policyApprovalTypes: string[]
): DryRunRequiredApproval[] {
  return [
    {
      type: operation,
      required_by: ".kairon/config/policies.json#git.require_approval_for",
      present: policyApprovalTypes.includes(operation)
    }
  ];
}

function dryRunApprovalTitle(request: DryRunRequest): string {
  if (request.operation === "merge") {
    return `Merge dry-run approval: ${request.sourceBranch} -> ${request.targetBranch}`;
  }

  return `Deploy dry-run approval: ${request.targetBranch} -> ${
    request.environment ?? "unspecified"
  }`;
}

function defaultRollbackHint(
  operation: DryRunOperation,
  targetBranch: string
): string {
  if (operation === "merge") {
    return `If an approved merge later causes issues, revert the merge commit on ${targetBranch}.`;
  }

  return `If an approved deploy later causes issues, redeploy the previous known-good artifact for ${targetBranch}.`;
}

function formatRequiredApprovals(approvals: DryRunRequiredApproval[]): string {
  return approvals
    .map((approval) => `${approval.type}:${approval.present ? "present" : "missing"}`)
    .join(",");
}

function isDryRunCheckStatus(value: string): value is DryRunCheckStatus {
  return ["passed", "failed", "skipped", "unknown"].includes(value);
}
