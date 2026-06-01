import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue, ApprovalNotPendingError } from "../src/approvals/approval-queue.js";
import {
  APPROVAL_COMMAND_ERROR_EXIT_CODE,
  decideApprovalCommand,
  listApprovalsCommand,
  showApprovalCommand
} from "../src/cli/commands/approval.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("ApprovalQueue", () => {
  it("lists pending approvals by default", async () => {
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

    const approvals = await new ApprovalQueue(root).list();

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: "APR-0001" });
    await expect(listApprovalsCommand(root)).resolves.toContain("id=APR-0001");
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
          "message=Approval APR-0001 is not pending or snoozed. Current status: decided"
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
