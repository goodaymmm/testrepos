import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type ApprovalFollowUpDecision =
  | "approve"
  | "reject"
  | "request_changes"
  | "snooze";

export type ApprovalFollowUpStatus = "pending" | "snoozed" | "not_required";

export type ApprovalFollowUpArtifact = {
  schema_version: "0.1";
  artifact_kind: "approval_follow_up";
  id: string;
  idempotency_key: string;
  approval_id: string;
  approval_type?: string;
  decision: ApprovalFollowUpDecision;
  action_type: string;
  status: ApprovalFollowUpStatus;
  risk_level: "high" | "medium" | "low";
  task_id?: string;
  run_id?: string;
  transaction_id?: string;
  queue_item_type?: string;
  queue_payload_preview?: Record<string, unknown>;
  command_hint: string;
  reason?: string;
  due_at?: string;
  source_approval_path: string;
  created_at: string;
  updated_at: string;
};

export type RecordApprovalFollowUpInput = {
  approval: Record<string, unknown>;
  decision: ApprovalFollowUpDecision;
  decidedAt: string;
  reason?: string;
  dueAt?: string;
};

type ApprovalFollowUpPlan = {
  action_type: string;
  status: ApprovalFollowUpStatus;
  risk_level: "high" | "medium" | "low";
  queue_item_type?: string;
  queue_payload_preview?: Record<string, unknown>;
  command_hint: string;
};

export async function recordApprovalFollowUp(
  projectRoot: string,
  input: RecordApprovalFollowUpInput
): Promise<ApprovalFollowUpArtifact> {
  const approvalId = readString(input.approval.id ?? input.approval.approval_id);
  if (approvalId === undefined) {
    throw new Error("Approval follow-up requires approval id.");
  }

  const approvalType = readString(input.approval.type);
  const plan = planApprovalFollowUp(input.approval, input.decision);
  const idempotencyKey = `${approvalId}:${input.decision}:${plan.action_type}`;
  const id = `FUP-${safeId(approvalId)}-${safeId(input.decision)}-${safeId(plan.action_type)}`;
  const followUpPath = approvalFollowUpPath(projectRoot, id);
  const existing = await readExistingFollowUp(followUpPath);
  const createdAt = existing?.created_at ?? input.decidedAt;
  const artifact: ApprovalFollowUpArtifact = {
    schema_version: "0.1",
    artifact_kind: "approval_follow_up",
    id,
    idempotency_key: idempotencyKey,
    approval_id: approvalId,
    approval_type: approvalType,
    decision: input.decision,
    action_type: plan.action_type,
    status: plan.status,
    risk_level: plan.risk_level,
    task_id: readString(input.approval.task_id),
    run_id: readString(input.approval.run_id),
    transaction_id: readString(input.approval.transaction_id),
    queue_item_type: plan.queue_item_type,
    queue_payload_preview: sanitizeMetadata(plan.queue_payload_preview),
    command_hint: sanitizeInline(plan.command_hint),
    reason: sanitizeOptional(input.reason ?? readString(input.approval.reason)),
    due_at: input.dueAt,
    source_approval_path: toProjectPath(
      projectRoot,
      path.join(getKaironPaths(projectRoot).approvalsDir, `${approvalId}.json`)
    ),
    created_at: createdAt,
    updated_at: input.decidedAt
  };

  await writeJsonFileAtomic(followUpPath, artifact);
  return artifact;
}

export async function listApprovalFollowUps(
  projectRoot: string
): Promise<ApprovalFollowUpArtifact[]> {
  const dir = approvalFollowUpsDir(projectRoot);
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJsonFile<ApprovalFollowUpArtifact>(resolveInside(dir, entry)))
  );

  return artifacts
    .filter((artifact) => artifact.artifact_kind === "approval_follow_up")
    .sort(compareFollowUpsDesc);
}

export function approvalFollowUpsDir(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "follow-ups");
}

function approvalFollowUpPath(projectRoot: string, followUpId: string): string {
  return resolveInside(approvalFollowUpsDir(projectRoot), `${followUpId}.json`);
}

async function readExistingFollowUp(
  followUpPath: string
): Promise<ApprovalFollowUpArtifact | null> {
  try {
    return await readJsonFile<ApprovalFollowUpArtifact>(followUpPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }

    throw error;
  }
}

function planApprovalFollowUp(
  approval: Record<string, unknown>,
  decision: ApprovalFollowUpDecision
): ApprovalFollowUpPlan {
  const approvalType = readString(approval.type);

  if (decision === "snooze") {
    return {
      action_type: "approval.revisit",
      status: "snoozed",
      risk_level: "low",
      command_hint: "Review the approval again after snooze_until."
    };
  }

  if (decision === "approve" && isGitPushApproval(approvalType)) {
    const transactionId = readString(approval.transaction_id);
    return {
      action_type: "git.resume_push",
      status: "pending",
      risk_level: "high",
      queue_item_type: "git.transaction",
      queue_payload_preview: {
        action: "resume_push",
        transaction_id: transactionId,
        approval_id: readString(approval.id),
        expected_head_sha: readString(approval.expected_head_sha),
        remote: readString(approval.remote),
        remote_ref: readString(approval.remote_ref)
      },
      command_hint:
        transactionId === undefined
          ? "Inspect the git push approval before resuming the transaction."
          : `Resume approved git transaction ${transactionId} through the runtime queue.`
    };
  }

  if (decision === "approve" && approvalType === "merge") {
    return {
      action_type: "merge.execute_preflight",
      status: "pending",
      risk_level: "high",
      command_hint: "Run merge execution preflight before any merge operation."
    };
  }

  if (decision === "approve" && approvalType === "deploy") {
    return {
      action_type: "deploy.execute_preflight",
      status: "pending",
      risk_level: "high",
      command_hint: "Run deploy execution preflight before any deployment operation."
    };
  }

  if (decision === "reject" || decision === "request_changes") {
    return {
      action_type: "approval.rework",
      status: "pending",
      risk_level: "medium",
      command_hint: "Notify the requester, update the related task, and keep dangerous execution blocked."
    };
  }

  return {
    action_type: "approval.review_next_action",
    status: "pending",
    risk_level: "low",
    command_hint: "Review the approval result and decide the next manual action."
  };
}

function isGitPushApproval(approvalType: string | undefined): boolean {
  return approvalType === "git_push" || approvalType === "git_protected_branch_push";
}

function compareFollowUpsDesc(
  left: ApprovalFollowUpArtifact,
  right: ApprovalFollowUpArtifact
): number {
  return Date.parse(right.updated_at) - Date.parse(left.updated_at);
}

function sanitizeMetadata(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries = Object.entries(value)
    .filter(([, raw]) => raw !== undefined)
    .map(([key, raw]) => [
      key,
      secretKeyPattern.test(key)
        ? "[redacted]"
        : typeof raw === "string"
          ? sanitizeInline(raw)
          : raw
    ]);
  return Object.fromEntries(entries);
}

function sanitizeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeInline(value);
}

function sanitizeInline(value: string): string {
  const collapsed = value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 237)}...`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

const secretKeyPattern = /(secret|token|password|api[_-]?key|authorization|cookie|credential)/iu;
