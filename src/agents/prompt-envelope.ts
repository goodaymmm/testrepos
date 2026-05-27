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
  contextContent?: string;
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
    "- The job context is embedded in this prompt; do not call file read tools just to read the context path.",
    "- Prefer writing the required outbox JSON file when file tools are available.",
    "- If file writing, tool execution, or approval is blocked, print the complete outbox JSON between the stdout fallback markers below.",
    "- Do not modify canonical state directly.",
    "",
    "Stdout fallback format:",
    "KAIRON_OUTBOX_JSON_START",
    JSON.stringify(
      {
        schema_version: "0.1",
        run_id: input.runId,
        task_id: input.taskId,
        persona: input.persona,
        status: "completed",
        events: [
          {
            type: "message.created",
            payload: {
              message_type: "agent.run.completed",
              body: "Short completion summary."
            }
          }
        ]
      },
      null,
      2
    ),
    "KAIRON_OUTBOX_JSON_END",
    "",
    "Context path:",
    input.contextPath,
    "",
    "Embedded context:",
    "KAIRON_CONTEXT_START",
    input.contextContent ?? "",
    "KAIRON_CONTEXT_END",
    "",
    `KAIRON_JOB_END ${input.runId}`,
    ""
  ].join("\n");
}
