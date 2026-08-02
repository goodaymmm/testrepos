import {
  formatDiscordHttpStatus,
  formatDiscordHttpServerResult,
  getDiscordHttpServerStatus,
  startDiscordHttpInteractionsServer,
  type DiscordHttpServerHandle
} from "../../discord/http-server.js";

export async function startDiscordHttpCommand(
  projectRoot: string,
  options: {
    profile?: "loopback" | "reverse-proxy";
    host?: string;
    port?: string;
    timestampToleranceSeconds?: string;
    replayTtlSeconds?: string;
  } = {}
): Promise<DiscordHttpServerHandle> {
  return startDiscordHttpInteractionsServer(projectRoot, {
    profile: options.profile,
    host: options.host,
    port: parseOptionalInteger(options.port),
    timestampToleranceSeconds: parseOptionalPositiveInteger(
      options.timestampToleranceSeconds
    ),
    replayTtlSeconds: parseOptionalPositiveInteger(options.replayTtlSeconds)
  });
}

export { formatDiscordHttpServerResult };

export async function getDiscordHttpStatusCommand(
  projectRoot: string
): Promise<string> {
  return formatDiscordHttpStatus(await getDiscordHttpServerStatus(projectRoot));
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
