import type { AgentId, RunnerMode } from "../types.js";

export type AgentAdapterDefinition = {
  agent: AgentId;
  adapter: string;
  command: string;
  defaultMode: RunnerMode;
  supports: {
    nonInteractive: boolean;
    jsonOutput: boolean;
    resume: boolean;
    workspaceWrite: boolean;
    nativeMcp: boolean;
    multimodal: boolean;
  };
  subscriptionMode: boolean;
  requiresVisibleTerminal: boolean;
  sessionStrategy: string;
};

export const codexAdapter: AgentAdapterDefinition = {
  agent: "codex",
  adapter: "codex_cli",
  command: "codex",
  defaultMode: "persistent_terminal_session",
  supports: {
    nonInteractive: true,
    jsonOutput: true,
    resume: true,
    workspaceWrite: true,
    nativeMcp: true,
    multimodal: false
  },
  subscriptionMode: true,
  requiresVisibleTerminal: false,
  sessionStrategy: "terminal_session_primary_resume_for_recovery"
};
