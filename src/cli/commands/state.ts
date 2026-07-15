import {
  createStateBackup,
  formatStateBackupCreate,
  formatStateBackupDryRun,
  formatStateBackupRehearsal,
  formatStateBackupRestore,
  formatStateBackupVerify,
  planStateBackup,
  rehearseStateBackup,
  restoreStateBackup,
  verifyStateBackup
} from "../../state/backup.js";
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
import {
  compactEventLogs,
  formatEventCompactionPlan,
  formatEventCompactionResult,
  formatEventCompactionVerification,
  planEventCompaction,
  verifyEventCompaction
} from "../../state/event-compaction.js";

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

export type StateEventsCompactCommandOptions = {
  dryRun?: boolean;
  confirm?: string;
  format?: string;
};

export type StateEventsVerifyCommandOptions = {
  format?: string;
};

export type StateBackupCreateCommandOptions = {
  dryRun?: boolean;
  output?: string;
  format?: string;
};

export type StateBackupCommandOptions = {
  source?: string;
  format?: string;
};

export type StateBackupRestoreCommandOptions = {
  confirm?: string;
  source?: string;
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

export async function stateEventsCompactCommand(
  projectRoot: string,
  options: StateEventsCompactCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  if (options.dryRun === true && options.confirm !== undefined) {
    throw new Error("Use either --dry-run or --confirm, not both.");
  }
  if (options.dryRun === true) {
    return formatEventCompactionPlan(await planEventCompaction(projectRoot), {
      format
    });
  }
  if (options.confirm === undefined) {
    throw new Error(
      "Event compaction requires --dry-run or --confirm <checkpoint-id>."
    );
  }

  return formatEventCompactionResult(
    await compactEventLogs(projectRoot, { confirm: options.confirm }),
    { format }
  );
}

export async function stateEventsVerifyCommand(
  projectRoot: string,
  checkpointId: string,
  options: StateEventsVerifyCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  return formatEventCompactionVerification(
    await verifyEventCompaction(projectRoot, checkpointId),
    { format }
  );
}

export async function stateBackupCreateCommand(
  projectRoot: string,
  options: StateBackupCreateCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  if (options.dryRun === true) {
    return formatStateBackupDryRun(await planStateBackup(projectRoot), { format });
  }

  return formatStateBackupCreate(
    await createStateBackup(projectRoot, { output: options.output }),
    { format }
  );
}

export async function stateBackupVerifyCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  return formatStateBackupVerify(
    await verifyStateBackup(projectRoot, backupId, { source: options.source }),
    { format }
  );
}

export async function stateBackupRehearseCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  return formatStateBackupRehearsal(
    await rehearseStateBackup(projectRoot, backupId, { source: options.source }),
    { format }
  );
}

export async function stateBackupRestoreCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupRestoreCommandOptions = {}
): Promise<string> {
  if (options.confirm === undefined) {
    throw new Error(`Backup restore requires --confirm ${backupId}.`);
  }

  const format = parseStateOutputFormat(options.format);
  return formatStateBackupRestore(
    await restoreStateBackup(projectRoot, backupId, {
      confirm: options.confirm,
      source: options.source
    }),
    { format }
  );
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
