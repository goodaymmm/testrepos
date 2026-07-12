import {
  checkStateIntegrity,
  formatStateIntegrityCheck
} from "../../state/integrity-check.js";
import {
  collectStateSnapshotDryRun,
  createStateSnapshot,
  formatStateSnapshotCreate,
  formatStateSnapshotDryRun,
  formatStateSnapshotRestorePlan,
  formatStateSnapshotRestoreResult,
  planStateSnapshotRestore,
  restoreStateSnapshot
} from "../../state/snapshot.js";

export type StateCheckCommandOptions = {
  format?: string;
};

export type StateSnapshotCommandOptions = {
  dryRun?: boolean;
  format?: string;
};

export type StateSnapshotRestoreCommandOptions = {
  dryRun?: boolean;
  confirm?: string;
  format?: string;
};

export async function stateCheckCommand(
  projectRoot: string,
  options: StateCheckCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  const result = await checkStateIntegrity(projectRoot);
  return formatStateIntegrityCheck(result, { format });
}

export async function stateSnapshotCommand(
  projectRoot: string,
  options: StateSnapshotCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  if (options.dryRun === true) {
    const result = await collectStateSnapshotDryRun(projectRoot);
    return formatStateSnapshotDryRun(result, { format });
  }

  const result = await createStateSnapshot(projectRoot);
  return formatStateSnapshotCreate(result, { format });
}

export async function stateSnapshotRestoreCommand(
  projectRoot: string,
  snapshotId: string,
  options: StateSnapshotRestoreCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  if (options.dryRun === true && options.confirm !== undefined) {
    throw new Error("Use either --dry-run or --confirm, not both.");
  }
  if (options.dryRun === true) {
    const result = await planStateSnapshotRestore(projectRoot, snapshotId);
    return formatStateSnapshotRestorePlan(result, { format });
  }
  if (options.confirm === undefined) {
    throw new Error(
      `Restore requires --dry-run or --confirm ${snapshotId}.`
    );
  }

  const result = await restoreStateSnapshot(projectRoot, snapshotId, {
    confirm: options.confirm
  });
  return formatStateSnapshotRestoreResult(result, { format });
}

function parseStateOutputFormat(value: string | undefined): "text" | "json" {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }

  throw new Error(`Invalid state output format: ${value}`);
}
