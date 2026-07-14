import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { getAgentAdapter } from "./adapters/index.js";
import {
  createAgentSessionHealth,
  reconcileAgentCommandHealth,
  recordAgentSessionHealth,
  summarizeAgentSessionHealth,
  type AgentSessionHealthArtifact,
  type AgentSessionHealthSummary,
  type SessionHealthObservation
} from "./session-health.js";
import { agentIds, type AgentId, type RunnerMode } from "./types.js";

export type SessionStatus = "ready" | "setup_required" | "closed";
export type SameDaySessionStatus =
  | "ready"
  | "idle"
  | "busy"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited"
  | "closed";
export type DispatcherSessionStatus =
  | "ready"
  | "idle"
  | "busy"
  | "unavailable"
  | "missing_cli"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited";
export type SessionRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited"
  | "timeout"
  | "no_output";

export type SessionResumeHint = {
  strategy:
    | "native_resume"
    | "kairon_context_checkpoint"
    | "interactive_terminal_reuse";
  command: string;
  args: string[];
  automatic: boolean;
  constraints: string[];
  updated_at: string;
};

export type SessionPause = {
  status:
    | "setup_required"
    | "permission_required"
    | "rate_limited"
    | "usage_limited";
  reason?: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
  run_id?: string;
  task_id?: string;
  updated_at: string;
};

export type SessionRunCheckpoint = {
  kind: "daily_bootstrap" | "job";
  run_id?: string;
  task_id?: string;
  persona?: string;
  context_path: string;
  outbox_path?: string;
  prompt_path?: string;
  stdout_log?: string;
  stderr_log?: string;
  runner_metadata_path: string;
  status: SessionRunStatus;
  failure_reason?: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
};

export type SessionContextManifest = {
  schema_version: string;
  kind: "session_context_manifest";
  session_id: string;
  date: string;
  agent: AgentId;
  scratch: string;
  latest_context_path: string | null;
  runs: SessionRunCheckpoint[];
  updated_at: string;
};

export type SessionRunUpdate = Omit<SessionRunCheckpoint, "updated_at">;

export type SessionMetadata = {
  schema_version: string;
  session_id: string;
  date: string;
  agent: AgentId;
  adapter: string;
  command: string;
  command_available: boolean;
  mode: RunnerMode;
  status: SessionStatus;
  native: {
    resume_id: string | null;
    thread_id: string | null;
    resume_supported: boolean;
  };
  active_run_id: string | null;
  last_run_id: string | null;
  last_task_id?: string | null;
  last_persona?: string | null;
  last_context_path?: string | null;
  last_prompt_path?: string | null;
  last_stdout_log?: string | null;
  last_stderr_log?: string | null;
  last_runner_metadata_path?: string | null;
  last_status?: SessionRunStatus | null;
  pause?: SessionPause | null;
  terminal_id?: string;
  resume_hint?: SessionResumeHint;
  context_manifest: string;
  session_context_manifest?: string;
  health?: AgentSessionHealthSummary;
  health_path?: string;
  scratch: string;
  created_at: string;
  updated_at: string;
};

export type SameDaySessionSnapshot = {
  agent: AgentId;
  session_id: string;
  terminal_id?: string;
  status: SameDaySessionStatus;
  dispatcher_status: DispatcherSessionStatus;
  mode: RunnerMode;
  command: string;
  command_available: boolean;
  active_run_id: string | null;
  last_run_id: string | null;
  last_status?: SessionRunStatus | null;
  last_prompt_path?: string | null;
  last_stdout_log?: string | null;
  last_stderr_log?: string | null;
  last_runner_metadata_path?: string | null;
  pause?: SessionPause | null;
  resume_hint?: SessionResumeHint;
  session_path: string;
  scratch: string;
  session_context_manifest?: string;
  health?: AgentSessionHealthSummary;
  health_path?: string;
};

export type SameDaySessionSummary = {
  schema_version: string;
  date: string;
  initialized: number;
  ready: number;
  idle: number;
  busy: number;
  setup_required: number;
  permission_required: number;
  rate_limited: number;
  usage_limited: number;
  closed: number;
  agents: SameDaySessionSnapshot[];
  updated_at: string;
};

export type AgentJobEnvelope = {
  runId: string;
  taskId?: string;
  persona: string;
  contextPath: string;
  expectedOutboxPath: string;
};

export type RunHandle = {
  run_id: string;
  session_id: string;
  status: "accepted_for_runner";
  context_path: string;
  expected_outbox_path: string;
};

export type CommandAvailabilityChecker = (command: string) => Promise<boolean>;

type AgentsConfig = {
  agents: Record<
    string,
    {
      enabled?: boolean;
      command?: string;
      adapter?: string;
      mode?: RunnerMode;
    }
  >;
};

const execFileAsync = promisify(execFile);

export class FileSessionHost {
  constructor(
    private readonly projectRoot: string,
    private readonly options: {
      commandAvailability?: CommandAvailabilityChecker;
      now?: () => Date;
    } = {}
  ) {}

  async openSession(agent: AgentId, date: string): Promise<SessionMetadata> {
    const sessionDir = this.sessionDir(agent, date);
    await mkdir(sessionDir, { recursive: true });
    await ensureFile(resolveInside(sessionDir, "scratch.md"), "");
    await ensureJsonFile(resolveInside(sessionDir, "context_manifest.json"), {
      schema_version: "0.1",
      agent,
      date,
      sources: []
    });
    const created = await this.createSessionMetadata(agent, date);
    const current = await this.attachSession(agent, date);
    const baseMetadata =
      current === null ? created : mergeSessionMetadata(current, created, this.now());
    const metadata = await this.reconcileSessionHealth(baseMetadata);
    await this.ensureSessionContextManifest(metadata);
    await writeJsonFileAtomic(this.sessionPath(agent, date), metadata);
    return metadata;
  }

  async attachSession(
    agent: AgentId,
    date: string
  ): Promise<SessionMetadata | null> {
    const sessionPath = this.sessionPath(agent, date);

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

  async sendJob(
    sessionId: string,
    job: AgentJobEnvelope
  ): Promise<RunHandle> {
    return {
      run_id: job.runId,
      session_id: sessionId,
      status: "accepted_for_runner",
      context_path: job.contextPath,
      expected_outbox_path: job.expectedOutboxPath
    };
  }

  async markRunStarted(
    agent: AgentId,
    date: string,
    run: string | SessionRunUpdate
  ): Promise<SessionMetadata | null> {
    const current = await this.attachSession(agent, date);
    if (current === null) {
      return null;
    }

    const runId = typeof run === "string" ? run : run.run_id;
    const updated = await this.writeSession(agent, date, {
      ...current,
      active_run_id: runId ?? current.active_run_id,
      last_task_id: typeof run === "string" ? current.last_task_id : (run.task_id ?? null),
      last_persona: typeof run === "string" ? current.last_persona : (run.persona ?? null),
      last_context_path:
        typeof run === "string" ? current.last_context_path : run.context_path,
      last_prompt_path:
        typeof run === "string" ? current.last_prompt_path : (run.prompt_path ?? null),
      last_stdout_log:
        typeof run === "string" ? current.last_stdout_log : (run.stdout_log ?? null),
      last_stderr_log:
        typeof run === "string" ? current.last_stderr_log : (run.stderr_log ?? null),
      last_runner_metadata_path:
        typeof run === "string"
          ? current.last_runner_metadata_path
          : run.runner_metadata_path,
      last_status: typeof run === "string" ? "running" : run.status,
      pause: null,
      updated_at: this.now().toISOString()
    });

    if (typeof run !== "string") {
      await this.upsertSessionRun(agent, date, run);
    }

    return updated;
  }

  async markRunFinished(
    agent: AgentId,
    date: string,
    run: string | SessionRunUpdate
  ): Promise<SessionMetadata | null> {
    const current = await this.attachSession(agent, date);
    if (current === null) {
      return null;
    }

    const runId = typeof run === "string" ? run : run.run_id;
    let next: SessionMetadata = {
      ...current,
      active_run_id:
        runId !== undefined && current.active_run_id === runId
          ? null
          : current.active_run_id,
      last_run_id: runId ?? current.last_run_id,
      last_task_id: typeof run === "string" ? current.last_task_id : (run.task_id ?? null),
      last_persona: typeof run === "string" ? current.last_persona : (run.persona ?? null),
      last_context_path:
        typeof run === "string" ? current.last_context_path : run.context_path,
      last_prompt_path:
        typeof run === "string" ? current.last_prompt_path : (run.prompt_path ?? null),
      last_stdout_log:
        typeof run === "string" ? current.last_stdout_log : (run.stdout_log ?? null),
      last_stderr_log:
        typeof run === "string" ? current.last_stderr_log : (run.stderr_log ?? null),
      last_runner_metadata_path:
        typeof run === "string"
          ? current.last_runner_metadata_path
          : run.runner_metadata_path,
      last_status: typeof run === "string" ? current.last_status : run.status,
      pause: typeof run === "string" ? current.pause : pauseForRun(run, this.now()),
      updated_at: this.now().toISOString()
    };

    if (typeof run !== "string") {
      next = await this.withRunHealth(next, run);
    }

    const updated = await this.writeSession(agent, date, next);

    if (typeof run !== "string") {
      await this.upsertSessionRun(agent, date, run);
    }

    return updated;
  }

  async recordSessionContext(
    agent: AgentId,
    date: string,
    run: SessionRunUpdate
  ): Promise<SessionMetadata | null> {
    const current = await this.attachSession(agent, date);
    if (current === null) {
      return null;
    }

    let next: SessionMetadata = {
      ...current,
      last_run_id: run.run_id ?? current.last_run_id,
      last_task_id: run.task_id ?? current.last_task_id ?? null,
      last_persona: run.persona ?? current.last_persona ?? null,
      last_context_path: run.context_path,
      last_prompt_path: run.prompt_path ?? current.last_prompt_path ?? null,
      last_stdout_log: run.stdout_log ?? current.last_stdout_log ?? null,
      last_stderr_log: run.stderr_log ?? current.last_stderr_log ?? null,
      last_runner_metadata_path: run.runner_metadata_path,
      last_status: run.status,
      pause: pauseForRun(run, this.now()),
      updated_at: this.now().toISOString()
    };
    next = await this.withRunHealth(next, run);
    const updated = await this.writeSession(agent, date, next);
    await this.upsertSessionRun(agent, date, run);
    return updated;
  }

  async closeSession(agent: AgentId, date: string): Promise<SessionMetadata | null> {
    const current = await this.attachSession(agent, date);
    if (current === null) {
      return null;
    }

    const updated = {
      ...current,
      status: "closed" as const,
      updated_at: this.now().toISOString()
    };
    await writeJsonFileAtomic(this.sessionPath(agent, date), updated);
    return updated;
  }

  private async writeSession(
    agent: AgentId,
    date: string,
    metadata: SessionMetadata
  ): Promise<SessionMetadata> {
    await writeJsonFileAtomic(this.sessionPath(agent, date), metadata);
    return metadata;
  }

  private async createSessionMetadata(
    agent: AgentId,
    date: string
  ): Promise<SessionMetadata> {
    const adapter = getAgentAdapter(agent);
    const configured = await this.loadConfiguredAgent(agent);
    const command = configured.command ?? adapter.command;
    const commandAvailable = await this.checkCommand(command);
    const paths = getKaironPaths(this.projectRoot);
    const sessionDir = this.sessionDir(agent, date);
    const contextManifestPath = resolveInside(sessionDir, "context_manifest.json");
    const sessionContextManifestPath = resolveInside(
      sessionDir,
      "session_context_manifest.json"
    );
    const scratchPath = resolveInside(sessionDir, "scratch.md");
    const now = this.now().toISOString();
    const terminalId = terminalIdFor(agent, date);

    return {
      schema_version: "0.1",
      session_id: `SESSION-${date}-${agent}`,
      date,
      agent,
      adapter: configured.adapter ?? adapter.adapter,
      command,
      command_available: commandAvailable,
      mode: configured.mode ?? adapter.defaultMode,
      status: commandAvailable ? "ready" : "setup_required",
      native: {
        resume_id: null,
        thread_id: null,
        resume_supported: adapter.supports.resume
      },
      active_run_id: null,
      last_run_id: null,
      last_task_id: null,
      last_persona: null,
      last_context_path: null,
      last_prompt_path: null,
      last_stdout_log: null,
      last_stderr_log: null,
      last_runner_metadata_path: null,
      last_status: null,
      pause: null,
      terminal_id: terminalId,
      resume_hint: createResumeHint(agent, command, now),
      context_manifest: toArtifactPath(paths.root, contextManifestPath),
      session_context_manifest: toArtifactPath(paths.root, sessionContextManifestPath),
      scratch: toArtifactPath(paths.root, scratchPath),
      created_at: now,
      updated_at: now
    };
  }

  private async ensureSessionContextManifest(
    metadata: SessionMetadata
  ): Promise<void> {
    const manifestPath = this.sessionContextManifestPath(
      metadata.agent,
      metadata.date
    );
    const existing = await this.readSessionContextManifest(
      metadata.agent,
      metadata.date
    );
    await writeJsonFileAtomic(manifestPath, {
      schema_version: "0.1",
      kind: "session_context_manifest",
      session_id: metadata.session_id,
      date: metadata.date,
      agent: metadata.agent,
      scratch: metadata.scratch,
      latest_context_path: existing?.latest_context_path ?? null,
      runs: existing?.runs ?? [],
      updated_at: this.now().toISOString()
    } satisfies SessionContextManifest);
  }

  private async upsertSessionRun(
    agent: AgentId,
    date: string,
    run: SessionRunUpdate
  ): Promise<void> {
    const metadata = await this.attachSession(agent, date);
    if (metadata === null) {
      return;
    }

    const existing =
      (await this.readSessionContextManifest(agent, date)) ??
      createEmptySessionContextManifest(metadata, this.now());
    const checkpoint: SessionRunCheckpoint = {
      ...run,
      updated_at: this.now().toISOString()
    };
    const key = sessionRunKey(checkpoint);
    const runs = [
      ...existing.runs.filter((entry) => sessionRunKey(entry) !== key),
      checkpoint
    ];

    await writeJsonFileAtomic(this.sessionContextManifestPath(agent, date), {
      ...existing,
      session_id: metadata.session_id,
      date,
      agent,
      scratch: metadata.scratch,
      latest_context_path: run.context_path,
      runs,
      updated_at: this.now().toISOString()
    } satisfies SessionContextManifest);
    await this.updateSessionScratchCheckpoint(agent, date, checkpoint);
  }

  private async readSessionContextManifest(
    agent: AgentId,
    date: string
  ): Promise<SessionContextManifest | null> {
    const manifestPath = this.sessionContextManifestPath(agent, date);

    try {
      await access(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }

    return readJsonFile<SessionContextManifest>(manifestPath);
  }

  private async reconcileSessionHealth(
    metadata: SessionMetadata
  ): Promise<SessionMetadata> {
    const now = this.now();
    const existing = await this.readSessionHealth(metadata.agent, metadata.date);
    const health = existing === null
      ? createAgentSessionHealth({
          sessionId: metadata.session_id,
          date: metadata.date,
          agent: metadata.agent,
          commandAvailable: metadata.command_available,
          now
        })
      : reconcileAgentCommandHealth(existing, metadata.command_available, now);
    await writeJsonFileAtomic(this.healthPath(metadata.agent, metadata.date), health);
    return this.withHealthSummary(metadata, health);
  }

  private async withRunHealth(
    metadata: SessionMetadata,
    run: SessionRunUpdate
  ): Promise<SessionMetadata> {
    const observation = healthObservationForRun(run);
    if (observation === null) {
      return metadata;
    }

    const now = this.now();
    const current =
      (await this.readSessionHealth(metadata.agent, metadata.date)) ??
      createAgentSessionHealth({
        sessionId: metadata.session_id,
        date: metadata.date,
        agent: metadata.agent,
        commandAvailable: metadata.command_available,
        now
      });
    const health = recordAgentSessionHealth(current, observation, now);
    await writeJsonFileAtomic(this.healthPath(metadata.agent, metadata.date), health);
    return this.withHealthSummary(metadata, health);
  }

  private withHealthSummary(
    metadata: SessionMetadata,
    health: AgentSessionHealthArtifact
  ): SessionMetadata {
    return {
      ...metadata,
      health: summarizeAgentSessionHealth(health),
      health_path: toArtifactPath(
        this.projectRoot,
        this.healthPath(metadata.agent, metadata.date)
      )
    };
  }

  private async readSessionHealth(
    agent: AgentId,
    date: string
  ): Promise<AgentSessionHealthArtifact | null> {
    const healthPath = this.healthPath(agent, date);
    try {
      await access(healthPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }

    return readJsonFile<AgentSessionHealthArtifact>(healthPath);
  }

  private async loadConfiguredAgent(agent: AgentId): Promise<{
    command?: string;
    adapter?: string;
    mode?: RunnerMode;
  }> {
    const config = await loadConfigFile<AgentsConfig>(this.projectRoot, "agents.json");
    return config.agents[agent] ?? {};
  }

  private async checkCommand(command: string): Promise<boolean> {
    const checker = this.options.commandAvailability ?? isCommandAvailable;
    return checker(command);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private sessionDir(agent: AgentId, date: string): string {
    return resolveInside(getKaironPaths(this.projectRoot).sessionsDir, date, agent);
  }

  private sessionPath(agent: AgentId, date: string): string {
    return resolveInside(this.sessionDir(agent, date), "session.json");
  }

  private sessionContextManifestPath(agent: AgentId, date: string): string {
    return resolveInside(
      this.sessionDir(agent, date),
      "session_context_manifest.json"
    );
  }

  private healthPath(agent: AgentId, date: string): string {
    return resolveInside(this.sessionDir(agent, date), "health.json");
  }

  private async updateSessionScratchCheckpoint(
    agent: AgentId,
    date: string,
    checkpoint: SessionRunCheckpoint
  ): Promise<void> {
    const scratchPath = resolveInside(this.sessionDir(agent, date), "scratch.md");
    const existing = await readTextIfExists(scratchPath);
    const withoutCheckpoint = existing
      .replace(
        /\n?<!-- KAIRON_SESSION_CHECKPOINT_START -->[\s\S]*?<!-- KAIRON_SESSION_CHECKPOINT_END -->\n?/,
        ""
      )
      .trimEnd();
    const checkpointBlock = [
      "<!-- KAIRON_SESSION_CHECKPOINT_START -->",
      "# Kairon Session Checkpoint",
      "",
      `Agent: ${agent}`,
      `Date: ${date}`,
      `Run: ${checkpoint.run_id ?? "(bootstrap)"}`,
      `Task: ${checkpoint.task_id ?? "(none)"}`,
      `Persona: ${checkpoint.persona ?? "(none)"}`,
      `Status: ${checkpoint.status}`,
      `Context: ${checkpoint.context_path}`,
      checkpoint.prompt_path === undefined ? null : `Prompt: ${checkpoint.prompt_path}`,
      checkpoint.outbox_path === undefined ? null : `Outbox: ${checkpoint.outbox_path}`,
      checkpoint.stdout_log === undefined ? null : `Stdout: ${checkpoint.stdout_log}`,
      checkpoint.stderr_log === undefined ? null : `Stderr: ${checkpoint.stderr_log}`,
      `Runner: ${checkpoint.runner_metadata_path}`,
      checkpoint.failure_reason === undefined
        ? null
        : `Failure: ${checkpoint.failure_reason}`,
      checkpoint.resume_hint === undefined ? null : `Resume: ${checkpoint.resume_hint}`,
      `Updated: ${checkpoint.updated_at}`,
      "<!-- KAIRON_SESSION_CHECKPOINT_END -->",
      ""
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    await writeFile(
      scratchPath,
      `${withoutCheckpoint}${withoutCheckpoint.length === 0 ? "" : "\n\n"}${checkpointBlock}`,
      "utf8"
    );
  }
}

export async function initializeSameDaySessions(
  projectRoot: string,
  date: string,
  options: {
    commandAvailability?: CommandAvailabilityChecker;
    now?: () => Date;
  } = {}
): Promise<SameDaySessionSummary> {
  const config = await loadConfigFile<AgentsConfig>(projectRoot, "agents.json");
  const host = new FileSessionHost(projectRoot, options);
  const enabledAgents = agentIds.filter((agent) => {
    const agentConfig = config.agents[agent];
    return agentConfig !== undefined && agentConfig.enabled !== false;
  });
  const sessions = await Promise.all(
    enabledAgents.map((agent) => host.openSession(agent, date))
  );
  const snapshots = sessions.map((session) => sessionSnapshot(projectRoot, session));
  const count = (status: SameDaySessionStatus): number =>
    snapshots.filter((session) => session.status === status).length;

  return {
    schema_version: "0.1",
    date,
    initialized: snapshots.length,
    ready: count("ready"),
    idle: count("idle"),
    busy: count("busy"),
    setup_required: count("setup_required"),
    permission_required: count("permission_required"),
    rate_limited: count("rate_limited"),
    usage_limited: count("usage_limited"),
    closed: count("closed"),
    agents: snapshots,
    updated_at: (options.now?.() ?? new Date()).toISOString()
  };
}

export function sessionSnapshot(
  projectRoot: string,
  metadata: SessionMetadata
): SameDaySessionSnapshot {
  const status = sameDaySessionStatus(metadata);

  return {
    agent: metadata.agent,
    session_id: metadata.session_id,
    terminal_id: metadata.terminal_id,
    status,
    dispatcher_status: dispatcherStatusFor(status, metadata),
    mode: metadata.mode,
    command: metadata.command,
    command_available: metadata.command_available,
    active_run_id: metadata.active_run_id,
    last_run_id: metadata.last_run_id,
    last_status: metadata.last_status,
    last_prompt_path: metadata.last_prompt_path,
    last_stdout_log: metadata.last_stdout_log,
    last_stderr_log: metadata.last_stderr_log,
    last_runner_metadata_path: metadata.last_runner_metadata_path,
    pause: metadata.pause,
    resume_hint: metadata.resume_hint,
    health: metadata.health,
    health_path: metadata.health_path,
    session_path: toArtifactPath(
      projectRoot,
      resolveInside(
        getKaironPaths(projectRoot).sessionsDir,
        metadata.date,
        metadata.agent,
        "session.json"
      )
    ),
    scratch: metadata.scratch,
    session_context_manifest: metadata.session_context_manifest
  };
}

export function sameDaySessionStatus(
  metadata: SessionMetadata
): SameDaySessionStatus {
  if (metadata.status === "closed") {
    return "closed";
  }

  if (metadata.status === "setup_required" || !metadata.command_available) {
    return "setup_required";
  }

  if (metadata.active_run_id !== null) {
    return "busy";
  }

  if (
    metadata.last_status === "setup_required" ||
    metadata.last_status === "permission_required" ||
    metadata.last_status === "rate_limited" ||
    metadata.last_status === "usage_limited"
  ) {
    return metadata.last_status;
  }

  return metadata.last_run_id === null ? "ready" : "idle";
}

export function dispatcherStatusFor(
  status: SameDaySessionStatus,
  metadata: Pick<SessionMetadata, "command_available">
): DispatcherSessionStatus {
  if (status === "setup_required" || !metadata.command_available) {
    return metadata.command_available ? "setup_required" : "missing_cli";
  }

  if (status === "closed") {
    return "unavailable";
  }

  return status;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where.exe" : "which";

  try {
    await execFileAsync(finder, [command], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  }
}

async function ensureJsonFile(filePath: string, content: unknown): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await writeJsonFileAtomic(filePath, content);
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function toArtifactPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function mergeSessionMetadata(
  current: SessionMetadata,
  next: SessionMetadata,
  now: Date
): SessionMetadata {
  return {
    ...current,
    adapter: next.adapter,
    command: next.command,
    command_available: next.command_available,
    mode: next.mode,
    status: current.status === "closed" ? current.status : next.status,
    native: {
      ...current.native,
      resume_supported: next.native.resume_supported
    },
    terminal_id: next.terminal_id,
    resume_hint: next.resume_hint,
    context_manifest: next.context_manifest,
    session_context_manifest: next.session_context_manifest,
    scratch: next.scratch,
    updated_at: now.toISOString()
  };
}

function createEmptySessionContextManifest(
  metadata: SessionMetadata,
  now: Date
): SessionContextManifest {
  return {
    schema_version: "0.1",
    kind: "session_context_manifest",
    session_id: metadata.session_id,
    date: metadata.date,
    agent: metadata.agent,
    scratch: metadata.scratch,
    latest_context_path: null,
    runs: [],
    updated_at: now.toISOString()
  };
}

function healthObservationForRun(
  run: SessionRunUpdate
): SessionHealthObservation | null {
  if (run.status === "running") {
    return null;
  }

  return {
    status: run.status,
    reason: run.failure_reason ?? `session_run_${run.status}`,
    run_id: run.run_id,
    task_id: run.task_id,
    setup_action: run.setup_action,
    resume_hint: run.resume_hint,
    retry_after: run.retry_after,
    matched_pattern: run.matched_pattern
  };
}

function sessionRunKey(
  run: Pick<SessionRunCheckpoint, "kind" | "run_id" | "runner_metadata_path">
): string {
  return run.run_id ?? `${run.kind}:${run.runner_metadata_path}`;
}

function pauseForRun(
  run: SessionRunUpdate,
  now: Date
): SessionPause | null {
  if (
    run.status !== "setup_required" &&
    run.status !== "permission_required" &&
    run.status !== "rate_limited" &&
    run.status !== "usage_limited"
  ) {
    return null;
  }

  return {
    status: run.status,
    reason: run.failure_reason,
    setup_action: run.setup_action,
    resume_hint: run.resume_hint,
    retry_after: run.retry_after,
    matched_pattern: run.matched_pattern,
    run_id: run.run_id,
    task_id: run.task_id,
    updated_at: now.toISOString()
  };
}

function terminalIdFor(agent: AgentId, date: string): string {
  return `TERM-${agent}-${date.replaceAll("-", "")}`;
}

function createResumeHint(
  agent: AgentId,
  command: string,
  updatedAt: string
): SessionResumeHint {
  if (agent === "codex") {
    return {
      strategy: "native_resume",
      command,
      args: ["resume", "--last"],
      automatic: false,
      constraints: [
        "Use only when a native Codex session exists for the project.",
        "Kairon non-interactive runs still carry the full context checkpoint."
      ],
      updated_at: updatedAt
    };
  }

  if (agent === "claude") {
    return {
      strategy: "kairon_context_checkpoint",
      command,
      args: ["--continue"],
      automatic: false,
      constraints: [
        "Claude can continue native conversations, but Kairon keeps deterministic print-mode prompts checkpointed.",
        "Enable native resume only when prior conversation ownership is clear."
      ],
      updated_at: updatedAt
    };
  }

  return {
    strategy: "interactive_terminal_reuse",
    command,
    args: ["--continue"],
    automatic: false,
    constraints: [
      "Antigravity requires a visible PTY-backed session for reuse.",
      "If the PTY session exits or stops producing outboxes, start a fresh session and keep the old artifacts."
    ],
    updated_at: updatedAt
  };
}
