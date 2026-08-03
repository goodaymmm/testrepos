export const agentIds = ["codex", "claude", "gemini"] as const;

export type AgentId = (typeof agentIds)[number];

export type RunnerMode =
  | "foreground_terminal"
  | "persistent_terminal_session"
  | "background_child_process"
  | "dry_run";

export type SessionScope = "daily";

export function isAgentId(value: string): value is AgentId {
  return (agentIds as readonly string[]).includes(value);
}
