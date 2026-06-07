import {
  exportBoardProjection,
  formatBoardExportResult
} from "../../board/projection.js";
import {
  formatBoardServeResult,
  startBoardServer,
  type BoardServerHandle
} from "../../board/server.js";

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
  options: { host?: string; port?: string; recent?: string } = {}
): Promise<BoardServerHandle> {
  return startBoardServer(projectRoot, {
    host: options.host,
    port: parseOptionalInteger(options.port),
    recentLimit: parseOptionalNumber(options.recent)
  });
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
