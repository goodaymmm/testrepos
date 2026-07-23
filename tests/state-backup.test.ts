import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  stateBackupCreateCommand,
  stateBackupRestoreCommand
} from "../src/cli/commands/state.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  createStateBackup,
  planStateBackup,
  rehearseStateBackup,
  restoreStateBackup,
  StateBackupSafetyError,
  stateBackupRestoreMarkerPath,
  verifyStateBackup,
  type StateBackupManifest,
  type StateBackupRestoreMarker
} from "../src/state/backup.js";
import { restoreStateSnapshot } from "../src/state/snapshot.js";
import {
  inspectRuntimeRecoveryTargets,
  runRuntimeRecovery
} from "../src/recovery/runtime-recovery.js";
import {
  acquireRuntimeLock,
  releaseRuntimeLock
} from "../src/runtime/runtime-lock.js";
import { createTempProject } from "./test-utils.js";

describe("state backup", () => {
  it("plans deterministic canonical state and reports policy exclusions", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "saved" });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "runtime", "state-lock.json"),
      { schema_version: "0.1", token: "ephemeral" }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "config", "service-token.json"),
      { schema_version: "0.1", token: "SHOULD_NOT_BE_BACKED_UP" }
    );
    await writeFile(
      path.join(root, ".kairon", "workflows", "checkpoints.sqlite"),
      "generated checkpoint mirror",
      "utf8"
    );
    await writeJsonFileAtomic(
      path.join(
        root,
        ".kairon",
        "workflows",
        "checkpoints",
        "WF-T169-BACKUP-000001.json"
      ),
      { schema_version: "0.1", workflow_id: "WF-T169-BACKUP", sequence: 1 }
    );

    const now = () => new Date("2026-07-15T00:00:00.000Z");
    const first = await planStateBackup(root, { now });
    const second = await planStateBackup(root, { now });

    expect(first.proposed_backup_id).toBe(second.proposed_backup_id);
    expect(first.content_sha256).toBe(second.content_sha256);
    expect(first.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".kairon/state/sample.json",
          category: "state",
          schema_version: "0.1"
        }),
        expect.objectContaining({
          path:
            ".kairon/workflows/checkpoints/WF-T169-BACKUP-000001.json",
          schema_version: "0.1"
        })
      ])
    );
    expect(first.files.map((file) => file.path)).not.toContain(
      ".kairon/config/service-token.json"
    );
    expect(first.excluded).toEqual(
      expect.arrayContaining([
        {
          path: ".kairon/runtime/**",
          reason: "runtime_ephemeral"
        },
        {
          path: ".kairon/config/service-token.json",
          reason: "secret_like_path"
        },
        {
          path: ".kairon/workflows/checkpoints.sqlite",
          reason: "generated"
        }
      ])
    );
    await expect(
      stateBackupCreateCommand(root, { dryRun: true })
    ).resolves.toContain("Kairon state backup dry-run.");
  });

  it("creates, verifies, and rehearses a backup without changing current state", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "saved" });
    const samplePath = path.join(root, ".kairon", "state", "sample.json");
    const before = await readFile(samplePath);

    const backup = await createStateBackup(root, {
      now: () => new Date("2026-07-15T01:00:00.000Z")
    });
    const verification = await verifyStateBackup(root, backup.backup_id);
    const rehearsal = await rehearseStateBackup(root, backup.backup_id, {
      now: () => new Date("2026-07-15T01:05:00.000Z")
    });

    expect(verification).toMatchObject({
      status: "verified",
      backup_id: backup.backup_id,
      content_sha256: backup.content_sha256
    });
    expect(rehearsal).toMatchObject({
      status: "passed",
      backup_id: backup.backup_id,
      cleaned_up: true,
      integrity: { summary: { errors: 0 } }
    });
    await expect(access(rehearsal.isolated_project_path)).rejects.toThrow();
    expect(await readFile(samplePath)).toEqual(before);

    await rm(path.join(root, backup.registry_path));
    await expect(
      verifyStateBackup(root, backup.backup_id, { source: backup.package_path })
    ).resolves.toMatchObject({ status: "verified" });
  });

  it("rejects modified and missing backup payloads", async () => {
    const modifiedRoot = await createInitializedProject();
    await writeState(modifiedRoot, "sample.json", { value: "saved" });
    const modified = await createStateBackup(modifiedRoot, {
      now: () => new Date("2026-07-15T02:00:00.000Z")
    });
    const modifiedManifest = await readJsonFile<StateBackupManifest>(
      modified.manifest_path
    );
    const modifiedPayload = payloadPath(
      modified.package_path,
      modifiedManifest.files[0].path
    );
    await writeFile(modifiedPayload, "{}\n", "utf8");
    await expect(
      verifyStateBackup(modifiedRoot, modified.backup_id)
    ).rejects.toThrow(StateBackupSafetyError);

    const missingRoot = await createInitializedProject();
    await writeState(missingRoot, "sample.json", { value: "saved" });
    const missing = await createStateBackup(missingRoot, {
      now: () => new Date("2026-07-15T02:30:00.000Z")
    });
    const missingManifest = await readJsonFile<StateBackupManifest>(
      missing.manifest_path
    );
    await rm(payloadPath(missing.package_path, missingManifest.files[0].path));
    await expect(
      verifyStateBackup(missingRoot, missing.backup_id)
    ).rejects.toThrow("payload file set does not match manifest");
  });

  it("restores after exact confirmation and records a pre-restore snapshot", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "backup" });
    const backup = await createStateBackup(root, {
      now: () => new Date("2026-07-15T03:00:00.000Z")
    });
    await writeState(root, "sample.json", { value: "current" });
    await writeState(root, "extra.json", { value: "remove" });

    await expect(
      restoreStateBackup(root, backup.backup_id, { confirm: "BKP-WRONG" })
    ).rejects.toThrow(StateBackupSafetyError);
    await expect(
      stateBackupRestoreCommand(root, backup.backup_id)
    ).rejects.toThrow("Backup restore requires --confirm");

    await acquireRuntimeLock(root);
    try {
      await expect(
        restoreStateBackup(root, backup.backup_id, {
          confirm: backup.backup_id
        })
      ).rejects.toThrow("runtime must be stopped");
    } finally {
      await releaseRuntimeLock(root);
    }

    const result = await restoreStateBackup(root, backup.backup_id, {
      confirm: backup.backup_id,
      now: () => new Date("2026-07-15T03:30:00.000Z")
    });

    expect(result).toMatchObject({
      status: "restored",
      backup_id: backup.backup_id,
      pre_restore_snapshot_id: "SNP-20260715033000000",
      summary: { updated: 1, deleted: 1 },
      integrity: { summary: { errors: 0 } }
    });
    await expect(readState(root, "sample.json")).resolves.toMatchObject({
      value: "backup"
    });
    await expect(
      access(path.join(root, ".kairon", "state", "extra.json"))
    ).rejects.toThrow();
    await expect(access(stateBackupRestoreMarkerPath(root))).rejects.toThrow();
  });

  it("surfaces an interrupted restore and rolls back from its pre-restore snapshot", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "backup" });
    const backup = await createStateBackup(root, {
      now: () => new Date("2026-07-15T04:00:00.000Z")
    });
    await writeState(root, "sample.json", { value: "pre-restore" });

    await expect(
      restoreStateBackup(root, backup.backup_id, {
        confirm: backup.backup_id,
        now: () => new Date("2026-07-15T04:30:00.000Z"),
        afterFileRestored: async (_file, restoredCount) => {
          if (restoredCount === 1) {
            throw new Error("injected restore interruption");
          }
        }
      })
    ).rejects.toThrow("injected restore interruption");

    const marker = await readJsonFile<StateBackupRestoreMarker>(
      stateBackupRestoreMarkerPath(root)
    );
    expect(marker).toMatchObject({
      status: "restore_failed",
      backup_id: backup.backup_id,
      pre_restore_snapshot_id: "SNP-20260715043000000",
      restored_files: 1,
      error_code: "restore_apply_failed"
    });
    const inspection = await inspectRuntimeRecoveryTargets(root);
    expect(inspection.summary.state_backup_restore_issues).toBe(1);
    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "state_backup_restore_mid_state",
          target_id: backup.backup_id,
          pre_restore_snapshot_id: marker.pre_restore_snapshot_id
        })
      ])
    );
    const recovery = await runRuntimeRecovery(root, {
      now: new Date("2026-07-15T04:31:00.000Z")
    });
    expect(recovery.summary).toMatchObject({
      approvals_requested: 1,
      state_backup_restore_issues: 1
    });
    expect(recovery.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_requested",
          issue: expect.objectContaining({
            kind: "state_backup_restore_mid_state",
            backup_id: backup.backup_id
          })
        })
      ])
    );

    await restoreStateSnapshot(root, marker.pre_restore_snapshot_id, {
      confirm: marker.pre_restore_snapshot_id
    });
    await expect(readState(root, "sample.json")).resolves.toMatchObject({
      value: "pre-restore"
    });
  });

  it("rejects malformed canonical JSON before creating a backup", async () => {
    const root = await createInitializedProject();
    await writeFile(
      path.join(root, ".kairon", "state", "broken.json"),
      "{ broken json",
      "utf8"
    );

    await expect(createStateBackup(root)).rejects.toThrow(
      "Backup source is not valid JSON"
    );
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

function payloadPath(packagePath: string, statePath: string): string {
  return path.join(
    packagePath,
    "files",
    ...statePath.slice(".kairon/".length).split("/")
  );
}
