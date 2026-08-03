import {
  access,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { BackupCatalog } from "../src/state/backup-catalog.js";
import { createStateBackup, type StateBackupManifest } from "../src/state/backup.js";
import {
  copyDisasterRecoveryBackup,
  DisasterRecoveryError,
  planDisasterRecoveryCopy,
  rehearseDisasterRecoveryBackup,
  verifyDisasterRecoveryBackup
} from "../src/state/disaster-recovery.js";
import { createTempProject } from "./test-utils.js";

describe("off-device disaster recovery", () => {
  it("copies, catalogs, verifies, and rehearses outside the source project", async () => {
    const root = await createInitializedProject();
    const destination = await createTempProject();
    const catalogPath = path.join(await createTempProject(), "catalog.json");
    const statePath = await writeState(root, "sample.json", { value: "saved" });
    const before = await readFile(statePath);
    const backup = await createStateBackup(root, {
      now: () => new Date("2026-07-27T00:00:00.000Z")
    });

    const planned = await planDisasterRecoveryCopy(root, backup.backup_id, {
      destinationRoot: destination,
      minimumFreeBytes: 0,
      catalogPath,
      now: () => new Date("2026-07-27T00:01:00.000Z")
    });
    await expect(
      copyDisasterRecoveryBackup(root, planned.plan.plan_id, {
        confirm: "DRP-WRONG",
        catalogPath
      })
    ).rejects.toMatchObject({ code: "confirmation_mismatch" });

    const copied = await copyDisasterRecoveryBackup(
      root,
      planned.plan.plan_id,
      {
        confirm: planned.plan.plan_id,
        catalogPath,
        now: () => new Date("2026-07-27T00:02:00.000Z")
      }
    );
    expect(copied).toMatchObject({
      status: "copied",
      backup_id: backup.backup_id,
      content_sha256: backup.content_sha256
    });
    expect(copied.package_path.startsWith(destination)).toBe(true);

    await rm(backup.package_path, { recursive: true, force: true });
    await expect(
      verifyDisasterRecoveryBackup(root, backup.backup_id, {
        catalogPath,
        now: () => new Date("2026-07-27T00:03:00.000Z")
      })
    ).resolves.toMatchObject({
      status: "verified",
      content_sha256: backup.content_sha256
    });
    await expect(
      rehearseDisasterRecoveryBackup(root, backup.backup_id, {
        catalogPath,
        now: () => new Date("2026-07-27T00:04:00.000Z")
      })
    ).resolves.toMatchObject({
      status: "passed",
      cleaned_up: true,
      config_validation: { ok: true },
      workflow_replay: { status: "ready" }
    });
    expect(await readFile(statePath)).toEqual(before);

    const catalog = await new BackupCatalog({ catalogPath }).read();
    expect(catalog.entries).toEqual([
      expect.objectContaining({
        backup_id: backup.backup_id,
        verification_status: "verified",
        rehearsal_status: "passed"
      })
    ]);
  });

  it("rejects unsafe destinations and removes partial copies after interruption", async () => {
    const root = await createInitializedProject();
    await writeState(root, "sample.json", { value: "saved" });
    const backup = await createStateBackup(root, {
      now: () => new Date("2026-07-27T01:00:00.000Z")
    });
    const catalogPath = path.join(await createTempProject(), "catalog.json");

    await expect(
      planDisasterRecoveryCopy(root, backup.backup_id, {
        destinationRoot: path.join(root, ".kairon"),
        minimumFreeBytes: 0,
        catalogPath
      })
    ).rejects.toMatchObject({ code: "destination_inside_project" });
    await expect(
      planDisasterRecoveryCopy(root, backup.backup_id, {
        destinationRoot: await createTempProject(),
        minimumFreeBytes: 0,
        catalogPath: path.join(root, ".kairon", "backup-catalog.json")
      })
    ).rejects.toMatchObject({ code: "destination_inside_project" });
    await expect(
      planDisasterRecoveryCopy(root, backup.backup_id, {
        destinationRoot: path.join(root, "..", "missing-destination"),
        minimumFreeBytes: 0,
        catalogPath
      })
    ).rejects.toMatchObject({ code: "destination_missing" });

    const destination = await createTempProject();
    await expect(
      planDisasterRecoveryCopy(root, backup.backup_id, {
        destinationRoot: destination,
        minimumFreeBytes: 1,
        freeSpaceReader: async () => 0,
        catalogPath
      })
    ).rejects.toMatchObject({ code: "insufficient_space" });

    const planned = await planDisasterRecoveryCopy(root, backup.backup_id, {
      destinationRoot: destination,
      minimumFreeBytes: 0,
      catalogPath
    });
    await expect(
      copyDisasterRecoveryBackup(root, planned.plan.plan_id, {
        confirm: planned.plan.plan_id,
        catalogPath,
        afterFileCopied: async () => {
          throw new Error("injected copy interruption");
        }
      })
    ).rejects.toMatchObject({ code: "copy_interrupted" });
    await expect(access(planned.plan.destination_package_path)).rejects.toThrow();
    expect(
      (await listFiles(destination)).filter((file) => file.endsWith(".partial"))
    ).toEqual([]);
    expect(await new BackupCatalog({ catalogPath }).list()).toEqual([]);

    await writeJsonFileAtomic(planned.plan_path, {
      ...planned.plan,
      destination: {
        ...planned.plan.destination,
        minimum_free_bytes: -1
      }
    });
    await expect(
      copyDisasterRecoveryBackup(root, planned.plan.plan_id, {
        confirm: planned.plan.plan_id,
        catalogPath
      })
    ).rejects.toMatchObject({ code: "plan_invalid" });
  });

  it("classifies destination tampering and unsupported backup schemas", async () => {
    const tampered = await createCopiedBackup("2026-07-27T02:00:00.000Z");
    const manifest = await readJsonFile<StateBackupManifest>(
      path.join(tampered.packagePath, "manifest.json")
    );
    await writeFile(
      payloadPath(tampered.packagePath, manifest.files[0].path),
      "{}\n",
      "utf8"
    );
    await expect(
      verifyDisasterRecoveryBackup(tampered.root, tampered.backupId, {
        catalogPath: tampered.catalogPath
      })
    ).rejects.toMatchObject({ code: "destination_tampered" });

    const unsupported = await createCopiedBackup("2026-07-27T03:00:00.000Z");
    const manifestPath = path.join(unsupported.packagePath, "manifest.json");
    const unsupportedManifest = await readJsonFile<Record<string, unknown>>(
      manifestPath
    );
    unsupportedManifest.schema_version = "9.9";
    await writeJsonFileAtomic(manifestPath, unsupportedManifest);
    await expect(
      verifyDisasterRecoveryBackup(unsupported.root, unsupported.backupId, {
        catalogPath: unsupported.catalogPath
      })
    ).rejects.toMatchObject({ code: "backup_schema_unsupported" });
  });

  it("rotates old generations without removing the latest verified backup", async () => {
    const root = await createInitializedProject();
    const destination = await createTempProject();
    const catalogPath = path.join(await createTempProject(), "catalog.json");
    const copiedPaths: string[] = [];
    const backupIds: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      await writeState(root, "sample.json", { value: `generation-${index}` });
      const now = new Date(Date.UTC(2026, 6, 27, 4 + index));
      const backup = await createStateBackup(root, { now: () => now });
      const planned = await planDisasterRecoveryCopy(root, backup.backup_id, {
        destinationRoot: destination,
        minimumFreeBytes: 0,
        maxBackups: 2,
        maxAgeDays: 365,
        minKeep: 1,
        catalogPath,
        now: () => now
      });
      const copied = await copyDisasterRecoveryBackup(
        root,
        planned.plan.plan_id,
        {
          confirm: planned.plan.plan_id,
          catalogPath,
          now: () => now
        }
      );
      copiedPaths.push(copied.package_path);
      backupIds.push(backup.backup_id);
    }

    const entries = await new BackupCatalog({ catalogPath }).list();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.backup_id)).toEqual(
      expect.arrayContaining(backupIds.slice(1))
    );
    await expect(access(copiedPaths[0])).rejects.toThrow();
    await expect(access(copiedPaths[2])).resolves.toBeUndefined();
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function writeState(
  root: string,
  fileName: string,
  value: Record<string, unknown>
): Promise<string> {
  const target = path.join(root, ".kairon", "state", fileName);
  await writeJsonFileAtomic(target, {
    schema_version: "0.1",
    ...value
  });
  return target;
}

async function createCopiedBackup(nowText: string): Promise<{
  root: string;
  backupId: string;
  packagePath: string;
  catalogPath: string;
}> {
  const root = await createInitializedProject();
  const destination = await createTempProject();
  const catalogPath = path.join(await createTempProject(), "catalog.json");
  await writeState(root, "sample.json", { value: "saved" });
  const now = new Date(nowText);
  const backup = await createStateBackup(root, { now: () => now });
  const planned = await planDisasterRecoveryCopy(root, backup.backup_id, {
    destinationRoot: destination,
    minimumFreeBytes: 0,
    catalogPath,
    now: () => now
  });
  const copied = await copyDisasterRecoveryBackup(
    root,
    planned.plan.plan_id,
    {
      confirm: planned.plan.plan_id,
      catalogPath,
      now: () => now
    }
  );
  return {
    root,
    backupId: backup.backup_id,
    packagePath: copied.package_path,
    catalogPath
  };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else {
        files.push(target);
      }
    }
  };
  await walk(root);
  return files;
}

function payloadPath(packagePath: string, statePath: string): string {
  return path.join(
    packagePath,
    "files",
    ...statePath.slice(".kairon/".length).split("/")
  );
}
