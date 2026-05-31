import type { AgentId } from "./types.js";

export function agentDisplayName(agent: AgentId): string {
  if (agent === "gemini") {
    return "antigravity(gemini)";
  }

  return agent;
}

export function agentCliIdHint(): string {
  return "codex, claude, or gemini (Antigravity compatibility id)";
}
