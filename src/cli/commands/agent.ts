import {
  formatAgentSmokeResult,
  runAgentSmoke
} from "../../agents/smoke-runner.js";
import { agentCliIdHint } from "../../agents/display.js";
import { createAntigravityPtySessionRunner } from "../../agents/pty-session-runner.js";
import {
  dispatcherStatusFor,
  sameDaySessionStatus,
  type SessionMetadata
} from "../../agents/session-host.js";
import { agentIds, isAgentId, type AgentId } from "../../agents/types.js";
import { loadConfigFile } from "../../core/config/load-config.js";
import { readJsonFile } from "../../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../../core/fs/paths.js";
import { getLocalDateKey } from "../../runtime/schedule-engine.js";
import { access, readdir, rename } from "node:fs/promises";
import path from "node:path";

export type AgentSmokeCommandOptions = {
  agent?: string;
  timeoutMs?: string;
};

export type AgentSessionCommandOptions = {
  date?: string;
  now?: () => Date;
};

export type AgentSessionResetCommandOptions = AgentSessionCommandOptions;

type ScheduleConfig = {
  timezone: string;
};

export async function runAgentSmokeCommand(
  projectRoot: string,
  options: AgentSmokeCommandOptions
): Promise<string> {
  if (options.agent === undefined || !isAgentId(options.agent)) {
    throw new Error(`Invalid --agent. Use one of: ${agentCliIdHint()}.`);
  }

  const timeoutMs =
    options.timeoutMs === undefined ? undefined : parsePositiveInteger(options.timeoutMs);

  return formatAgentSmokeResult(
    await runAgentSmoke(
      projectRoot,
      {
        agent: options.agent,
        timeoutMs
      },
      {
        interactiveSessionRunner: createAntigravityPtySessionRunner()
      }
    )
  );
}

export async function listAgentSessionsCommand(
  projectRoot: string,
  options: AgentSessionCommandOptions = {}
): Promise<string> {
  const date = await resolveSessionDate(projectRoot, options);
  const sessions = await readSessionsForDate(projectRoot, date);

  return [
    "Kairon agent sessions.",
    `date=${date}`,
    `sessions=${sessions.length}`,
    ...sessions.map(formatSessionListLine)
  ].join("\n");
}

export async function showAgentSessionCommand(
  projectRoot: string,
  agent: string,
  options: AgentSessionCommandOptions = {}
): Promise<string> {
  const agentId = parseAgentId(agent);
  const date = await resolveSessionDate(projectRoot, options);
  const metadata = await readSession(projectRoot, date, agentId);

  if (metadata === null) {
    return [
      "Kairon agent session not found.",
      `date=${date}`,
      `agent=${agentId}`,
      "status=missing",
      `session_path=${sessionArtifactPath(projectRoot, date, agentId)}`
    ].join("\n");
  }

  const status = sameDaySessionStatus(metadata);
  const dispatcherStatus = dispatcherStatusFor(status, metadata);
  const issue = sessionIssue(metadata);

  return [
    "Kairon agent session.",
    `date=${date}`,
    `agent=${metadata.agent}`,
    `session_id=${metadata.session_id}`,
    `status=${status}`,
    `dispatcher_status=${dispatcherStatus}`,
    `mode=${metadata.mode}`,
    `command=${metadata.command}`,
    `command_available=${metadata.command_available}`,
    `active_run_id=${metadata.active_run_id ?? ""}`,
    `last_run_id=${metadata.last_run_id ?? ""}`,
    `last_task_id=${metadata.last_task_id ?? ""}`,
    `last_status=${metadata.last_status ?? ""}`,
    `session_path=${sessionArtifactPath(projectRoot, date, agentId)}`,
    `scratch=${metadata.scratch}`,
    ...(metadata.session_context_manifest === undefined
      ? []
      : [`session_context_manifest=${metadata.session_context_manifest}`]),
    ...formatIssueLines(issue)
  ].join("\n");
}

export async function resetAgentSessionCommand(
  projectRoot: string,
  agent: string,
  options: AgentSessionResetCommandOptions = {}
): Promise<string> {
  const agentId = parseAgentId(agent);
  if (options.date === undefined) {
    throw new Error("Missing --date for agent session reset.");
  }

  const date = options.date;
  const sessionDir = sessionDirectory(projectRoot, date, agentId);
  const archiveDir = await nextArchiveDirectory(
    projectRoot,
    date,
    agentId,
    options.now?.() ?? new Date()
  );

  if (!(await exists(sessionDir))) {
    return [
      "Kairon agent session reset skipped.",
      `date=${date}`,
      `agent=${agentId}`,
      "status=missing",
      `session_path=${sessionArtifactPath(projectRoot, date, agentId)}`
    ].join("\n");
  }

  await rename(sessionDir, archiveDir);

  return [
    "Kairon agent session reset.",
    `date=${date}`,
    `agent=${agentId}`,
    "status=archived",
    `archived_path=${toArtifactPath(projectRoot, archiveDir)}`
  ].join("\n");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  return parsed;
}

async function resolveSessionDate(
  projectRoot: string,
  options: AgentSessionCommandOptions
): Promise<string> {
  if (options.date !== undefined) {
    return options.date;
  }

  const config = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  return getLocalDateKey(options.now?.() ?? new Date(), config.timezone);
}

async function readSessionsForDate(
  projectRoot: string,
  date: string
): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  for (const agent of agentIds) {
    const session = await readSession(projectRoot, date, agent);
    if (session !== null) {
      sessions.push(session);
    }
  }

  return sessions.sort((left, right) => left.agent.localeCompare(right.agent));
}

async function readSession(
  projectRoot: string,
  date: string,
  agent: AgentId
): Promise<SessionMetadata | null> {
  const sessionPath = resolveInside(sessionDirectory(projectRoot, date, agent), "session.json");
  try {
    await access(sessionPath);
    return readJsonFile<SessionMetadata>(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function formatSessionListLine(metadata: SessionMetadata): string {
  const status = sameDaySessionStatus(metadata);
  const dispatcherStatus = dispatcherStatusFor(status, metadata);
  const issue = sessionIssue(metadata);
  return [
    `agent=${metadata.agent}`,
    `status=${status}`,
    `dispatcher_status=${dispatcherStatus}`,
    `command=${metadata.command}`,
    `command_available=${metadata.command_available}`,
    `last_status=${metadata.last_status ?? ""}`,
    `reason=${issue?.reason ?? ""}`,
    `session_path=${sessionArtifactPathFromMetadata(metadata)}`
  ].join(" ");
}

type SessionIssue = {
  reason: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
};

function sessionIssue(metadata: SessionMetadata): SessionIssue | null {
  if (!metadata.command_available) {
    return {
      reason: "cli_command_missing",
      setup_action: `Install or expose ${metadata.command} on PATH, then run kairon agent session reset ${metadata.agent} --date ${metadata.date}.`
    };
  }

  if (metadata.pause !== undefined && metadata.pause !== null) {
    return {
      reason: metadata.pause.reason ?? metadata.pause.status,
      setup_action: metadata.pause.setup_action,
      resume_hint: metadata.pause.resume_hint,
      retry_after: metadata.pause.retry_after,
      matched_pattern: metadata.pause.matched_pattern
    };
  }

  if (metadata.status === "setup_required") {
    return {
      reason: "session_setup_required",
      setup_action: `Complete ${metadata.command} setup, then run kairon agent session reset ${metadata.agent} --date ${metadata.date}.`
    };
  }

  return null;
}

function formatIssueLines(issue: SessionIssue | null): string[] {
  if (issue === null) {
    return [];
  }

  return [
    `setup_reason=${issue.reason}`,
    ...(issue.setup_action === undefined ? [] : [`setup_action=${issue.setup_action}`]),
    ...(issue.resume_hint === undefined ? [] : [`resume_hint=${issue.resume_hint}`]),
    ...(issue.retry_after === undefined ? [] : [`retry_after=${issue.retry_after}`]),
    ...(issue.matched_pattern === undefined
      ? []
      : [`matched_pattern=${issue.matched_pattern}`])
  ];
}

function parseAgentId(agent: string): AgentId {
  if (!isAgentId(agent)) {
    throw new Error(`Invalid agent. Use one of: ${agentCliIdHint()}.`);
  }

  return agent;
}

function sessionDirectory(projectRoot: string, date: string, agent: AgentId): string {
  return resolveInside(getKaironPaths(projectRoot).sessionsDir, date, agent);
}

function sessionArtifactPath(projectRoot: string, date: string, agent: AgentId): string {
  return toArtifactPath(
    projectRoot,
    resolveInside(sessionDirectory(projectRoot, date, agent), "session.json")
  );
}

function sessionArtifactPathFromMetadata(metadata: SessionMetadata): string {
  return `.kairon/sessions/${metadata.date}/${metadata.agent}/session.json`;
}

async function nextArchiveDirectory(
  projectRoot: string,
  date: string,
  agent: AgentId,
  now: Date
): Promise<string> {
  const parent = resolveInside(getKaironPaths(projectRoot).sessionsDir, date);
  const stamp = archiveStamp(now);
  const baseName = `${agent}.archived-${stamp}`;
  const entries = new Set(await listNames(parent));
  if (!entries.has(baseName)) {
    return resolveInside(parent, baseName);
  }

  for (let index = 2; index < 1000; index += 1) {
    const name = `${baseName}-${index}`;
    if (!entries.has(name)) {
      return resolveInside(parent, name);
    }
  }

  throw new Error(`Unable to allocate archive path for ${agent} on ${date}.`);
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).map(
      (entry) => entry.name
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function archiveStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toArtifactPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
