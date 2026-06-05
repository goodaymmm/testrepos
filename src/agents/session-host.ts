import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { getAgentAdapter } from "./adapters/index.js";
import type { AgentId, RunnerMode } from "./types.js";

export type SessionStatus = "ready" | "setup_required" | "closed";
export type SessionRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
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

export type SessionRunCheckpoint = {
  kind: "daily_bootstrap" | "job";
  run_id?: string;
  task_id?: string;
  persona?: string;
  context_path: string;
  outbox_path?: string;
  runner_metadata_path: string;
  status: SessionRunStatus;
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
  last_status?: SessionRunStatus | null;
  terminal_id?: string;
  resume_hint?: SessionResumeHint;
  context_manifest: string;
  session_context_manifest?: string;
  scratch: string;
  created_at: string;
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
    const metadata =
      current === null ? created : mergeSessionMetadata(current, created, this.now());
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
      last_status: typeof run === "string" ? "running" : run.status,
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
    const updated = await this.writeSession(agent, date, {
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
      last_status: typeof run === "string" ? current.last_status : run.status,
      updated_at: this.now().toISOString()
    });

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

    const updated = await this.writeSession(agent, date, {
      ...current,
      last_run_id: run.run_id ?? current.last_run_id,
      last_task_id: run.task_id ?? current.last_task_id ?? null,
      last_persona: run.persona ?? current.last_persona ?? null,
      last_context_path: run.context_path,
      last_status: run.status,
      updated_at: this.now().toISOString()
    });
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
      last_status: null,
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

function sessionRunKey(
  run: Pick<SessionRunCheckpoint, "kind" | "run_id" | "runner_metadata_path">
): string {
  return run.run_id ?? `${run.kind}:${run.runner_metadata_path}`;
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
