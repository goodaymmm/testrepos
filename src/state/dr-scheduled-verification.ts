import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { loadConfigFile } from "../core/config/load-config.js";
import {
  acquireLockFile,
  LockAlreadyExistsError,
  releaseLockFile
} from "../core/fs/lock-file.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../core/fs/json-file.js";
import {
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import { sanitizeSupportText } from "../diagnostics/support-redaction.js";
import {
  BackupCatalog,
  BackupCatalogCorruptError,
  getBackupCatalogPath,
  type BackupCatalogOptions,
  type OffDeviceBackupCatalogEntry
} from "./backup-catalog.js";
import {
  DisasterRecoveryError,
  rehearseDisasterRecoveryBackup,
  verifyDisasterRecoveryBackup,
  type DisasterRecoveryRehearsalResult,
  type DisasterRecoveryVerifyResult
} from "./disaster-recovery.js";

export type ScheduledDrVerificationStatus =
  | "PASS"
  | "FAIL"
  | "SETUP_REQUIRED"
  | "BUSY";

export type ScheduledDrVerificationClassification =
  | "verified"
  | "disabled"
  | "busy"
  | "catalog_missing"
  | "catalog_unavailable"
  | "catalog_corrupt"
  | "destination_unavailable"
  | "generation_shortfall"
  | "backup_not_verified"
  | "backup_missing"
  | "backup_corrupt"
  | "verification_failed"
  | "rehearsal_failed";

export type ScheduledDrVerificationProfile = {
  schema_version: "0.1";
  enabled: boolean;
  task_name: string;
  catalog_path: string;
  interval_hours: number;
  rehearsal_interval_days: number;
  timeout_ms: number;
  minimum_generations: number;
  kairon_command: string;
  updated_at: string;
};

export type ScheduledDrTaskStatus = {
  schema_version: "0.1";
  status:
    | "registered"
    | "missing"
    | "disabled"
    | "foreign"
    | "error"
    | "unknown";
  task_name: string;
  action: "install" | "status" | "uninstall";
  managed: boolean;
  reason?: string;
  observed_at: string;
};

export type ScheduledDrVerificationResult = {
  schema_version: "0.1";
  artifact_kind: "scheduled_dr_verification";
  run_id: string;
  status: ScheduledDrVerificationStatus;
  classification: ScheduledDrVerificationClassification;
  project_id: string | null;
  backup_id: string | null;
  destination_id: string | null;
  catalog: {
    path_hash: string;
    sha256: string | null;
    entries: number;
    generations: number;
    minimum_generations: number;
  };
  verification: {
    status: "verified" | "failed" | "not_run";
    verified_at: string | null;
    verification_due_at: string | null;
  };
  rehearsal: {
    required: boolean;
    status: "passed" | "failed" | "not_due" | "not_run";
    rehearsed_at: string | null;
    next_due_at: string | null;
  };
  reason?: string;
  checked_at: string;
  next_run_at: string;
  operator_restore_command: string | null;
  automatic_restore: false;
  cleanup_performed: false;
  result_digest: string;
};

export type ScheduledDrVerificationStatusView = {
  schema_version: "0.1";
  enabled: boolean;
  profile: ScheduledDrVerificationProfile | null;
  task: ScheduledDrTaskStatus | null;
  latest: ScheduledDrVerificationResult | null;
  stale: boolean;
};

export type ScheduledDrInstallOptions = {
  taskName?: string;
  catalogPath?: string;
  intervalHours?: number;
  rehearsalIntervalDays?: number;
  timeoutMs?: number;
  minimumGenerations?: number;
  kaironCommand?: string;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
  powerShellCommand?: string;
  helperPath?: string;
  now?: () => Date;
};

export type ScheduledDrTaskActionOptions = {
  taskName?: string;
  catalogPath?: string;
  kaironCommand?: string;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
  powerShellCommand?: string;
  helperPath?: string;
  now?: () => Date;
};

export type ScheduledDrRunOptions = BackupCatalogOptions & {
  rehearsalIntervalDays?: number;
  timeoutMs?: number;
  minimumGenerations?: number;
  now?: () => Date;
  catalogFactory?: (options: BackupCatalogOptions) => BackupCatalog;
  verifyBackup?: typeof verifyDisasterRecoveryBackup;
  rehearseBackup?: typeof rehearseDisasterRecoveryBackup;
  probeDestination?: (
    entry: OffDeviceBackupCatalogEntry
  ) => Promise<"ready" | "destination_unavailable" | "backup_missing" | "backup_corrupt">;
};

export const defaultScheduledDrVerificationProfile = {
  interval_hours: 24,
  rehearsal_interval_days: 30,
  timeout_ms: 10 * 60_000,
  minimum_generations: 2
} as const;

const scheduleDirectory = ".kairon/state/dr-schedule";
const profileFile = "profile.json";
const taskStatusFile = "task-status.json";
const latestFile = "latest.json";
const lockFile = "run.lock";
const staleMultiplier = 3;

export async function installScheduledDrVerification(
  projectRoot: string,
  options: ScheduledDrInstallOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return setupRequired(platform);
  }
  const now = options.now?.() ?? new Date();
  const profile = normalizeProfile(projectRoot, {
    enabled: true,
    taskName: options.taskName,
    catalogPath: options.catalogPath,
    intervalHours: options.intervalHours,
    rehearsalIntervalDays: options.rehearsalIntervalDays,
    timeoutMs: options.timeoutMs,
    minimumGenerations: options.minimumGenerations,
    kaironCommand: options.kaironCommand,
    now
  });
  assertCatalogOutsideProject(projectRoot, profile.catalog_path);
  const action = await invokeTaskHelper("install", projectRoot, profile, options);
  if (action.status !== "registered") {
    return action.output;
  }
  await writeJsonFileAtomic(scheduledDrPaths(projectRoot).profile, profile);
  return action.output;
}

export async function uninstallScheduledDrVerification(
  projectRoot: string,
  options: ScheduledDrTaskActionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return setupRequired(platform);
  }
  const now = options.now?.() ?? new Date();
  const current = await readScheduledDrProfile(projectRoot);
  const profile =
    current ??
    normalizeProfile(projectRoot, {
      enabled: false,
      taskName: options.taskName,
      catalogPath: options.catalogPath,
      kaironCommand: options.kaironCommand,
      now
    });
  assertCatalogOutsideProject(projectRoot, profile.catalog_path);
  const action = await invokeTaskHelper("uninstall", projectRoot, profile, options);
  if (action.status === "foreign" || action.status === "error") {
    return action.output;
  }
  await writeJsonFileAtomic(scheduledDrPaths(projectRoot).profile, {
    ...profile,
    enabled: false,
    updated_at: now.toISOString()
  });
  return action.output;
}

export async function verifyScheduledDrTask(
  projectRoot: string,
  options: ScheduledDrTaskActionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return setupRequired(platform);
  }
  const now = options.now?.() ?? new Date();
  const current = await readScheduledDrProfile(projectRoot);
  const profile =
    current ??
    normalizeProfile(projectRoot, {
      enabled: false,
      taskName: options.taskName,
      catalogPath: options.catalogPath,
      kaironCommand: options.kaironCommand,
      now
    });
  assertCatalogOutsideProject(projectRoot, profile.catalog_path);
  return (await invokeTaskHelper("status", projectRoot, profile, options)).output;
}

export async function runScheduledDrVerification(
  projectRoot: string,
  options: ScheduledDrRunOptions = {}
): Promise<ScheduledDrVerificationResult> {
  const root = path.resolve(projectRoot);
  const now = options.now?.() ?? new Date();
  const profile = await readScheduledDrProfile(root);
  if (profile === null || !profile.enabled) {
    return writeScheduledResult(root, createResult({
      root,
      now,
      profile,
      status: "SETUP_REQUIRED",
      classification: "disabled",
      reason: "scheduled_dr_verification_disabled"
    }));
  }
  try {
    assertCatalogOutsideProject(root, profile.catalog_path);
  } catch {
    return writeScheduledResult(root, createResult({
      root,
      now,
      profile,
      status: "FAIL",
      classification: "catalog_corrupt",
      reason: "scheduled_dr_catalog_inside_project"
    }));
  }
  assertRunOptionsMatchProfile(profile, options);

  let lock;
  try {
    lock = await acquireLockFile(
      scheduledDrPaths(root).lock,
      `scheduled-dr-${process.pid}`,
      profile.timeout_ms + 30_000
    );
  } catch (error) {
    if (error instanceof LockAlreadyExistsError) {
      return createResult({
        root,
        now,
        profile,
        status: "BUSY",
        classification: "busy",
        reason: "scheduled_dr_verification_lock_held"
      });
    }
    throw error;
  }

  try {
    const catalogFactory =
      options.catalogFactory ?? ((catalogOptions) => new BackupCatalog(catalogOptions));
    const catalog = catalogFactory({
      catalogPath: profile.catalog_path,
      now: () => now
    });
    let catalogExists: boolean;
    try {
      catalogExists = await catalog.exists();
    } catch (error) {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: "SETUP_REQUIRED",
        classification: "catalog_unavailable",
        reason: unavailableReason(error, "off_device_backup_catalog_unavailable")
      }));
    }
    if (!catalogExists) {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: "SETUP_REQUIRED",
        classification: "catalog_missing",
        reason: "off_device_backup_catalog_missing"
      }));
    }

    let entries: OffDeviceBackupCatalogEntry[];
    try {
      const project = await loadConfigFile<{ project_id?: unknown }>(
        root,
        "project.json"
      );
      const projectId =
        typeof project.project_id === "string" && project.project_id.trim()
          ? project.project_id.trim()
          : path.basename(root);
      entries = await catalog.list(projectId);
    } catch (error) {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: isUnavailableError(error) ? "SETUP_REQUIRED" : "FAIL",
        classification:
          error instanceof BackupCatalogCorruptError
            ? "catalog_corrupt"
            : isUnavailableError(error)
              ? "catalog_unavailable"
              : "verification_failed",
        reason: safeReason(root, error)
      }));
    }

    const selected = selectLatestVerified(entries);
    if (selected === undefined) {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: "FAIL",
        classification:
          entries.length === 0 ? "generation_shortfall" : "backup_not_verified",
        reason:
          entries.length === 0
            ? "off_device_backup_generation_missing"
            : "off_device_backup_has_no_verified_generation",
        entries
      }));
    }
    const generations = entries.filter(
      (entry) =>
        normalizePath(entry.destination_root) ===
        normalizePath(selected.destination_root)
    );
    const probe = await (
      options.probeDestination ?? probeBackupDestination
    )(selected);
    if (probe !== "ready") {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: probe === "destination_unavailable" ? "SETUP_REQUIRED" : "FAIL",
        classification: probe,
        reason: probe,
        entries,
        selected,
        generations: generations.length
      }));
    }

    const rehearsalDue = isRehearsalDue(
      selected,
      profile.rehearsal_interval_days,
      now
    );
    let verification: DisasterRecoveryVerifyResult | undefined;
    let rehearsal: DisasterRecoveryRehearsalResult | undefined;
    try {
      if (rehearsalDue) {
        rehearsal = await withTimeout(
          (options.rehearseBackup ?? rehearseDisasterRecoveryBackup)(
            root,
            selected.backup_id,
            {
              catalogPath: profile.catalog_path,
              packagePath: selected.package_path,
              now: () => now
            }
          ),
          profile.timeout_ms
        );
      } else {
        verification = await withTimeout(
          (options.verifyBackup ?? verifyDisasterRecoveryBackup)(
            root,
            selected.backup_id,
            {
              catalogPath: profile.catalog_path,
              packagePath: selected.package_path,
              now: () => now
            }
          ),
          profile.timeout_ms
        );
      }
    } catch (error) {
      const classification = classifyRunError(error);
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status:
          classification === "destination_unavailable"
            ? "SETUP_REQUIRED"
            : "FAIL",
        classification,
        reason: safeReason(root, error),
        entries,
        selected,
        generations: generations.length,
        rehearsalDue
      }));
    }

    if (rehearsal?.status === "failed") {
      return writeScheduledResult(root, createResult({
        root,
        now,
        profile,
        status: "FAIL",
        classification: "rehearsal_failed",
        reason: "isolated_disaster_recovery_rehearsal_failed",
        entries,
        selected,
        generations: generations.length,
        rehearsalDue,
        rehearsal
      }));
    }

    const generationShortfall =
      generations.length < profile.minimum_generations;
    return writeScheduledResult(root, createResult({
      root,
      now,
      profile,
      status: generationShortfall ? "FAIL" : "PASS",
      classification: generationShortfall ? "generation_shortfall" : "verified",
      reason: generationShortfall
        ? `minimum_generations_not_met:${generations.length}/${profile.minimum_generations}`
        : undefined,
      entries,
      selected,
      generations: generations.length,
      rehearsalDue,
      verification,
      rehearsal
    }));
  } finally {
    await releaseLockFile(lock);
  }
}

export async function readScheduledDrProfile(
  projectRoot: string
): Promise<ScheduledDrVerificationProfile | null> {
  return readOptionalJson(
    scheduledDrPaths(projectRoot).profile,
    isScheduledDrProfile
  );
}

export async function readScheduledDrTaskStatus(
  projectRoot: string
): Promise<ScheduledDrTaskStatus | null> {
  return readOptionalJson(
    scheduledDrPaths(projectRoot).taskStatus,
    isScheduledDrTaskStatus
  );
}

export async function readLatestScheduledDrVerification(
  projectRoot: string
): Promise<ScheduledDrVerificationResult | null> {
  return readOptionalJson(
    scheduledDrPaths(projectRoot).latest,
    isScheduledDrResult
  );
}

export async function getScheduledDrVerificationStatus(
  projectRoot: string,
  options: { now?: () => Date } = {}
): Promise<ScheduledDrVerificationStatusView> {
  const now = options.now?.() ?? new Date();
  const [profile, task, latest] = await Promise.all([
    readScheduledDrProfile(projectRoot),
    readScheduledDrTaskStatus(projectRoot),
    readLatestScheduledDrVerification(projectRoot)
  ]);
  const stale =
    profile?.enabled === true &&
    (latest === null ||
      Date.parse(latest.checked_at) +
        profile.interval_hours * staleMultiplier * 60 * 60_000 <=
        now.getTime());
  return {
    schema_version: "0.1",
    enabled: profile?.enabled === true,
    profile,
    task,
    latest,
    stale
  };
}

export function formatScheduledDrVerification(
  result: ScheduledDrVerificationResult
): string {
  return [
    "Kairon scheduled off-device backup verification completed.",
    `status=${result.status}`,
    `classification=${result.classification}`,
    `run_id=${result.run_id}`,
    `project_id=${result.project_id ?? "none"}`,
    `backup_id=${result.backup_id ?? "none"}`,
    `catalog_entries=${result.catalog.entries}`,
    `generations=${result.catalog.generations}`,
    `minimum_generations=${result.catalog.minimum_generations}`,
    `verification_status=${result.verification.status}`,
    `rehearsal_required=${result.rehearsal.required}`,
    `rehearsal_status=${result.rehearsal.status}`,
    `operator_restore_command=${result.operator_restore_command ?? "none"}`,
    "automatic_restore=false",
    "cleanup_performed=false",
    ...(result.reason === undefined ? [] : [`reason=${result.reason}`])
  ].join("\n");
}

export function formatScheduledDrStatus(
  view: ScheduledDrVerificationStatusView
): string {
  return [
    "Kairon scheduled off-device backup verification status:",
    `enabled=${view.enabled}`,
    `task_name=${view.profile?.task_name ?? "none"}`,
    `task_status=${view.task?.status ?? "unknown"}`,
    `task_managed=${view.task?.managed ?? false}`,
    `interval_hours=${view.profile?.interval_hours ?? "none"}`,
    `rehearsal_interval_days=${view.profile?.rehearsal_interval_days ?? "none"}`,
    `timeout_ms=${view.profile?.timeout_ms ?? "none"}`,
    `minimum_generations=${view.profile?.minimum_generations ?? "none"}`,
    `last_run=${view.latest?.checked_at ?? "none"}`,
    `last_status=${view.latest?.status ?? "none"}`,
    `last_classification=${view.latest?.classification ?? "none"}`,
    `stale=${view.stale}`,
    "automatic_restore=false",
    "cleanup_performed=false"
  ].join("\n");
}

export function scheduledDrPaths(projectRoot: string): {
  directory: string;
  profile: string;
  taskStatus: string;
  latest: string;
  results: string;
  lock: string;
} {
  const directory = resolveInside(projectRoot, scheduleDirectory);
  return {
    directory,
    profile: resolveInside(directory, profileFile),
    taskStatus: resolveInside(directory, taskStatusFile),
    latest: resolveInside(directory, latestFile),
    results: resolveInside(directory, "results"),
    lock: resolveInside(directory, lockFile)
  };
}

async function invokeTaskHelper(
  action: "install" | "status" | "uninstall",
  projectRoot: string,
  profile: ScheduledDrVerificationProfile,
  options: ScheduledDrTaskActionOptions
): Promise<{
  status: ScheduledDrTaskStatus["status"];
  output: string;
}> {
  const helperPath =
    options.helperPath ??
    fileURLToPath(
      new URL("../../scripts/kairon-dr-verify-task.ps1", import.meta.url)
    );
  const helperAction = {
    install: "Register",
    status: "Verify",
    uninstall: "Unregister"
  }[action];
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-Action",
    helperAction,
    "-TaskName",
    profile.task_name,
    "-ProjectRoot",
    path.resolve(projectRoot),
    "-CatalogPath",
    profile.catalog_path,
    "-KaironCommand",
    profile.kairon_command,
    "-IntervalHours",
    String(profile.interval_hours),
    "-RehearsalIntervalDays",
    String(profile.rehearsal_interval_days),
    "-TimeoutMs",
    String(profile.timeout_ms),
    "-MinimumGenerations",
    String(profile.minimum_generations)
  ];
  const result = await (options.commandRunner ?? spawnCommandRunner)({
    command: options.powerShellCommand ?? "powershell.exe",
    args,
    cwd: path.resolve(projectRoot),
    timeoutMs: 120_000
  });
  const safeOutput = redactOutput(result.stdout || result.stderr).trim();
  const managed = /^task\.managed=true$/imu.test(safeOutput);
  const exists = /^task\.exists=true$/imu.test(safeOutput);
  const disabled = /^task\.state=disabled$/imu.test(safeOutput);
  const permissionDenied = isPermissionError(safeOutput);
  const status: ScheduledDrTaskStatus["status"] =
    result.exitCode !== 0 || result.timedOut
      ? !managed && exists
        ? "foreign"
        : "error"
      : !exists
        ? "missing"
        : !managed
          ? "foreign"
          : disabled
            ? "disabled"
            : "registered";
  const reason =
    status === "error"
      ? permissionDenied
        ? "task_scheduler_permission_denied"
        : "task_scheduler_command_failed"
      : status === "foreign"
        ? "task_is_not_managed_by_kairon"
        : undefined;
  await writeJsonFileAtomic(scheduledDrPaths(projectRoot).taskStatus, {
    schema_version: "0.1",
    status,
    task_name: profile.task_name,
    action,
    managed,
    reason,
    observed_at: (options.now?.() ?? new Date()).toISOString()
  } satisfies ScheduledDrTaskStatus);
  if (status === "error" || status === "foreign") {
    return {
      status,
      output: [
        "Kairon scheduled DR verification setup required.",
        "status=setup_required",
        `action=${action}`,
        `task_status=${status}`,
        `reason=${reason}`,
        ...(permissionDenied
          ? ["guidance=Run Windows PowerShell as Administrator and retry."]
          : []),
        ...(safeOutput ? safeOutput.split(/\r?\n/u) : [])
      ].join("\n")
    };
  }
  return {
    status,
    output: [
      "Kairon scheduled DR task command completed.",
      "status=completed",
      `action=${action}`,
      `task_status=${status}`,
      `task_name=${profile.task_name}`,
      `task_managed=${managed}`,
      ...(safeOutput ? safeOutput.split(/\r?\n/u) : [])
    ].join("\n")
  };
}

function normalizeProfile(
  projectRoot: string,
  input: {
    enabled: boolean;
    taskName?: string;
    catalogPath?: string;
    intervalHours?: number;
    rehearsalIntervalDays?: number;
    timeoutMs?: number;
    minimumGenerations?: number;
    kaironCommand?: string;
    now: Date;
  }
): ScheduledDrVerificationProfile {
  const catalogPath = path.resolve(
    input.catalogPath?.trim() || getBackupCatalogPath()
  );
  const taskName =
    input.taskName?.trim() ||
    `Kairon DR Verify ${sha256(path.resolve(projectRoot)).slice(0, 8)}`;
  if (!taskName || taskName.length > 120 || /[\r\n]/u.test(taskName)) {
    throw new Error("Scheduled DR task name is invalid.");
  }
  const kaironCommand = input.kaironCommand?.trim() || "kairon";
  if (!kaironCommand || /[\r\n]/u.test(kaironCommand)) {
    throw new Error("Scheduled DR Kairon command is invalid.");
  }
  return {
    schema_version: "0.1",
    enabled: input.enabled,
    task_name: taskName,
    catalog_path: catalogPath,
    interval_hours: boundedInteger(
      input.intervalHours ?? defaultScheduledDrVerificationProfile.interval_hours,
      "intervalHours",
      1,
      168
    ),
    rehearsal_interval_days: boundedInteger(
      input.rehearsalIntervalDays ??
        defaultScheduledDrVerificationProfile.rehearsal_interval_days,
      "rehearsalIntervalDays",
      1,
      365
    ),
    timeout_ms: boundedInteger(
      input.timeoutMs ?? defaultScheduledDrVerificationProfile.timeout_ms,
      "timeoutMs",
      1_000,
      60 * 60_000
    ),
    minimum_generations: boundedInteger(
      input.minimumGenerations ??
        defaultScheduledDrVerificationProfile.minimum_generations,
      "minimumGenerations",
      1,
      100
    ),
    kairon_command: kaironCommand,
    updated_at: input.now.toISOString()
  };
}

function assertRunOptionsMatchProfile(
  profile: ScheduledDrVerificationProfile,
  options: ScheduledDrRunOptions
): void {
  const requestedCatalog =
    options.catalogPath === undefined ? undefined : path.resolve(options.catalogPath);
  if (
    (requestedCatalog !== undefined &&
      normalizePath(requestedCatalog) !== normalizePath(profile.catalog_path)) ||
    (options.rehearsalIntervalDays !== undefined &&
      options.rehearsalIntervalDays !== profile.rehearsal_interval_days) ||
    (options.timeoutMs !== undefined &&
      options.timeoutMs !== profile.timeout_ms) ||
    (options.minimumGenerations !== undefined &&
      options.minimumGenerations !== profile.minimum_generations)
  ) {
    throw new Error("Scheduled DR task arguments do not match the installed profile.");
  }
}

function selectLatestVerified(
  entries: OffDeviceBackupCatalogEntry[]
): OffDeviceBackupCatalogEntry | undefined {
  return [...entries]
    .sort(
      (left, right) =>
        right.copied_at.localeCompare(left.copied_at) ||
        left.backup_id.localeCompare(right.backup_id)
    )
    .find((entry) => entry.verification_status === "verified");
}

async function probeBackupDestination(
  entry: OffDeviceBackupCatalogEntry
): Promise<"ready" | "destination_unavailable" | "backup_missing" | "backup_corrupt"> {
  try {
    const rootStats = await lstat(entry.destination_root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return "destination_unavailable";
    }
  } catch {
    return "destination_unavailable";
  }
  if (!isInside(entry.destination_root, entry.package_path)) {
    return "backup_corrupt";
  }
  try {
    const packageStats = await lstat(entry.package_path);
    if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
      return "backup_corrupt";
    }
    await access(entry.package_path);
    return "ready";
  } catch (error) {
    return isUnavailableError(error)
      ? "destination_unavailable"
      : "backup_missing";
  }
}

function isRehearsalDue(
  entry: OffDeviceBackupCatalogEntry,
  intervalDays: number,
  now: Date
): boolean {
  const rehearsedAt = Date.parse(entry.rehearsed_at ?? "");
  return (
    !Number.isFinite(rehearsedAt) ||
    rehearsedAt + intervalDays * 86_400_000 <= now.getTime()
  );
}

function classifyRunError(
  error: unknown
): ScheduledDrVerificationClassification {
  if (error instanceof ScheduledDrTimeoutError) {
    return "verification_failed";
  }
  if (error instanceof DisasterRecoveryError) {
    if (error.code === "destination_missing") {
      return "backup_missing";
    }
    if (
      error.code === "destination_tampered" ||
      error.code === "backup_schema_unsupported" ||
      error.code === "destination_symbolic_link"
    ) {
      return "backup_corrupt";
    }
  }
  return "verification_failed";
}

function createResult(input: {
  root: string;
  now: Date;
  profile: ScheduledDrVerificationProfile | null;
  status: ScheduledDrVerificationStatus;
  classification: ScheduledDrVerificationClassification;
  reason?: string;
  entries?: OffDeviceBackupCatalogEntry[];
  selected?: OffDeviceBackupCatalogEntry;
  generations?: number;
  rehearsalDue?: boolean;
  verification?: DisasterRecoveryVerifyResult;
  rehearsal?: DisasterRecoveryRehearsalResult;
}): ScheduledDrVerificationResult {
  const entries = input.entries ?? [];
  const selected = input.selected;
  const profile = input.profile;
  const checkedAt = input.now.toISOString();
  const rehearsalInterval =
    profile?.rehearsal_interval_days ??
    defaultScheduledDrVerificationProfile.rehearsal_interval_days;
  const rehearsalBase =
    input.rehearsal?.rehearsed_at ??
    selected?.rehearsed_at ??
    selected?.copied_at;
  const rehearsalNextDue =
    rehearsalBase === undefined
      ? null
      : new Date(
          Date.parse(rehearsalBase) + rehearsalInterval * 86_400_000
        ).toISOString();
  const catalogPath =
    profile?.catalog_path ?? getBackupCatalogPath();
  const base = {
    schema_version: "0.1" as const,
    artifact_kind: "scheduled_dr_verification" as const,
    run_id: createRunId(input.now, input.classification, selected?.backup_id),
    status: input.status,
    classification: input.classification,
    project_id: selected?.project_id ?? null,
    backup_id: selected?.backup_id ?? null,
    destination_id:
      selected === undefined
        ? null
        : `dst-${sha256(normalizePath(selected.destination_root)).slice(0, 12)}`,
    catalog: {
      path_hash: sha256(normalizePath(catalogPath)),
      sha256: null as string | null,
      entries: entries.length,
      generations: input.generations ?? 0,
      minimum_generations:
        profile?.minimum_generations ??
        defaultScheduledDrVerificationProfile.minimum_generations
    },
    verification: {
      status:
        input.verification?.status === "verified" ||
        input.rehearsal?.status === "passed"
          ? "verified" as const
          : input.status === "FAIL"
            ? "failed" as const
            : "not_run" as const,
      verified_at:
        input.verification?.verified_at ??
        (input.rehearsal === undefined ? null : input.now.toISOString()),
      verification_due_at:
        input.verification?.verification_due_at ??
        (selected?.verified_at === undefined
          ? null
          : new Date(
              Date.parse(selected.verified_at) +
                selected.verification_interval_days * 86_400_000
            ).toISOString())
    },
    rehearsal: {
      required: input.rehearsalDue === true,
      status:
        input.rehearsal?.status ??
        (input.rehearsalDue === true
          ? input.status === "FAIL"
            ? "failed" as const
            : "not_run" as const
          : selected === undefined
            ? "not_run" as const
            : "not_due" as const),
      rehearsed_at: input.rehearsal?.rehearsed_at ?? null,
      next_due_at: rehearsalNextDue
    },
    reason: input.reason,
    checked_at: checkedAt,
    next_run_at: new Date(
      input.now.getTime() +
        (profile?.interval_hours ??
          defaultScheduledDrVerificationProfile.interval_hours) *
          60 *
          60_000
    ).toISOString(),
    operator_restore_command:
      selected === undefined
        ? null
        : [
            "kairon state backup restore",
            quoteCommandArgument(selected.backup_id),
            "--source",
            quoteCommandArgument(selected.package_path),
            "--confirm",
            quoteCommandArgument(selected.backup_id)
          ].join(" "),
    automatic_restore: false as const,
    cleanup_performed: false as const
  };
  const result: ScheduledDrVerificationResult = {
    ...base,
    catalog: {
      ...base.catalog,
      sha256: null
    },
    result_digest: ""
  };
  result.result_digest = `sha256:${sha256(stableStringify({
    ...result,
    result_digest: undefined
  }))}`;
  return result;
}

async function writeScheduledResult(
  projectRoot: string,
  initial: ScheduledDrVerificationResult
): Promise<ScheduledDrVerificationResult> {
  const catalogPath =
    (await readScheduledDrProfile(projectRoot))?.catalog_path;
  const result =
    catalogPath === undefined
      ? initial
      : {
          ...initial,
          catalog: {
            ...initial.catalog,
            sha256: await catalogDigestAsync(catalogPath)
          }
        };
  result.result_digest = `sha256:${sha256(stableStringify({
    ...result,
    result_digest: undefined
  }))}`;
  const paths = scheduledDrPaths(projectRoot);
  await writeJsonFileAtomic(
    resolveInside(paths.results, `${result.run_id}.json`),
    result
  );
  await writeJsonFileAtomic(paths.latest, result);
  return result;
}

async function readOptionalJson<T>(
  filePath: string,
  validator: (value: unknown) => value is T
): Promise<T | null> {
  try {
    const value = await readJsonFile<unknown>(filePath);
    if (!validator(value)) {
      throw new Error(`Scheduled DR artifact is invalid: ${toPosixPath(filePath)}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isScheduledDrProfile(
  value: unknown
): value is ScheduledDrVerificationProfile {
  const record = asRecord(value);
  return (
    record?.schema_version === "0.1" &&
    typeof record.enabled === "boolean" &&
    typeof record.task_name === "string" &&
    record.task_name.length > 0 &&
    record.task_name.length <= 120 &&
    !/[\r\n]/u.test(record.task_name) &&
    typeof record.catalog_path === "string" &&
    path.isAbsolute(record.catalog_path) &&
    isPositiveInteger(record.interval_hours) &&
    Number(record.interval_hours) <= 168 &&
    isPositiveInteger(record.rehearsal_interval_days) &&
    Number(record.rehearsal_interval_days) <= 365 &&
    isPositiveInteger(record.timeout_ms) &&
    Number(record.timeout_ms) >= 1_000 &&
    Number(record.timeout_ms) <= 60 * 60_000 &&
    isPositiveInteger(record.minimum_generations) &&
    Number(record.minimum_generations) <= 100 &&
    typeof record.kairon_command === "string" &&
    record.kairon_command.length > 0 &&
    !/[\r\n]/u.test(record.kairon_command) &&
    isDate(record.updated_at)
  );
}

function isScheduledDrTaskStatus(value: unknown): value is ScheduledDrTaskStatus {
  const record = asRecord(value);
  return (
    record?.schema_version === "0.1" &&
    typeof record.status === "string" &&
    ["registered", "missing", "disabled", "foreign", "error", "unknown"].includes(
      record.status
    ) &&
    typeof record.task_name === "string" &&
    typeof record.action === "string" &&
    ["install", "status", "uninstall"].includes(record.action) &&
    typeof record.managed === "boolean" &&
    (record.reason === undefined || typeof record.reason === "string") &&
    isDate(record.observed_at)
  );
}

function isScheduledDrResult(
  value: unknown
): value is ScheduledDrVerificationResult {
  const record = asRecord(value);
  const catalog = asRecord(record?.catalog);
  const verification = asRecord(record?.verification);
  const rehearsal = asRecord(record?.rehearsal);
  const structurallyValid =
    record?.schema_version === "0.1" &&
    record.artifact_kind === "scheduled_dr_verification" &&
    typeof record.run_id === "string" &&
    typeof record.status === "string" &&
    ["PASS", "FAIL", "SETUP_REQUIRED", "BUSY"].includes(record.status) &&
    typeof record.classification === "string" &&
    [
      "verified",
      "disabled",
      "busy",
      "catalog_missing",
      "catalog_unavailable",
      "catalog_corrupt",
      "destination_unavailable",
      "generation_shortfall",
      "backup_not_verified",
      "backup_missing",
      "backup_corrupt",
      "verification_failed",
      "rehearsal_failed"
    ].includes(record.classification) &&
    (record.project_id === null || typeof record.project_id === "string") &&
    (record.backup_id === null || typeof record.backup_id === "string") &&
    (record.destination_id === null || typeof record.destination_id === "string") &&
    typeof catalog?.path_hash === "string" &&
    /^[a-f0-9]{64}$/u.test(catalog.path_hash) &&
    (catalog.sha256 === null ||
      (typeof catalog.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(catalog.sha256))) &&
    Number.isSafeInteger(catalog.entries) &&
    Number(catalog.entries) >= 0 &&
    Number.isSafeInteger(catalog.generations) &&
    Number(catalog.generations) >= 0 &&
    isPositiveInteger(catalog.minimum_generations) &&
    typeof verification?.status === "string" &&
    ["verified", "failed", "not_run"].includes(verification.status) &&
    (verification.verified_at === null || isDate(verification.verified_at)) &&
    (verification.verification_due_at === null ||
      isDate(verification.verification_due_at)) &&
    typeof rehearsal?.required === "boolean" &&
    typeof rehearsal.status === "string" &&
    ["passed", "failed", "not_due", "not_run"].includes(rehearsal.status) &&
    (rehearsal.rehearsed_at === null || isDate(rehearsal.rehearsed_at)) &&
    (rehearsal.next_due_at === null || isDate(rehearsal.next_due_at)) &&
    (record.reason === undefined || typeof record.reason === "string") &&
    isDate(record.checked_at) &&
    isDate(record.next_run_at) &&
    (record.operator_restore_command === null ||
      typeof record.operator_restore_command === "string") &&
    record.automatic_restore === false &&
    record.cleanup_performed === false &&
    typeof record.result_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(record.result_digest);
  if (!structurallyValid) {
    return false;
  }
  return record.result_digest === `sha256:${sha256(stableStringify({
    ...record,
    result_digest: undefined
  }))}`;
}

function setupRequired(platform: string): string {
  return [
    "Kairon scheduled DR verification setup required.",
    "status=setup_required",
    `platform=${platform}`,
    "reason=windows_task_scheduler_required"
  ].join("\n");
}

function assertCatalogOutsideProject(
  projectRoot: string,
  catalogPath: string
): void {
  if (isInside(path.resolve(projectRoot), path.resolve(catalogPath))) {
    throw new Error("Scheduled DR catalog must be outside the source project.");
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function classifyPermissionText(value: string): string {
  return value.toLowerCase();
}

function isPermissionError(value: string): boolean {
  const normalized = classifyPermissionText(value);
  return [
    "access is denied",
    "access denied",
    "permission denied",
    "requested operation requires elevation",
    "unauthorizedaccessexception",
    "0x80070005"
  ].some((candidate) => normalized.includes(candidate));
}

function isUnavailableError(error: unknown): boolean {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code).toUpperCase()
      : "";
  return ["EACCES", "EPERM", "EBUSY", "ENODEV", "ENXIO"].includes(code);
}

function unavailableReason(error: unknown, fallback: string): string {
  if (!isUnavailableError(error)) {
    return fallback;
  }
  const code = String((error as { code?: unknown }).code).toLowerCase();
  return `${fallback}:${code}`;
}

function redactOutput(value: string): string {
  return sanitizeSupportText(value)
    .replace(
      /(github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|Bot\s+[A-Za-z0-9._-]+)/gu,
      "[redacted]"
    );
}

function safeReason(projectRoot: string, error: unknown): string {
  if (error instanceof DisasterRecoveryError) {
    return error.code;
  }
  if (error instanceof BackupCatalogCorruptError) {
    return "backup_catalog_corrupt";
  }
  if (error instanceof ScheduledDrTimeoutError) {
    return "scheduled_dr_verification_timeout";
  }
  return sanitizeSupportText(
    error instanceof Error ? error.name : String(error),
    { projectRoot }
  ).slice(0, 160);
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function quoteCommandArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function createRunId(
  now: Date,
  classification: ScheduledDrVerificationClassification,
  backupId: string | undefined
): string {
  return `DRV-${formatTimestamp(now)}-${sha256(
    `${classification}:${backupId ?? "none"}:${now.toISOString()}`
  ).slice(0, 10)}`;
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/\D/gu, "").slice(0, 17);
}

async function catalogDigestAsync(filePath: string): Promise<string | null> {
  try {
    return sha256(await readFile(filePath));
  } catch {
    return null;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  if (Array.isArray(normalized)) {
    return `[${normalized.map(stableStringify).join(",")}]`;
  }
  if (normalized !== null && typeof normalized === "object") {
    return `{${Object.entries(normalized as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(normalized);
}

class ScheduledDrTimeoutError extends Error {
  constructor() {
    super("Scheduled DR verification timed out.");
    this.name = "ScheduledDrTimeoutError";
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ScheduledDrTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
