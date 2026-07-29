import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
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
  appendJsonLine,
  readJsonLines
} from "../core/fs/jsonl-file.js";
import {
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import {
  resolveGitHubTokenSecret,
  type GitHubTokenLookupOptions,
  type ResolvedSecret,
  type SecretResolver
} from "../core/secrets/secret-resolver.js";
import {
  createDiscordRestNotificationChannel,
  notifyScheduledUpdateRelease
} from "../discord/watchdog-notifier.js";
import {
  prepareDiscordGateway,
  type PreparedDiscordGateway
} from "../discord/gateway.js";
import type { DiscordApprovalChannel } from "../discord/approval-notifier.js";
import {
  evaluateAlertPolicyNotification,
  resolveAlertPolicy,
  type AlertPolicyDecision,
  type PreparedAlertPolicy
} from "../notifications/alert-policy.js";
import { getLocalDateKey } from "../runtime/schedule-engine.js";
import { readWatchdogAuditRecords } from "../runtime/watchdog.js";
import {
  checkForUpdate,
  type UpdateCheckResult,
  type UpdateDependencies
} from "./downloader.js";
import {
  requireUpdateChannel,
  type UpdateChannelConfig
} from "./channel.js";
import {
  loadUpdateRegistry,
  updateRegistryPath
} from "./registry.js";

export type ScheduledUpdateClassification =
  | "new_release"
  | "current"
  | "pinned_mismatch"
  | "remote_unavailable";

export type ScheduledUpdateRunStatus =
  | "completed"
  | "setup_required"
  | "busy";

export type ScheduledUpdateNotificationStatus =
  | "not_required"
  | "sent"
  | "aggregated"
  | "deduplicated"
  | "deferred"
  | "suppressed"
  | "setup_required"
  | "failed";

export type ScheduledUpdateProfile = {
  schema_version: "0.1";
  enabled: boolean;
  task_name: string;
  interval_hours: number;
  timeout_ms: number;
  cooldown_hours: number;
  token_env?: string;
  kairon_command: string;
  updated_at: string;
};

export type ScheduledUpdateTaskStatus = {
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

export type ScheduledUpdateNotificationResult = {
  status: ScheduledUpdateNotificationStatus;
  fingerprint?: string;
  policy_decision?: AlertPolicyDecision["decision"];
  policy_reason?: string;
  defer_until?: string;
  message_id?: string;
};

export type ScheduledUpdateCheckResult = {
  schema_version: "0.1";
  artifact_kind: "scheduled_update_check";
  check_id: string;
  status: ScheduledUpdateRunStatus;
  classification: ScheduledUpdateClassification;
  repository: string | null;
  channel: UpdateChannelConfig["channel"] | null;
  current_version: string;
  selected_version: string | null;
  selected_release_id: number | null;
  selected_tag: string | null;
  selected_source_commit: string | null;
  credential: {
    status: "present" | "missing";
    provider: string | null;
    source: string | null;
  };
  notification: ScheduledUpdateNotificationResult;
  manual_download_command: string | null;
  read_only_guard: {
    project_state_digest_before: string;
    project_state_digest_after: string;
    update_registry_digest_before: string;
    update_registry_digest_after: string;
    update_downloads_digest_before: string;
    update_downloads_digest_after: string;
    mutation_detected: boolean;
  };
  reason?: string;
  checked_at: string;
  next_run_at: string;
  automatic_download: false;
  automatic_apply: false;
  automatic_restart: false;
  result_digest: string;
};

export type ScheduledUpdateStatusView = {
  schema_version: "0.1";
  enabled: boolean;
  profile: ScheduledUpdateProfile | null;
  task: ScheduledUpdateTaskStatus | null;
  latest: ScheduledUpdateCheckResult | null;
  stale: boolean;
  credential: {
    status: "present" | "missing";
    provider: string | null;
    source: string | null;
  };
};

export type ScheduledUpdateInstallOptions = {
  taskName?: string;
  intervalHours?: number;
  timeoutMs?: number;
  cooldownHours?: number;
  tokenEnv?: string;
  kaironCommand?: string;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
  powerShellCommand?: string;
  helperPath?: string;
  now?: () => Date;
};

export type ScheduledUpdateRunOptions = {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  secretResolver?: SecretResolver;
  updateDependencies?: UpdateDependencies;
  updateCheck?: typeof checkForUpdate;
  resolveGitHubToken?: (
    options?: GitHubTokenLookupOptions
  ) => Promise<ResolvedSecret>;
  resolvePolicy?: (projectRoot: string) => Promise<PreparedAlertPolicy>;
  prepareDiscord?: (
    projectRoot: string,
    env?: NodeJS.ProcessEnv,
    secretResolver?: SecretResolver
  ) => Promise<PreparedDiscordGateway>;
  channelFactory?: (
    gateway: PreparedDiscordGateway & { status: "ready" }
  ) => Promise<DiscordApprovalChannel>;
  notifyDiscord?: typeof notifyScheduledUpdateRelease;
  readWatchdogAudit?: (
    projectRoot: string
  ) => Promise<Record<string, unknown>[]>;
};

export type ScheduledUpdateTaskActionOptions = {
  taskName?: string;
  platform?: NodeJS.Platform;
  commandRunner?: CommandRunner;
  powerShellCommand?: string;
  helperPath?: string;
  kaironCommand?: string;
  now?: () => Date;
};

export const defaultScheduledUpdateProfile = {
  interval_hours: 24,
  timeout_ms: 60_000,
  cooldown_hours: 24
} as const;

const scheduleDirectory = ".kairon/update/schedule";
const profileFile = "profile.json";
const taskStatusFile = "task-status.json";
const latestResultFile = "latest.json";
const notificationAuditFile = "notifications.jsonl";
const lockFile = "run.lock";
const resultLifetimeMultiplier = 3;

export async function installScheduledUpdateCheck(
  projectRoot: string,
  options: ScheduledUpdateInstallOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      "Kairon scheduled update check setup required.",
      "status=setup_required",
      `platform=${platform}`,
      "reason=windows_task_scheduler_required"
    ].join("\n");
  }
  const now = options.now?.() ?? new Date();
  const profile = normalizeProfile(projectRoot, {
    enabled: true,
    taskName: options.taskName,
    intervalHours: options.intervalHours,
    timeoutMs: options.timeoutMs,
    cooldownHours: options.cooldownHours,
    tokenEnv: options.tokenEnv,
    kaironCommand: options.kaironCommand,
    now
  });
  const actionResult = await invokeTaskHelper("install", projectRoot, profile, {
    ...options,
    now: () => now
  });
  if (actionResult.status !== "registered") {
    return actionResult.output;
  }
  await writeJsonFileAtomic(scheduledUpdatePaths(projectRoot).profile, profile);
  return actionResult.output;
}

export async function uninstallScheduledUpdateCheck(
  projectRoot: string,
  options: ScheduledUpdateTaskActionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      "Kairon scheduled update check setup required.",
      "status=setup_required",
      `platform=${platform}`,
      "reason=windows_task_scheduler_required"
    ].join("\n");
  }
  const current = await readScheduledUpdateProfile(projectRoot);
  const now = options.now?.() ?? new Date();
  const profile =
    current ??
    normalizeProfile(projectRoot, {
      enabled: false,
      taskName: options.taskName,
      kaironCommand: options.kaironCommand,
      now
    });
  const result = await invokeTaskHelper("uninstall", projectRoot, profile, {
    ...options,
    now: () => now
  });
  if (result.status === "foreign" || result.status === "error") {
    return result.output;
  }
  await writeJsonFileAtomic(scheduledUpdatePaths(projectRoot).profile, {
    ...profile,
    enabled: false,
    updated_at: now.toISOString()
  });
  return result.output;
}

export async function verifyScheduledUpdateTask(
  projectRoot: string,
  options: ScheduledUpdateTaskActionOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      "Kairon scheduled update check setup required.",
      "status=setup_required",
      `platform=${platform}`,
      "reason=windows_task_scheduler_required"
    ].join("\n");
  }
  const current = await readScheduledUpdateProfile(projectRoot);
  const now = options.now?.() ?? new Date();
  const profile =
    current ??
    normalizeProfile(projectRoot, {
      enabled: false,
      taskName: options.taskName,
      kaironCommand: options.kaironCommand,
      now
    });
  return (await invokeTaskHelper("status", projectRoot, profile, {
    ...options,
    now: () => now
  })).output;
}

export async function runScheduledUpdateCheck(
  projectRoot: string,
  currentVersion: string,
  options: ScheduledUpdateRunOptions = {}
): Promise<ScheduledUpdateCheckResult> {
  const root = path.resolve(projectRoot);
  const paths = scheduledUpdatePaths(root);
  const now = options.now?.() ?? new Date();
  const profile = await readScheduledUpdateProfile(root);
  const guardBefore = await readOnlyGuard(root);
  if (profile === null || !profile.enabled) {
    return writeScheduledResult(root, createUnavailableResult({
      root,
      now,
      profile,
      currentVersion,
      guardBefore,
      reason: "scheduled_update_check_disabled"
    }));
  }

  let lock;
  try {
    lock = await acquireLockFile(
      paths.lock,
      `scheduled-update-${process.pid}`,
      profile.timeout_ms + 30_000
    );
  } catch (error) {
    if (error instanceof LockAlreadyExistsError) {
      return writeScheduledResult(root, createUnavailableResult({
        root,
        now,
        profile,
        currentVersion,
        guardBefore,
        status: "busy",
        reason: "scheduled_update_check_lock_held"
      }));
    }
    throw error;
  }

  try {
    let channel: UpdateChannelConfig;
    try {
      channel = await requireUpdateChannel(root);
    } catch {
      return writeScheduledResult(root, createUnavailableResult({
        root,
        now,
        profile,
        currentVersion,
        guardBefore,
        reason: "update_channel_missing"
      }));
    }
    await loadUpdateRegistry(root, currentVersion, () => now);
    const resolveToken =
      options.resolveGitHubToken ?? resolveGitHubTokenSecret;
    const credential = await resolveToken({
      env: options.env,
      envName: profile.token_env,
      resolver: options.secretResolver
    });
    if (credential.status !== "present") {
      return writeScheduledResult(root, await createRemoteUnavailableResult({
        root,
        now,
        profile,
        currentVersion,
        channel,
        credential,
        guardBefore,
        reason: "github_token_missing"
      }));
    }

    let update: UpdateCheckResult;
    try {
      update = await withTimeout(
        (options.updateCheck ?? checkForUpdate)(
          root,
          currentVersion,
          { tokenEnv: profile.token_env },
          {
            ...options.updateDependencies,
            env: options.env,
            secretResolver: options.secretResolver,
            now: () => now
          }
        ),
        profile.timeout_ms
      );
    } catch (error) {
      return writeScheduledResult(root, await createRemoteUnavailableResult({
        root,
        now,
        profile,
        currentVersion,
        channel,
        credential,
        guardBefore,
        reason: sanitizeReason(error)
      }));
    }

    const classification = classifyScheduledUpdate(channel, update);
    const fingerprint = notificationFingerprint(update);
    const manualDownload =
      classification === "new_release" ||
      classification === "pinned_mismatch"
        ? `kairon update download ${update.selected_version}`
        : null;
    const notification =
      classification === "current" || manualDownload === null
        ? { status: "not_required" as const }
        : await processNotification(
            root,
            profile,
            update,
            classification,
            {
              ...options,
              now: () => now
            },
            fingerprint,
            manualDownload
          );
    const guardAfter = await readOnlyGuard(root);
    const checkedAt = now.toISOString();
    const result = finalizeResult({
      status: "completed",
      classification,
      channel,
      currentVersion,
      update,
      credential,
      notification,
      manualDownload,
      guardBefore,
      guardAfter,
      checkedAt,
      nextRunAt: new Date(
        now.getTime() + profile.interval_hours * 60 * 60_000
      ).toISOString()
    });
    return writeScheduledResult(root, result);
  } finally {
    await releaseLockFile(lock);
  }
}

export async function readScheduledUpdateProfile(
  projectRoot: string
): Promise<ScheduledUpdateProfile | null> {
  return readOptionalJson<ScheduledUpdateProfile>(
    scheduledUpdatePaths(projectRoot).profile,
    isScheduledUpdateProfile
  );
}

export async function readScheduledUpdateTaskStatus(
  projectRoot: string
): Promise<ScheduledUpdateTaskStatus | null> {
  return readOptionalJson<ScheduledUpdateTaskStatus>(
    scheduledUpdatePaths(projectRoot).taskStatus,
    isScheduledUpdateTaskStatus
  );
}

export async function readLatestScheduledUpdateCheck(
  projectRoot: string
): Promise<ScheduledUpdateCheckResult | null> {
  return readOptionalJson<ScheduledUpdateCheckResult>(
    scheduledUpdatePaths(projectRoot).latest,
    isScheduledUpdateCheckResult
  );
}

export async function getScheduledUpdateStatus(
  projectRoot: string,
  options: {
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
    secretResolver?: SecretResolver;
  } = {}
): Promise<ScheduledUpdateStatusView> {
  const now = options.now?.() ?? new Date();
  const profile = await readScheduledUpdateProfile(projectRoot);
  const [task, latest, credential] = await Promise.all([
    readScheduledUpdateTaskStatus(projectRoot),
    readLatestScheduledUpdateCheck(projectRoot),
    resolveGitHubTokenSecret({
      env: options.env,
      envName: profile?.token_env,
      resolver: options.secretResolver
    })
  ]);
  const stale =
    profile?.enabled === true &&
    (latest === null ||
      Date.parse(latest.checked_at) +
        profile.interval_hours *
          resultLifetimeMultiplier *
          60 *
          60_000 <=
        now.getTime());
  return {
    schema_version: "0.1",
    enabled: profile?.enabled === true,
    profile,
    task,
    latest,
    stale,
    credential: credentialView(credential)
  };
}

export function formatScheduledUpdateRun(
  result: ScheduledUpdateCheckResult
): string {
  return [
    "Kairon scheduled update check completed.",
    `status=${result.status}`,
    `classification=${result.classification}`,
    `repository=${result.repository ?? "none"}`,
    `channel=${result.channel ?? "none"}`,
    `current_version=${result.current_version}`,
    `selected_version=${result.selected_version ?? "none"}`,
    `selected_release_id=${result.selected_release_id ?? "none"}`,
    `notification_status=${result.notification.status}`,
    `credential_status=${result.credential.status}`,
    `credential_provider=${result.credential.provider ?? "none"}`,
    `manual_download_command=${result.manual_download_command ?? "none"}`,
    `mutation_detected=${result.read_only_guard.mutation_detected}`,
    `checked_at=${result.checked_at}`,
    `next_run_at=${result.next_run_at}`,
    "automatic_download=false",
    "automatic_apply=false",
    "automatic_restart=false",
    ...(result.reason === undefined ? [] : [`reason=${result.reason}`])
  ].join("\n");
}

export function formatScheduledUpdateStatus(
  view: ScheduledUpdateStatusView
): string {
  return [
    "Kairon scheduled update status:",
    `enabled=${view.enabled}`,
    `task_name=${view.profile?.task_name ?? "none"}`,
    `task_status=${view.task?.status ?? "unknown"}`,
    `task_managed=${view.task?.managed ?? false}`,
    `interval_hours=${view.profile?.interval_hours ?? "none"}`,
    `timeout_ms=${view.profile?.timeout_ms ?? "none"}`,
    `cooldown_hours=${view.profile?.cooldown_hours ?? "none"}`,
    `last_run=${view.latest?.checked_at ?? "none"}`,
    `next_run=${view.latest?.next_run_at ?? "none"}`,
    `last_result=${view.latest?.classification ?? "none"}`,
    `last_status=${view.latest?.status ?? "none"}`,
    `stale=${view.stale}`,
    `credential_status=${view.credential.status}`,
    `credential_provider=${view.credential.provider ?? "none"}`,
    `credential_source=${view.credential.source ?? "none"}`,
    "automatic_download=false",
    "automatic_apply=false",
    "automatic_restart=false"
  ].join("\n");
}

export function scheduledUpdatePaths(projectRoot: string): {
  directory: string;
  profile: string;
  taskStatus: string;
  latest: string;
  results: string;
  notificationAudit: string;
  lock: string;
} {
  const directory = resolveInside(projectRoot, scheduleDirectory);
  return {
    directory,
    profile: resolveInside(directory, profileFile),
    taskStatus: resolveInside(directory, taskStatusFile),
    latest: resolveInside(directory, latestResultFile),
    results: resolveInside(directory, "results"),
    notificationAudit: resolveInside(directory, notificationAuditFile),
    lock: resolveInside(directory, lockFile)
  };
}

async function processNotification(
  projectRoot: string,
  profile: ScheduledUpdateProfile,
  update: UpdateCheckResult,
  classification: Extract<
    ScheduledUpdateClassification,
    "new_release" | "pinned_mismatch"
  >,
  options: ScheduledUpdateRunOptions,
  fingerprint: string,
  manualDownload: string
): Promise<ScheduledUpdateNotificationResult> {
  const now = options.now?.() ?? new Date();
  let audit: NotificationAuditRecord[];
  try {
    audit = await readNotificationAudit(projectRoot);
  } catch {
    return {
      status: "failed",
      fingerprint,
      policy_reason: "notification_audit_invalid"
    };
  }
  const previous = [...audit]
    .reverse()
    .find((entry) => entry.fingerprint === fingerprint);
  if (
    previous?.status === "sent" ||
    previous?.status === "aggregated"
  ) {
    const result: ScheduledUpdateNotificationResult = {
      status: "deduplicated",
      fingerprint,
      policy_reason: "release_already_notified"
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
  if (
    previous !== undefined &&
    Date.parse(previous.recorded_at) +
      profile.cooldown_hours * 60 * 60_000 >
      now.getTime()
  ) {
    const result: ScheduledUpdateNotificationResult = {
      status: "deferred",
      fingerprint,
      policy_reason: "cooldown",
      defer_until: new Date(
        Date.parse(previous.recorded_at) +
          profile.cooldown_hours * 60 * 60_000
      ).toISOString()
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }

  let preparedPolicy: PreparedAlertPolicy;
  try {
    preparedPolicy = await (options.resolvePolicy ?? resolveAlertPolicy)(
      projectRoot
    );
  } catch {
    const result: ScheduledUpdateNotificationResult = {
      status: "failed",
      fingerprint,
      policy_reason: "alert_policy_unavailable"
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
  const sentToday = await countSentToday(
    projectRoot,
    audit,
    now,
    preparedPolicy.policy.timezone,
    options.readWatchdogAudit ?? readWatchdogAuditRecords
  );
  const policyDecision = evaluateAlertPolicyNotification(
    preparedPolicy.policy,
    {
      severity: "warning",
      event: "open"
    },
    {
      now,
      sent_today: sentToday
    }
  );
  if (policyDecision.decision === "defer") {
    const result: ScheduledUpdateNotificationResult = {
      status: "deferred",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: policyDecision.reason,
      defer_until: policyDecision.defer_until
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
  if (policyDecision.decision === "suppress") {
    const result: ScheduledUpdateNotificationResult = {
      status: "suppressed",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: policyDecision.reason
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }

  const prepareDiscord = options.prepareDiscord ?? prepareDiscordGateway;
  let gateway: PreparedDiscordGateway;
  try {
    gateway = await prepareDiscord(
      projectRoot,
      options.env,
      options.secretResolver
    );
  } catch {
    const result: ScheduledUpdateNotificationResult = {
      status: "failed",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: "discord_setup_failed"
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
  if (gateway.status !== "ready") {
    const result: ScheduledUpdateNotificationResult = {
      status: "setup_required",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: gateway.reason
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
  try {
    const channel = await (
      options.channelFactory ??
      ((ready) =>
        createDiscordRestNotificationChannel(
          ready.bot_token,
          ready.approval_channel_id
        ))
    )(gateway);
    const sent = await (
      options.notifyDiscord ?? notifyScheduledUpdateRelease
    )(channel, {
      repository: update.repository,
      channel: update.channel,
      version: update.selected_version,
      release_id: update.selected_release_id,
      status: classification,
      download_command: manualDownload,
      fingerprint,
      aggregated: policyDecision.decision === "aggregate"
    });
    const result: ScheduledUpdateNotificationResult = {
      status:
        policyDecision.decision === "aggregate" ? "aggregated" : "sent",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: policyDecision.reason,
      message_id: sent.message_id
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  } catch (error) {
    const result: ScheduledUpdateNotificationResult = {
      status: "failed",
      fingerprint,
      policy_decision: policyDecision.decision,
      policy_reason: sanitizeReason(error)
    };
    await appendNotificationAudit(projectRoot, update, result, now);
    return result;
  }
}

type NotificationAuditRecord = {
  schema_version: "0.1";
  fingerprint: string;
  repository: string;
  channel: string;
  version: string;
  release_id: number;
  status: ScheduledUpdateNotificationStatus;
  policy_decision?: AlertPolicyDecision["decision"];
  policy_reason?: string;
  defer_until?: string;
  message_id?: string;
  recorded_at: string;
};

async function appendNotificationAudit(
  projectRoot: string,
  update: UpdateCheckResult,
  result: ScheduledUpdateNotificationResult,
  now: Date
): Promise<void> {
  if (result.fingerprint === undefined) {
    return;
  }
  await appendJsonLine(scheduledUpdatePaths(projectRoot).notificationAudit, {
    schema_version: "0.1",
    fingerprint: result.fingerprint,
    repository: update.repository,
    channel: update.channel,
    version: update.selected_version,
    release_id: update.selected_release_id,
    status: result.status,
    policy_decision: result.policy_decision,
    policy_reason: result.policy_reason,
    defer_until: result.defer_until,
    message_id: result.message_id,
    recorded_at: now.toISOString()
  } satisfies NotificationAuditRecord);
}

async function readNotificationAudit(
  projectRoot: string
): Promise<NotificationAuditRecord[]> {
  try {
    const records = await readJsonLines<unknown>(
      scheduledUpdatePaths(projectRoot).notificationAudit
    );
    if (!records.every(isNotificationAuditRecord)) {
      throw new Error("Scheduled update notification audit is invalid.");
    }
    return records;
  } catch (error) {
    if (isMissingError(error)) {
      return [];
    }
    throw error;
  }
}

function isNotificationAuditRecord(
  value: unknown
): value is NotificationAuditRecord {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.repository === "string" &&
    typeof candidate.channel === "string" &&
    typeof candidate.version === "string" &&
    Number.isInteger(candidate.release_id) &&
    [
      "not_required",
      "sent",
      "aggregated",
      "deduplicated",
      "deferred",
      "suppressed",
      "setup_required",
      "failed"
    ].includes(String(candidate.status)) &&
    typeof candidate.recorded_at === "string" &&
    Number.isFinite(Date.parse(candidate.recorded_at));
}

async function countSentToday(
  projectRoot: string,
  updateAudit: NotificationAuditRecord[],
  now: Date,
  timezone: string,
  readWatchdogAudit: (
    projectRoot: string
  ) => Promise<Record<string, unknown>[]>
): Promise<number> {
  const localDate = getLocalDateKey(now, timezone);
  const ownMessageIds = new Set(
    updateAudit
      .filter(
        (entry) =>
          (entry.status === "sent" || entry.status === "aggregated") &&
          getLocalDateKey(new Date(entry.recorded_at), timezone) === localDate
      )
      .map((entry) => entry.message_id ?? entry.fingerprint)
  );
  let watchdog: Record<string, unknown>[] = [];
  try {
    watchdog = await readWatchdogAudit(projectRoot);
  } catch {
    // Missing derived watchdog audit does not block the update check.
  }
  const watchdogMessageIds = new Set<string>();
  for (const record of watchdog) {
    if (
      record.event !== "notification.sent" ||
      typeof record.created_at !== "string" ||
      getLocalDateKey(new Date(record.created_at), timezone) !== localDate
    ) {
      continue;
    }
    watchdogMessageIds.add(
      typeof record.message_id === "string"
        ? record.message_id
        : `${String(record.alert_id)}:${record.created_at}`
    );
  }
  return ownMessageIds.size + watchdogMessageIds.size;
}

async function createRemoteUnavailableResult(input: {
  root: string;
  now: Date;
  profile: ScheduledUpdateProfile;
  currentVersion: string;
  channel: UpdateChannelConfig;
  credential: ResolvedSecret;
  guardBefore: Awaited<ReturnType<typeof readOnlyGuard>>;
  reason: string;
}): Promise<ScheduledUpdateCheckResult> {
  const guardAfter = await readOnlyGuard(input.root);
  return finalizeResult({
    status: "setup_required",
    classification: "remote_unavailable",
    channel: input.channel,
    currentVersion: input.currentVersion,
    credential: input.credential,
    notification: {
      status: "not_required"
    },
    manualDownload: null,
    guardBefore: input.guardBefore,
    guardAfter,
    checkedAt: input.now.toISOString(),
    nextRunAt: new Date(
      input.now.getTime() +
        input.profile.interval_hours * 60 * 60_000
    ).toISOString(),
    reason: input.reason
  });
}

function createUnavailableResult(input: {
  root: string;
  now: Date;
  profile: ScheduledUpdateProfile | null;
  currentVersion: string;
  guardBefore: Awaited<ReturnType<typeof readOnlyGuard>>;
  status?: ScheduledUpdateRunStatus;
  reason: string;
}): ScheduledUpdateCheckResult {
  return finalizeResult({
    status: input.status ?? "setup_required",
    classification: "remote_unavailable",
    channel: null,
    currentVersion: input.currentVersion,
    credential: {
      status: "missing",
      reason: "not_resolved"
    },
    notification: { status: "not_required" },
    manualDownload: null,
    guardBefore: input.guardBefore,
    guardAfter: input.guardBefore,
    checkedAt: input.now.toISOString(),
    nextRunAt: new Date(
      input.now.getTime() +
        (input.profile?.interval_hours ??
          defaultScheduledUpdateProfile.interval_hours) *
          60 *
          60_000
    ).toISOString(),
    reason: input.reason
  });
}

function finalizeResult(input: {
  status: ScheduledUpdateRunStatus;
  classification: ScheduledUpdateClassification;
  channel: UpdateChannelConfig | null;
  currentVersion: string;
  update?: UpdateCheckResult;
  credential: ResolvedSecret;
  notification: ScheduledUpdateNotificationResult;
  manualDownload: string | null;
  guardBefore: Awaited<ReturnType<typeof readOnlyGuard>>;
  guardAfter: Awaited<ReturnType<typeof readOnlyGuard>>;
  checkedAt: string;
  nextRunAt: string;
  reason?: string;
}): ScheduledUpdateCheckResult {
  const guard = {
    project_state_digest_before: input.guardBefore.projectState,
    project_state_digest_after: input.guardAfter.projectState,
    update_registry_digest_before: input.guardBefore.registry,
    update_registry_digest_after: input.guardAfter.registry,
    update_downloads_digest_before: input.guardBefore.downloads,
    update_downloads_digest_after: input.guardAfter.downloads,
    mutation_detected:
      input.guardBefore.projectState !== input.guardAfter.projectState ||
      input.guardBefore.registry !== input.guardAfter.registry ||
      input.guardBefore.downloads !== input.guardAfter.downloads
  };
  const digestInput = {
    status: input.status,
    classification: input.classification,
    repository: input.update?.repository ?? input.channel?.repository ?? null,
    channel: input.update?.channel ?? input.channel?.channel ?? null,
    current_version: input.currentVersion,
    selected_version: input.update?.selected_version ?? null,
    selected_release_id: input.update?.selected_release_id ?? null,
    selected_source_commit: input.update?.selected_source_commit ?? null,
    notification: input.notification,
    read_only_guard: guard,
    reason: input.reason ?? null,
    checked_at: input.checkedAt
  };
  const digest = sha256Json(digestInput);
  return {
    schema_version: "0.1",
    artifact_kind: "scheduled_update_check",
    check_id: `SUC-${compactTimestamp(input.checkedAt)}-${digest.slice(0, 12)}`,
    status: guard.mutation_detected ? "setup_required" : input.status,
    classification: guard.mutation_detected
      ? "remote_unavailable"
      : input.classification,
    repository: input.update?.repository ?? input.channel?.repository ?? null,
    channel: input.update?.channel ?? input.channel?.channel ?? null,
    current_version: input.currentVersion,
    selected_version: input.update?.selected_version ?? null,
    selected_release_id: input.update?.selected_release_id ?? null,
    selected_tag: input.update?.selected_tag ?? null,
    selected_source_commit: input.update?.selected_source_commit ?? null,
    credential: credentialView(input.credential),
    notification: input.notification,
    manual_download_command: input.manualDownload,
    read_only_guard: guard,
    reason: guard.mutation_detected
      ? "read_only_guard_detected_mutation"
      : input.reason,
    checked_at: input.checkedAt,
    next_run_at: input.nextRunAt,
    automatic_download: false,
    automatic_apply: false,
    automatic_restart: false,
    result_digest: `sha256:${digest}`
  };
}

async function writeScheduledResult(
  projectRoot: string,
  resultOrPromise:
    | ScheduledUpdateCheckResult
    | Promise<ScheduledUpdateCheckResult>
): Promise<ScheduledUpdateCheckResult> {
  const result = await resultOrPromise;
  const paths = scheduledUpdatePaths(projectRoot);
  await writeJsonFileAtomic(
    resolveInside(paths.results, `${result.check_id}.json`),
    result
  );
  await writeJsonFileAtomic(paths.latest, result);
  return result;
}

function classifyScheduledUpdate(
  channel: UpdateChannelConfig,
  update: UpdateCheckResult
): Exclude<ScheduledUpdateClassification, "remote_unavailable"> {
  if (
    channel.channel === "pinned" &&
    update.selected_version !== update.current_version
  ) {
    return "pinned_mismatch";
  }
  return update.status === "update_available"
    ? "new_release"
    : update.status === "current"
      ? "current"
      : "pinned_mismatch";
}

function notificationFingerprint(update: UpdateCheckResult): string {
  return `scheduled-update:${sha256Json({
    repository: update.repository,
    channel: update.channel,
    version: update.selected_version,
    release_id: update.selected_release_id
  })}`;
}

async function invokeTaskHelper(
  action: "install" | "status" | "uninstall",
  projectRoot: string,
  profile: ScheduledUpdateProfile,
  options: ScheduledUpdateTaskActionOptions & {
    commandRunner?: CommandRunner;
    powerShellCommand?: string;
    helperPath?: string;
  }
): Promise<{
  status: ScheduledUpdateTaskStatus["status"];
  output: string;
}> {
  const helperPath =
    options.helperPath ??
    fileURLToPath(
      new URL("../../scripts/kairon-update-check-task.ps1", import.meta.url)
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
    "-KaironCommand",
    profile.kairon_command,
    "-IntervalHours",
    String(profile.interval_hours)
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
  const status: ScheduledUpdateTaskStatus["status"] =
    result.exitCode !== 0 || result.timedOut
      ? managed === false && exists
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
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  await writeJsonFileAtomic(scheduledUpdatePaths(projectRoot).taskStatus, {
    schema_version: "0.1",
    status,
    task_name: profile.task_name,
    action,
    managed,
    reason,
    observed_at: observedAt
  } satisfies ScheduledUpdateTaskStatus);
  if (status === "error" || status === "foreign") {
    return {
      status,
      output: [
        "Kairon scheduled update check setup required.",
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
      "Kairon scheduled update task command completed.",
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
    intervalHours?: number;
    timeoutMs?: number;
    cooldownHours?: number;
    tokenEnv?: string;
    kaironCommand?: string;
    now: Date;
  }
): ScheduledUpdateProfile {
  const taskName =
    input.taskName?.trim() ||
    `Kairon Update Check ${sha256Text(path.resolve(projectRoot)).slice(0, 8)}`;
  if (
    taskName.length === 0 ||
    taskName.length > 120 ||
    /[\r\n]/u.test(taskName)
  ) {
    throw new Error("Scheduled update task name is invalid.");
  }
  const tokenEnv = input.tokenEnv?.trim();
  if (
    tokenEnv !== undefined &&
    !/^[A-Z_][A-Z0-9_]{0,79}$/u.test(tokenEnv)
  ) {
    throw new Error("Scheduled update token env name is invalid.");
  }
  const kaironCommand = input.kaironCommand?.trim() || "kairon";
  if (kaironCommand.length === 0 || /[\r\n]/u.test(kaironCommand)) {
    throw new Error("Scheduled update Kairon command is invalid.");
  }
  return {
    schema_version: "0.1",
    enabled: input.enabled,
    task_name: taskName,
    interval_hours: boundedInteger(
      input.intervalHours ??
        defaultScheduledUpdateProfile.interval_hours,
      "intervalHours",
      1,
      168
    ),
    timeout_ms: boundedInteger(
      input.timeoutMs ?? defaultScheduledUpdateProfile.timeout_ms,
      "timeoutMs",
      1_000,
      10 * 60_000
    ),
    cooldown_hours: boundedInteger(
      input.cooldownHours ??
        defaultScheduledUpdateProfile.cooldown_hours,
      "cooldownHours",
      1,
      720
    ),
    ...(tokenEnv === undefined ? {} : { token_env: tokenEnv }),
    kairon_command: kaironCommand,
    updated_at: input.now.toISOString()
  };
}

async function readOnlyGuard(projectRoot: string): Promise<{
  projectState: string;
  registry: string;
  downloads: string;
}> {
  const stateRoots = [
    resolveInside(projectRoot, ".kairon", "config"),
    resolveInside(projectRoot, ".kairon", "state"),
    resolveInside(projectRoot, ".kairon", "project.json"),
    resolveInside(projectRoot, "package.json")
  ];
  return {
    projectState: await digestPaths(projectRoot, stateRoots),
    registry: await digestPaths(projectRoot, [
      updateRegistryPath(projectRoot)
    ]),
    downloads: await digestPaths(projectRoot, [
      resolveInside(projectRoot, ".kairon", "update", "downloads")
    ])
  };
}

async function digestPaths(
  projectRoot: string,
  roots: string[]
): Promise<string> {
  const entries: Array<{ path: string; digest: string }> = [];
  for (const root of roots) {
    await collectDigestEntries(projectRoot, root, entries);
  }
  return sha256Json(entries.sort((left, right) =>
    left.path.localeCompare(right.path)
  ));
}

async function collectDigestEntries(
  projectRoot: string,
  candidate: string,
  entries: Array<{ path: string; digest: string }>
): Promise<void> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw error;
  }
  const relative = toPosixPath(path.relative(projectRoot, candidate)) || ".";
  if (info.isSymbolicLink()) {
    entries.push({
      path: relative,
      digest: sha256Text("symbolic_link_not_followed")
    });
    return;
  }
  if (info.isFile()) {
    entries.push({
      path: relative,
      digest: sha256Bytes(await readFile(candidate))
    });
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  for (const name of (await readdir(candidate)).sort()) {
    await collectDigestEntries(
      projectRoot,
      resolveInside(candidate, name),
      entries
    );
  }
}

async function readOptionalJson<T>(
  filePath: string,
  validate: (value: unknown) => value is T
): Promise<T | null> {
  try {
    const value = await readJsonFile<unknown>(filePath);
    return validate(value) ? value : null;
  } catch {
    return null;
  }
}

function isScheduledUpdateProfile(
  value: unknown
): value is ScheduledUpdateProfile {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.task_name === "string" &&
    Number.isInteger(candidate.interval_hours) &&
    Number.isInteger(candidate.timeout_ms) &&
    Number.isInteger(candidate.cooldown_hours) &&
    (candidate.token_env === undefined ||
      typeof candidate.token_env === "string") &&
    typeof candidate.kairon_command === "string" &&
    typeof candidate.updated_at === "string";
}

function isScheduledUpdateTaskStatus(
  value: unknown
): value is ScheduledUpdateTaskStatus {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    typeof candidate.status === "string" &&
    typeof candidate.task_name === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.managed === "boolean" &&
    typeof candidate.observed_at === "string";
}

function isScheduledUpdateCheckResult(
  value: unknown
): value is ScheduledUpdateCheckResult {
  const candidate = record(value);
  return candidate?.schema_version === "0.1" &&
    candidate.artifact_kind === "scheduled_update_check" &&
    typeof candidate.check_id === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.classification === "string" &&
    typeof candidate.current_version === "string" &&
    typeof candidate.checked_at === "string" &&
    typeof candidate.next_run_at === "string" &&
    typeof candidate.result_digest === "string";
}

function credentialView(resolved: ResolvedSecret): {
  status: "present" | "missing";
  provider: string | null;
  source: string | null;
} {
  return {
    status: resolved.status,
    provider:
      resolved.status === "present" ? resolved.provider : resolved.provider ?? null,
    source: resolved.source ?? null
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("scheduled_update_check_timed_out")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function sanitizeReason(error: unknown): string {
  const value = String(error)
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
  if (value.includes("scheduled_update_check_timed_out")) {
    return "remote_check_timed_out";
  }
  if (/GitHub token is required/iu.test(value)) {
    return "github_token_missing";
  }
  return "remote_check_failed";
}

function redactOutput(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [redacted]");
}

function isPermissionError(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "access denied",
    "access is denied",
    "0x80070005",
    "unauthorizedaccessexception",
    "アクセスが拒否"
  ].some((pattern) => normalized.includes(pattern));
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return value;
}

function compactTimestamp(value: string): string {
  return value.replace(/\D/gu, "").slice(0, 17);
}

function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ||
    String(error).includes("ENOENT");
}
