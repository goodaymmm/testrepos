import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { listIncidents } from "../src/incidents/store.js";
import { inspectRuntimeRecoveryTargets } from "../src/recovery/runtime-recovery.js";
import {
  beginUpdateTransaction,
  finalizeUpdateTransaction,
  readActiveUpdateTransaction,
  readUpdateTransaction,
  updateTransactionMarkerPath
} from "../src/update/transaction.js";
import { createTempProject } from "./test-utils.js";

describe("update transaction", () => {
  it("persists preflight and removes the marker only after successful post-check", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const transaction = await beginUpdateTransaction(
      root,
      transactionInput(),
      transactionDependencies(root)
    );

    expect(transaction).toMatchObject({
      transaction_id: "UTX-0001",
      status: "running",
      phase: "preflight",
      package_sha256: "a".repeat(64),
      timeline: [
        { phase: "preflight", status: "passed", code: "preflight_passed" },
        { phase: "staging", status: "started", code: "staging_started" }
      ]
    });
    await expect(readActiveUpdateTransaction(root)).resolves.toMatchObject({
      transaction_id: "UTX-0001"
    });

    const completed = await finalizeUpdateTransaction(
      root,
      transaction.transaction_id,
      {
        status: "completed",
        phase: "completed",
        stateBackupId: "BKP-20260726000000000-aaaaaaaaaaaa",
        rollbackPackageSha256: "b".repeat(64)
      },
      { now: () => new Date("2026-07-26T00:01:00.000Z") }
    );

    expect(completed).toMatchObject({
      status: "completed",
      phase: "completed",
      state_backup_id: "BKP-20260726000000000-aaaaaaaaaaaa",
      rollback_package_sha256: "b".repeat(64)
    });
    await expect(readActiveUpdateTransaction(root)).resolves.toBeNull();
    await expect(access(transaction.staging_path)).rejects.toThrow();
    await expect(
      readUpdateTransaction(root, transaction.transaction_id)
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("blocks ambiguous reapplication and exposes the marker to runtime recovery", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dependencies = transactionDependencies(root);
    const transaction = await beginUpdateTransaction(
      root,
      transactionInput(),
      dependencies
    );

    await expect(
      beginUpdateTransaction(root, transactionInput(), dependencies)
    ).rejects.toThrow(
      `Update transaction ${transaction.transaction_id} is running`
    );
    const inspection = await inspectRuntimeRecoveryTargets(root);
    expect(inspection.summary.update_transaction_issues).toBe(1);
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      kind: "update_transaction_mid_state",
      target_id: transaction.transaction_id,
      target_type: "update_transaction",
      severity: "high"
    }));
  });

  it("retains a recovery marker and creates one critical incident on rollback failure", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const transaction = await beginUpdateTransaction(
      root,
      transactionInput(),
      transactionDependencies(root)
    );
    const failed = await finalizeUpdateTransaction(
      root,
      transaction.transaction_id,
      {
        status: "recovery_required",
        phase: "rollback",
        errorCode: "rollback_package_restore_failed"
      },
      { now: () => new Date("2026-07-26T00:02:00.000Z") }
    );

    expect(failed).toMatchObject({
      status: "recovery_required",
      phase: "rollback",
      error_code: "rollback_package_restore_failed",
      incident_id: "INC-0001"
    });
    await expect(access(updateTransactionMarkerPath(root))).resolves.toBeUndefined();
    await expect(listIncidents(root)).resolves.toMatchObject([
      {
        incident_id: "INC-0001",
        status: "open",
        severity: "critical",
        resources: [
          {
            kind: "update_transaction",
            id: "UTX-0001",
            status: "recovery_required"
          }
        ]
      }
    ]);
  });

  it("fails preflight before creating an active marker", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(beginUpdateTransaction(
      root,
      transactionInput(),
      {
        ...transactionDependencies(root),
        freeSpaceReader: async () => 1
      }
    )).rejects.toThrow("free bytes");
    await expect(readActiveUpdateTransaction(root)).resolves.toBeNull();
  });
});

function transactionInput() {
  return {
    action: "apply" as const,
    currentVersion: "0.2.0",
    targetVersion: "0.3.0",
    downloadId: "UPD-0001",
    packageSha256: "a".repeat(64),
    packageSizeBytes: 1024
  };
}

function transactionDependencies(root: string) {
  return {
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    stagingRoot: path.join(
      os.tmpdir(),
      `kairon-transaction-staging-${path.basename(root)}`
    ),
    freeSpaceReader: async () => 1024 * 1024 * 1024
  };
}
