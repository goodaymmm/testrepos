import type { CommandRunResult } from "./command-runner.js";
import type { SessionMetadata } from "./session-host.js";
import type { AgentId } from "./types.js";

export type InteractiveSessionJob = {
  agent: AgentId;
  command: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  runId: string;
  taskId: string;
  persona: string;
  outboxPath: string;
  expectedOutboxPath: string;
  contextPath: string;
  session: SessionMetadata;
};

export type InteractiveSessionRunner = (
  job: InteractiveSessionJob
) => Promise<CommandRunResult>;
