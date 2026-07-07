import {
  formatDiscordHttpServerResult,
  startDiscordHttpInteractionsServer,
  type DiscordHttpServerHandle
} from "../../discord/http-server.js";

export async function startDiscordHttpCommand(
  projectRoot: string,
  options: { host?: string; port?: string } = {}
): Promise<DiscordHttpServerHandle> {
  return startDiscordHttpInteractionsServer(projectRoot, {
    host: options.host,
    port: parseOptionalInteger(options.port)
  });
}

export { formatDiscordHttpServerResult };

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
