import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitPrCommand,
  listGitPrCandidatesCommand,
  showGitPrCandidateCommand
} from "../src/cli/commands/git-pr.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import type { GitPrCandidateArtifact } from "../src/git/pr-artifact.js";
import type {
  GitHubPullRequestCreateRequest,
  GitHubPullRequestCreateResult
} from "../src/github/pull-request-client.js";
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
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      {
        env: { GH_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
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
        approvalId: "APR-PR",
        repository: "goodaymmm/Kairon"
      },
      { env: {} as NodeJS.ProcessEnv }
    );

    expect(output).toContain("Kairon git PR create setup required.");
    expect(output).toContain("reason=missing_github_token");
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

async function writeApprovedApproval(root: string, approvalId: string): Promise<void> {
  await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", `${approvalId}.json`), {
    schema_version: "0.1",
    id: approvalId,
    status: "decided",
    decision: "approve",
    type: "manual_test",
    title: `Manual approval ${approvalId}`,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z"
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
