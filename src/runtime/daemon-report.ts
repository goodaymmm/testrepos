import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";

export type DaemonReportFormat = "markdown" | "json";

export type DaemonEvidenceReport = {
  schema_version: "0.1";
  generated_at: string;
  window: {
    since: string;
    until: string;
    duration_ms: number;
  };
  logs: {
    scanned_files: number;
    event_count: number;
    paths: string[];
    first_event_at?: string;
    latest_event_at?: string;
  };
  summary: {
    status: "no_events" | "running_or_incomplete" | "stopped" | "fatal_error";
    started: number;
    ticks: number;
    idle_ticks: number;
    processed_ticks: number;
    stopped: number;
    fatal_errors: number;
    stop_reasons: Record<string, number>;
    last_action?: string;
    latest_stop_reason?: string;
    heartbeat_gaps: number;
    max_heartbeat_gap_ms?: number;
    stale_lock_suspected: boolean;
  };
  failures: DaemonFailureSummary[];
  heartbeat_gaps: DaemonHeartbeatGap[];
};

export type DaemonFailureSummary = {
  event: "fatal_error" | "stopped";
  at?: string;
  code?: string;
  message?: string;
};

export type DaemonHeartbeatGap = {
  from: string;
  to: string;
  gap_ms: number;
};

export type DaemonEvidenceReportOptions = {
  since?: string;
  now?: () => Date;
  heartbeatGapMs?: number;
};

type DaemonLogEvent = Record<string, unknown> & {
  event?: string;
  created_at?: string;
};

const defaultSince = "24h";
const defaultHeartbeatGapMs = 60_000;

export async function createDaemonEvidenceReport(
  projectRoot: string,
  options: DaemonEvidenceReportOptions = {}
): Promise<DaemonEvidenceReport> {
  const now = options.now?.() ?? new Date();
  const since = parseSinceDate(options.since ?? defaultSince, now);
  const heartbeatGapMs = options.heartbeatGapMs ?? defaultHeartbeatGapMs;
  const { events, paths } = await readDaemonLogEvents(projectRoot, since, now);
  const sortedEvents = events.sort(
    (left, right) => eventTime(left).getTime() - eventTime(right).getTime()
  );
  const ticks = sortedEvents.filter((event) => event.event === "tick");
  const stopped = sortedEvents.filter((event) => event.event === "stopped");
  const fatalErrors = sortedEvents.filter((event) => event.event === "fatal_error");
  const heartbeatGaps = findHeartbeatGaps(sortedEvents, heartbeatGapMs);
  const latestEvent = sortedEvents.at(-1);
  const latestStopped = stopped.at(-1);
  const stopReasons = countStopReasons(stopped);
  const latestStopReason = asString(latestStopped?.stop_reason);
  const status = summarizeDaemonStatus({
    events: sortedEvents,
    latestEvent,
    latestStopReason,
    fatalErrors,
    now,
    heartbeatGapMs
  });

  return {
    schema_version: "0.1",
    generated_at: now.toISOString(),
    window: {
      since: since.toISOString(),
      until: now.toISOString(),
      duration_ms: now.getTime() - since.getTime()
    },
    logs: {
      scanned_files: paths.length,
      event_count: sortedEvents.length,
      paths,
      first_event_at: sortedEvents[0]?.created_at,
      latest_event_at: latestEvent?.created_at
    },
    summary: {
      status,
      started: sortedEvents.filter((event) => event.event === "started").length,
      ticks: ticks.length,
      idle_ticks: ticks.filter((event) => asString(event.action) === "idle").length,
      processed_ticks: ticks.filter((event) => asString(event.action) !== "idle").length,
      stopped: stopped.length,
      fatal_errors: fatalErrors.length,
      stop_reasons: stopReasons,
      last_action: asString(ticks.at(-1)?.action),
      latest_stop_reason: latestStopReason,
      heartbeat_gaps: heartbeatGaps.length,
      max_heartbeat_gap_ms:
        heartbeatGaps.length === 0
          ? undefined
          : Math.max(...heartbeatGaps.map((gap) => gap.gap_ms)),
      stale_lock_suspected:
        latestEvent !== undefined &&
        latestEvent.event !== "stopped" &&
        now.getTime() - eventTime(latestEvent).getTime() > heartbeatGapMs
    },
    failures: summarizeFailures([...fatalErrors, ...stopped]),
    heartbeat_gaps: heartbeatGaps
  };
}

export function formatDaemonEvidenceReport(
  report: DaemonEvidenceReport,
  format: DaemonReportFormat = "markdown"
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  return [
    "# Kairon Daemon Evidence Report",
    "",
    `generated_at: ${report.generated_at}`,
    `window: ${report.window.since} - ${report.window.until}`,
    "",
    "## Summary",
    "",
    "| Key | Value |",
    "| --- | --- |",
    ...[
      ["status", report.summary.status],
      ["scanned_files", String(report.logs.scanned_files)],
      ["event_count", String(report.logs.event_count)],
      ["started", String(report.summary.started)],
      ["ticks", String(report.summary.ticks)],
      ["idle_ticks", String(report.summary.idle_ticks)],
      ["processed_ticks", String(report.summary.processed_ticks)],
      ["fatal_errors", String(report.summary.fatal_errors)],
      ["stopped", String(report.summary.stopped)],
      ["latest_stop_reason", report.summary.latest_stop_reason ?? "-"],
      ["last_action", report.summary.last_action ?? "-"],
      ["heartbeat_gaps", String(report.summary.heartbeat_gaps)],
      ["max_heartbeat_gap_ms", optionalNumber(report.summary.max_heartbeat_gap_ms)],
      ["stale_lock_suspected", String(report.summary.stale_lock_suspected)]
    ].map(([key, value]) => `| ${escapeMarkdown(key)} | ${escapeMarkdown(value)} |`),
    "",
    "## Stop Reasons",
    "",
    tableFromRecord(report.summary.stop_reasons),
    "",
    "## Logs",
    "",
    report.logs.paths.length === 0
      ? "No daemon log files were found in the selected window."
      : report.logs.paths.map((logPath) => `- \`${escapeMarkdown(logPath)}\``).join("\n"),
    "",
    "## Failures",
    "",
    report.failures.length === 0
      ? "No daemon failures were found."
      : report.failures
          .map(
            (failure) =>
              `- ${failure.at ?? "unknown"} ${failure.event} ${failure.code ?? ""} ${failure.message ?? ""}`.trim()
          )
          .map(escapeMarkdown)
          .join("\n"),
    "",
    "## Heartbeat Gaps",
    "",
    report.heartbeat_gaps.length === 0
      ? "No heartbeat gaps exceeded the threshold."
      : [
          "| From | To | Gap ms |",
          "| --- | --- | --- |",
          ...report.heartbeat_gaps.map(
            (gap) =>
              `| ${escapeMarkdown(gap.from)} | ${escapeMarkdown(gap.to)} | ${gap.gap_ms} |`
          )
        ].join("\n"),
    ""
  ].join("\n");
}

export async function writeDaemonEvidenceReport(
  projectRoot: string,
  outputPath: string,
  report: DaemonEvidenceReport,
  format: DaemonReportFormat
): Promise<string> {
  const resolved = path.isAbsolute(outputPath)
    ? outputPath
    : path.join(projectRoot, outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, formatDaemonEvidenceReport(report, format), "utf8");
  return toProjectPath(projectRoot, resolved);
}

export function parseDaemonReportFormat(value: string | undefined): DaemonReportFormat {
  if (value === undefined || value === "markdown" || value === "md") {
    return "markdown";
  }
  if (value === "json") {
    return "json";
  }

  throw new Error(`Invalid daemon report format: ${value}`);
}

export function parseSinceDate(value: string, now: Date): Date {
  const trimmed = value.trim();
  const relative = /^(\d+)(ms|s|m|h|d|w)$/.exec(trimmed);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1_000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : unit === "d"
                ? 86_400_000
                : 604_800_000;
    return new Date(now.getTime() - amount * multiplier);
  }

  const parsed = new Date(trimmed);
  if (Number.isFinite(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Invalid daemon report since value: ${value}`);
}

async function readDaemonLogEvents(
  projectRoot: string,
  since: Date,
  until: Date
): Promise<{ events: DaemonLogEvent[]; paths: string[] }> {
  const daemonDir = path.join(getKaironPaths(projectRoot).runtimeDir, "daemon");
  let entries: string[];
  try {
    entries = (await readdir(daemonDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return { events: [], paths: [] };
    }

    throw error;
  }

  const events: DaemonLogEvent[] = [];
  const usedPaths = new Set<string>();
  for (const entry of entries) {
    const filePath = path.join(daemonDir, entry);
    const lines = await readJsonLines<DaemonLogEvent>(filePath);
    const filtered = lines.filter((event) => {
      const time = eventTime(event);
      return time >= since && time <= until;
    });
    if (filtered.length > 0) {
      usedPaths.add(toProjectPath(projectRoot, filePath));
      events.push(...filtered.map(sanitizeDaemonEvent));
    }
  }

  return {
    events,
    paths: [...usedPaths]
  };
}

function sanitizeDaemonEvent(event: DaemonLogEvent): DaemonLogEvent {
  const sanitized: DaemonLogEvent = {};
  for (const [key, value] of Object.entries(event)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeValue(child)])
    );
  }
  return value;
}

function countStopReasons(events: DaemonLogEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const reason = asString(event.stop_reason) ?? "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function summarizeFailures(events: DaemonLogEvent[]): DaemonFailureSummary[] {
  return events
    .map((event) => {
      const error = asRecord(event.error) ?? asRecord(event.last_error);
      if (event.event === "stopped" && error === undefined) {
        return undefined;
      }
      const summary: DaemonFailureSummary = {
        event: event.event === "fatal_error" ? "fatal_error" : "stopped",
      };
      const at = asString(event.created_at) ?? asString(error?.at);
      const code = sanitizeText(asString(error?.code) ?? "");
      const message = sanitizeText(asString(error?.message) ?? "");
      if (at !== undefined) {
        summary.at = at;
      }
      if (code.length > 0) {
        summary.code = code;
      }
      if (message.length > 0) {
        summary.message = message;
      }
      return summary;
    })
    .filter((failure): failure is DaemonFailureSummary => failure !== undefined);
}

function findHeartbeatGaps(
  events: DaemonLogEvent[],
  heartbeatGapMs: number
): DaemonHeartbeatGap[] {
  const gaps: DaemonHeartbeatGap[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    const gapMs = eventTime(current).getTime() - eventTime(previous).getTime();
    if (gapMs > heartbeatGapMs) {
      gaps.push({
        from: previous.created_at ?? eventTime(previous).toISOString(),
        to: current.created_at ?? eventTime(current).toISOString(),
        gap_ms: gapMs
      });
    }
  }
  return gaps;
}

function summarizeDaemonStatus(input: {
  events: DaemonLogEvent[];
  latestEvent: DaemonLogEvent | undefined;
  latestStopReason: string | undefined;
  fatalErrors: DaemonLogEvent[];
  now: Date;
  heartbeatGapMs: number;
}): DaemonEvidenceReport["summary"]["status"] {
  if (input.events.length === 0) {
    return "no_events";
  }
  if (input.latestStopReason === "fatal_error" || input.latestEvent?.event === "fatal_error") {
    return "fatal_error";
  }
  if (input.fatalErrors.length > 0) {
    return "fatal_error";
  }
  if (input.latestEvent?.event === "stopped") {
    return "stopped";
  }
  return "running_or_incomplete";
}

function eventTime(event: DaemonLogEvent): Date {
  const value =
    asString(event.created_at) ??
    asString(event.started_at) ??
    asString(event.at) ??
    new Date(0).toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim();
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function tableFromRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return "No stop reasons were recorded.";
  }

  return [
    "| Reason | Count |",
    "| --- | --- |",
    ...entries.map(([reason, count]) => `| ${escapeMarkdown(reason)} | ${count} |`)
  ].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
