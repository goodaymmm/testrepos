import { claudeAdapter } from "./claude.js";
import { codexAdapter, type AgentAdapterDefinition } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import type { AgentId } from "../types.js";

export const defaultAgentAdapters: Record<AgentId, AgentAdapterDefinition> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter
};

export function getAgentAdapter(agent: AgentId): AgentAdapterDefinition {
  return defaultAgentAdapters[agent];
}

export type { AgentAdapterDefinition };
