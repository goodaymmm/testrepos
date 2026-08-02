import type { AgentAdapterDefinition } from "./codex.js";

export const claudeAdapter: AgentAdapterDefinition = {
  agent: "claude",
  adapter: "claude_code",
  command: "claude",
  defaultMode: "persistent_terminal_session",
  supports: {
    nonInteractive: true,
    jsonOutput: true,
    resume: false,
    workspaceWrite: true,
    nativeMcp: true,
    multimodal: false
  },
  subscriptionMode: true,
  requiresVisibleTerminal: false,
  sessionStrategy: "terminal_session_primary_kairon_context_checkpoint"
};
