import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  stateSnapshotRestoreCommand
} from "../src/cli/commands/state.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  acquireRuntimeLock,
  releaseRuntimeLock
} from "../src/runtime/runtime-lock.js";
import {
  createStateSnapshot,
  formatStateSnapshotRestorePlan,
  planStateSnapshotRestore,
  restoreStateSnapshot,
  StateSnapshotSafetyError,
  type StateSnapshotManifest
} from "../src/state/snapshot.js";
import { createTempProject } from "./test-utils.js";

describe("state snapshot", () => {
  it("creates a verified snapshot and excludes ephemeral state", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "saved" });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "runtime", "last-tick.json"),
      { schema_version: "0.1", status: "ephemeral" }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "tmp", "ignored.json"),
      { schema_version: "0.1", status: "ignored" }
    );
    await mkdir(path.join(root, ".kairon", "runs", "RUN-LOG"), {
      recursive: true
    });
    await writeFile(
      path.join(root, ".kairon", "runs", "RUN-LOG", "stdout.log"),
      "ignored log",
      "utf8"
    );

    const result = await createStateSnapshot(root, {
      snapshotId: "SNP-TEST-CREATE",
      now: () => new Date("2026-07-12T00:00:00.000Z")
    });
    const manifest = await readJsonFile<StateSnapshotManifest>(
      path.join(root, result.manifest_path)
    );

    expect(result).toMatchObject({
      status: "created",
      snapshot_id: "SNP-TEST-CREATE",
      snapshot_path: ".kairon/snapshots/SNP-TEST-CREATE"
    });
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".kairon/state/sample.json",
          sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
        })
      ])
    );
    expect(manifest.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([
        ".kairon/runtime/last-tick.json",
        ".kairon/tmp/ignored.json",
        ".kairon/runs/RUN-LOG/stdout.log"
      ])
    );
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "snapshots",
          "SNP-TEST-CREATE",
          "files",
          "state",
          "sample.json"
        )
      )
    ).resolves.toMatchObject({ value: "saved" });
  });

  it("plans add, update, and delete changes without mutating state", async () => {
    const root = await createInitializedProject();
    await writeState(root, "update.json", { value: "snapshot" });
    await writeState(root, "add.json", { value: "restore-me" });
    await createStateSnapshot(root, { snapshotId: "SNP-TEST-PLAN" });

    await writeState(root, "update.json", { value: "current" });
    await rm(path.join(root, ".kairon", "state", "add.json"));
    await writeState(root, "delete.json", { value: "remove-me" });

    const plan = await planStateSnapshotRestore(root, "SNP-TEST-PLAN", {
      now: () => new Date("2026-07-12T01:00:00.000Z")
    });

    expect(plan.summary).toMatchObject({ add: 1, update: 1, delete: 1 });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { action: "add", path: ".kairon/state/add.json", bytes: expect.any(Number) },
        { action: "update", path: ".kairon/state/update.json", bytes: expect.any(Number) },
        { action: "delete", path: ".kairon/state/delete.json", bytes: expect.any(Number) }
      ])
    );
    expect(formatStateSnapshotRestorePlan(plan)).toContain(
      "change action=update"
    );
    await expect(readState(root, "update.json")).resolves.toMatchObject({
      value: "current"
    });
    await expect(
      stateSnapshotRestoreCommand(root, "SNP-TEST-PLAN")
    ).rejects.toThrow("Restore requires --dry-run or --confirm");
    await expect(
      stateSnapshotRestoreCommand(root, "SNP-TEST-PLAN", { dryRun: true })
    ).resolves.toContain("dry_run=true");
  });

  it("restores only after exact confirmation and keeps a pre-restore backup", async () => {
    const root = await createInitializedProject();
    await writeState(root, "update.json", { value: "snapshot" });
    await writeState(root, "add.json", { value: "restore-me" });
    await createStateSnapshot(root, { snapshotId: "SNP-TEST-RESTORE" });

    await writeState(root, "update.json", { value: "current" });
    await rm(path.join(root, ".kairon", "state", "add.json"));
    await writeState(root, "delete.json", { value: "remove-me" });

    await expect(
      restoreStateSnapshot(root, "SNP-TEST-RESTORE", {
        confirm: "SNP-WRONG"
      })
    ).rejects.toThrow(StateSnapshotSafetyError);
    await expect(readState(root, "update.json")).resolves.toMatchObject({
      value: "current"
    });

    const result = await restoreStateSnapshot(root, "SNP-TEST-RESTORE", {
      confirm: "SNP-TEST-RESTORE",
      now: () => new Date("2026-07-12T02:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "restored",
      snapshot_id: "SNP-TEST-RESTORE",
      backup_snapshot_id: "SNP-20260712020000000",
      integrity: {
        status: "ok",
        summary: { errors: 0 }
      }
    });
    await expect(readState(root, "update.json")).resolves.toMatchObject({
      value: "snapshot"
    });
    await expect(readState(root, "add.json")).resolves.toMatchObject({
      value: "restore-me"
    });
    await expect(
      access(path.join(root, ".kairon", "state", "delete.json"))
    ).rejects.toThrow();
    await expect(
      access(
        path.join(
          root,
          ".kairon",
          "snapshots",
          result.backup_snapshot_id,
          "manifest.json"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("rejects unsafe manifest paths and restores while runtime is stopped only", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "saved" });
    const snapshot = await createStateSnapshot(root, {
      snapshotId: "SNP-TEST-GUARD"
    });
    const manifestPath = path.join(root, snapshot.manifest_path);
    const manifest = await readJsonFile<StateSnapshotManifest>(manifestPath);
    manifest.files[0] = {
      ...manifest.files[0],
      path: ".kairon/../outside.json"
    };
    await writeJsonFileAtomic(manifestPath, manifest);

    await expect(
      planStateSnapshotRestore(root, "SNP-TEST-GUARD")
    ).rejects.toThrow("restorable .kairon path");

    const safeSnapshot = await createStateSnapshot(root, {
      snapshotId: "SNP-TEST-RUNTIME"
    });
    await acquireRuntimeLock(root);
    try {
      await expect(
        restoreStateSnapshot(root, safeSnapshot.snapshot_id, {
          confirm: safeSnapshot.snapshot_id
        })
      ).rejects.toThrow("runtime must be stopped");
    } finally {
      await releaseRuntimeLock(root);
    }
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function writeState(
  root: string,
  fileName: string,
  value: Record<string, unknown>
): Promise<void> {
  return writeJsonFileAtomic(path.join(root, ".kairon", "state", fileName), {
    schema_version: "0.1",
    ...value
  });
}

function readState(root: string, fileName: string): Promise<Record<string, unknown>> {
  return readJsonFile(path.join(root, ".kairon", "state", fileName));
}
