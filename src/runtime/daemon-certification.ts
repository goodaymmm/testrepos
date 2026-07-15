import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  createDaemonEvidenceReport,
  daemonEventTime,
  parseSinceDate,
  readDaemonLogEvents,
  type DaemonLogEvent,
  type DaemonReportFormat
} from "./daemon-report.js";

export type DaemonCertificationStatus =
  | "PASS"
  | "UNPASSED"
  | "INCOMPLETE"
  | "SETUP_REQUIRED";

export type DaemonCertificationProfile = {
  profile_id: "daemon_soak_v1";
  expected_interval_ms: number;
  max_heartbeat_gap_ms: number;
  max_restart_gap_ms: number;
  max_fatal_errors: number;
  minimum_ticks: number;
  minimum_tick_ratio: number;
  allowed_stop_reasons: string[];
};

export type DaemonCertificationCheck = {
  id:
    | "evidence_available"
    | "window_coverage"
    | "minimum_ticks"
    | "fatal_errors"
    | "heartbeat_continuity"
    | "restart_sequence"
    | "stale_lock";
  status: DaemonCertificationStatus;
  expected: string;
  actual: string;
  reason: string;
};

export type DaemonCertificationRestart = {
  kind: "scheduled_restart" | "host_reboot" | "unexpected_restart" | "final_stop";
  status: "allowed" | "unexpected";
  from: string;
  to?: string;
  gap_ms?: number;
  stop_reason?: string;
};

export type DaemonSoakCertification = {
  schema_version: "0.1";
  kind: "daemon_soak_certification";
  certification_id: string;
  generated_at: string;
  status: DaemonCertificationStatus;
  window: {
    since: string;
    until: string;
    requested_duration_ms: number;
    observed_duration_ms: number;
    leading_gap_ms: number;
    trailing_gap_ms: number;
    complete: boolean;
  };
  profile: DaemonCertificationProfile;
  source: {
    event_count: number;
    first_event_at?: string;
    latest_event_at?: string;
    logs: Array<{
      path: string;
      sha256: string;
    }>;
  };
  metrics: {
    started: number;
    ticks: number;
    stopped: number;
    fatal_errors: number;
    heartbeat_gap_violations: number;
    allowed_restarts: number;
    unexpected_restarts: number;
    stale_lock_suspected: boolean;
  };
  checks: DaemonCertificationCheck[];
  restarts: DaemonCertificationRestart[];
  reasons: string[];
};

export type DaemonCertificationOptions = {
  since?: string;
  now?: () => Date;
  expectedIntervalMs?: number;
  maxHeartbeatGapMs?: number;
  maxRestartGapMs?: number;
  maxFatalErrors?: number;
  minimumTicks?: number;
};

const defaultSince = "24h";
const defaultExpectedIntervalMs = 60_000;
const defaultMinimumTickRatio = 0.9;
const allowedStopReasons = ["stop_requested"];

export async function createDaemonSoakCertification(
  projectRoot: string,
  options: DaemonCertificationOptions = {}
): Promise<DaemonSoakCertification> {
  const now = options.now?.() ?? new Date();
  const since = parseSinceDate(options.since ?? defaultSince, now);
  const requestedDurationMs = now.getTime() - since.getTime();
  if (requestedDurationMs <= 0) {
    throw new Error("Daemon certification window must start before the current time.");
  }

  const profile = createCertificationProfile(requestedDurationMs, options);
  const report = await createDaemonEvidenceReport(projectRoot, {
    since: since.toISOString(),
    now: () => now,
    heartbeatGapMs: profile.max_heartbeat_gap_ms
  });
  const evidence = await readDaemonLogEvents(projectRoot, since, now);
  const events = evidence.events.sort(
    (left, right) => daemonEventTime(left).getTime() - daemonEventTime(right).getTime()
  );
  const sourceLogs = await hashSourceLogs(projectRoot, [
    ...evidence.context_paths,
    ...evidence.paths
  ]);
  const firstEvent = events[0];
  const latestEvent = events.at(-1);
  const firstTime = firstEvent === undefined ? undefined : daemonEventTime(firstEvent);
  const latestTime = latestEvent === undefined ? undefined : daemonEventTime(latestEvent);
  const leadingGapMs =
    firstTime === undefined ? requestedDurationMs : Math.max(0, firstTime.getTime() - since.getTime());
  const trailingGapMs =
    latestTime === undefined ? requestedDurationMs : Math.max(0, now.getTime() - latestTime.getTime());
  const observedDurationMs =
    firstTime === undefined || latestTime === undefined
      ? 0
      : Math.max(0, latestTime.getTime() - firstTime.getTime());
  const windowComplete =
    events.length > 0 &&
    leadingGapMs <= profile.max_heartbeat_gap_ms &&
    trailingGapMs <= profile.max_heartbeat_gap_ms;
  const restartAnalysis = analyzeRestarts(
    events,
    profile,
    now,
    evidence.prior_started
  );
  const heartbeatGapViolations = findHeartbeatGapViolations(
    events,
    profile.max_heartbeat_gap_ms,
    restartAnalysis.allowedGapPairs
  );
  const ticks = events.filter((event) => event.event === "tick").length;
  const fatalErrors = events.filter((event) => event.event === "fatal_error").length;
  const checks = buildChecks({
    eventCount: events.length,
    windowComplete,
    leadingGapMs,
    trailingGapMs,
    ticks,
    fatalErrors,
    heartbeatGapViolations,
    unexpectedRestarts: restartAnalysis.unexpectedCount,
    staleLockSuspected: report.summary.stale_lock_suspected,
    profile
  });
  const status = summarizeCertificationStatus(checks);

  return {
    schema_version: "0.1",
    kind: "daemon_soak_certification",
    certification_id: certificationId(now),
    generated_at: now.toISOString(),
    status,
    window: {
      since: since.toISOString(),
      until: now.toISOString(),
      requested_duration_ms: requestedDurationMs,
      observed_duration_ms: observedDurationMs,
      leading_gap_ms: leadingGapMs,
      trailing_gap_ms: trailingGapMs,
      complete: windowComplete
    },
    profile,
    source: {
      event_count: events.length,
      first_event_at: firstEvent?.created_at,
      latest_event_at: latestEvent?.created_at,
      logs: sourceLogs
    },
    metrics: {
      started: events.filter((event) => event.event === "started").length,
      ticks,
      stopped: events.filter((event) => event.event === "stopped").length,
      fatal_errors: fatalErrors,
      heartbeat_gap_violations: heartbeatGapViolations,
      allowed_restarts: restartAnalysis.allowedCount,
      unexpected_restarts: restartAnalysis.unexpectedCount,
      stale_lock_suspected: report.summary.stale_lock_suspected
    },
    checks,
    restarts: restartAnalysis.restarts,
    reasons: checks
      .filter((check) => check.status !== "PASS")
      .map((check) => `${check.id}: ${check.reason}`)
  };
}

export function formatDaemonSoakCertification(
  certification: DaemonSoakCertification,
  format: DaemonReportFormat = "markdown"
): string {
  if (format === "json") {
    return `${JSON.stringify(certification, null, 2)}\n`;
  }

  return [
    "# Kairon Daemon Soak Certification",
    "",
    `certification_id: ${certification.certification_id}`,
    `generated_at: ${certification.generated_at}`,
    `status: ${certification.status}`,
    `window: ${certification.window.since} - ${certification.window.until}`,
    "",
    "## Profile",
    "",
    "| Key | Value |",
    "| --- | --- |",
    ...Object.entries(certification.profile).map(([key, value]) =>
      `| ${escapeMarkdown(key)} | ${escapeMarkdown(Array.isArray(value) ? value.join(",") : String(value))} |`
    ),
    "",
    "## Metrics",
    "",
    "| Key | Value |",
    "| --- | --- |",
    ...Object.entries({ ...certification.window, ...certification.metrics }).map(
      ([key, value]) => `| ${escapeMarkdown(key)} | ${escapeMarkdown(String(value))} |`
    ),
    "",
    "## Checks",
    "",
    "| Check | Status | Expected | Actual | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...certification.checks.map(
      (check) =>
        `| ${escapeMarkdown(check.id)} | ${check.status} | ${escapeMarkdown(
          check.expected
        )} | ${escapeMarkdown(check.actual)} | ${escapeMarkdown(check.reason)} |`
    ),
    "",
    "## Restarts",
    "",
    certification.restarts.length === 0
      ? "No restart events were found."
      : [
          "| Kind | Status | From | To | Gap ms | Stop reason |",
          "| --- | --- | --- | --- | --- | --- |",
          ...certification.restarts.map(
            (restart) =>
              `| ${restart.kind} | ${restart.status} | ${escapeMarkdown(
                restart.from
              )} | ${escapeMarkdown(restart.to ?? "-")} | ${restart.gap_ms ?? "-"} | ${escapeMarkdown(
                restart.stop_reason ?? "-"
              )} |`
          )
        ].join("\n"),
    "",
    "## Source Logs",
    "",
    certification.source.logs.length === 0
      ? "No daemon source logs were found."
      : certification.source.logs
          .map((source) => `- \`${escapeMarkdown(source.path)}\` sha256=${source.sha256}`)
          .join("\n"),
    "",
    "## Reasons",
    "",
    certification.reasons.length === 0
      ? "All certification checks passed."
      : certification.reasons.map((reason) => `- ${escapeMarkdown(reason)}`).join("\n"),
    ""
  ].join("\n");
}

export async function writeDaemonSoakCertification(
  projectRoot: string,
  outputPath: string,
  certification: DaemonSoakCertification,
  format: DaemonReportFormat
): Promise<string> {
  const resolved = path.isAbsolute(outputPath)
    ? outputPath
    : resolveInside(projectRoot, ...outputPath.split(/[\\/]+/));
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, formatDaemonSoakCertification(certification, format), "utf8");
  return toPosixPath(path.relative(projectRoot, resolved));
}

function createCertificationProfile(
  requestedDurationMs: number,
  options: DaemonCertificationOptions
): DaemonCertificationProfile {
  const expectedIntervalMs = requirePositive(
    options.expectedIntervalMs ?? defaultExpectedIntervalMs,
    "expectedIntervalMs"
  );
  const maxHeartbeatGapMs = requirePositive(
    options.maxHeartbeatGapMs ?? expectedIntervalMs * 3,
    "maxHeartbeatGapMs"
  );
  const maxRestartGapMs = requirePositive(
    options.maxRestartGapMs ?? expectedIntervalMs * 10,
    "maxRestartGapMs"
  );
  const maxFatalErrors = requireNonNegative(
    options.maxFatalErrors ?? 0,
    "maxFatalErrors"
  );
  const defaultMinimumTicks = Math.max(
    1,
    Math.floor((requestedDurationMs / expectedIntervalMs) * defaultMinimumTickRatio)
  );
  const minimumTicks = requireNonNegative(
    options.minimumTicks ?? defaultMinimumTicks,
    "minimumTicks"
  );

  return {
    profile_id: "daemon_soak_v1",
    expected_interval_ms: expectedIntervalMs,
    max_heartbeat_gap_ms: maxHeartbeatGapMs,
    max_restart_gap_ms: maxRestartGapMs,
    max_fatal_errors: maxFatalErrors,
    minimum_ticks: minimumTicks,
    minimum_tick_ratio: defaultMinimumTickRatio,
    allowed_stop_reasons: [...allowedStopReasons]
  };
}

function analyzeRestarts(
  events: DaemonLogEvent[],
  profile: DaemonCertificationProfile,
  until: Date,
  priorStarted?: DaemonLogEvent
): {
  restarts: DaemonCertificationRestart[];
  allowedGapPairs: Set<string>;
  allowedCount: number;
  unexpectedCount: number;
} {
  const restarts: DaemonCertificationRestart[] = [];
  const allowedGapPairs = new Set<string>();
  let previousLifecycle:
    | { event: DaemonLogEvent; index: number }
    | undefined = priorStarted === undefined
    ? undefined
    : { event: priorStarted, index: -1 };
  let previousStarted = priorStarted;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.event === "started") {
      if (previousLifecycle !== undefined) {
        const previousEventIndex = index - 1;
        const previousEvent =
          previousEventIndex >= 0 ? events[previousEventIndex] : previousLifecycle.event;
        const gapMs = daemonEventTime(event).getTime() - daemonEventTime(previousEvent).getTime();
        const stopReason = asString(previousLifecycle.event.stop_reason);
        const cleanRestart =
          previousLifecycle.event.event === "stopped" &&
          stopReason !== undefined &&
          profile.allowed_stop_reasons.includes(stopReason) &&
          gapMs <= profile.max_restart_gap_ms;
        const hostReboot =
          previousLifecycle.event.event === "started" &&
          previousStarted !== undefined &&
          isDifferentHostBoot(previousStarted, event) &&
          gapMs <= profile.max_restart_gap_ms;

        if (cleanRestart || hostReboot) {
          restarts.push({
            kind: cleanRestart ? "scheduled_restart" : "host_reboot",
            status: "allowed",
            from: previousEvent.created_at ?? daemonEventTime(previousEvent).toISOString(),
            to: event.created_at ?? daemonEventTime(event).toISOString(),
            gap_ms: gapMs,
            stop_reason: cleanRestart ? stopReason : undefined
          });
          if (previousEventIndex >= 0) {
            allowedGapPairs.add(`${previousEventIndex}:${index}`);
          }
        } else {
          restarts.push({
            kind: "unexpected_restart",
            status: "unexpected",
            from: previousEvent.created_at ?? daemonEventTime(previousEvent).toISOString(),
            to: event.created_at ?? daemonEventTime(event).toISOString(),
            gap_ms: gapMs,
            stop_reason:
              previousLifecycle.event.event === "stopped" ? stopReason : undefined
          });
        }
      } else if (index > 0) {
        const previousEvent = events[index - 1];
        restarts.push({
          kind: "unexpected_restart",
          status: "unexpected",
          from: previousEvent.created_at ?? daemonEventTime(previousEvent).toISOString(),
          to: event.created_at ?? daemonEventTime(event).toISOString(),
          gap_ms: daemonEventTime(event).getTime() - daemonEventTime(previousEvent).getTime()
        });
      }
      previousStarted = event;
      previousLifecycle = { event, index };
      continue;
    }

    if (event.event === "stopped") {
      const stopReason = asString(event.stop_reason) ?? "unknown";
      const nextStartedIndex = events.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && candidate.event === "started"
      );
      const finalStop = nextStartedIndex === -1 && index === events.length - 1;
      if (
        finalStop &&
        profile.allowed_stop_reasons.includes(stopReason) &&
        until.getTime() - daemonEventTime(event).getTime() <= profile.max_heartbeat_gap_ms
      ) {
        restarts.push({
          kind: "final_stop",
          status: "allowed",
          from: event.created_at ?? daemonEventTime(event).toISOString(),
          stop_reason: stopReason
        });
      } else if (!profile.allowed_stop_reasons.includes(stopReason)) {
        restarts.push({
          kind: "unexpected_restart",
          status: "unexpected",
          from: event.created_at ?? daemonEventTime(event).toISOString(),
          stop_reason: stopReason
        });
      }
      previousLifecycle = { event, index };
    }
  }

  return {
    restarts,
    allowedGapPairs,
    allowedCount: restarts.filter(
      (restart) => restart.status === "allowed" && restart.kind !== "final_stop"
    ).length,
    unexpectedCount: restarts.filter((restart) => restart.status === "unexpected").length
  };
}

function findHeartbeatGapViolations(
  events: DaemonLogEvent[],
  maxHeartbeatGapMs: number,
  allowedGapPairs: Set<string>
): number {
  let violations = 0;
  for (let index = 1; index < events.length; index += 1) {
    const gapMs =
      daemonEventTime(events[index]).getTime() - daemonEventTime(events[index - 1]).getTime();
    if (gapMs > maxHeartbeatGapMs && !allowedGapPairs.has(`${index - 1}:${index}`)) {
      violations += 1;
    }
  }
  return violations;
}

function buildChecks(input: {
  eventCount: number;
  windowComplete: boolean;
  leadingGapMs: number;
  trailingGapMs: number;
  ticks: number;
  fatalErrors: number;
  heartbeatGapViolations: number;
  unexpectedRestarts: number;
  staleLockSuspected: boolean;
  profile: DaemonCertificationProfile;
}): DaemonCertificationCheck[] {
  const evidenceAvailable = input.eventCount > 0;
  return [
    check(
      "evidence_available",
      evidenceAvailable ? "PASS" : "SETUP_REQUIRED",
      "at least one daemon event",
      `${input.eventCount} events`,
      evidenceAvailable ? "daemon evidence is available" : "daemon logs are missing in the selected window"
    ),
    check(
      "window_coverage",
      !evidenceAvailable ? "SETUP_REQUIRED" : input.windowComplete ? "PASS" : "INCOMPLETE",
      `leading and trailing gaps <= ${input.profile.max_heartbeat_gap_ms}ms`,
      `leading=${input.leadingGapMs}ms trailing=${input.trailingGapMs}ms`,
      input.windowComplete ? "the requested window is covered" : "the requested window is not fully covered"
    ),
    check(
      "minimum_ticks",
      !evidenceAvailable
        ? "SETUP_REQUIRED"
        : !input.windowComplete
          ? "INCOMPLETE"
          : input.ticks >= input.profile.minimum_ticks
            ? "PASS"
            : "UNPASSED",
      `ticks >= ${input.profile.minimum_ticks}`,
      `ticks=${input.ticks}`,
      input.ticks >= input.profile.minimum_ticks
        ? "minimum tick count is satisfied"
        : input.windowComplete
          ? "minimum tick count is not satisfied"
          : "tick count cannot be certified until the window is complete"
    ),
    check(
      "fatal_errors",
      !evidenceAvailable
        ? "SETUP_REQUIRED"
        : input.fatalErrors <= input.profile.max_fatal_errors
          ? "PASS"
          : "UNPASSED",
      `fatal_errors <= ${input.profile.max_fatal_errors}`,
      `fatal_errors=${input.fatalErrors}`,
      input.fatalErrors <= input.profile.max_fatal_errors
        ? "fatal error threshold is satisfied"
        : "fatal error threshold was exceeded"
    ),
    check(
      "heartbeat_continuity",
      !evidenceAvailable
        ? "SETUP_REQUIRED"
        : input.heartbeatGapViolations === 0
          ? "PASS"
          : "UNPASSED",
      `unallowed gaps > ${input.profile.max_heartbeat_gap_ms}ms = 0`,
      `violations=${input.heartbeatGapViolations}`,
      input.heartbeatGapViolations === 0
        ? "heartbeat continuity is satisfied"
        : "one or more heartbeat gaps exceeded the threshold"
    ),
    check(
      "restart_sequence",
      !evidenceAvailable
        ? "SETUP_REQUIRED"
        : input.unexpectedRestarts === 0
          ? "PASS"
          : "UNPASSED",
      "unexpected restarts = 0",
      `unexpected_restarts=${input.unexpectedRestarts}`,
      input.unexpectedRestarts === 0
        ? "all observed restart sequences are allowed"
        : "an unexpected start, stop, or restart sequence was observed"
    ),
    check(
      "stale_lock",
      !evidenceAvailable
        ? "SETUP_REQUIRED"
        : input.staleLockSuspected
          ? "UNPASSED"
          : "PASS",
      "stale_lock_suspected=false",
      `stale_lock_suspected=${input.staleLockSuspected}`,
      input.staleLockSuspected
        ? "the latest daemon evidence is stale without a clean stop"
        : "no stale daemon evidence was detected"
    )
  ];
}

function check(
  id: DaemonCertificationCheck["id"],
  status: DaemonCertificationStatus,
  expected: string,
  actual: string,
  reason: string
): DaemonCertificationCheck {
  return { id, status, expected, actual, reason };
}

function summarizeCertificationStatus(
  checks: DaemonCertificationCheck[]
): DaemonCertificationStatus {
  if (checks.some((check) => check.status === "UNPASSED")) {
    return "UNPASSED";
  }
  if (checks.some((check) => check.status === "SETUP_REQUIRED")) {
    return "SETUP_REQUIRED";
  }
  if (checks.some((check) => check.status === "INCOMPLETE")) {
    return "INCOMPLETE";
  }
  return "PASS";
}

async function hashSourceLogs(
  projectRoot: string,
  sourcePaths: string[]
): Promise<Array<{ path: string; sha256: string }>> {
  return Promise.all(
    [...new Set(sourcePaths)].map(async (sourcePath) => {
      const resolved = resolveInside(projectRoot, ...sourcePath.split("/"));
      const content = await readFile(resolved);
      return {
        path: sourcePath,
        sha256: createHash("sha256").update(content).digest("hex")
      };
    })
  );
}

function isDifferentHostBoot(previous: DaemonLogEvent, current: DaemonLogEvent): boolean {
  const previousBoot = asString(previous.host_boot_at);
  const currentBoot = asString(current.host_boot_at);
  return previousBoot !== undefined && currentBoot !== undefined && previousBoot !== currentBoot;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid daemon certification ${name}: ${value}`);
  }
  return value;
}

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid daemon certification ${name}: ${value}`);
  }
  return value;
}

function certificationId(now: Date): string {
  return `DSC-${now.toISOString().replace(/[-:.TZ]/g, "")}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}
