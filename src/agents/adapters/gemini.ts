import type { AgentAdapterDefinition } from "./codex.js";

export const geminiAdapter: AgentAdapterDefinition = {
  agent: "gemini",
  adapter: "antigravity_cli",
  command: "agy",
  defaultMode: "persistent_terminal_session",
  supports: {
    nonInteractive: false,
    jsonOutput: false,
    resume: false,
    workspaceWrite: true,
    nativeMcp: false,
    multimodal: true
  },
  subscriptionMode: true,
  requiresVisibleTerminal: true,
  sessionStrategy: "terminal_session_primary_visible_terminal_required"
};
