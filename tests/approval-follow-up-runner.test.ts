import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  listApprovalFollowUps,
  recordApprovalFollowUp,
  runApprovalFollowUp,
  showApprovalFollowUp
} from "../src/approvals/follow-up-runner.js";
import {
  listApprovalFollowUpsCommand,
  runApprovalFollowUpCommand,
  showApprovalFollowUpCommand
} from "../src/cli/commands/approval.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { createDryRunApproval } from "../src/deploy/dry-run.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("approval follow-up runner", () => {
  it("lists, shows, and dry-runs sanitized follow-up artifacts", async () => {
    const root = await createInitializedProject();
    const followUp = await recordApprovalFollowUp(root, {
      approval: {
        id: "APR-MANUAL",
        type: "manual_test",
        task_id: "TASK-0001"
      },
      decision: "request_changes",
      decidedAt: "2026-07-13T00:00:00.000Z",
      reason: "token=SHOULD_NOT_LEAK update required"
    });

    await expect(listApprovalFollowUpsCommand(root)).resolves.toContain(
      `id=${followUp.id} status=pending action=approval.rework`
    );
    await expect(
      listApprovalFollowUps(root, { status: "completed" })
    ).resolves.toEqual([]);

    const detail = await showApprovalFollowUpCommand(root, followUp.id);
    expect(detail).toContain("token=[redacted]");
    expect(detail).not.toContain("SHOULD_NOT_LEAK");

    const dryRun = await runApprovalFollowUp(root, followUp.id, {
      dryRun: true
    });
    expect(dryRun).toMatchObject({
      mode: "dry_run",
      status: "planned",
      supported: false,
      readiness: "not_applicable",
      execution_performed: false
    });
    await expect(
      runApprovalFollowUpCommand(root, followUp.id, { dryRun: true })
    ).resolves.toContain("Kairon approval follow-up dry-run.");
    const unchanged = await showApprovalFollowUp(root, followUp.id);
    expect(unchanged.status).toBe("pending");
    expect(unchanged.attempts).toBeUndefined();
  });

  it("enqueues one approved git resume action and reconciles it idempotently", async () => {
    const root = await createInitializedProject();
    const followUp = await recordApprovalFollowUp(root, {
      approval: {
        id: "APR-GIT",
        type: "git_push",
        task_id: "TASK-0001",
        transaction_id: "GTX-0001",
        expected_head_sha: "commit-sha",
        remote: "origin",
        remote_ref: "auto/TASK-0001/codex"
      },
      decision: "approve",
      decidedAt: "2026-07-13T01:00:00.000Z"
    });

    const first = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T01:01:00.000Z")
    });
    expect(first).toMatchObject({
      mode: "execute",
      status: "running",
      supported: true,
      execution_performed: true,
      idempotent: false,
      queue_item_id: "JOB-0001",
      event_id: "EVT-000001"
    });

    const second = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T01:02:00.000Z")
    });
    expect(second).toMatchObject({
      status: "running",
      execution_performed: false,
      queue_item_id: "JOB-0001"
    });
    await expect(new WorkQueue(root).list()).resolves.toHaveLength(1);

    await new WorkQueue(root).fail("JOB-0001", {
      code: "temporary_failure",
      message: "retry after verification"
    });
    const retried = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T01:03:00.000Z")
    });
    expect(retried).toMatchObject({
      status: "running",
      execution_performed: true,
      queue_item_id: "JOB-0002"
    });
    await expect(new WorkQueue(root).list()).resolves.toHaveLength(2);

    await new WorkQueue(root).complete("JOB-0002", {
      transaction_id: "GTX-0001"
    });
    const completed = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T01:04:00.000Z")
    });
    expect(completed.status).toBe("completed");

    const repeated = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T01:05:00.000Z")
    });
    expect(repeated).toMatchObject({
      status: "completed",
      idempotent: true
    });
    await expect(showApprovalFollowUp(root, followUp.id)).resolves.toMatchObject({
      status: "completed",
      attempts: 4,
      queue_item_id: "JOB-0002",
      execution_history: expect.arrayContaining([
        expect.objectContaining({ status: "completed" })
      ])
    });
    const events = await readAllEvents(root, "2026-07-13");
    expect(
      events.filter((event) => event.type === "approval.follow_up.updated")
    ).toHaveLength(4);
  });

  it("runs approved merge dry-run preflight without executing a merge", async () => {
    const root = await createInitializedProject();
    const dryRun = await createDryRunApproval(root, {
      operation: "merge",
      sourceBranch: "codex/t133-follow-up",
      targetBranch: "main",
      checks: [{ name: "build", status: "passed" }],
      rollbackHint: "Revert the merge commit on main."
    });
    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve",
      reason: "approved for preflight"
    });
    const followUpId = `FUP-${dryRun.approval_id}-approve-merge-execute_preflight`;

    const dryRunResult = await runApprovalFollowUp(root, followUpId, {
      dryRun: true
    });
    expect(dryRunResult).toMatchObject({
      supported: true,
      readiness: "passed",
      execution_performed: false,
      details: {
        preflight_status: "passed",
        execution_allowed: false,
        operation: "merge"
      }
    });

    const result = await runApprovalFollowUp(root, followUpId, {
      confirm: followUpId,
      now: () => new Date("2026-07-13T02:00:00.000Z")
    });
    expect(result).toMatchObject({
      status: "completed",
      execution_performed: false,
      details: {
        preflight_status: "passed",
        execution_allowed: false
      }
    });
    await expect(showApprovalFollowUp(root, followUpId)).resolves.toMatchObject({
      approval_type: "merge_dry_run",
      action_type: "merge.execute_preflight",
      status: "completed",
      last_execution: {
        execution_performed: false,
        status: "completed"
      }
    });
  });

  it("requires exact confirmation and records unsupported actions as skipped", async () => {
    const root = await createInitializedProject();
    const followUp = await recordApprovalFollowUp(root, {
      approval: { id: "APR-REWORK", type: "manual_test" },
      decision: "reject",
      decidedAt: "2026-07-13T03:00:00.000Z"
    });

    await expect(
      runApprovalFollowUp(root, followUp.id, { confirm: "FUP-WRONG" })
    ).rejects.toThrow("confirmation does not match");

    const skipped = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id,
      now: () => new Date("2026-07-13T03:01:00.000Z")
    });
    expect(skipped).toMatchObject({
      status: "skipped",
      supported: false,
      readiness: "not_applicable",
      execution_performed: false,
      idempotent: false
    });

    const repeated = await runApprovalFollowUp(root, followUp.id, {
      confirm: followUp.id
    });
    expect(repeated).toMatchObject({
      status: "skipped",
      idempotent: true
    });
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function readAllEvents(
  root: string,
  date: string
): Promise<Array<Record<string, unknown>>> {
  return readJsonLines(path.join(root, ".kairon", "events", `${date}.jsonl`));
}
