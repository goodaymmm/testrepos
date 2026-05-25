import type { AgentId } from "./types.js";

export type BootstrapPromptInput = {
  agent: AgentId;
  date: string;
  contextPath: string;
};

export type JobPromptInput = {
  runId: string;
  taskId: string;
  persona: string;
  contextPath: string;
  expectedOutboxPath: string;
  capabilities?: string[];
};

const agentDisplayNames: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Antigravity"
};

export function buildDailyBootstrapPrompt(input: BootstrapPromptInput): string {
  return [
    `KAIRON_DAILY_BOOTSTRAP_START ${input.date}`,
    "",
    `You are running as the ${agentDisplayNames[input.agent]} Agent inside Kairon.`,
    "This terminal session should stay active until maintenance end.",
    "Use the provided project rules and daily context.",
    "Do not treat this session memory as canonical state.",
    "Important decisions must be written to outbox / messages / scratch.",
    "",
    "Bootstrap context:",
    input.contextPath,
    "",
    `KAIRON_DAILY_BOOTSTRAP_END ${input.date}`,
    ""
  ].join("\n");
}

export function buildJobPrompt(input: JobPromptInput): string {
  const capabilityLines =
    input.capabilities === undefined || input.capabilities.length === 0
      ? []
      : [
          "",
          "Capability hints:",
          ...input.capabilities.map((capability) => `- ${capability}`)
        ];

  return [
    `KAIRON_JOB_START ${input.runId}`,
    `Task: ${input.taskId}`,
    `Persona: ${input.persona}`,
    `Expected outbox: ${input.expectedOutboxPath}`,
    ...capabilityLines,
    "",
    "Instructions:",
    "- Use the current project session context.",
    "- Read the attached job context.",
    "- Write the required outbox JSON.",
    "- Do not modify canonical state directly.",
    "",
    "Context path:",
    input.contextPath,
    "",
    `KAIRON_JOB_END ${input.runId}`,
    ""
  ].join("\n");
}
