import path from "node:path";
import { getBoardServerStatus } from "../board/server.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  getDiscordHttpServerStatus,
  type DiscordHttpServerRuntimeStatus
} from "../discord/http-server.js";
import {
  prepareStableRemoteProfile,
  stableRemoteProfileName,
  type RemoteNotificationsConfig
} from "./profile.js";

const identityEnforcementHeader = "x-kairon-identity-enforced";
const identityEnforcementValue = "verified";
const defaultFailureStreakWindowMs = 30 * 60 * 1_000;

export type RemoteEndpointState =
  | "not_configured"
  | "missing"
  | "ready"
  | "stopped"
  | "setup_required"
  | "disabled"
  | "error";

export type RemoteProbeState =
  | "not_checked"
  | "ready"
  | "unreachable"
  | "identity_enforced"
  | "identity_bypass_detected";

export type StableRemoteOperationsStatus = {
  schema_version: "0.1";
  profile: "disabled" | typeof stableRemoteProfileName;
  status: "not_configured" | "setup_required" | "ready" | "degraded";
  config: {
    status: "not_configured" | "setup_required" | "ready";
    missing: string[];
    invalid: string[];
  };
  discord: {
    local_status: RemoteEndpointState;
    expected_url?: string;
    observed_url?: string;
    url_drift: boolean;
    external_readiness: RemoteProbeState;
    consecutive_failures: number;
  };
  board: {
    local_status: RemoteEndpointState;
    expected_url?: string;
    observed_url?: string;
    url_drift: boolean;
    external_readiness: RemoteProbeState;
    consecutive_failures: number;
  };
  identity: {
    header: string;
    status: "not_configured" | "not_checked" | "enforced" | "bypass_detected";
  };
  tunnel: {
    status: "not_configured" | "not_checked" | "connected" | "disconnected";
    consecutive_failures: number;
  };
  issues: string[];
  checked_at: string;
  status_path: string;
};

export type StableRemoteStatusOptions = {
  now?: () => Date;
  probeExternal?: boolean;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  failureStreakWindowMs?: number;
  persist?: boolean;
};

export async function inspectStableRemoteOperations(
  projectRoot: string,
  options: StableRemoteStatusOptions = {}
): Promise<StableRemoteOperationsStatus> {
  const now = options.now?.() ?? new Date();
  const notifications = await loadConfigFile<RemoteNotificationsConfig>(
    projectRoot,
    "notifications.json"
  );
  const profile = prepareStableRemoteProfile(notifications.remote);
  const statusPath = stableRemoteStatusPath(projectRoot);
  const statusPathRelative = toPosixPath(path.relative(projectRoot, statusPath));
  const configIssues = [...profile.missingConfig, ...profile.invalidConfig];

  if (!profile.configured) {
    const invalid = profile.invalidConfig.length > 0;
    const result: StableRemoteOperationsStatus = {
      schema_version: "0.1",
      profile: "disabled",
      status: invalid ? "setup_required" : "not_configured",
      config: {
        status: invalid ? "setup_required" : "not_configured",
        missing: [],
        invalid: [...profile.invalidConfig]
      },
      discord: {
        local_status: "not_configured",
        url_drift: false,
        external_readiness: "not_checked",
        consecutive_failures: 0
      },
      board: {
        local_status: "not_configured",
        url_drift: false,
        external_readiness: "not_checked",
        consecutive_failures: 0
      },
      identity: {
        header: profile.identityHeader,
        status: "not_configured"
      },
      tunnel: { status: "not_configured", consecutive_failures: 0 },
      issues: [...profile.invalidConfig],
      checked_at: now.toISOString(),
      status_path: statusPathRelative
    };
    return persistStatus(projectRoot, result, options.persist);
  }

  const [discordRuntime, boardRuntime] = await Promise.all([
    getDiscordHttpServerStatus(projectRoot),
    getBoardServerStatus(projectRoot)
  ]);
  const expectedDiscordUrl =
    profile.discordInteractionsBaseUrl === undefined
      ? undefined
      : new URL("interactions", profile.discordInteractionsBaseUrl).toString();
  const expectedBoardUrl = profile.boardBaseUrl;
  const observedDiscordUrl = readDiscordExternalUrl(discordRuntime);
  const observedBoardUrl = boardRuntime?.external_url;
  const discordDrift =
    expectedDiscordUrl !== undefined &&
    observedDiscordUrl !== undefined &&
    observedDiscordUrl !== expectedDiscordUrl;
  const boardDrift =
    expectedBoardUrl !== undefined &&
    observedBoardUrl !== undefined &&
    observedBoardUrl !== expectedBoardUrl;

  let discordProbe: RemoteProbeState = "not_checked";
  let boardProbe: RemoteProbeState = "not_checked";
  let identityStatus:
    StableRemoteOperationsStatus["identity"]["status"] = "not_checked";
  const previousStatus = options.probeExternal === true
    ? await getStoredStableRemoteStatus(projectRoot)
    : undefined;
  if (options.probeExternal === true && configIssues.length === 0) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.requestTimeoutMs ?? 5_000;
    discordProbe = await probeDiscordReadiness(
      profile.discordInteractionsBaseUrl!,
      fetchImpl,
      timeoutMs
    );
    boardProbe = await probeBoardIdentity(
      profile.boardBaseUrl!,
      fetchImpl,
      timeoutMs
    );
    identityStatus =
      boardProbe === "identity_enforced"
        ? "enforced"
        : boardProbe === "identity_bypass_detected"
          ? "bypass_detected"
          : "not_checked";
  }

  const discordLocal = discordLocalStatus(discordRuntime);
  const boardLocal = boardRuntime?.status ?? "missing";
  const issues = [
    ...configIssues,
    ...(discordDrift ? ["discord_url_drift"] : []),
    ...(boardDrift ? ["board_url_drift"] : []),
    ...(discordProbe === "unreachable" ? ["discord_external_unreachable"] : []),
    ...(boardProbe === "unreachable" ? ["board_external_unreachable"] : []),
    ...(identityStatus === "bypass_detected" ? ["board_identity_bypass"] : [])
  ];
  if (discordLocal !== "ready") {
    issues.push(`discord_local_${discordLocal}`);
  }
  if (boardLocal !== "ready") {
    issues.push(`board_local_${boardLocal}`);
  }

  const tunnelStatus: StableRemoteOperationsStatus["tunnel"]["status"] =
    options.probeExternal !== true
      ? "not_checked"
      : discordProbe === "unreachable" && boardProbe === "unreachable"
        ? "disconnected"
        : discordProbe === "ready" &&
            (boardProbe === "identity_enforced" ||
              boardProbe === "identity_bypass_detected")
          ? "connected"
          : "not_checked";
  const previousIsFresh = isPreviousProbeFresh(
    previousStatus,
    now,
    options.failureStreakWindowMs ?? defaultFailureStreakWindowMs
  );
  const discordConsecutiveFailures = nextFailureStreak({
    failed: discordProbe === "unreachable",
    previousFailed:
      previousStatus?.discord.external_readiness === "unreachable",
    previousCount: previousStatus?.discord.consecutive_failures,
    previousIsFresh
  });
  const boardConsecutiveFailures = nextFailureStreak({
    failed: boardProbe === "unreachable",
    previousFailed: previousStatus?.board.external_readiness === "unreachable",
    previousCount: previousStatus?.board.consecutive_failures,
    previousIsFresh
  });
  const tunnelConsecutiveFailures = nextFailureStreak({
    failed: tunnelStatus === "disconnected",
    previousFailed: previousStatus?.tunnel.status === "disconnected",
    previousCount: previousStatus?.tunnel.consecutive_failures,
    previousIsFresh
  });
  if (tunnelStatus === "disconnected") {
    issues.push("tunnel_disconnected");
  }

  const configStatus =
    configIssues.length === 0 ? "ready" as const : "setup_required" as const;
  const status =
    configStatus === "setup_required"
      ? "setup_required" as const
      : issues.length === 0
        ? "ready" as const
        : "degraded" as const;
  const result: StableRemoteOperationsStatus = {
    schema_version: "0.1",
    profile: stableRemoteProfileName,
    status,
    config: {
      status: configStatus,
      missing: [...profile.missingConfig],
      invalid: [...profile.invalidConfig]
    },
    discord: {
      local_status: discordLocal,
      expected_url: expectedDiscordUrl,
      observed_url: observedDiscordUrl,
      url_drift: discordDrift,
      external_readiness: discordProbe,
      consecutive_failures: discordConsecutiveFailures
    },
    board: {
      local_status: boardLocal,
      expected_url: expectedBoardUrl,
      observed_url: observedBoardUrl,
      url_drift: boardDrift,
      external_readiness: boardProbe,
      consecutive_failures: boardConsecutiveFailures
    },
    identity: {
      header: profile.identityHeader,
      status: identityStatus
    },
    tunnel: {
      status: tunnelStatus,
      consecutive_failures: tunnelConsecutiveFailures
    },
    issues: [...new Set(issues)].sort(),
    checked_at: now.toISOString(),
    status_path: statusPathRelative
  };
  return persistStatus(projectRoot, result, options.persist);
}

export async function getStoredStableRemoteStatus(
  projectRoot: string
): Promise<StableRemoteOperationsStatus | undefined> {
  try {
    return await readJsonFile<StableRemoteOperationsStatus>(
      stableRemoteStatusPath(projectRoot)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function formatStableRemoteStatus(
  status: StableRemoteOperationsStatus,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(status, null, 2)}\n`;
  }
  return [
    `remote.profile=${status.profile}`,
    `remote.status=${status.status}`,
    `remote.config.status=${status.config.status}`,
    `remote.discord.local_status=${status.discord.local_status}`,
    `remote.discord.external_readiness=${status.discord.external_readiness}`,
    `remote.discord.consecutive_failures=${status.discord.consecutive_failures}`,
    `remote.discord.url_drift=${status.discord.url_drift}`,
    `remote.board.local_status=${status.board.local_status}`,
    `remote.board.external_readiness=${status.board.external_readiness}`,
    `remote.board.consecutive_failures=${status.board.consecutive_failures}`,
    `remote.board.url_drift=${status.board.url_drift}`,
    `remote.identity.status=${status.identity.status}`,
    `remote.tunnel.status=${status.tunnel.status}`,
    `remote.tunnel.consecutive_failures=${status.tunnel.consecutive_failures}`,
    `remote.issues=${status.issues.join(",") || "none"}`,
    `remote.status_path=${status.status_path}`
  ].join("\n");
}

function readDiscordExternalUrl(
  status: DiscordHttpServerRuntimeStatus | undefined
): string | undefined {
  return status !== undefined && "external_url" in status
    ? status.external_url
    : undefined;
}

function discordLocalStatus(
  status: DiscordHttpServerRuntimeStatus | undefined
): RemoteEndpointState {
  if (status === undefined) {
    return "missing";
  }
  return status.status;
}

async function probeDiscordReadiness(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<RemoteProbeState> {
  const response = await safeFetch(
    fetchImpl,
    new URL("ready", baseUrl).toString(),
    timeoutMs
  );
  if (response === undefined || !response.ok) {
    return "unreachable";
  }
  try {
    const body = await response.json() as Record<string, unknown>;
    return body.status === "ready" && body.mode === "http_interactions"
      ? "ready"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function probeBoardIdentity(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<RemoteProbeState> {
  const response = await safeFetch(fetchImpl, baseUrl, timeoutMs, "manual");
  if (response === undefined || response.status >= 500) {
    return "unreachable";
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return "identity_enforced";
  }
  if (
    response.ok &&
    response.headers.get(identityEnforcementHeader) === identityEnforcementValue
  ) {
    return "identity_enforced";
  }
  return response.ok ? "identity_bypass_detected" : "unreachable";
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  redirect: "follow" | "manual" = "follow"
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect,
      signal: controller.signal,
      headers: { accept: "application/json,text/html;q=0.9" }
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function persistStatus(
  projectRoot: string,
  status: StableRemoteOperationsStatus,
  persist: boolean | undefined
): Promise<StableRemoteOperationsStatus> {
  if (persist !== false) {
    await writeJsonFileAtomic(stableRemoteStatusPath(projectRoot), status);
  }
  return status;
}

function stableRemoteStatusPath(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "remote",
    "status.json"
  );
}

function isPreviousProbeFresh(
  previous: StableRemoteOperationsStatus | undefined,
  now: Date,
  windowMs: number
): boolean {
  if (previous === undefined) {
    return false;
  }
  const checkedAt = Date.parse(previous.checked_at);
  const ageMs = now.getTime() - checkedAt;
  return Number.isFinite(checkedAt) && ageMs >= 0 && ageMs <= windowMs;
}

function nextFailureStreak(input: {
  failed: boolean;
  previousFailed: boolean;
  previousCount: number | undefined;
  previousIsFresh: boolean;
}): number {
  if (!input.failed) {
    return 0;
  }
  if (!input.previousFailed || !input.previousIsFresh) {
    return 1;
  }
  const previousCount = typeof input.previousCount === "number" &&
      Number.isInteger(input.previousCount) &&
      input.previousCount > 0
    ? input.previousCount
    : 1;
  return Math.min(Number.MAX_SAFE_INTEGER, previousCount + 1);
}
