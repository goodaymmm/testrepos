import { loadConfigFile } from "../core/config/load-config.js";
import { getAgentAdapter } from "./adapters/index.js";
import { agentDisplayName } from "./display.js";
import type { AgentId, RunnerMode, SessionScope } from "./types.js";
import { agentIds, isAgentId } from "./types.js";

export type AgentSessionAvailability = {
  agent: AgentId;
  status:
    | "ready"
    | "idle"
    | "busy"
    | "unavailable"
    | "missing_cli"
    | "setup_required"
    | "permission_required"
    | "rate_limited"
    | "usage_limited";
  mode?: RunnerMode;
};

export type DispatchRequest = {
  taskId?: string;
  persona: string;
  modelClass?: string;
  requiredCapabilities?: string[];
  resources?: string[];
  tags?: string[];
  scheduleMode?: string;
  availableSessions?: AgentSessionAvailability[];
  excludedAgents?: AgentId[];
  allowInteractiveAgents?: boolean;
  policy?: {
    allowedAgents?: AgentId[];
    excludedAgents?: AgentId[];
  };
};

export type DispatchDecision = {
  agent: AgentId;
  persona: string;
  runnerMode: RunnerMode;
  sessionScope: SessionScope;
  reason: string;
  candidates: AgentId[];
};

type AgentsConfig = {
  agents: Record<
    string,
    {
      enabled: boolean;
      command?: string;
      mode?: RunnerMode;
      personas?: string[];
    }
  >;
};

type DispatchConfig = {
  default_agent?: string;
  personas?: Record<string, { preferred_agents?: string[]; max_parallel?: number }>;
};

const antigravitySignals = [
  "google",
  "gcp",
  "firebase",
  "android",
  "chrome",
  "workspace",
  "youtube",
  "multimodal",
  "vision",
  "image",
  "video",
  "large_context",
  "large-context"
];

const capabilityMatrix: Record<AgentId, string[]> = {
  codex: [
    "coding",
    "filesystem.write",
    "workspace.write",
    "json.output",
    "native.mcp",
    "qa",
    "resume",
    "research",
    "review"
  ],
  claude: [
    "coding",
    "filesystem.write",
    "workspace.write",
    "json.output",
    "native.mcp",
    "planning",
    "qa",
    "research",
    "review"
  ],
  gemini: [
    "filesystem.write",
    "google.ecosystem",
    "json.output",
    "large.context",
    "multimodal",
    "qa",
    "research",
    "review"
  ]
};

export class AgentDispatcher {
  constructor(private readonly projectRoot: string) {}

  async decide(request: DispatchRequest): Promise<DispatchDecision> {
    const [agentsConfig, dispatchConfig] = await Promise.all([
      loadConfigFile<AgentsConfig>(this.projectRoot, "agents.json"),
      loadConfigFile<DispatchConfig>(this.projectRoot, "dispatch.json")
    ]);

    const candidates = this.resolveCandidates(request, agentsConfig, dispatchConfig);
    const selected = candidates[0];

    if (selected === undefined) {
      throw new Error(`No available agent for persona: ${request.persona}`);
    }

    const session = request.availableSessions?.find(
      (candidate) => candidate.agent === selected
    );
    const agentConfig = agentsConfig.agents[selected];

    return {
      agent: selected,
      persona: request.persona,
      runnerMode:
        session?.mode ?? agentConfig?.mode ?? "persistent_terminal_session",
      sessionScope: "daily",
      reason: buildReason(selected, request, session),
      candidates
    };
  }

  private resolveCandidates(
    request: DispatchRequest,
    agentsConfig: AgentsConfig,
    dispatchConfig: DispatchConfig
  ): AgentId[] {
    const eligible = new Set(
      agentIds.filter((agent) => {
        const config = agentsConfig.agents[agent];
        if (config === undefined || !config.enabled) {
          return false;
        }

        if (request.excludedAgents?.includes(agent)) {
          return false;
        }

        if (request.policy?.excludedAgents?.includes(agent)) {
          return false;
        }

        if (
          request.policy?.allowedAgents !== undefined &&
          !request.policy.allowedAgents.includes(agent)
        ) {
          return false;
        }

        if (
          config.personas !== undefined &&
          !config.personas.includes(request.persona) &&
          agent !== dispatchConfig.default_agent
        ) {
          return false;
        }

        if (!supportsRequiredCapabilities(agent, request.requiredCapabilities)) {
          return false;
        }

        if (
          !getAgentAdapter(agent).supports.nonInteractive &&
          request.allowInteractiveAgents !== true
        ) {
          return false;
        }

        return hasAvailableSession(agent, request.availableSessions);
      })
    );

    const preferredAgents =
      dispatchConfig.personas?.[request.persona]?.preferred_agents ?? [];
    const defaultAgent = dispatchConfig.default_agent;
    const ordered = uniqueAgentIds([
      ...(prefersAntigravity(request) ? ["gemini"] : []),
      ...preferredAgents,
      ...(defaultAgent === undefined ? [] : [defaultAgent]),
      ...agentIds
    ]);

    return ordered.filter((agent) => eligible.has(agent));
  }
}

export async function decideAgent(
  projectRoot: string,
  request: DispatchRequest
): Promise<DispatchDecision> {
  return new AgentDispatcher(projectRoot).decide(request);
}

function hasAvailableSession(
  agent: AgentId,
  sessions: AgentSessionAvailability[] | undefined
): boolean {
  if (sessions === undefined) {
    return true;
  }

  const session = sessions.find((candidate) => candidate.agent === agent);
  return session?.status === "ready" || session?.status === "idle";
}

function uniqueAgentIds(values: readonly string[]): AgentId[] {
  const result: AgentId[] = [];

  for (const value of values) {
    if (isAgentId(value) && !result.includes(value)) {
      result.push(value);
    }
  }

  return result;
}

function prefersAntigravity(request: DispatchRequest): boolean {
  const signals = [
    request.modelClass,
    ...(request.requiredCapabilities ?? []),
    ...(request.resources ?? []),
    ...(request.tags ?? [])
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());

  return signals.some((signal) =>
    antigravitySignals.some((antigravitySignal) => signal.includes(antigravitySignal))
  );
}

function supportsRequiredCapabilities(
  agent: AgentId,
  capabilities: string[] | undefined
): boolean {
  if (capabilities === undefined) {
    return true;
  }

  const normalizedCapabilities = new Set(
    capabilityMatrix[agent].map(normalizeCapability)
  );
  const knownCapabilities = new Set(
    Object.values(capabilityMatrix).flat().map(normalizeCapability)
  );

  return capabilities
    .map(normalizeCapability)
    .filter((capability) => knownCapabilities.has(capability))
    .every((capability) => normalizedCapabilities.has(capability));
}

function normalizeCapability(capability: string): string {
  return capability.toLowerCase().replace(/[_-]/g, ".");
}

function buildReason(
  agent: AgentId,
  request: DispatchRequest,
  session: AgentSessionAvailability | undefined
): string {
  const parts = [`${agentDisplayName(agent)} selected for persona ${request.persona}`];

  if (prefersAntigravity(request) && agent === "gemini") {
    parts.push("google or multimodal signal matched");
  }

  if (session !== undefined) {
    parts.push(`session ${session.status}`);
  }

  return parts.join("; ");
}
