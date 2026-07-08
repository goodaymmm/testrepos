import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  deployExecuteCommand,
  mergeExecuteCommand
} from "../src/cli/commands/deploy.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { createDryRunApproval } from "../src/deploy/dry-run.js";
import { buildExecutionPreflight } from "../src/deploy/execution-guard.js";
import { createTempProject } from "./test-utils.js";

describe("merge/deploy execution guardrails", () => {
  it("builds a passing merge preflight from an approved dry-run artifact", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dryRun = await createDryRunApproval(root, {
      operation: "merge",
      sourceBranch: "codex/t127-merge",
      targetBranch: "main",
      commitRange: "main..codex/t127-merge",
      checks: [{ name: "build", status: "passed" }],
      rollbackHint: "Revert the merge commit on main."
    });

    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve",
      reason: "preflight test"
    });

    const preflight = await buildExecutionPreflight(root, {
      operation: "merge",
      dryRunArtifact: dryRun.approval_id,
      approvalId: dryRun.approval_id,
      expectedHeadSha: "target-sha",
      actualHeadSha: "target-sha",
      requiredChecks: ["build"]
    });

    expect(preflight).toMatchObject({
      operation: "merge",
      status: "passed",
      execution_allowed: false,
      approval_id: dryRun.approval_id,
      expected_head_sha: "target-sha",
      actual_head_sha: "target-sha",
      rollback_plan: "Revert the merge commit on main."
    });
    expect(preflight.checks).toEqual(
      expect.arrayContaining([
        {
          name: "approval_decision",
          status: "passed",
          detail: "decision=approve"
        },
        {
          name: "required_checks",
          status: "passed",
          detail: "build:passed"
        }
      ])
    );

    const text = await mergeExecuteCommand(root, {
      dryRunArtifact: dryRun.approval_id,
      approvalId: dryRun.approval_id,
      expectedHeadSha: "target-sha",
      actualHeadSha: "target-sha",
      requiredCheck: ["build"]
    });

    expect(text).toContain("Kairon merge execution preflight.");
    expect(text).toContain("preflight.status=passed");
    expect(text).toContain("execution_allowed=false");
    expect(text).toContain("check.expected_head_sha=passed");
  });

  it("fails preflight when the observed target head does not match the expected SHA", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dryRun = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "staging",
      checks: [{ name: "smoke", status: "passed" }]
    });
    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve"
    });

    const preflight = await buildExecutionPreflight(root, {
      operation: "deploy",
      dryRunArtifact: dryRun.artifact_path,
      expectedHeadSha: "expected-sha",
      actualHeadSha: "actual-sha",
      requiredChecks: ["smoke"]
    });

    expect(preflight.status).toBe("failed");
    expect(preflight.checks).toEqual(
      expect.arrayContaining([
        {
          name: "expected_head_sha",
          status: "failed",
          detail: "expected=expected-sha actual=actual-sha"
        }
      ])
    );
  });

  it("fails preflight when the dry-run approval record is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dryRun = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "production",
      checks: [{ name: "release", status: "passed" }]
    });
    await rm(path.join(root, ".kairon", "approvals", `${dryRun.approval_id}.json`));

    const text = await deployExecuteCommand(root, {
      dryRunArtifact: dryRun.approval_id,
      expectedHeadSha: "target-sha",
      actualHeadSha: "target-sha",
      requiredCheck: ["release"]
    });

    expect(text).toContain("preflight.status=failed");
    expect(text).toContain(`check.approval_record=failed missing approval ${dryRun.approval_id}`);
    expect(text).toContain("check.approval_decision=failed approval record is missing");
  });

  it("keeps execute mode explicitly rejected even after all preflight checks pass", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dryRun = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "production",
      checks: [{ name: "release", status: "passed" }],
      rollbackHint: "Redeploy the previous production artifact."
    });
    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve"
    });

    const text = await deployExecuteCommand(root, {
      dryRunArtifact: dryRun.approval_id,
      execute: true,
      approvalId: dryRun.approval_id,
      expectedHeadSha: "target-sha",
      actualHeadSha: "target-sha",
      requiredCheck: ["release"],
      confirm: `EXECUTE DEPLOY ${dryRun.approval_id}`
    });

    expect(text).toContain("Kairon deploy execution rejected.");
    expect(text).toContain("mode=execute");
    expect(text).toContain("preflight.status=passed");
    expect(text).toContain("reason=execution_not_implemented");
    expect(text).toContain("execution_allowed=false");
  });
});
