import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type GitHubReleaseAsset,
  type GitHubReleaseClient,
  type GitHubReleaseInspection,
  type GitHubReleaseRecord
} from "../src/github/release-client.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { releaseStableVerifyCommand } from "../src/cli/commands/release.js";
import { runDoctor } from "../src/diagnostics/doctor.js";
import {
  formatStableReleaseVerification,
  inspectLatestStableReleaseVerification,
  verifyPublishedStableRelease
} from "../src/release/stable-verification.js";
import { createAttestedReleaseBundleFixture } from "./release-test-fixture.js";

const sourceCommit = "a".repeat(40);
const driftCommit = "b".repeat(40);
const version = "0.3.0";

describe("published Stable release verification", () => {
  it("downloads and verifies the exact Stable bundle without GitHub mutation", async () => {
    const fixture = await createFixture();
    const first = await verifyPublishedStableRelease(
      fixture.root,
      request(),
      fixture.deps
    );
    const second = await verifyPublishedStableRelease(
      fixture.root,
      request(),
      {
        ...fixture.deps,
        now: () => new Date("2026-07-28T00:05:00.000Z")
      }
    );

    expect(first.result).toMatchObject({
      status: "PASS",
      integrity_status: "PASS",
      currentness_status: "PASS",
      release_id: 101,
      target_commit_sha: sourceCommit,
      tag_commit_sha: sourceCommit,
      draft: false,
      prerelease: false,
      credential_provider: "env",
      execution_performed: false,
      manifest: {
        status: "verified",
        source_commit: sourceCommit,
        verification_context: "consumer",
        failed_checks: []
      },
      channel_selection: {
        selected_release_id: 101,
        selected_version: version,
        matches_requested_release: true
      }
    });
    expect(first.result.assets).toHaveLength(5);
    expect(first.result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "asset_set", status: "pass" }),
      expect.objectContaining({ id: "asset_integrity", status: "pass" }),
      expect.objectContaining({ id: "source_binding", status: "pass" }),
      expect.objectContaining({ id: "read_only_execution", status: "pass" })
    ]));
    expect(first.result.state_digest).toBe(second.result.state_digest);
    expect(fixture.client.mutations).toBe(0);
    expect(await readdir(fixture.tempRoot)).toEqual([]);
    expect(JSON.stringify(first.result)).not.toContain("secret-token");
    expect(JSON.stringify(first.result)).not.toContain(fixture.tempRoot);
    expect(formatStableReleaseVerification(first, fixture.root)).toContain(
      "execution_performed=false"
    );
    expect(JSON.parse(
      formatStableReleaseVerification(first, fixture.root, "json")
    )).toMatchObject({ status: "PASS" });
    const command = await releaseStableVerifyCommand(
      fixture.root,
      { ...request(), format: "json" },
      fixture.deps
    );
    expect(command.ok).toBe(true);
    expect(JSON.parse(command.text)).toMatchObject({
      status: "PASS",
      execution_performed: false
    });

    const latest = await inspectLatestStableReleaseVerification(fixture.root);
    expect(latest).toMatchObject({
      status: "available",
      result: { verification_id: second.result.verification_id }
    });
    const doctor = await runDoctor({
      projectRoot: fixture.root,
      commandAvailability: async () => true,
      env: {},
      now: () => new Date("2026-07-28T00:05:00.000Z")
    });
    expect(doctor.checks).toContainEqual(expect.objectContaining({
      id: "release.stable_verification",
      status: "pass",
      details: expect.arrayContaining([
        "status=PASS",
        "integrity_status=PASS",
        "currentness_status=PASS"
      ])
    }));
  });

  it("separates release integrity from Stable channel currentness", async () => {
    const fixture = await createFixture();
    fixture.client.releases.unshift({
      ...fixture.client.release,
      id: 102,
      tag_name: "v0.3.1",
      name: "Kairon 0.3.1"
    });

    const execution = await verifyPublishedStableRelease(
      fixture.root,
      request(),
      fixture.deps
    );

    expect(execution.result).toMatchObject({
      status: "FAIL",
      integrity_status: "PASS",
      currentness_status: "FAIL",
      channel_selection: {
        selected_release_id: 102,
        selected_version: "0.3.1",
        matches_requested_release: false
      }
    });
    expect(execution.result.reasons).toContain(
      "stable_channel_selects_different_release"
    );
  });

  it.each([
    {
      name: "prerelease",
      mutate: (client: FakeStableReleaseClient) => {
        client.release.prerelease = true;
        client.releases = [client.release];
      },
      checkId: "stable_state",
      reason: "release_is_prerelease"
    },
    {
      name: "extra asset",
      mutate: (client: FakeStableReleaseClient) => {
        client.release.assets.push({
          id: 999,
          name: "unexpected.txt",
          size_bytes: 1,
          state: "uploaded",
          digest: `sha256:${"0".repeat(64)}`
        });
      },
      checkId: "asset_set",
      reason: "unexpected_release_asset"
    },
    {
      name: "asset digest drift",
      mutate: (client: FakeStableReleaseClient) => {
        client.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
      },
      checkId: "asset_integrity",
      reason: "asset_digest_drift"
    },
    {
      name: "release target drift",
      mutate: (client: FakeStableReleaseClient) => {
        client.release.target_commitish = driftCommit;
      },
      checkId: "source_binding",
      reason: "release_target_drift"
    },
    {
      name: "tag drift",
      mutate: (client: FakeStableReleaseClient) => {
        client.tagSha = driftCommit;
      },
      checkId: "source_binding",
      reason: "tag_source_drift"
    }
  ])("classifies $name without writing to GitHub", async ({
    mutate,
    checkId,
    reason
  }) => {
    const fixture = await createFixture();
    mutate(fixture.client);

    const execution = await verifyPublishedStableRelease(
      fixture.root,
      request(),
      fixture.deps
    );

    expect(execution.result.status).toBe("FAIL");
    expect(execution.result.checks).toContainEqual(expect.objectContaining({
      id: checkId,
      status: "fail",
      reason
    }));
    expect(fixture.client.mutations).toBe(0);
  });

  it("records setup required without exposing the requested credential source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kairon-stable-setup-"));
    const execution = await verifyPublishedStableRelease(
      root,
      {
        ...request(),
        tokenEnv: "PRIVATE_GITHUB_TOKEN"
      },
      { env: {} }
    );

    expect(execution.result).toMatchObject({
      status: "SETUP_REQUIRED",
      integrity_status: "SETUP_REQUIRED",
      currentness_status: "SETUP_REQUIRED",
      credential_provider: null,
      execution_performed: false
    });
    expect(execution.result.reasons).toEqual(["missing_github_token"]);
    expect(JSON.stringify(execution.result)).not.toContain(
      "PRIVATE_GITHUB_TOKEN"
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kairon-stable-source-"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kairon-stable-temp-"));
  await initializeProject({ projectRoot: root });
  const bundle = await createAttestedReleaseBundleFixture(
    root,
    sourceCommit,
    version
  );
  const client = await FakeStableReleaseClient.create([
    bundle.packagePath,
    bundle.checksumPath,
    bundle.releaseManifestPath,
    bundle.sbomPath,
    bundle.provenancePath
  ]);
  return {
    root,
    tempRoot,
    client,
    deps: {
      env: { GH_TOKEN: "secret-token" },
      client,
      tempRoot,
      now: () => new Date("2026-07-28T00:00:00.000Z")
    }
  };
}

function request() {
  return {
    version,
    repository: "goodaymmm/Kairon",
    baseBranch: "main"
  };
}

class FakeStableReleaseClient implements GitHubReleaseClient {
  readonly bytes = new Map<number, Uint8Array>();
  release: GitHubReleaseRecord;
  releases: GitHubReleaseRecord[];
  tagSha = sourceCommit;
  mutations = 0;

  private constructor(release: GitHubReleaseRecord) {
    this.release = release;
    this.releases = [release];
  }

  static async create(files: string[]): Promise<FakeStableReleaseClient> {
    const assets: GitHubReleaseAsset[] = [];
    const contents = new Map<number, Uint8Array>();
    for (const [index, file] of files.entries()) {
      const id = index + 1;
      const bytes = new Uint8Array(await readFile(file));
      assets.push({
        id,
        name: path.basename(file),
        size_bytes: bytes.byteLength,
        state: "uploaded",
        digest: `sha256:${sha256(bytes)}`
      });
      contents.set(id, bytes);
    }
    const client = new FakeStableReleaseClient({
      id: 101,
      tag_name: `v${version}`,
      name: `Kairon ${version}`,
      target_commitish: sourceCommit,
      draft: false,
      prerelease: false,
      html_url: "https://example.invalid/release",
      assets
    });
    for (const [id, bytes] of contents) {
      client.bytes.set(id, bytes);
    }
    return client;
  }

  async listReleases(): Promise<GitHubReleaseRecord[]> {
    return this.releases;
  }

  async inspect(): Promise<GitHubReleaseInspection> {
    return {
      repository: "goodaymmm/Kairon",
      branch: "main",
      branch_sha: sourceCommit,
      tag: {
        name: `v${version}`,
        sha: this.tagSha,
        object_type: "commit"
      },
      release: this.release
    };
  }

  async downloadAsset(request: {
    assetId: number;
  }): Promise<Uint8Array> {
    const bytes = this.bytes.get(request.assetId);
    if (bytes === undefined) {
      throw new Error("missing fake asset");
    }
    return bytes;
  }

  async createTag(): Promise<never> {
    this.mutations += 1;
    throw new Error("unexpected mutation");
  }

  async createDraftRelease(): Promise<never> {
    this.mutations += 1;
    throw new Error("unexpected mutation");
  }

  async uploadAsset(): Promise<never> {
    this.mutations += 1;
    throw new Error("unexpected mutation");
  }

  async publishRelease(): Promise<never> {
    this.mutations += 1;
    throw new Error("unexpected mutation");
  }

  async promoteRelease(): Promise<never> {
    this.mutations += 1;
    throw new Error("unexpected mutation");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
