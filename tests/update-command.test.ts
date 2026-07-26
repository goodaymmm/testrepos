import { access, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandRunResult } from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import type {
  GitHubReleaseClient,
  GitHubReleaseRecord
} from "../src/github/release-client.js";
import { setUpdateChannel } from "../src/update/channel.js";
import {
  applyDownloadedUpdate,
  checkForUpdate,
  downloadUpdate,
  rollbackUpdate
} from "../src/update/downloader.js";
import { loadUpdateRegistry } from "../src/update/registry.js";
import {
  createAttestedReleaseBundleFixture,
  createReleaseBundleFixture
} from "./release-test-fixture.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);

describe("verified update commands", () => {
  it("checks the configured channel without changing download or registry state", async () => {
    const fixture = await createUpdateFixture();
    const result = await checkForUpdate(
      fixture.root,
      "0.1.0",
      {},
      fixture.dependencies
    );

    expect(result).toMatchObject({
      status: "update_available",
      current_version: "0.1.0",
      selected_version: "0.2.0",
      selected_source_commit: sourceCommit,
      filesystem_changed: false,
      automatic_updates: false
    });
    await expect(access(path.join(fixture.root, ".kairon", "update", "downloads")))
      .rejects.toThrow();
    await expect(access(path.join(fixture.root, ".kairon", "update", "registry.json")))
      .rejects.toThrow();
  });

  it("downloads to an external cache, verifies all manifests, and applies through PowerShell", async () => {
    const fixture = await createUpdateFixture();
    const downloaded = await downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    );
    const runner = vi.fn(async (invocation) => commandResult(invocation, {
      stdout: "installed_version=0.2.0\nupdate.status=completed\n"
    }));

    const applied = await applyDownloadedUpdate(
      fixture.root,
      "0.1.0",
      downloaded.download.download_id,
      { confirm: downloaded.download.download_id },
      { ...fixture.dependencies, commandRunner: runner }
    );

    expect(downloaded).toMatchObject({
      status: "downloaded",
      download: {
        version: "0.2.0",
        source_commit: sourceCommit,
        release_channel: "beta"
      }
    });
    expect(path.relative(fixture.root, downloaded.download.cache_directory)).toMatch(/^\.\./u);
    expect(applied).toMatchObject({
      status: "completed",
      action: "apply",
      registry: {
        installed: { version: "0.2.0" },
        previous: { version: "0.1.0" },
        last_successful_version: "0.2.0"
      }
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining([
      "-ReleaseManifest",
      downloaded.download.release_manifest_path,
      "-ProjectRoot",
      path.resolve(fixture.root)
    ]));
  });

  it("does not update the registry when the PowerShell lifecycle fails", async () => {
    const fixture = await createUpdateFixture();
    const downloaded = await downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    );
    const runner = vi.fn(async (invocation) => commandResult(invocation, {
      exitCode: 1,
      stderr: "sensitive native failure"
    }));

    await expect(applyDownloadedUpdate(
      fixture.root,
      "0.1.0",
      downloaded.download.download_id,
      { confirm: downloaded.download.download_id },
      { ...fixture.dependencies, commandRunner: runner }
    )).rejects.toThrow("before registry update");
    await expect(access(path.join(fixture.root, ".kairon", "update", "registry.json")))
      .rejects.toThrow();
    const registry = await loadUpdateRegistry(fixture.root, "0.1.0");
    expect(registry).toMatchObject({
      installed: { version: "0.1.0" },
      previous: null,
      last_successful_version: "0.1.0"
    });
  });

  it("requires exact confirmation and records an explicit rollback", async () => {
    const fixture = await createUpdateFixture();
    const downloaded = await downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    );
    const runner = vi.fn(async (invocation) => commandResult(invocation, {
      stdout: "installed_version=0.2.0\nupdate.status=completed\n"
    }));

    await expect(applyDownloadedUpdate(
      fixture.root,
      "0.3.0",
      downloaded.download.download_id,
      { confirm: "UPD-WRONG" },
      { ...fixture.dependencies, commandRunner: runner }
    )).rejects.toThrow(`--confirm ${downloaded.download.download_id}`);
    expect(runner).not.toHaveBeenCalled();

    const rolledBack = await rollbackUpdate(
      fixture.root,
      "0.3.0",
      "0.2.0",
      { confirm: "0.2.0" },
      { ...fixture.dependencies, commandRunner: runner }
    );
    expect(rolledBack).toMatchObject({
      status: "completed",
      action: "rollback",
      current_version: "0.3.0",
      target_version: "0.2.0",
      downgrade: true,
      registry: {
        installed: { version: "0.2.0" },
        previous: { version: "0.3.0" },
        last_successful_version: "0.2.0",
        history: [{ action: "rollback", status: "completed" }]
      }
    });
  });

  it("rejects tampering before PowerShell starts", async () => {
    const fixture = await createUpdateFixture();
    const downloaded = await downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    );
    await writeFile(downloaded.download.package_path, "tampered", "utf8");
    const runner = vi.fn();

    await expect(applyDownloadedUpdate(
      fixture.root,
      "0.1.0",
      downloaded.download.download_id,
      { confirm: downloaded.download.download_id },
      { ...fixture.dependencies, commandRunner: runner }
    )).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("removes partial cache files when an asset download fails", async () => {
    const fixture = await createUpdateFixture();
    const originalDownload = fixture.client.downloadAsset;
    fixture.client.downloadAsset = vi.fn(async (request) => {
      if (request.assetId === 2) {
        throw new Error("network interrupted");
      }
      return originalDownload(request);
    });

    await expect(downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    )).rejects.toThrow("network interrupted");
    const entries = await readdir(fixture.cacheRoot).catch(() => [] as string[]);
    expect(entries.some((entry) => entry.startsWith(".partial-"))).toBe(false);
  });

  it("downloads and verifies SBOM and provenance for an attested Stable release", async () => {
    const fixture = await createUpdateFixture(true);
    await setUpdateChannel(fixture.root, {
      channel: "stable",
      repository: "goodaymmm/Kairon",
      write: true,
      confirm: "stable",
      now: () => new Date("2026-07-23T00:01:00.000Z")
    });
    fixture.release.prerelease = false;
    fixture.release.name = "Kairon 0.2.0";

    const downloaded = await downloadUpdate(
      fixture.root,
      "0.2.0",
      {},
      fixture.dependencies
    );

    expect(downloaded.download).toMatchObject({
      release_channel: "stable",
      sbom_path: expect.stringContaining("sbom.cdx.json"),
      provenance_path: expect.stringContaining("provenance.json")
    });
    await expect(access(downloaded.download.sbom_path!)).resolves.toBeUndefined();
    await expect(access(downloaded.download.provenance_path!)).resolves.toBeUndefined();
  });
});

async function createUpdateFixture(attested = false) {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await setUpdateChannel(root, {
    channel: "beta",
    repository: "goodaymmm/Kairon",
    write: true,
    confirm: "beta",
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
  const bundle = attested
    ? await createAttestedReleaseBundleFixture(root, sourceCommit, "0.2.0")
    : await createReleaseBundleFixture(root, sourceCommit, "0.2.0");
  const files = [
    bundle.packagePath,
    bundle.checksumPath,
    bundle.releaseManifestPath
  ];
  if ("sbomPath" in bundle && "provenancePath" in bundle) {
    files.push(bundle.sbomPath as string, bundle.provenancePath as string);
  }
  const bytes = new Map<number, Uint8Array>();
  for (const [index, file] of files.entries()) {
    bytes.set(index + 1, await readFile(file));
  }
  const release: GitHubReleaseRecord = {
    id: 163,
    tag_name: "v0.2.0",
    name: "Kairon 0.2.0 Local Beta",
    draft: false,
    prerelease: true,
    html_url: "https://github.com/goodaymmm/Kairon/releases/tag/v0.2.0",
    assets: files.map((file, index) => ({
      id: index + 1,
      name: path.basename(file),
      size_bytes: bytes.get(index + 1)!.byteLength,
      state: "uploaded"
    }))
  };
  const client: GitHubReleaseClient = {
    listReleases: vi.fn(async () => [release]),
    inspect: vi.fn(async () => ({
      repository: "goodaymmm/Kairon",
      branch: "main",
      branch_sha: "b".repeat(40),
      tag: { name: "v0.2.0", sha: sourceCommit, object_type: "commit" as const },
      release
    })),
    downloadAsset: vi.fn(async ({ assetId }) => bytes.get(assetId)!),
    createTag: vi.fn(async () => { throw new Error("not used"); }),
    createDraftRelease: vi.fn(async () => { throw new Error("not used"); }),
    uploadAsset: vi.fn(async () => { throw new Error("not used"); }),
    publishRelease: vi.fn(async () => { throw new Error("not used"); }),
    promoteRelease: vi.fn(async () => { throw new Error("not used"); })
  };
  const cacheRoot = path.join(
    os.tmpdir(),
    `kairon-update-cache-${path.basename(root)}`
  );
  const dependencies = {
    releaseClient: client,
    cacheRoot,
    env: { GH_TOKEN: "secret-token" },
    now: () => new Date("2026-07-23T00:02:00.000Z")
  };
  return { root, cacheRoot, client, release, dependencies };
}

function commandResult(
  invocation: { command: string; args: string[]; cwd: string },
  overrides: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    timedOut: false,
    ...overrides
  };
}
