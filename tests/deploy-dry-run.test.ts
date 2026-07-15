import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  deployDryRunCommand,
  mergeDryRunCommand
} from "../src/cli/commands/deploy.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createDryRunApproval, parseDryRunCheck } from "../src/deploy/dry-run.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("merge/deploy dry-run approvals", () => {
  it("creates a merge dry-run artifact and high-risk approval without executing merge work", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const text = await mergeDryRunCommand(root, {
      candidateId: "GTX-0111",
      source: "codex/t111-merge",
      target: "main",
      commitRange: "main..codex/t111-merge",
      check: ["build:passed", "unit:unknown:manual pending"],
      rollbackHint: "Revert the merge commit on main.",
      reason: "operation test"
    });

    expect(text).toContain("Kairon merge dry-run approval created.");
    expect(text).toContain("dry_run=true");
    expect(text).toContain("execution_allowed=false");
    expect(text).toContain("required_approvals=merge:present");
    expect(text).toContain("candidate_id=GTX-0111");

    const approval = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "approvals", "APR-0001.json")
    );
    const artifact = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "deploy", "dry-runs", "APR-0001.json")
    );

    expect(approval).toMatchObject({
      id: "APR-0001",
      status: "pending",
      type: "merge_dry_run",
      risk_level: "high",
      dry_run: true,
      execution_allowed: false,
      approval_required_for: "merge",
      candidate_id: "GTX-0111",
      transaction_id: "GTX-0111",
      source_branch: "codex/t111-merge",
      target_branch: "main"
    });
    expect(approval.confirmation).toMatchObject({
      status: "required",
      action: "approve",
      required_by: "board"
    });
    expect(artifact).toMatchObject({
      schema_version: "0.1",
      operation: "merge",
      dry_run: true,
      execution_allowed: false,
      approval_id: "APR-0001",
      candidate_id: "GTX-0111",
      source_branch: "codex/t111-merge",
      target_branch: "main",
      commit_range: "main..codex/t111-merge",
      rollback_hint: "Revert the merge commit on main."
    });
    expect(artifact.required_approvals).toEqual([
      {
        type: "merge",
        required_by: ".kairon/config/policies.json#git.require_approval_for",
        present: true
      }
    ]);
    expect(artifact.checks_summary).toEqual([
      { name: "build", status: "passed" },
      { name: "unit", status: "unknown", detail: "manual pending" }
    ]);
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);
  });

  it("creates a deploy dry-run approval with rollback and required approval policy evidence", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const result = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "staging",
      commitRange: "v0.1.0..main",
      checks: [parseDryRunCheck("smoke:skipped:not run in dry-run")]
    });

    const approval = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "approvals", result.approval_id + ".json")
    );
    const artifact = await readJsonFile<Record<string, unknown>>(
      path.join(root, result.artifact_path)
    );

    expect(result).toMatchObject({
      operation: "deploy",
      dry_run: true,
      execution_allowed: false,
      approval_id: "APR-0001",
      artifact_path: ".kairon/deploy/dry-runs/APR-0001.json"
    });
    expect(approval).toMatchObject({
      type: "deploy_dry_run",
      approval_required_for: "deploy",
      target_branch: "main",
      environment: "staging",
      artifact_path: ".kairon/deploy/dry-runs/APR-0001.json"
    });
    expect(artifact).toMatchObject({
      operation: "deploy",
      dry_run: true,
      execution_allowed: false,
      target_branch: "main",
      environment: "staging"
    });
    expect(artifact.required_approvals).toEqual([
      {
        type: "deploy",
        required_by: ".kairon/config/policies.json#git.require_approval_for",
        present: true
      }
    ]);
    expect(String(artifact.rollback_hint)).toContain("previous known-good artifact");
  });

  it("allows local approval decisions for dry-run records without enqueuing execution", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await deployDryRunCommand(root, {
      target: "main",
      environment: "production",
      check: ["release:passed"]
    });

    const decision = await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "approve",
      reason: "dry-run reviewed"
    });
    const approval = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "approvals", "APR-0001.json")
    );

    expect(decision).toMatchObject({
      approval_id: "APR-0001",
      status: "decided",
      action: "approve"
    });
    expect(approval).toMatchObject({
      status: "decided",
      decision: "approve"
    });
    expect(approval.confirmation).toMatchObject({
      status: "confirmed"
    });
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);
  });

  it("rejects malformed check summaries before writing approval state", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      deployDryRunCommand(root, {
        target: "main",
        check: ["build:not-a-status"]
      })
    ).rejects.toThrow(/Invalid --check status/);

    await expect(new ApprovalQueue(root).list({ status: "all" })).resolves.toEqual([]);
  });
});
