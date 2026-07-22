import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findVerifiedUpdateDownloadByVersion,
  loadUpdateRegistry,
  recordSuccessfulUpdate,
  writeVerifiedUpdateDownload,
  type VerifiedUpdateDownload
} from "../src/update/registry.js";
import { createTempProject } from "./test-utils.js";

describe("update registry", () => {
  it("starts from the current runtime without claiming a background updater", async () => {
    const root = await createTempProject();
    await expect(loadUpdateRegistry(
      root,
      "0.2.0",
      () => new Date("2026-07-23T00:00:00.000Z")
    )).resolves.toMatchObject({
      installed: { version: "0.2.0", source: "current_runtime" },
      previous: null,
      last_successful_version: "0.2.0",
      automatic_updates: false,
      history: []
    });
  });

  it("updates installed, previous, and last successful only after success", async () => {
    const root = await createTempProject();
    const download = createDownload(root, "UPD-0001", "0.3.0");
    const result = await recordSuccessfulUpdate(root, {
      action: "apply",
      currentVersion: "0.2.0",
      download,
      now: () => new Date("2026-07-23T00:01:00.000Z")
    });

    expect(result).toMatchObject({
      installed: { version: "0.3.0", download_id: "UPD-0001" },
      previous: { version: "0.2.0", source: "current_runtime" },
      last_successful_version: "0.3.0",
      history: [{
        action: "apply",
        from_version: "0.2.0",
        to_version: "0.3.0",
        status: "completed"
      }]
    });
  });

  it("selects the newest verified cached package for rollback", async () => {
    const root = await createTempProject();
    await writeVerifiedUpdateDownload(
      root,
      createDownload(root, "UPD-0001", "0.1.0", "2026-07-22T00:00:00.000Z")
    );
    await writeVerifiedUpdateDownload(
      root,
      createDownload(root, "UPD-0002", "0.1.0", "2026-07-23T00:00:00.000Z")
    );

    await expect(findVerifiedUpdateDownloadByVersion(root, "0.1.0"))
      .resolves.toMatchObject({ download_id: "UPD-0002" });
  });
});

function createDownload(
  root: string,
  id: string,
  version: string,
  downloadedAt = "2026-07-23T00:00:00.000Z"
): VerifiedUpdateDownload {
  const cache = path.resolve(root, "..", `cache-${id}`);
  return {
    schema_version: "0.1",
    artifact_kind: "verified_update_download",
    download_id: id,
    repository: "goodaymmm/Kairon",
    release_id: Number(id.slice(4)) + 100,
    release_channel: "beta",
    version,
    tag: `v${version}`,
    source_commit: "a".repeat(40),
    package_sha256: "b".repeat(64),
    package_size_bytes: 100,
    cache_directory: cache,
    package_path: path.join(cache, `kairon-${version}.tgz`),
    checksum_manifest_path: path.join(cache, `kairon-${version}.tgz.sha256.json`),
    release_manifest_path: path.join(cache, "release-manifest.json"),
    downloaded_at: downloadedAt
  };
}
