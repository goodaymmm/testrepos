import {
  createDaemonEvidenceReport,
  formatDaemonEvidenceReport,
  parseDaemonReportFormat,
  writeDaemonEvidenceReport
} from "../../runtime/daemon-report.js";

export type DaemonReportCommandOptions = {
  since?: string;
  format?: string;
  output?: string;
  heartbeatGapMs?: string;
};

export async function daemonReportCommand(
  projectRoot: string,
  options: DaemonReportCommandOptions = {}
): Promise<string> {
  const format = parseDaemonReportFormat(options.format);
  const report = await createDaemonEvidenceReport(projectRoot, {
    since: options.since,
    heartbeatGapMs: parseOptionalPositiveNumber(options.heartbeatGapMs, "heartbeat-gap-ms")
  });

  if (options.output !== undefined) {
    const reportPath = await writeDaemonEvidenceReport(
      projectRoot,
      options.output,
      report,
      format
    );
    return [
      "Kairon daemon evidence report written.",
      `report=${reportPath}`,
      `format=${format}`,
      `events=${report.logs.event_count}`,
      `status=${report.summary.status}`,
      `heartbeat_gaps=${report.summary.heartbeat_gaps}`,
      `fatal_errors=${report.summary.fatal_errors}`
    ].join("\n");
  }

  return formatDaemonEvidenceReport(report, format);
}

function parseOptionalPositiveNumber(
  value: string | undefined,
  optionName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`Invalid ${optionName}: ${value}`);
}
