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
import {
  createDaemonSoakCertification,
  formatDaemonSoakCertification,
  writeDaemonSoakCertification
} from "../../runtime/daemon-certification.js";

export type DaemonReportCommandOptions = {
  since?: string;
  format?: string;
  output?: string;
  heartbeatGapMs?: string;
};

export type DaemonCertifyCommandOptions = {
  since?: string;
  format?: string;
  output?: string;
  expectedIntervalMs?: string;
  maxHeartbeatGapMs?: string;
  maxRestartGapMs?: string;
  maxFatalErrors?: string;
  minimumTicks?: string;
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

export async function daemonCertifyCommand(
  projectRoot: string,
  options: DaemonCertifyCommandOptions = {}
): Promise<string> {
  const format = parseDaemonReportFormat(options.format);
  const certification = await createDaemonSoakCertification(projectRoot, {
    since: options.since,
    expectedIntervalMs: parseOptionalPositiveNumber(
      options.expectedIntervalMs,
      "expected-interval-ms"
    ),
    maxHeartbeatGapMs: parseOptionalPositiveNumber(
      options.maxHeartbeatGapMs,
      "max-heartbeat-gap-ms"
    ),
    maxRestartGapMs: parseOptionalPositiveNumber(
      options.maxRestartGapMs,
      "max-restart-gap-ms"
    ),
    maxFatalErrors: parseOptionalNonNegativeNumber(
      options.maxFatalErrors,
      "max-fatal-errors"
    ),
    minimumTicks: parseOptionalNonNegativeNumber(options.minimumTicks, "minimum-ticks")
  });

  if (options.output !== undefined) {
    const certificationPath = await writeDaemonSoakCertification(
      projectRoot,
      options.output,
      certification,
      format
    );
    return [
      "Kairon daemon soak certification written.",
      `certification=${certificationPath}`,
      `certification_id=${certification.certification_id}`,
      `format=${format}`,
      `status=${certification.status}`,
      `window_complete=${certification.window.complete}`,
      `ticks=${certification.metrics.ticks}`,
      `fatal_errors=${certification.metrics.fatal_errors}`,
      `heartbeat_gap_violations=${certification.metrics.heartbeat_gap_violations}`,
      `unexpected_restarts=${certification.metrics.unexpected_restarts}`
    ].join("\n");
  }

  return formatDaemonSoakCertification(certification, format);
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
    if (isTaskSchedulerPermissionError(detail)) {
      return [
        "Kairon daemon task setup required.",
        "status=setup_required",
        `action=${action}`,
        "reason=task_scheduler_permission_denied",
        "guidance=Run Windows PowerShell as Administrator, then retry the command."
      ].join("\n");
    }
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

function parseOptionalNonNegativeNumber(
  value: string | undefined,
  optionName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  throw new Error(`Invalid ${optionName}: ${value}`);
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

function isTaskSchedulerPermissionError(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "permissiondenied",
    "access denied",
    "access is denied",
    "0x80070005",
    "unauthorizedaccessexception",
    "アクセスが拒否"
  ].some((pattern) => normalized.includes(pattern));
}
