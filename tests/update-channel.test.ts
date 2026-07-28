import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCoreVersions,
  isVersionAllowedByChannel,
  selectReleaseForChannel,
  setUpdateChannel,
  showUpdateChannel
} from "../src/update/channel.js";
import type { GitHubReleaseRecord } from "../src/github/release-client.js";
import {
  readStableReleasePromotion,
  recordStableReleasePromotion
} from "../src/update/registry.js";
import { createTempProject } from "./test-utils.js";

describe("update channel", () => {
  it("defaults to an unconfigured manual channel and keeps dry runs non-mutating", async () => {
    const root = await createTempProject();
    await expect(showUpdateChannel(root)).resolves.toMatchObject({
      status: "unconfigured",
      config: null
    });

    const result = await setUpdateChannel(root, {
      channel: "beta",
      repository: "goodaymmm/Kairon",
      dryRun: true,
      now: () => new Date("2026-07-23T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "would_update",
      dry_run: true,
      confirmation: "beta",
      next: { automatic_updates: false }
    });
    await expect(access(path.join(root, ".kairon", "update", "channel.json")))
      .rejects.toThrow();
  });

  it("requires exact confirmation before writing channel changes", async () => {
    const root = await createTempProject();
    await expect(setUpdateChannel(root, {
      channel: "beta",
      repository: "goodaymmm/Kairon",
      write: true,
      confirm: "stable"
    })).rejects.toThrow("--confirm beta");

    await setUpdateChannel(root, {
      channel: "beta",
      repository: "goodaymmm/Kairon",
      write: true,
      confirm: "beta",
      now: () => new Date("2026-07-23T00:00:00.000Z")
    });
    await expect(showUpdateChannel(root)).resolves.toMatchObject({
      status: "configured",
      config: {
        channel: "beta",
        repository: "goodaymmm/Kairon",
        base_branch: "main",
        automatic_updates: false
      }
    });
  });

  it("pins an exact version and evaluates stable and beta releases", async () => {
    const root = await createTempProject();
    await setUpdateChannel(root, {
      channel: "pinned",
      repository: "goodaymmm/Kairon",
      version: "0.2.0",
      write: true,
      confirm: "pinned@0.2.0"
    });
    const pinned = (await showUpdateChannel(root)).config!;
    expect(isVersionAllowedByChannel(pinned, "0.2.0", true)).toBe(true);
    expect(isVersionAllowedByChannel(pinned, "0.2.1", false)).toBe(false);
    expect(isVersionAllowedByChannel({ ...pinned, channel: "stable" }, "0.2.0", true))
      .toBe(false);
    expect(isVersionAllowedByChannel({ ...pinned, channel: "beta" }, "0.2.0", true))
      .toBe(true);
    expect(compareCoreVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("records a sanitized Stable release pointer independently of channel selection", async () => {
    const root = await createTempProject();
    await recordStableReleasePromotion(root, {
      schema_version: "0.1",
      artifact_kind: "stable_release_pointer",
      repository: "goodaymmm/Kairon",
      base_branch: "main",
      version: "0.3.0",
      tag: "v0.3.0",
      source_commit: "a".repeat(40),
      release_id: 162,
      promotion_plan_id: "REL-0001",
      promotion_plan_digest: `sha256:${"b".repeat(64)}`,
      sbom_sha256: "c".repeat(64),
      provenance_sha256: "d".repeat(64),
      promoted_at: "2026-07-26T00:00:00.000Z"
    });

    await expect(readStableReleasePromotion(root)).resolves.toMatchObject({
      version: "0.3.0",
      release_id: 162,
      promotion_plan_id: "REL-0001"
    });
    await expect(showUpdateChannel(root)).resolves.toMatchObject({
      status: "unconfigured"
    });
  });

  it("selects the latest release through the same Stable channel contract", () => {
    const config = {
      schema_version: "0.1" as const,
      channel: "stable" as const,
      repository: "goodaymmm/Kairon",
      base_branch: "main",
      automatic_updates: false as const,
      updated_at: "2026-07-28T00:00:00.000Z"
    };
    const releases = [
      release(1, "0.3.0", false),
      release(2, "0.3.1", true),
      release(3, "0.2.9", false),
      { ...release(4, "0.4.0", false), draft: true }
    ];

    expect(selectReleaseForChannel(config, releases)).toMatchObject({
      version: "0.3.0",
      release: { id: 1 }
    });
    expect(selectReleaseForChannel(config, releases, "0.2.9")).toMatchObject({
      version: "0.2.9",
      release: { id: 3 }
    });
  });
});

function release(
  id: number,
  version: string,
  prerelease: boolean
): GitHubReleaseRecord {
  return {
    id,
    tag_name: `v${version}`,
    name: `Kairon ${version}`,
    draft: false,
    prerelease,
    html_url: "https://example.invalid/release",
    assets: []
  };
}
