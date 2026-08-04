import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue, ApprovalNotPendingError } from "../src/approvals/approval-queue.js";
import {
  APPROVAL_COMMAND_ERROR_EXIT_CODE,
  decideApprovalCommand,
  listApprovalsCommand,
  seedApprovalCommand,
  showApprovalCommand
} from "../src/cli/commands/approval.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  correlationArtifactPath,
  ensureApprovalCorrelation
} from "../src/correlation/store.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  acquireResourceLock,
  releaseResourceLock
} from "../src/core/fs/resource-lock.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { StateApplier } from "../src/state/state-applier.js";
import { createTempProject } from "./test-utils.js";

describe("ApprovalQueue", () => {
  it("lists open approvals by default", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      type: "merge",
      title: "Merge branch",
      created_at: "2026-05-26T01:00:00.000Z"
    });
    await writeApproval(root, {
      id: "APR-0002",
      status: "decided",
      type: "deploy",
      title: "Deploy app",
      created_at: "2026-05-26T00:00:00.000Z"
    });
    await writeApproval(root, {
      id: "APR-0003",
      status: "confirmation_required",
      type: "deploy",
      title: "Confirm deploy",
      created_at: "2026-05-26T02:00:00.000Z",
      confirmation: {
        required_by: "board"
      }
    });

    const approvals = await new ApprovalQueue(root).list();

    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({ id: "APR-0001" });
    await expect(listApprovalsCommand(root)).resolves.toContain("id=APR-0001");
    await expect(listApprovalsCommand(root)).resolves.toContain(
      "id=APR-0003 status=confirmation_required type=deploy confirmation=board"
    );
  });

  it("does not mutate an existing correlation while listing approvals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const approval = {
      id: "APR-LOCKED-CORRELATION",
      status: "pending",
      created_at: "2026-08-04T00:00:00.000Z"
    };
    await writeApproval(root, approval);
    const correlation = await ensureApprovalCorrelation(root, approval);
    const lock = await acquireResourceLock(
      root,
      correlationArtifactPath(root, correlation.correlation_id),
      { owner: "approval-list-read-test" }
    );

    try {
      await expect(new ApprovalQueue(root).list()).resolves.toEqual([
        expect.objectContaining({
          id: approval.id,
          correlation_id: correlation.correlation_id
        })
      ]);
    } finally {
      await releaseResourceLock(lock);
    }
  });

  it("shows sanitized details without raw diff, logs, or secrets", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      type: "git_push",
      title: "Push feature",
      diff: "secret diff content",
      stdout: "full stdout",
      api_token: "token-value",
      nested: {
        password: "password-value",
        body: "long body"
      }
    });

    const text = await showApprovalCommand(root, "APR-0001");

    expect(text).toContain('"diff": "[omitted]"');
    expect(text).toContain('"stdout": "[omitted]"');
    expect(text).toContain('"api_token": "[redacted]"');
    expect(text).toContain('"password": "[redacted]"');
    expect(text).toContain('"body": "[omitted]"');
    expect(text).not.toContain("token-value");
    expect(text).not.toContain("password-value");
  });

  it("applies final decisions and rejects duplicate decisions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      actions: ["approve", "reject", "request_changes"]
    });

    await expect(
      decideApprovalCommand(root, "APR-0001", {
        action: "approve",
        reason: "looks good"
      })
    ).resolves.toContain("status=decided");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "decided",
      decision: "approve",
      reason: "looks good"
    });
    await expect(
      new ApprovalQueue(root).decide({
        approvalId: "APR-0001",
        action: "reject"
      })
    ).rejects.toThrow(ApprovalNotPendingError);
  });

  it("queues approved git push transactions for resume", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeTransaction(root, { transaction_id: "GTX-0001" });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      type: "git_push",
      task_id: "TASK-0001",
      transaction_id: "GTX-0001",
      remote: "origin",
      remote_ref: "auto/TASK-0001/codex",
      expected_head_sha: "commit-sha"
    });

    await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "approve"
    });

    await expect(new WorkQueue(root).list("ready")).resolves.toMatchObject([
      {
        id: "JOB-0001",
        type: "git.transaction",
        task_id: "TASK-0001",
        payload: {
          action: "resume_push",
          approved: true,
          approval_decision: "approve",
          transaction_id: "GTX-0001",
          approval_id: "APR-0001",
          expected_head_sha: "commit-sha",
          remote: "origin",
          remote_ref: "auto/TASK-0001/codex"
        }
      }
    ]);

    await new StateApplier(root).appendEvent({
      type: "approval.decided",
      payload: {
        approval_id: "APR-0001",
        decision: "approve"
      },
      created_at: "2026-05-26T00:01:00.000Z"
    });
    await expect(new WorkQueue(root).list("ready")).resolves.toHaveLength(1);
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "follow-ups",
          "FUP-APR-0001-approve-git-resume_push.json"
        )
      )
    ).resolves.toMatchObject({
      approval_id: "APR-0001",
      action_type: "git.resume_push",
      status: "pending",
      queue_item_type: "git.transaction"
    });
  });

  it("allows local CLI approval for confirmation-required high-risk approvals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeApproval(root, {
      id: "APR-HIGH-LOCAL",
      status: "confirmation_required",
      type: "deploy",
      risk_level: "high",
      actions: ["approve", "reject", "request_changes"],
      confirmation: {
        status: "required",
        action: "approve",
        required_by: "board",
        reason: "board_confirmation_required"
      }
    });

    await expect(
      decideApprovalCommand(root, "APR-HIGH-LOCAL", {
        action: "approve",
        reason: "local re-auth completed"
      })
    ).resolves.toContain("status=decided");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-HIGH-LOCAL.json"))
    ).resolves.toMatchObject({
      status: "decided",
      decision: "approve",
      reason: "local re-auth completed",
      confirmation: {
        status: "confirmed"
      }
    });
  });

  it("records rejected git push approvals on the transaction", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeTransaction(root, { transaction_id: "GTX-0001" });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending",
      type: "git_push",
      transaction_id: "GTX-0001"
    });

    await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "reject",
      reason: "not ready"
    });

    await expect(new WorkQueue(root).list("ready")).resolves.toHaveLength(0);
    await expect(
      readJsonFile(path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"))
    ).resolves.toMatchObject({
      status: "failed",
      push: {
        reason: "push approval reject"
      },
      checks: expect.arrayContaining([
        {
          name: "push_approval",
          status: "failed",
          detail: "decision=reject"
        }
      ])
    });
  });

  it("formats duplicate decisions for CLI output without throwing a stack trace", async () => {
    const root = await createTempProject();
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      await initializeProject({ projectRoot: root });
      await writeApproval(root, {
        id: "APR-0001",
        status: "pending",
        actions: ["approve", "reject", "request_changes"]
      });

      await expect(
        decideApprovalCommand(root, "APR-0001", {
          action: "approve",
          reason: "first decision"
        })
      ).resolves.toContain("status=decided");

      await expect(
        decideApprovalCommand(root, "APR-0001", {
          action: "approve",
          reason: "duplicate"
        })
      ).resolves.toBe(
        [
          "Kairon approval decision rejected.",
          "approval_id=APR-0001",
          "reason=not_pending",
          "status=decided",
          "message=Approval APR-0001 is not pending, snoozed, or confirmation_required. Current status: decided"
        ].join("\n")
      );
      expect(process.exitCode).toBe(APPROVAL_COMMAND_ERROR_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("seeds manual approvals without passing JSON through shell arguments", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const text = await seedApprovalCommand(root, "APR-MANUAL-0001", {
      actions: "approve,reject",
      title: "Manual approval seed",
      redactionFixture: true
    });

    expect(text).toContain("Kairon approval seeded.");
    expect(text).toContain("approval_id=APR-MANUAL-0001");
    expect(text).toContain("actions=approve,reject");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-MANUAL-0001.json"))
    ).resolves.toMatchObject({
      id: "APR-MANUAL-0001",
      status: "pending",
      title: "Manual approval seed",
      actions: ["approve", "reject"],
      diff: "SHOULD_BE_OMITTED",
      stdout: "SHOULD_BE_OMITTED",
      api_token: "SHOULD_BE_REDACTED"
    });
  });

  it("accepts whitespace-separated approval seed actions from PowerShell", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const text = await seedApprovalCommand(root, "APR-MANUAL-0002", {
      actions: "approve reject request_changes snooze"
    });

    expect(text).toContain("Kairon approval seeded.");
    expect(text).toContain("actions=approve,reject,request_changes,snooze");
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-MANUAL-0002.json"))
    ).resolves.toMatchObject({
      id: "APR-MANUAL-0002",
      status: "pending",
      actions: ["approve", "reject", "request_changes", "snooze"]
    });
  });

  it("formats invalid approval seed actions without throwing a stack trace", async () => {
    const root = await createTempProject();
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      await initializeProject({ projectRoot: root });

      await expect(
        seedApprovalCommand(root, "APR-MANUAL-0003", {
          actions: "approve invalid_action"
        })
      ).resolves.toBe(
        [
          "Kairon approval seed rejected.",
          "approval_id=APR-MANUAL-0003",
          "reason=invalid_action",
          "action=invalid_action",
          "message=Invalid approval action: invalid_action. Expected one of: approve, reject, request_changes, snooze."
        ].join("\n")
      );
      expect(process.exitCode).toBe(APPROVAL_COMMAND_ERROR_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("formats action-not-allowed decisions for CLI output", async () => {
    const root = await createTempProject();
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      await initializeProject({ projectRoot: root });
      await seedApprovalCommand(root, "APR-LIMITED-0001", {
        actions: "approve,reject"
      });

      await expect(
        decideApprovalCommand(root, "APR-LIMITED-0001", {
          action: "snooze"
        })
      ).resolves.toBe(
        [
          "Kairon approval decision rejected.",
          "approval_id=APR-LIMITED-0001",
          "reason=action_not_allowed",
          "action=snooze",
          "message=Approval APR-LIMITED-0001 does not allow action: snooze"
        ].join("\n")
      );
      expect(process.exitCode).toBe(APPROVAL_COMMAND_ERROR_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("formats missing approvals for CLI output", async () => {
    const root = await createTempProject();
    const previousExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      await initializeProject({ projectRoot: root });

      await expect(
        decideApprovalCommand(root, "APR-MISSING-0001", {
          action: "approve"
        })
      ).resolves.toBe(
        [
          "Kairon approval decision rejected.",
          "approval_id=APR-MISSING-0001",
          "reason=not_found",
          "message=Approval not found: APR-MISSING-0001"
        ].join("\n")
      );
      expect(process.exitCode).toBe(APPROVAL_COMMAND_ERROR_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("snoozes approvals and allows a later final decision", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new ApprovalQueue(root, {
      now: () => new Date("2026-05-26T07:00:00.000Z")
    });
    await writeApproval(root, {
      id: "APR-0001",
      status: "pending"
    });

    await expect(
      queue.decide({
        approvalId: "APR-0001",
        action: "snooze"
      })
    ).resolves.toMatchObject({
      status: "snoozed"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "snoozed",
      snooze_until: "2026-05-26T08:00:00.000Z"
    });
    await expect(
      queue.decide({
        approvalId: "APR-0001",
        action: "request_changes"
      })
    ).resolves.toMatchObject({
      status: "decided"
    });
  });
});

async function writeApproval(
  root: string,
  approval: Record<string, unknown>
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "approvals", `${approval.id}.json`),
    {
      schema_version: "0.1",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z",
      ...approval
    }
  );
}

async function writeTransaction(
  root: string,
  transaction: Record<string, unknown>
): Promise<void> {
  const transactionId = String(transaction.transaction_id);
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "git", "transactions", `${transactionId}.json`),
    {
      schema_version: "0.1",
      transaction_id: transactionId,
      task_id: "TASK-0001",
      run_id: "RUN-0001",
      review_loop_id: "REV-0001",
      branch: "auto/TASK-0001/codex",
      worktree_path: ".kairon/worktrees/TASK-0001-codex",
      status: "approval_required",
      base_branch: "main",
      base_sha: "base-sha",
      parent_sha: "parent-sha",
      commit_sha: "commit-sha",
      diff_sha256: "diff-sha",
      checks: [],
      push: {
        requested: true,
        allowed: false,
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex",
        pushed: false,
        approval_id: "APR-0001"
      },
      rollback: {
        strategy: "reset_branch_to_parent",
        parent_sha: "parent-sha",
        command_hint: "git reset --hard parent-sha"
      },
      workspace: {
        schema_version: "0.1",
        task_id: "TASK-0001",
        branch: "auto/TASK-0001/codex",
        agent: "codex",
        base_branch: "main",
        base_sha: "base-sha",
        worktree_path: ".kairon/worktrees/TASK-0001-codex",
        status: "active",
        writer_lock: ".kairon/git/locks/branch-auto-TASK-0001-codex.json",
        path_lock: ".kairon/git/locks/path-TASK-0001.json",
        write_paths: ["src/**"],
        created_at: "2026-05-26T00:00:00.000Z"
      },
      transaction_path: `.kairon/git/transactions/${transactionId}.json`,
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:00:00.000Z",
      ...transaction
    }
  );
}
