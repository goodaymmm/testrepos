import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCoreVersions,
  isVersionAllowedByChannel,
  setUpdateChannel,
  showUpdateChannel
} from "../src/update/channel.js";
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
});
