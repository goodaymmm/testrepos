import {
  exportBoardProjection,
  formatBoardExportResult
} from "../../board/projection.js";
import {
  formatBoardServeResult,
  startBoardServer,
  type BoardServerHandle
} from "../../board/server.js";
import {
  issuePersistentBoardAccess,
  revokePersistentBoardAccess
} from "../../board/access-token.js";
import {
  prepareBoardProfile,
  type BoardProfile,
  type BoardProfileConfig
} from "../../board/profile.js";
import { loadConfigFile } from "../../core/config/load-config.js";

export async function exportBoard(
  projectRoot: string,
  options: { output?: string; recent?: string } = {}
): Promise<string> {
  const result = await exportBoardProjection(projectRoot, {
    outputPath: options.output,
    recentLimit: parseOptionalNumber(options.recent)
  });

  return formatBoardExportResult(result);
}

export async function serveBoard(
  projectRoot: string,
  options: {
    profile?: string;
    host?: string;
    port?: string;
    recent?: string;
    requireToken?: boolean;
    accessTokenTtlSeconds?: string;
  } = {}
): Promise<BoardServerHandle> {
  const notifications = await loadConfigFile<{ board?: BoardProfileConfig }>(
    projectRoot,
    "notifications.json"
  );
  const requestedProfile = parseOptionalBoardProfile(options.profile);
  const prepared = prepareBoardProfile(notifications.board, requestedProfile);
  const profileIssues = [...prepared.invalidConfig, ...prepared.missingConfig];
  if (profileIssues.length > 0) {
    throw new Error(`Board profile setup required: ${profileIssues.join(", ")}`);
  }
  return startBoardServer(projectRoot, {
    profile: prepared.profile,
    host: options.host,
    port: parseOptionalInteger(options.port),
    recentLimit: parseOptionalNumber(options.recent),
    requireToken: options.requireToken,
    accessTokenTtlSeconds: parseOptionalPositiveInteger(
      options.accessTokenTtlSeconds
    ),
    externalBaseUrl: prepared.externalBaseUrl,
    trustedProxies: prepared.trustedProxies,
    allowedOrigins: prepared.allowedOrigins,
    identityHeader: prepared.identityHeader,
    rateLimitPerMinute: prepared.rateLimitPerMinute
  });
}

export async function issueBoardAccessCommand(
  projectRoot: string,
  options: { ttlMinutes?: string } = {}
): Promise<string> {
  const issued = await issuePersistentBoardAccess(projectRoot, {
    ttlMinutes: parseOptionalPositiveInteger(options.ttlMinutes)
  });
  return [
    "Kairon board access issued.",
    `access_id=${issued.access_id}`,
    `access_token=${issued.access_token}`,
    `expires_at=${issued.expires_at}`,
    `scope=${issued.scope}`,
    `artifact=${issued.artifact_path}`
  ].join("\n");
}

export async function revokeBoardAccessCommand(
  projectRoot: string,
  accessId: string
): Promise<string> {
  const revoked = await revokePersistentBoardAccess(projectRoot, accessId);
  return [
    "Kairon board access revoked.",
    `access_id=${revoked.access_id}`,
    `status=${revoked.status}`,
    `revoked_at=${revoked.revoked_at}`
  ].join("\n");
}

export { formatBoardServeResult };

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (Number.isInteger(parsed)) {
    return parsed;
  }

  throw new Error(`Invalid numeric option: ${value}`);
}

function parseOptionalPositiveInteger(
  value: string | undefined
): number | undefined {
  const parsed = parseOptionalInteger(value);
  if (parsed === undefined || parsed > 0) {
    return parsed;
  }

  throw new Error(`Invalid positive numeric option: ${value}`);
}

function parseOptionalBoardProfile(value: string | undefined): BoardProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "loopback" || value === "remote-readonly") {
    return value;
  }
  throw new Error(`Invalid Board profile: ${value}`);
}
