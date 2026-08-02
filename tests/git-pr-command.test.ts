import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitPrCommand,
  listGitPrCandidatesCommand,
  showGitPrCandidateCommand
} from "../src/cli/commands/git-pr.js";
import { recordApprovalFollowUp } from "../src/approvals/follow-up-runner.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  readPrCandidateArtifact,
  type GitPrCandidateArtifact
} from "../src/git/pr-artifact.js";
import type {
  GitHubPullRequestCreateRequest,
  GitHubPullRequestCreateResult
} from "../src/github/pull-request-client.js";
import { GitHubPullRequestClientError } from "../src/github/pull-request-client.js";
import { createTempProject } from "./test-utils.js";

describe("git PR candidate commands", () => {
  it("lists and shows PR candidate artifacts", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));

    await expect(listGitPrCandidatesCommand(root)).resolves.toContain(
      "id=GTX-0001 status=ready_for_pr"
    );
    const detail = await showGitPrCandidateCommand(root, "GTX-0001");

    expect(detail).toContain("Kairon git PR candidate:");
    expect(detail).toContain("artifact=.kairon/git/pr-candidates/GTX-0001.json");
    expect(detail).toContain('"artifact_kind": "git_pr_candidate"');
  });

  it("prints a safe dry-run payload with a Japanese PR body", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));

    const output = await createGitPrCommand(root, "GTX-0001", {
      repository: "goodaymmm/Kairon"
    });

    expect(output).toContain("Kairon git PR create dry-run.");
    expect(output).toContain("repository=goodaymmm/Kairon");
    expect(output).toContain("base=main");
    expect(output).toContain("head=auto/TASK-0001/codex");
    expect(output).toContain("## 目的");
    expect(output).toContain("## 変更内容");
    expect(output).toContain("## 検証");
    expect(output).not.toContain("diff --git");
  });

  it("blocks execution when an approval id is missing", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));

    const output = await createGitPrCommand(root, "GTX-0001", {
      execute: true,
      confirm: "GTX-0001",
      repository: "goodaymmm/Kairon"
    });

    expect(output).toContain("Kairon git PR create blocked.");
    expect(output).toContain("reason=approval_required");
  });

  it("blocks execution when the candidate is not ready", async () => {
    const root = await createTempProject();
    await writeCandidate(
      root,
      candidateArtifact({
        transaction_id: "GTX-0001",
        status: "push_approval_required"
      })
    );
    await writeApprovedApproval(root, "APR-PR");

    const output = await createGitPrCommand(root, "GTX-0001", {
      execute: true,
      confirm: "GTX-0001",
      approvalId: "APR-PR",
      repository: "goodaymmm/Kairon"
    });

    expect(output).toContain("reason=candidate_status_not_ready");
    expect(output).toContain("candidate_status=push_approval_required");
  });

  it("creates a GitHub PR only with an approved approval and token", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR");
    const requests: GitHubPullRequestCreateRequest[] = [];

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        pullRequestRefClient: async () => ({
          baseSha: "base-sha",
          headSha: "commit-sha"
        }),
        pullRequestClient: async (request) => {
          requests.push(request);
          return {
            url: "https://github.com/goodaymmm/Kairon/pull/123",
            number: 123,
            state: "open"
          } satisfies GitHubPullRequestCreateResult;
        }
      }
    );

    expect(output).toContain("Kairon git PR created.");
    expect(output).toContain("url=https://github.com/goodaymmm/Kairon/pull/123");
    expect(output).not.toContain("secret-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      repository: "goodaymmm/Kairon",
      base: "main",
      head: "auto/TASK-0001/codex",
      title: "TASK-0001 automated change",
      token: "secret-token"
    });
    expect(requests[0]?.body).toContain("## 目的");
    await expect(readPrCandidateArtifact(root, "GTX-0001")).resolves.toMatchObject({
      live_execution: {
        status: "created",
        observed_base_sha: "base-sha",
        observed_head_sha: "commit-sha",
        approval_id: "APR-PR",
        pull_request_number: 123,
        pull_request_url: "https://github.com/goodaymmm/Kairon/pull/123"
      }
    });

    const repeated = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      { env: {} as NodeJS.ProcessEnv }
    );
    expect(repeated).toContain("idempotent=true");
    expect(requests).toHaveLength(1);

    const changedRequest = await createGitPrCommand(root, "GTX-0001", {
      execute: true,
      confirm: "GTX-0001",
      approvalId: "APR-PR",
      repository: "goodaymmm/Kairon",
      draft: true
    });
    expect(changedRequest).toContain("reason=live_execution_request_mismatch");
    expect(requests).toHaveLength(1);
  });

  it("reports setup_required when the GitHub token is missing", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR");

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      { env: {} as NodeJS.ProcessEnv }
    );

    expect(output).toContain("Kairon git PR create setup required.");
    expect(output).toContain("reason=missing_github_token");
  });

  it("requires an exact candidate confirmation before reading secrets or calling GitHub", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR");
    let called = false;

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-WRONG",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        pullRequestRefClient: async () => {
          called = true;
          return { baseSha: "base-sha", headSha: "commit-sha" };
        }
      }
    );

    expect(output).toContain("reason=confirmation_required");
    expect(called).toBe(false);
    expect(output).not.toContain("secret-token");
  });

  it("blocks live creation when the remote base or head ref drifted", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR");

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        pullRequestRefClient: async () => ({
          baseSha: "moved-base-sha",
          headSha: "commit-sha"
        }),
        pullRequestClient: async () => {
          throw new Error("must not create");
        }
      }
    );

    expect(output).toContain("reason=base_branch_drift");
    expect(output).not.toContain("secret-token");
  });

  it("accepts a matching GitHub PR approval follow-up", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR", {
      type: "git_pr_create",
      transaction_id: "GTX-0001"
    });
    const followUp = await recordApprovalFollowUp(root, {
      approval: {
        id: "APR-PR",
        type: "git_pr_create",
        transaction_id: "GTX-0001"
      },
      decision: "approve",
      decidedAt: "2026-07-13T01:00:00.000Z"
    });

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        followUpId: followUp.id,
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        pullRequestRefClient: async () => ({
          baseSha: "base-sha",
          headSha: "commit-sha"
        }),
        pullRequestClient: async () => ({
          url: "https://github.com/goodaymmm/Kairon/pull/124",
          number: 124,
          state: "open"
        })
      }
    );

    expect(output).toContain(`follow_up_id=${followUp.id}`);
    expect(output).toContain("approval_id=APR-PR");
  });

  it("classifies GitHub permission failures as setup required without leaking tokens", async () => {
    const root = await createTempProject();
    await writeCandidate(root, candidateArtifact({ transaction_id: "GTX-0001" }));
    await writeApprovedApproval(root, "APR-PR");

    const output = await createGitPrCommand(
      root,
      "GTX-0001",
      {
        execute: true,
        confirm: "GTX-0001",
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
        pullRequestRefClient: async () => {
          throw new GitHubPullRequestClientError(
            "permission_error",
            "inspect_refs",
            403
          );
        }
      }
    );

    expect(output).toContain("Kairon git PR create setup required.");
    expect(output).toContain("reason=github_permission_error");
    expect(output).toContain("http_status=403");
    expect(output).not.toContain("secret-token");
  });
});

async function writeCandidate(
  root: string,
  artifact: GitPrCandidateArtifact
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "git", "pr-candidates", `${artifact.transaction_id}.json`),
    artifact
  );
}

async function writeApprovedApproval(
  root: string,
  approvalId: string,
  patch: Record<string, unknown> = {}
): Promise<void> {
  await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", `${approvalId}.json`), {
    schema_version: "0.1",
    id: approvalId,
    status: "decided",
    decision: "approve",
    type: "manual_test",
    title: `Manual approval ${approvalId}`,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...patch
  });
}

function candidateArtifact(
  patch: Partial<GitPrCandidateArtifact>
): GitPrCandidateArtifact {
  const transactionId = patch.transaction_id ?? "GTX-0001";

  return {
    schema_version: "0.1",
    artifact_kind: "git_pr_candidate",
    transaction_id: transactionId,
    status: "ready_for_pr",
    task_id: "TASK-0001",
    run_id: "RUN-0001",
    review_loop_id: "REV-0001",
    base_branch: "main",
    base_sha: "base-sha",
    head_branch: "auto/TASK-0001/codex",
    remote: "origin",
    remote_ref: "auto/TASK-0001/codex",
    commit_sha: "commit-sha",
    diff_sha256: "sha256:abc",
    changed_files: [
      {
        path: "src/example.ts",
        status: "modified",
        additions: 2,
        deletions: 1
      }
    ],
    diff_summary: {
      files: 1,
      additions: 2,
      deletions: 1,
      paths: ["src/example.ts"]
    },
    approvals: [],
    suggested_pr: {
      title: "TASK-0001 automated change",
      body: "legacy body",
      create_hint: "Create a PR from auto/TASK-0001/codex to main."
    },
    rollback: {
      strategy: "revert_commit",
      command_hint: "git revert parent-sha..HEAD"
    },
    source_transaction_path: ".kairon/git/transactions/GTX-0001.json",
    artifact_path: `.kairon/git/pr-candidates/${transactionId}.json`,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...patch
  };
}
