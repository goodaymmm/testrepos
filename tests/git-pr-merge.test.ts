import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { listApprovalFollowUps } from "../src/approvals/follow-up-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createDryRunApproval } from "../src/deploy/dry-run.js";
import { GitHubPullRequestClientError } from "../src/github/pull-request-client.js";
import type { GitHubPullRequestMergeInspection } from "../src/github/pull-request-merge.js";
import {
  readPrCandidateArtifact,
  type GitPrCandidateArtifact
} from "../src/git/pr-artifact.js";
import { mergeGitPrCommand } from "../src/git/pr-merge.js";
import { createTempProject } from "./test-utils.js";

describe("git PR merge", () => {
  it("merges only after candidate-bound approval, follow-up, checks, and review pass", async () => {
    const setup = await createMergeSetup();
    let mergeCalls = 0;

    const output = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      {
        execute: true,
        confirm: "GTX-0149",
        followUpId: setup.followUpId
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () => mergeInspection(),
        mergeClient: async (request) => {
          mergeCalls += 1;
          expect(request).toMatchObject({
            repository: "goodaymmm/Kairon",
            number: 149,
            expectedHeadSha: "head-sha",
            method: "squash",
            token: "secret-token"
          });
          return { merged: true, sha: "merged-sha" };
        },
        now: () => new Date("2026-07-15T01:00:00.000Z")
      }
    );

    expect(output).toContain("Kairon git PR merged.");
    expect(output).toContain("merged_sha=merged-sha");
    expect(output).not.toContain("secret-token");
    expect(mergeCalls).toBe(1);
    const artifact = await readPrCandidateArtifact(setup.root, "GTX-0149");
    expect(artifact.merge_execution).toMatchObject({
      status: "merged",
      repository: "goodaymmm/Kairon",
      pull_request_number: 149,
      method: "squash",
      approval_id: "APR-0001",
      follow_up_id: setup.followUpId,
      attempts: 1,
      merged_sha: "merged-sha",
      reconciled: false
    });
    expect(JSON.stringify(artifact)).not.toContain("secret-token");

    const repeated = await mergeGitPrCommand(setup.root, "GTX-0149", {
      execute: true,
      confirm: "GTX-0149",
      followUpId: setup.followUpId
    });
    expect(repeated).toContain("idempotent=true");
    expect(mergeCalls).toBe(1);
  });

  it("performs a read-only dry-run without calling the merge API", async () => {
    const setup = await createMergeSetup();
    let mergeCalls = 0;

    const output = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      { dryRun: true, followUpId: setup.followUpId },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () => mergeInspection(),
        mergeClient: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "must-not-run" };
        }
      }
    );

    expect(output).toContain("Kairon git PR merge dry-run passed.");
    expect(output).toContain("execution_performed=false");
    expect(output).toContain("required_status_checks=build,test");
    expect(mergeCalls).toBe(0);
    await expect(readPrCandidateArtifact(setup.root, "GTX-0149")).resolves.not.toHaveProperty(
      "merge_execution"
    );
  });

  it.each([
    ["head_sha_drift", { headSha: "moved-head" }],
    ["base_sha_drift", { baseSha: "moved-base" }],
    ["draft_pull_request", { draft: true }],
    ["merge_conflict", { mergeable: false, mergeableState: "dirty" }],
    ["required_status_checks_missing", { requiredStatusChecks: [] }],
    ["strict_status_checks_required", { requiredStatusChecksStrict: false }],
    [
      "required_status_checks_not_successful",
      { checks: [{ context: "build", status: "failure" as const }] }
    ],
    ["required_review_policy_missing", { requiredApprovingReviewCount: 0 }],
    ["required_reviews_missing", { approvalsOnHead: 0 }]
  ])("blocks %s before calling merge", async (reason, patch) => {
    const setup = await createMergeSetup();
    let mergeCalls = 0;

    const output = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      {
        execute: true,
        confirm: "GTX-0149",
        followUpId: setup.followUpId
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () => mergeInspection(patch),
        mergeClient: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "must-not-run" };
        }
      }
    );

    expect(output).toContain(`reason=${reason}`);
    expect(output).toContain("execution_performed=false");
    expect(mergeCalls).toBe(0);
  });

  it("requires exact confirmation and a candidate-bound merge follow-up", async () => {
    const setup = await createMergeSetup();
    let inspected = false;

    const confirmation = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      {
        execute: true,
        confirm: "GTX-WRONG",
        followUpId: setup.followUpId
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () => {
          inspected = true;
          return mergeInspection();
        }
      }
    );
    expect(confirmation).toContain("reason=confirmation_required");
    expect(inspected).toBe(false);

    const candidate = await readPrCandidateArtifact(setup.root, "GTX-0149");
    candidate.transaction_id = "GTX-MOVED";
    await writeCandidate(setup.root, candidate);
    const mismatch = await mergeGitPrCommand(setup.root, "GTX-MOVED", {
      dryRun: true,
      followUpId: setup.followUpId
    });
    expect(mismatch).toContain("reason=follow_up_candidate_mismatch");
  });

  it("blocks a disallowed method and a source approval that is no longer approved", async () => {
    const setup = await createMergeSetup();
    let inspected = false;
    const deps = {
      env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
      inspectionClient: async () => {
        inspected = true;
        return mergeInspection();
      }
    };

    const method = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      { dryRun: true, followUpId: setup.followUpId, method: "merge" },
      deps
    );
    expect(method).toContain("reason=merge_method_not_allowed");
    expect(inspected).toBe(false);

    await writeJsonFileAtomic(
      path.join(setup.root, ".kairon", "approvals", "APR-0001.json"),
      {
        schema_version: "0.1",
        id: "APR-0001",
        type: "merge_dry_run",
        status: "pending",
        artifact_path: ".kairon/deploy/dry-runs/APR-0001.json",
        candidate_id: "GTX-0149"
      }
    );
    const approval = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      { dryRun: true, followUpId: setup.followUpId },
      deps
    );
    expect(approval).toContain("reason=approval_not_approved");
    expect(inspected).toBe(false);
  });

  it("reconciles an unknown merge outcome without issuing a second merge request", async () => {
    const setup = await createMergeSetup();
    let mergeCalls = 0;

    const first = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      {
        execute: true,
        confirm: "GTX-0149",
        followUpId: setup.followUpId
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () => mergeInspection(),
        mergeClient: async () => {
          mergeCalls += 1;
          throw new GitHubPullRequestClientError(
            "network_error",
            "merge_pull_request"
          );
        },
        now: () => new Date("2026-07-15T02:00:00.000Z")
      }
    );
    expect(first).toContain("status=outcome_unknown");

    const second = await mergeGitPrCommand(
      setup.root,
      "GTX-0149",
      {
        execute: true,
        confirm: "GTX-0149",
        followUpId: setup.followUpId
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        inspectionClient: async () =>
          mergeInspection({
            state: "closed",
            merged: true,
            mergeable: null,
            mergeableState: undefined,
            baseSha: "post-merge-base",
            mergeCommitSha: "merged-sha"
          }),
        mergeClient: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "duplicate" };
        },
        now: () => new Date("2026-07-15T02:01:00.000Z")
      }
    );

    expect(second).toContain("Kairon git PR merged.");
    expect(second).toContain("reconciled=true");
    expect(mergeCalls).toBe(1);
    await expect(readPrCandidateArtifact(setup.root, "GTX-0149")).resolves.toMatchObject({
      merge_execution: {
        status: "merged",
        attempts: 2,
        reconciled: true,
        merged_sha: "merged-sha"
      }
    });
  });
});

async function createMergeSetup(): Promise<{
  root: string;
  followUpId: string;
}> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await writeCandidate(root, candidateArtifact());
  await createDryRunApproval(root, {
    operation: "merge",
    candidateId: "GTX-0149",
    sourceBranch: "codex/t149",
    targetBranch: "main",
    commitRange: "base-sha..head-sha",
    checks: [
      { name: "build", status: "passed" },
      { name: "test", status: "passed" }
    ],
    rollbackHint: "Revert the merge commit."
  });
  await new ApprovalQueue(root).decide({
    approvalId: "APR-0001",
    action: "approve",
    reason: "T149 merge approved"
  });
  const followUps = await listApprovalFollowUps(root);
  const followUp = followUps.find(
    (artifact) => artifact.action_type === "merge.execute_preflight"
  );
  if (followUp === undefined) {
    throw new Error("merge follow-up was not created");
  }
  return { root, followUpId: followUp.id };
}

async function writeCandidate(
  root: string,
  artifact: GitPrCandidateArtifact
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "git", "pr-candidates", `${artifact.transaction_id}.json`),
    artifact
  );
}

function candidateArtifact(): GitPrCandidateArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "git_pr_candidate",
    transaction_id: "GTX-0149",
    status: "ready_for_pr",
    task_id: "TASK-0149",
    run_id: "RUN-0149",
    review_loop_id: "REV-0149",
    base_branch: "main",
    base_sha: "base-sha",
    head_branch: "codex/t149",
    remote: "origin",
    remote_ref: "codex/t149",
    commit_sha: "head-sha",
    diff_sha256: "sha256:t149",
    changed_files: [],
    diff_summary: { files: 0, additions: 0, deletions: 0, paths: [] },
    approvals: [],
    suggested_pr: {
      title: "T149 live merge",
      body: "body",
      create_hint: "Create PR."
    },
    rollback: {
      strategy: "revert_commit",
      command_hint: "git revert merged-sha"
    },
    live_execution: {
      status: "created",
      repository: "goodaymmm/Kairon",
      base_branch: "main",
      head_branch: "codex/t149",
      expected_base_sha: "base-sha",
      observed_base_sha: "base-sha",
      expected_head_sha: "head-sha",
      observed_head_sha: "head-sha",
      approval_id: "APR-PR",
      draft: false,
      pull_request_number: 149,
      pull_request_url: "https://github.com/goodaymmm/Kairon/pull/149",
      pull_request_state: "open",
      created_at: "2026-07-15T00:00:00.000Z"
    },
    source_transaction_path: ".kairon/git/transactions/GTX-0149.json",
    artifact_path: ".kairon/git/pr-candidates/GTX-0149.json",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z"
  };
}

function mergeInspection(
  patch: Partial<GitHubPullRequestMergeInspection> = {}
): GitHubPullRequestMergeInspection {
  return {
    repository: "goodaymmm/Kairon",
    number: 149,
    url: "https://github.com/goodaymmm/Kairon/pull/149",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    baseRef: "main",
    baseSha: "base-sha",
    headRef: "codex/t149",
    headSha: "head-sha",
    requiredStatusChecks: ["build", "test"],
    requiredStatusChecksStrict: true,
    checks: [
      { context: "build", status: "success" },
      { context: "test", status: "success" }
    ],
    requiredApprovingReviewCount: 1,
    approvalsOnHead: 1,
    ...patch
  };
}
