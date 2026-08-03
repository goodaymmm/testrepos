import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import { WorkQueue } from "../queue/work-queue.js";
import type { GitTransactionRecord } from "./transaction-executor.js";

export type GitPushApprovalDecision = "approve" | "reject" | "request_changes";

export async function handleGitPushApprovalDecision(
  projectRoot: string,
  approval: Record<string, unknown>,
  input: {
    decision: GitPushApprovalDecision;
    decidedAt: string;
  }
): Promise<void> {
  if (!isGitPushApproval(approval)) {
    return;
  }

  const transactionId = readString(approval.transaction_id);
  if (transactionId === undefined) {
    return;
  }

  if (input.decision === "approve") {
    const queue = new WorkQueue(projectRoot);
    const existing = (await queue.list()).find(
      (item) =>
        item.type === "git.transaction" &&
        (item.status === "ready" || item.status === "claimed") &&
        item.payload?.action === "resume_push" &&
        item.payload.approval_id === readString(approval.id)
    );
    if (existing !== undefined) {
      return;
    }

    await queue.enqueue({
      type: "git.transaction",
      priority: 90,
      task_id: readString(approval.task_id),
      payload: {
        action: "resume_push",
        approved: true,
        approval_decision: "approve",
        transaction_id: transactionId,
        approval_id: readString(approval.id),
        expected_head_sha: readString(approval.expected_head_sha),
        remote: readString(approval.remote),
        remote_ref: readString(approval.remote_ref)
      },
      created_at: input.decidedAt
    });
    return;
  }

  const record = await readTransactionRecord(projectRoot, transactionId);
  await writeTransactionRecord(projectRoot, {
    ...record,
    status: "failed",
    push: {
      ...record.push,
      reason: `push approval ${input.decision}`
    },
    pr:
      record.pr === undefined
        ? undefined
        : {
            ...record.pr,
            status: "failed",
            rollback_strategy: record.rollback.strategy,
            rollback_hint: record.rollback.command_hint,
            create_hint: `Do not create a PR until transaction recovery is complete for ${record.branch}.`
          },
    checks: [
      ...record.checks,
      {
        name: "push_approval",
        status: "failed",
        detail: `decision=${input.decision}`
      }
    ],
    updated_at: input.decidedAt
  });
}

function isGitPushApproval(approval: Record<string, unknown>): boolean {
  return approval.type === "git_push" || approval.type === "git_protected_branch_push";
}

async function readTransactionRecord(
  projectRoot: string,
  transactionId: string
): Promise<GitTransactionRecord> {
  return readJsonFile<GitTransactionRecord>(
    resolveInside(
      getKaironPaths(projectRoot).kaironDir,
      "git",
      "transactions",
      `${transactionId}.json`
    )
  );
}

async function writeTransactionRecord(
  projectRoot: string,
  record: GitTransactionRecord
): Promise<void> {
  await writeJsonFileAtomic(resolveInside(projectRoot, record.transaction_path), record);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
