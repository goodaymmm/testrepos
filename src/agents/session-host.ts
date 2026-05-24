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
  context_manifest: string;
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
    const metadata = await this.createSessionMetadata(agent, date);
    const sessionDir = this.sessionDir(agent, date);
    await mkdir(sessionDir, { recursive: true });
    await ensureFile(resolveInside(sessionDir, "scratch.md"), "");
    await ensureJsonFile(resolveInside(sessionDir, "context_manifest.json"), {
      schema_version: "0.1",
      agent,
      date,
      sources: []
    });
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
    const scratchPath = resolveInside(sessionDir, "scratch.md");
    const now = this.now().toISOString();

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
      context_manifest: toArtifactPath(paths.root, contextManifestPath),
      scratch: toArtifactPath(paths.root, scratchPath),
      created_at: now,
      updated_at: now
    };
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
