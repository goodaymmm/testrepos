import {
  exportBoardProjection,
  formatBoardExportResult
} from "../../board/projection.js";

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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
