import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  releaseGitHubPlanCommand,
  releaseGitHubPublishCommand,
  releaseGitHubVerifyCommand
} from "../src/cli/commands/release.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  correlationArtifactPath,
  type CorrelationArtifact
} from "../src/correlation/store.js";
import type {
  CreateGitHubReleaseRequest,
  CreateGitHubReleaseTagRequest,
  DownloadGitHubReleaseAssetRequest,
  GitHubReleaseAsset,
  GitHubReleaseClient,
  GitHubReleaseInspection,
  GitHubReleaseRecord,
  InspectGitHubReleaseRequest,
  PublishGitHubReleaseRequest,
  UploadGitHubReleaseAssetRequest
} from "../src/github/release-client.js";
import { GitHubReleaseClientError } from "../src/github/release-client.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  githubReleasePlanPath,
  githubReleaseResultPath,
  planGitHubRelease,
  publishGitHubRelease,
  verifyGitHubRelease,
  type GitHubReleasePlan,
  type GitHubReleaseResult
} from "../src/release/github-release.js";
import { createReleaseBundleFixture } from "./release-test-fixture.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);

describe("GitHub release commands", () => {
  it("creates an approval-bound prerelease plan and publishes idempotently", async () => {
    const fixture = await createFixture();
    const plan = await planGitHubRelease(fixture.root, request(), fixture.deps);

    expect(plan.reason).toBeUndefined();
    expect(plan).toMatchObject({ status: "approval_required" });
    expect(plan.plan).toMatchObject({
      plan_id: "REL-0001",
      approval_id: "APR-0001",
      correlation_id: "COR-000001",
      prerelease: true,
      source_commit: sourceCommit,
      assets: expect.arrayContaining([
        expect.objectContaining({ name: "kairon-0.2.0.tgz" }),
        expect.objectContaining({ name: "release-manifest.json" })
      ])
    });
    const approval = await new ApprovalQueue(fixture.root).show("APR-0001");
    expect(approval).toMatchObject({
      type: "github_release_publish",
      plan_id: "REL-0001",
      plan_digest: plan.plan?.plan_digest,
      risk_level: "high"
    });
    expect(JSON.stringify(plan)).not.toContain("secret-token");
    expect(JSON.stringify(approval)).not.toContain("secret-token");

    await new ApprovalQueue(fixture.root).decide({
      approvalId: "APR-0001",
      action: "approve"
    });
    const published = await publishGitHubRelease(fixture.root, {
      planId: "REL-0001",
      approvalId: "APR-0001",
      confirm: "REL-0001"
    }, fixture.deps);
    const repeated = await publishGitHubRelease(fixture.root, {
      planId: "REL-0001",
      approvalId: "APR-0001",
      confirm: "REL-0001"
    }, fixture.deps);
    const verified = await verifyGitHubRelease(fixture.root, request(), fixture.deps);

    expect(published).toMatchObject({
      status: "published",
      execution_performed: true,
      result: {
        status: "published",
        tag_sha: sourceCommit,
        release_id: 162,
        assets: expect.arrayContaining([
          expect.objectContaining({ status: "verified" })
        ])
      }
    });
    expect(repeated).toMatchObject({
      status: "published",
      execution_performed: false,
      result: { idempotent: true, attempts: 2 }
    });
    expect(verified).toMatchObject({ status: "verified", execution_performed: false });
    expect(fixture.client.createTagCalls).toBe(1);
    expect(fixture.client.createReleaseCalls).toBe(1);
    expect(fixture.client.uploadCalls).toBe(3);
    expect(fixture.client.publishCalls).toBe(1);
    const result = await readJsonFile<GitHubReleaseResult>(
      githubReleaseResultPath(fixture.root, "REL-0001")
    );
    const correlation = await readJsonFile<CorrelationArtifact>(
      correlationArtifactPath(fixture.root, "COR-000001")
    );
    expect(result).toMatchObject({ status: "published", idempotent: true, attempts: 2 });
    expect(result).not.toHaveProperty("release_url");
    expect(correlation.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "release_plan", id: "REL-0001" }),
      expect.objectContaining({ kind: "release_result", id: "REL-0001", status: "published" })
    ]));
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("blocks stale remote main and exact-confirmation mismatches before mutation", async () => {
    const fixture = await createFixture();
    const planned = await planGitHubRelease(fixture.root, request(), fixture.deps);
    await new ApprovalQueue(fixture.root).decide({
      approvalId: planned.plan!.approval_id,
      action: "approve"
    });
    fixture.client.branchSha = "b".repeat(40);

    const wrongConfirm = await publishGitHubRelease(fixture.root, {
      planId: planned.plan!.plan_id,
      approvalId: planned.plan!.approval_id,
      confirm: "REL-9999"
    }, fixture.deps);
    const stale = await publishGitHubRelease(fixture.root, {
      planId: planned.plan!.plan_id,
      approvalId: planned.plan!.approval_id,
      confirm: planned.plan!.plan_id
    }, fixture.deps);

    expect(wrongConfirm).toMatchObject({
      status: "blocked",
      reason: "exact_confirmation_required"
    });
    expect(stale).toMatchObject({
      status: "blocked",
      reason: "remote_branch_sha_drift",
      result: { status: "blocked", retryable: false }
    });
    expect(fixture.client.createTagCalls).toBe(0);
    expect(fixture.client.createReleaseCalls).toBe(0);
    expect(fixture.client.uploadCalls).toBe(0);
  });

  it("resumes a partial upload without duplicating the verified first asset", async () => {
    const fixture = await createFixture();
    const planned = await planGitHubRelease(fixture.root, request(), fixture.deps);
    await new ApprovalQueue(fixture.root).decide({
      approvalId: planned.plan!.approval_id,
      action: "approve"
    });
    fixture.client.failUploadNumber = 2;

    const failed = await publishGitHubRelease(fixture.root, {
      planId: planned.plan!.plan_id,
      approvalId: planned.plan!.approval_id,
      confirm: planned.plan!.plan_id
    }, fixture.deps);
    fixture.client.failUploadNumber = undefined;
    const retried = await publishGitHubRelease(fixture.root, {
      planId: planned.plan!.plan_id,
      approvalId: planned.plan!.approval_id,
      confirm: planned.plan!.plan_id
    }, fixture.deps);

    expect(failed).toMatchObject({
      status: "failed",
      reason: "github_upload_asset_network_error",
      execution_performed: true,
      result: { retryable: true, assets: [{ status: "verified" }] }
    });
    expect(retried).toMatchObject({
      status: "published",
      result: { attempts: 2, assets: expect.any(Array) }
    });
    expect(retried.result?.assets).toHaveLength(3);
    expect(fixture.client.uploadCalls).toBe(4);
  });

  it("blocks an existing same-name asset with different content and formats setup errors safely", async () => {
    const fixture = await createFixture();
    const localPackage = await readFile(fixture.bundle.packagePath);
    fixture.client.seedPublishedAsset(
      "kairon-0.2.0.tgz",
      new Uint8Array(Buffer.concat([localPackage, Buffer.from("different")]))
    );
    const blocked = await planGitHubRelease(fixture.root, request(), fixture.deps);
    const missingTokenText = await releaseGitHubPlanCommand(
      fixture.root,
      request(),
      { ...fixture.deps, env: {} }
    );

    expect(blocked).toMatchObject({
      status: "blocked",
      reason: "remote_asset_hash_conflict"
    });
    expect(missingTokenText).toContain("status=setup_required");
    expect(missingTokenText).toContain("reason=missing_github_token");
    expect(missingTokenText).not.toContain("secret-token");
  });

  it("normalizes a preflight asset download failure without creating a plan", async () => {
    const fixture = await createFixture();
    const localPackage = await readFile(fixture.bundle.packagePath);
    fixture.client.seedPublishedAsset("kairon-0.2.0.tgz", localPackage);
    fixture.client.failDownloads = true;

    const failed = await planGitHubRelease(fixture.root, request(), fixture.deps);

    expect(failed).toMatchObject({
      status: "failed",
      reason: "github_download_asset_network_error",
      execution_performed: false
    });
    await expect(readFile(
      githubReleasePlanPath(fixture.root, "REL-0001")
    )).rejects.toThrow();
  });

  it("blocks mismatched release identity and unexpected remote assets", async () => {
    const wrongName = await createFixture();
    wrongName.client.tagSha = sourceCommit;
    wrongName.client.release = {
      id: 162,
      tag_name: "v0.2.0",
      name: "Different release",
      draft: true,
      prerelease: true,
      html_url: "https://github.com/goodaymmm/Kairon/releases/tag/v0.2.0",
      assets: []
    };
    await expect(planGitHubRelease(wrongName.root, request(), wrongName.deps))
      .resolves.toMatchObject({ status: "blocked", reason: "release_name_conflict" });

    const extraAsset = await createFixture();
    extraAsset.client.seedPublishedAsset(
      "unexpected.zip",
      new TextEncoder().encode("unexpected")
    );
    await expect(planGitHubRelease(extraAsset.root, request(), extraAsset.deps))
      .resolves.toMatchObject({ status: "blocked", reason: "unexpected_remote_asset" });
  });

  it("requires an explicit stable plan to change the release channel", async () => {
    const fixture = await createFixture();

    await expect(planGitHubRelease(
      fixture.root,
      { ...request(), stable: true },
      fixture.deps
    )).resolves.toMatchObject({
      status: "approval_required",
      plan: { prerelease: false, release_name: "Kairon 0.2.0" }
    });
  });

  it("exposes plan, publish, and verify through the release command handlers", async () => {
    const fixture = await createFixture();
    const planText = await releaseGitHubPlanCommand(fixture.root, request(), fixture.deps);
    const plan = await readJsonFile<GitHubReleasePlan>(
      githubReleasePlanPath(fixture.root, "REL-0001")
    );
    await new ApprovalQueue(fixture.root).decide({
      approvalId: plan.approval_id,
      action: "approve"
    });
    const publishText = await releaseGitHubPublishCommand(
      fixture.root,
      plan.plan_id,
      { approvalId: plan.approval_id, confirm: plan.plan_id },
      fixture.deps
    );
    const verifyText = await releaseGitHubVerifyCommand(
      fixture.root,
      request(),
      fixture.deps
    );

    expect(planText).toContain("Kairon GitHub release plan created.");
    expect(planText).toContain("prerelease=true");
    expect(publishText).toContain("Kairon GitHub release published.");
    expect(verifyText).toContain("Kairon GitHub release verified.");
  });
});

async function createFixture(): Promise<{
  root: string;
  bundle: Awaited<ReturnType<typeof createReleaseBundleFixture>>;
  client: FakeGitHubReleaseClient;
  deps: {
    env: NodeJS.ProcessEnv;
    client: FakeGitHubReleaseClient;
    commandRunner: CommandRunner;
    now: () => Date;
  };
}> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const bundle = await createReleaseBundleFixture(root, sourceCommit);
  const client = new FakeGitHubReleaseClient(sourceCommit);
  return {
    root,
    bundle,
    client,
    deps: {
      env: { GH_TOKEN: "secret-token" },
      client,
      commandRunner: cleanGitRunner,
      now: () => new Date("2026-07-22T01:00:00.000Z")
    }
  };
}

function request() {
  return {
    version: "0.2.0",
    repository: "goodaymmm/Kairon"
  };
}

const cleanGitRunner: CommandRunner = async (invocation) =>
  invocation.args[0] === "rev-parse"
    ? commandResult(invocation, { stdout: `${sourceCommit}\n` })
    : commandResult(invocation);

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-22T00:00:00.000Z",
    finishedAt: "2026-07-22T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

class FakeGitHubReleaseClient implements GitHubReleaseClient {
  branchSha: string;
  tagSha: string | null = null;
  release: GitHubReleaseRecord | null = null;
  createTagCalls = 0;
  createReleaseCalls = 0;
  uploadCalls = 0;
  publishCalls = 0;
  failUploadNumber?: number;
  failDownloads = false;
  private nextAssetId = 1;
  private readonly content = new Map<number, Uint8Array>();

  constructor(branchSha: string) {
    this.branchSha = branchSha;
  }

  async listReleases(): Promise<GitHubReleaseRecord[]> {
    return this.release === null
      ? []
      : [{ ...this.release, assets: [...this.release.assets] }];
  }

  async inspect(request: InspectGitHubReleaseRequest): Promise<GitHubReleaseInspection> {
    return {
      repository: request.repository,
      branch: request.branch,
      branch_sha: this.branchSha,
      tag: this.tagSha === null
        ? null
        : { name: request.tag, sha: this.tagSha, object_type: "commit" },
      release: this.release === null
        ? null
        : { ...this.release, assets: [...this.release.assets] }
    };
  }

  async createTag(request: CreateGitHubReleaseTagRequest) {
    this.createTagCalls += 1;
    this.tagSha = request.sha;
    return { name: request.tag, sha: request.sha, object_type: "commit" as const };
  }

  async createDraftRelease(request: CreateGitHubReleaseRequest) {
    this.createReleaseCalls += 1;
    this.release = {
      id: 162,
      tag_name: request.tag,
      name: request.name,
      draft: true,
      prerelease: request.prerelease,
      html_url: `https://github.com/${request.repository}/releases/tag/${request.tag}`,
      assets: []
    };
    return { ...this.release, assets: [] };
  }

  async uploadAsset(request: UploadGitHubReleaseAssetRequest) {
    this.uploadCalls += 1;
    if (this.failUploadNumber === this.uploadCalls) {
      throw new GitHubReleaseClientError("network_error", "upload_asset");
    }
    const asset: GitHubReleaseAsset = {
      id: this.nextAssetId++,
      name: request.name,
      size_bytes: request.content.byteLength,
      state: "uploaded",
      digest: `sha256:${hash(request.content)}`
    };
    this.content.set(asset.id, request.content);
    this.release = {
      ...this.release!,
      assets: [...this.release!.assets, asset]
    };
    return asset;
  }

  async downloadAsset(request: DownloadGitHubReleaseAssetRequest) {
    if (this.failDownloads) {
      throw new GitHubReleaseClientError("network_error", "download_asset");
    }
    const content = this.content.get(request.assetId);
    if (content === undefined) {
      throw new GitHubReleaseClientError("not_found", "download_asset", 404);
    }
    return content;
  }

  async publishRelease(request: PublishGitHubReleaseRequest) {
    this.publishCalls += 1;
    this.release = {
      ...this.release!,
      name: request.name,
      draft: false,
      prerelease: request.prerelease
    };
    return { ...this.release, assets: [...this.release.assets] };
  }

  seedPublishedAsset(name: string, content: Uint8Array): void {
    this.tagSha = sourceCommit;
    const asset: GitHubReleaseAsset = {
      id: this.nextAssetId++,
      name,
      size_bytes: content.byteLength,
      state: "uploaded",
      digest: `sha256:${hash(content)}`
    };
    this.content.set(asset.id, content);
    this.release = {
      id: 162,
      tag_name: "v0.2.0",
      name: "Kairon 0.2.0 Local Beta",
      draft: true,
      prerelease: true,
      html_url: "https://github.com/goodaymmm/Kairon/releases/tag/v0.2.0",
      assets: [asset]
    };
  }
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
