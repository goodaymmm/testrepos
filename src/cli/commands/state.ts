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
import {
  copyDisasterRecoveryBackup,
  planDisasterRecoveryCopy,
  rehearseDisasterRecoveryBackup,
  verifyDisasterRecoveryBackup
} from "../../state/disaster-recovery.js";
import {
  formatScheduledDrStatus,
  formatScheduledDrVerification,
  getScheduledDrVerificationStatus,
  installScheduledDrVerification,
  runScheduledDrVerification,
  uninstallScheduledDrVerification,
  verifyScheduledDrTask
} from "../../state/dr-scheduled-verification.js";

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

export type StateBackupDrPlanCommandOptions = {
  destination: string;
  source?: string;
  minimumFreeBytes?: string;
  verificationIntervalDays?: string;
  maxBackups?: string;
  maxAgeDays?: string;
  minKeep?: string;
  catalogPath?: string;
  format?: string;
};

export type StateBackupDrCopyCommandOptions = {
  confirm?: string;
  catalogPath?: string;
  format?: string;
};

export type StateBackupDrCatalogCommandOptions = {
  packagePath?: string;
  catalogPath?: string;
  format?: string;
};

export type StateBackupDrScheduleInstallCommandOptions = {
  taskName?: string;
  catalogPath?: string;
  intervalHours?: string;
  rehearsalIntervalDays?: string;
  timeoutMs?: string;
  minimumGenerations?: string;
  kaironCommand?: string;
};

export type StateBackupDrScheduleTaskCommandOptions = {
  taskName?: string;
  catalogPath?: string;
  kaironCommand?: string;
};

export type StateBackupDrScheduleRunCommandOptions = {
  catalogPath?: string;
  rehearsalIntervalDays?: string;
  timeoutMs?: string;
  minimumGenerations?: string;
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

export async function stateBackupDrPlanCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupDrPlanCommandOptions
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  const result = await planDisasterRecoveryCopy(projectRoot, backupId, {
    destinationRoot: options.destination,
    source: options.source,
    minimumFreeBytes: parseOptionalInteger(
      options.minimumFreeBytes,
      "minimum-free-bytes",
      true
    ),
    verificationIntervalDays: parseOptionalInteger(
      options.verificationIntervalDays,
      "verification-interval-days"
    ),
    maxBackups: parseOptionalInteger(options.maxBackups, "max-backups"),
    maxAgeDays: parseOptionalInteger(options.maxAgeDays, "max-age-days"),
    minKeep: parseOptionalInteger(options.minKeep, "min-keep"),
    catalogPath: options.catalogPath
  });
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return [
    "Kairon off-device backup plan created.",
    `plan_id=${result.plan.plan_id}`,
    `backup_id=${result.plan.backup_id}`,
    `destination=${result.plan.destination.destination_root}`,
    `package=${result.plan.destination_package_path}`,
    `source_digest=${result.plan.source_content_sha256}`,
    `retention_candidates=${result.plan.retention_candidates.length}`,
    `plan_path=${result.plan_path}`,
    `confirm=${result.plan.confirmation.expected}`
  ].join("\n");
}

export async function stateBackupDrCopyCommand(
  projectRoot: string,
  planId: string,
  options: StateBackupDrCopyCommandOptions
): Promise<string> {
  if (options.confirm === undefined) {
    throw new Error(`Off-device backup copy requires --confirm ${planId}.`);
  }
  const format = parseStateOutputFormat(options.format);
  const result = await copyDisasterRecoveryBackup(projectRoot, planId, {
    confirm: options.confirm,
    catalogPath: options.catalogPath
  });
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return [
    "Kairon off-device backup copied.",
    `status=${result.status}`,
    `plan_id=${result.plan_id}`,
    `backup_id=${result.backup_id}`,
    `package=${result.package_path}`,
    `content_sha256=${result.content_sha256}`,
    `verified_at=${result.verified_at}`,
    `retention_removed=${result.retention_removed.join(",") || "none"}`
  ].join("\n");
}

export async function stateBackupDrVerifyCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupDrCatalogCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  const result = await verifyDisasterRecoveryBackup(projectRoot, backupId, {
    packagePath: options.packagePath,
    catalogPath: options.catalogPath
  });
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return [
    "Kairon off-device backup verified.",
    `backup_id=${result.backup_id}`,
    `package=${result.package_path}`,
    `content_sha256=${result.content_sha256}`,
    `verified_at=${result.verified_at}`,
    `verification_due_at=${result.verification_due_at}`
  ].join("\n");
}

export async function stateBackupDrRehearseCommand(
  projectRoot: string,
  backupId: string,
  options: StateBackupDrCatalogCommandOptions = {}
): Promise<string> {
  const format = parseStateOutputFormat(options.format);
  const result = await rehearseDisasterRecoveryBackup(projectRoot, backupId, {
    packagePath: options.packagePath,
    catalogPath: options.catalogPath
  });
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return [
    "Kairon off-device disaster recovery rehearsal completed.",
    `status=${result.status}`,
    `backup_id=${result.backup_id}`,
    `package=${result.package_path}`,
    `integrity_status=${result.integrity.status}`,
    `config_ok=${result.config_validation.ok}`,
    `workflow_replay=${result.workflow_replay.status}`,
    `cleaned_up=${result.cleaned_up}`
  ].join("\n");
}

export async function stateBackupDrScheduleInstallCommand(
  projectRoot: string,
  options: StateBackupDrScheduleInstallCommandOptions = {}
): Promise<string> {
  return installScheduledDrVerification(projectRoot, {
    taskName: options.taskName,
    catalogPath: options.catalogPath,
    intervalHours: parseOptionalInteger(options.intervalHours, "interval-hours"),
    rehearsalIntervalDays: parseOptionalInteger(
      options.rehearsalIntervalDays,
      "rehearsal-interval-days"
    ),
    timeoutMs: parseOptionalInteger(options.timeoutMs, "timeout-ms"),
    minimumGenerations: parseOptionalInteger(
      options.minimumGenerations,
      "minimum-generations"
    ),
    kaironCommand: options.kaironCommand
  });
}

export async function stateBackupDrScheduleStatusCommand(
  projectRoot: string,
  options: StateBackupDrScheduleTaskCommandOptions = {}
): Promise<string> {
  const taskOutput = await verifyScheduledDrTask(projectRoot, options);
  const status = await getScheduledDrVerificationStatus(projectRoot);
  return `${taskOutput}\n${formatScheduledDrStatus(status)}`;
}

export async function stateBackupDrScheduleRunCommand(
  projectRoot: string,
  options: StateBackupDrScheduleRunCommandOptions = {}
): Promise<string> {
  return formatScheduledDrVerification(
    await runScheduledDrVerification(projectRoot, {
      catalogPath: options.catalogPath,
      rehearsalIntervalDays: parseOptionalInteger(
        options.rehearsalIntervalDays,
        "rehearsal-interval-days"
      ),
      timeoutMs: parseOptionalInteger(options.timeoutMs, "timeout-ms"),
      minimumGenerations: parseOptionalInteger(
        options.minimumGenerations,
        "minimum-generations"
      )
    })
  );
}

export async function stateBackupDrScheduleUninstallCommand(
  projectRoot: string,
  options: StateBackupDrScheduleTaskCommandOptions = {}
): Promise<string> {
  return uninstallScheduledDrVerification(projectRoot, options);
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

function parseOptionalInteger(
  value: string | undefined,
  name: string,
  allowZero = false
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(
      `--${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`
    );
  }
  return parsed;
}
