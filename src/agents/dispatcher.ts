import { loadConfigFile } from "../core/config/load-config.js";
import { getAgentAdapter } from "./adapters/index.js";
import { agentDisplayName } from "./display.js";
import {
  getProviderPolicyHealth,
  isProviderRunAllowed,
  type ProviderPolicyHealth
} from "./provider-policy.js";
import type { AgentSessionHealthStatus } from "./session-health.js";
import type { SessionBudgetStatus } from "./session-budget.js";
import type { AgentId, RunnerMode, SessionScope } from "./types.js";
import { agentIds, isAgentId } from "./types.js";
import {
  defaultAgentCapabilities,
  resolveCapability
} from "../policy/capabilities.js";

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
  healthStatus?: AgentSessionHealthStatus;
  nextRetryAt?: string | null;
  budgetStatus?: SessionBudgetStatus;
  budgetReasons?: string[];
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
  avoidUnhealthyAgents?: boolean;
  unattended?: boolean;
  persistProviderHealth?: boolean;
  now?: Date;
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
      supported_capabilities?: string[];
      supported_connectors?: string[];
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

export class AgentDispatcher {
  constructor(private readonly projectRoot: string) {}

  async decide(request: DispatchRequest): Promise<DispatchDecision> {
    const now = request.now ?? new Date();
    const [agentsConfig, dispatchConfig, providerHealth] = await Promise.all([
      loadConfigFile<AgentsConfig>(this.projectRoot, "agents.json"),
      loadConfigFile<DispatchConfig>(this.projectRoot, "dispatch.json"),
      Promise.all(
        agentIds.map(async (agent) => [
          agent,
          await getProviderPolicyHealth(this.projectRoot, agent, {
            now,
            persist: request.persistProviderHealth !== false
          })
        ] as const)
      )
    ]);

    const providerHealthByAgent = new Map(providerHealth);
    const candidates = this.resolveCandidates(
      request,
      agentsConfig,
      dispatchConfig,
      providerHealthByAgent
    );
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
      reason: buildReason(
        selected,
        request,
        session,
        providerHealthByAgent.get(selected)
      ),
      candidates
    };
  }

  private resolveCandidates(
    request: DispatchRequest,
    agentsConfig: AgentsConfig,
    dispatchConfig: DispatchConfig,
    providerHealth: ReadonlyMap<AgentId, ProviderPolicyHealth>
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

        if (
          !supportsRequiredCapabilities(
            agent,
            request.requiredCapabilities,
            config.supported_capabilities,
            config.supported_connectors
          )
        ) {
          return false;
        }

        if (
          !getAgentAdapter(agent).supports.nonInteractive &&
          request.allowInteractiveAgents !== true
        ) {
          return false;
        }

        const health = providerHealth.get(agent);
        if (
          health !== undefined &&
          !isProviderRunAllowed(
            health,
            request.unattended !== false,
            request.now ?? new Date()
          )
        ) {
          return false;
        }

        return hasAvailableSession(
          agent,
          request.availableSessions,
          request.avoidUnhealthyAgents !== false,
          request.now ?? new Date()
        );
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
  sessions: AgentSessionAvailability[] | undefined,
  avoidUnhealthyAgents: boolean,
  now: Date
): boolean {
  if (sessions === undefined) {
    return true;
  }

  const session = sessions.find((candidate) => candidate.agent === agent);
  if (session?.status !== "ready" && session?.status !== "idle") {
    return false;
  }

  if (
    !avoidUnhealthyAgents ||
    session.healthStatus === undefined ||
    session.healthStatus === "healthy"
  ) {
    return true;
  }

  if (session.nextRetryAt === undefined || session.nextRetryAt === null) {
    return false;
  }

  const nextRetryAt = Date.parse(session.nextRetryAt);
  return Number.isFinite(nextRetryAt) && nextRetryAt <= now.getTime();
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
  capabilities: string[] | undefined,
  supportedCapabilities: string[] | undefined,
  supportedConnectors: string[] | undefined
): boolean {
  if (capabilities === undefined) {
    return true;
  }

  const normalizedCapabilities = new Set(
    (supportedCapabilities ?? defaultAgentCapabilities[agent]).map(
      (capability) => resolveCapability(capability).id
    )
  );
  const normalizedConnectors =
    supportedConnectors === undefined
      ? undefined
      : new Set(
          supportedConnectors.map((connector) =>
            connector.trim().toLowerCase()
          )
        );

  return capabilities
    .map(resolveCapability)
    .every((capability) => {
      if (!capability.known) {
        return true;
      }
      if (capability.kind === "connector") {
        return (
          normalizedConnectors === undefined ||
          normalizedConnectors.has(capability.connector.id)
        );
      }
      return normalizedCapabilities.has(capability.id);
    });
}

function buildReason(
  agent: AgentId,
  request: DispatchRequest,
  session: AgentSessionAvailability | undefined,
  providerHealth: ProviderPolicyHealth | undefined
): string {
  const parts = [`${agentDisplayName(agent)} selected for persona ${request.persona}`];

  if (prefersAntigravity(request) && agent === "gemini") {
    parts.push("google or multimodal signal matched");
  }

  if (session !== undefined) {
    parts.push(`session ${session.status}`);
    if (session.healthStatus !== undefined) {
      parts.push(`health ${session.healthStatus}`);
    }
    if (session.budgetStatus !== undefined) {
      parts.push(`budget ${session.budgetStatus}`);
    }
  }

  if (providerHealth !== undefined) {
    parts.push(`provider ${providerHealth.status}`);
  }

  return parts.join("; ");
}
