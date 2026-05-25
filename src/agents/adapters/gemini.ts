import type { AgentAdapterDefinition } from "./codex.js";

export const geminiAdapter: AgentAdapterDefinition = {
  agent: "gemini",
  adapter: "antigravity_cli",
  command: "agy",
  defaultMode: "persistent_terminal_session",
  supports: {
    nonInteractive: true,
    jsonOutput: false,
    resume: false,
    workspaceWrite: true,
    nativeMcp: false,
    multimodal: true
  },
  subscriptionMode: true,
  requiresVisibleTerminal: false,
  sessionStrategy: "terminal_session_primary_kairon_context_checkpoint"
};
