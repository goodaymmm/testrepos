import { fileURLToPath } from "node:url";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../../agents/command-runner.js";
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

export type DaemonTaskAction = "status" | "install" | "uninstall" | "restart";

export type DaemonTaskCommandOptions = {
  taskName?: string;
  projectRoot?: string;
  kaironCommand?: string;
  intervalMs?: string;
  logRoot?: string;
  atStartup?: boolean;
  dryRun?: boolean;
  commandRunner?: CommandRunner;
  platform?: NodeJS.Platform;
  powerShellCommand?: string;
  helperPath?: string;
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

export async function daemonTaskCommand(
  currentProjectRoot: string,
  action: DaemonTaskAction,
  options: DaemonTaskCommandOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      "Kairon daemon task setup required.",
      "status=setup_required",
      `action=${action}`,
      `platform=${platform}`,
      "reason=windows_task_scheduler_required",
      "guidance=Run this command on Windows with Task Scheduler available."
    ].join("\n");
  }

  const helperAction = mapDaemonTaskAction(action);
  const projectRoot = options.projectRoot?.trim() || currentProjectRoot;
  const taskName = options.taskName?.trim() || "Kairon Runtime";
  const helperPath =
    options.helperPath ??
    fileURLToPath(new URL("../../../scripts/kairon-daemon-task.ps1", import.meta.url));
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-Action",
    helperAction,
    "-TaskName",
    taskName,
    "-ProjectRoot",
    projectRoot
  ];

  if (action === "install") {
    args.push(
      "-KaironCommand",
      options.kaironCommand?.trim() || "kairon",
      "-IntervalMs",
      String(parsePositiveNumber(options.intervalMs ?? "60000", "interval-ms"))
    );
    if (options.logRoot !== undefined && options.logRoot.trim().length > 0) {
      args.push("-LogRoot", options.logRoot.trim());
    }
    if (options.atStartup === true) {
      args.push("-AtStartup");
    }
  }

  if (action === "restart") {
    args.push("-KaironCommand", options.kaironCommand?.trim() || "kairon");
  }

  if ((action === "install" || action === "uninstall") && options.dryRun === true) {
    args.push("-DryRun");
  }

  const result = await (options.commandRunner ?? spawnCommandRunner)({
    command: options.powerShellCommand ?? "powershell.exe",
    args,
    cwd: projectRoot,
    timeoutMs: 120_000
  });

  if (result.exitCode !== 0 || result.timedOut) {
    const detail = redactDaemonTaskOutput(result.stderr || result.stdout).trim();
    throw new Error(
      `Kairon daemon task ${action} failed${detail.length === 0 ? "." : `: ${detail}`}`
    );
  }

  const output = redactDaemonTaskOutput(result.stdout).trim();
  return [
    "Kairon daemon task command completed.",
    "status=completed",
    `action=${action}`,
    `dry_run=${options.dryRun === true}`,
    ...(output.length === 0 ? [] : output.split(/\r?\n/))
  ].join("\n");
}

function mapDaemonTaskAction(
  action: DaemonTaskAction
): "Status" | "Register" | "Unregister" | "Restart" {
  switch (action) {
    case "status":
      return "Status";
    case "install":
      return "Register";
    case "uninstall":
      return "Unregister";
    case "restart":
      return "Restart";
  }
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

function parsePositiveNumber(value: string, optionName: string): number {
  const parsed = parseOptionalPositiveNumber(value, optionName);
  if (parsed === undefined) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return parsed;
}

function redactDaemonTaskOutput(value: string): string {
  return value
    .replace(
      /"([^"]*(?:api[_-]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"[^"]*"/giu,
      (_match, key: string) => `"${key}":"[redacted]"`
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    );
}
