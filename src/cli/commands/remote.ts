import { loadConfigFile } from "../../core/config/load-config.js";
import {
  prepareStableRemoteProfile,
  proposeStableRemoteMigration,
  type RemoteNotificationsConfig
} from "../../remote/profile.js";
import {
  formatStableRemoteStatus,
  inspectStableRemoteOperations,
  type RemoteProbeState
} from "../../remote/status.js";
import { recordRemoteReadiness } from "../../observability/runtime-metrics.js";
import { defaultWatchdogPolicy } from "../../runtime/watchdog-rules.js";

type OutputFormat = "text" | "json";

export async function showRemoteProfileCommand(
  projectRoot: string,
  options: { format?: string } = {}
): Promise<string> {
  const format = parseOutputFormat(options.format);
  const notifications = await loadNotifications(projectRoot);
  const profile = prepareStableRemoteProfile(notifications.remote);
  const migration = proposeStableRemoteMigration(notifications);
  const result = {
    schema_version: "0.1",
    profile: profile.profile,
    configured: profile.configured,
    discord_interactions_base_url: profile.discordInteractionsBaseUrl,
    board_base_url: profile.boardBaseUrl,
    trusted_proxies: profile.trustedProxies,
    allowed_origins: profile.allowedOrigins,
    identity_header: profile.identityHeader,
    missing_config: profile.missingConfig,
    invalid_config: profile.invalidConfig,
    migration_proposal: migration
  };
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    `remote.profile=${result.profile}`,
    `remote.configured=${result.configured}`,
    `remote.discord_interactions_base_url=${result.discord_interactions_base_url ?? "missing"}`,
    `remote.board_base_url=${result.board_base_url ?? "missing"}`,
    `remote.trusted_proxies=${result.trusted_proxies.length}`,
    `remote.allowed_origins=${result.allowed_origins.length}`,
    `remote.identity_header=${result.identity_header}`,
    `remote.missing_config=${result.missing_config.join(",") || "none"}`,
    `remote.invalid_config=${result.invalid_config.join(",") || "none"}`,
    `remote.migration_proposal=${result.migration_proposal === undefined ? "none" : "available"}`
  ].join("\n");
}

export async function validateRemoteProfileCommand(
  projectRoot: string,
  options: { format?: string } = {}
): Promise<string> {
  const format = parseOutputFormat(options.format);
  const notifications = await loadNotifications(projectRoot);
  const profile = prepareStableRemoteProfile(notifications.remote);
  const issues = [...profile.missingConfig, ...profile.invalidConfig];
  const status =
    issues.length > 0
      ? "setup_required"
      : profile.configured
        ? "ready"
        : "not_configured";
  const result = {
    schema_version: "0.1",
    profile: profile.profile,
    status,
    valid: status !== "setup_required",
    missing_config: profile.missingConfig,
    invalid_config: profile.invalidConfig
  };
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    `remote.profile=${result.profile}`,
    `remote.validation.status=${result.status}`,
    `remote.validation.valid=${result.valid}`,
    `remote.missing_config=${result.missing_config.join(",") || "none"}`,
    `remote.invalid_config=${result.invalid_config.join(",") || "none"}`
  ].join("\n");
}

export async function getRemoteStatusCommand(
  projectRoot: string,
  options: { format?: string } = {}
): Promise<string> {
  return formatStableRemoteStatus(
    await inspectStableRemoteOperations(projectRoot, {
      probeExternal: false,
      persist: false
    }),
    { format: parseOutputFormat(options.format) }
  );
}

export async function runRemoteDoctorCommand(
  projectRoot: string,
  options: { format?: string } = {}
): Promise<string> {
  const failureThreshold = await resolveRemoteFailureThreshold(projectRoot);
  const status = await inspectStableRemoteOperations(projectRoot, {
    probeExternal: true
  });
  await recordConfirmedRemoteReadiness(projectRoot, {
    provider: "discord",
    probe: status.discord.external_readiness,
    consecutiveFailures: status.discord.consecutive_failures,
    failureThreshold
  }).catch(() => undefined);
  await recordConfirmedRemoteReadiness(projectRoot, {
    provider: "board",
    probe: status.board.external_readiness,
    consecutiveFailures: status.board.consecutive_failures,
    failureThreshold
  }).catch(() => undefined);
  return formatStableRemoteStatus(status, {
    format: parseOutputFormat(options.format)
  });
}

type RemoteRuntimeConfig = {
  watchdog?: {
    rules?: {
      remote_external_unreachable?: {
        threshold?: number;
        threshold_seconds?: number;
      };
    };
  };
};

async function resolveRemoteFailureThreshold(projectRoot: string): Promise<number> {
  const runtime = await loadConfigFile<RemoteRuntimeConfig>(projectRoot, "runtime.json");
  const configured = runtime.watchdog?.rules?.remote_external_unreachable;
  return configured?.threshold_seconds ??
    configured?.threshold ??
    defaultWatchdogPolicy.rules.remote_external_unreachable.threshold;
}

async function recordConfirmedRemoteReadiness(
  projectRoot: string,
  input: {
    provider: "discord" | "board";
    probe: RemoteProbeState;
    consecutiveFailures: number;
    failureThreshold: number;
  }
): Promise<void> {
  if (
    input.probe === "unreachable" &&
    input.consecutiveFailures < input.failureThreshold
  ) {
    return;
  }
  await recordRemoteReadiness(projectRoot, {
    provider: input.provider,
    result: metricReadiness(input.probe)
  });
}

async function loadNotifications(
  projectRoot: string
): Promise<RemoteNotificationsConfig> {
  return loadConfigFile<RemoteNotificationsConfig>(
    projectRoot,
    "notifications.json"
  );
}

function parseOutputFormat(value: string | undefined): OutputFormat {
  const format = value ?? "text";
  if (format === "text" || format === "json") {
    return format;
  }
  throw new Error(`Unsupported output format: ${format}`);
}

function metricReadiness(
  value: RemoteProbeState
): "ready" | "unreachable" | "setup_required" | "unknown" {
  if (value === "ready" || value === "identity_enforced") {
    return "ready";
  }
  if (value === "unreachable" || value === "identity_bypass_detected") {
    return "unreachable";
  }
  return value === "not_checked" ? "unknown" : "setup_required";
}
