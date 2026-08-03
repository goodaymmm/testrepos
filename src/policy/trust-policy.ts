import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ApprovalRecord } from "../approvals/approval-queue.js";
import type { AgentId } from "../agents/types.js";
import { loadConfigFile } from "../core/config/load-config.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../core/fs/json-file.js";
import {
  getKaironPaths,
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { trackCorrelationMember } from "../correlation/store.js";
import { StateApplier } from "../state/state-applier.js";
import {
  capabilityClasses,
  defaultAgentCapabilities,
  resolveCapability,
  type CapabilityClass,
  type ResolvedCapability
} from "./capabilities.js";

export const capabilityDecisionStatuses = [
  "allowed",
  "approval_required",
  "setup_required",
  "denied"
] as const;

export type CapabilityDecisionStatus =
  (typeof capabilityDecisionStatuses)[number];

export const connectorTrustLevels = [
  "untrusted",
  "restricted",
  "trusted",
  "privileged"
] as const;

export type ConnectorTrustLevel = (typeof connectorTrustLevels)[number];

export type ConnectorTrustDeclaration = {
  enabled: boolean;
  trust_level: ConnectorTrustLevel;
  allowed_scopes: CapabilityClass[];
  data_egress: boolean;
  write_actions: boolean;
};

export type CapabilityPolicyDecision = {
  schema_version: "0.1";
  task_id: string;
  agent: AgentId;
  persona: string;
  status: CapabilityDecisionStatus;
  requested: string[];
  supported: string[];
  policy_allowed: string[];
  approved: string[];
  effective: string[];
  denied: string[];
  approval_required: string[];
  setup_required: string[];
  connectors: Array<{
    id: string;
    scope: CapabilityClass;
    status: CapabilityDecisionStatus;
    trust_level?: ConnectorTrustLevel;
    data_egress?: boolean;
    write_actions?: boolean;
  }>;
  reasons: string[];
  approval_id?: string;
  approval_fingerprint?: string;
  correlation_id?: string;
  policy_source: "config" | "built_in_compatibility";
  evaluated_at: string;
};

export type CapabilityPolicyInspection = {
  status: "ready" | "compatibility" | "invalid";
  details: string[];
};

type AgentsConfig = {
  agents?: Partial<
    Record<
      AgentId,
      {
        supported_capabilities?: string[];
        supported_connectors?: string[];
      }
    >
  >;
};

type CapabilityPolicyConfig = {
  default_effect?: "deny";
  allowed_classes?: CapabilityClass[];
  approval_required_classes?: CapabilityClass[];
  denied_capabilities?: string[];
  approval_required_capabilities?: string[];
  personas?: Record<
    string,
    {
      allowed_capabilities?: string[];
      allowed_classes?: CapabilityClass[];
    }
  >;
  connectors?: Record<string, ConnectorTrustDeclaration>;
};

type PoliciesConfig = {
  capability_policy?: CapabilityPolicyConfig;
};

export type EvaluateCapabilityPolicyInput = {
  taskId: string;
  persona: string;
  agent: AgentId;
  requestedCapabilities: string[];
  now?: Date;
  approvals?: ApprovalRecord[];
};

const defaultAllowedClasses: CapabilityClass[] = [...capabilityClasses];
const defaultApprovalClasses: CapabilityClass[] = [
  "git_write",
  "external_write",
  "privileged"
];
const defaultConnectorDeclarations: Record<
  string,
  ConnectorTrustDeclaration
> = {
  "native.mcp": {
    enabled: true,
    trust_level: "restricted",
    allowed_scopes: ["read", "external_read"],
    data_egress: true,
    write_actions: false
  }
};

export async function evaluateCapabilityPolicy(
  projectRoot: string,
  input: EvaluateCapabilityPolicyInput
): Promise<CapabilityPolicyDecision> {
  const [agentsConfig, policiesConfig, approvals] = await Promise.all([
    loadConfigFile<AgentsConfig>(projectRoot, "agents.json"),
    loadConfigFile<PoliciesConfig>(projectRoot, "policies.json"),
    input.approvals ?? readCapabilityApprovals(projectRoot)
  ]);
  const policy = policiesConfig.capability_policy;
  const policySource =
    policy === undefined ? "built_in_compatibility" : "config";
  const requested = uniqueResolved(input.requestedCapabilities);
  const supportedSet = new Set(
    (
      agentsConfig.agents?.[input.agent]?.supported_capabilities ??
      defaultAgentCapabilities[input.agent]
    ).map((value) => resolveCapability(value).id)
  );
  const supportedConnectors = agentsConfig.agents?.[input.agent]
    ?.supported_connectors;
  const supportedConnectorSet =
    supportedConnectors === undefined
      ? undefined
      : new Set(supportedConnectors.map((value) => value.trim().toLowerCase()));
  const allowedClasses = new Set(
    policy?.allowed_classes ?? defaultAllowedClasses
  );
  const approvalClasses = new Set(
    policy?.approval_required_classes ?? defaultApprovalClasses
  );
  const deniedCapabilities = new Set(
    (policy?.denied_capabilities ?? []).map(normalizePolicyCapability)
  );
  const approvalCapabilities = new Set(
    (policy?.approval_required_capabilities ?? []).map(
      normalizePolicyCapability
    )
  );
  const personaPolicy = policy?.personas?.[input.persona];
  const personaCapabilities =
    personaPolicy?.allowed_capabilities === undefined
      ? undefined
      : new Set(
          personaPolicy.allowed_capabilities.map(normalizePolicyCapability)
        );
  const personaClasses =
    personaPolicy?.allowed_classes === undefined
      ? undefined
      : new Set(personaPolicy.allowed_classes);
  const approvalFingerprint = buildCapabilityApprovalFingerprint({
    taskId: input.taskId,
    agent: input.agent,
    requested: requested.map((capability) => capability.id)
  });
  const matchingApprovals = approvals.filter(
    (approval) =>
      approval.type === "capability_policy" &&
      approval.task_id === input.taskId &&
      approval.capability_fingerprint === approvalFingerprint
  );
  const approvedByHuman = matchingApprovals.some(
    (approval) =>
      approval.status === "decided" && approval.decision === "approve"
  );
  const rejectedByHuman = matchingApprovals.some(
    (approval) =>
      approval.status === "decided" &&
      (approval.decision === "reject" ||
        approval.decision === "request_changes")
  );

  const supported: string[] = [];
  const policyAllowed: string[] = [];
  const approved: string[] = [];
  const effective: string[] = [];
  const denied: string[] = [];
  const approvalRequired: string[] = [];
  const setupRequired: string[] = [];
  const connectors: CapabilityPolicyDecision["connectors"] = [];
  const reasons: string[] = [];

  for (const capability of requested) {
    if (!capability.known) {
      denied.push(capability.id);
      reasons.push(`unknown_capability:${capability.id}`);
      continue;
    }

    if (capability.kind === "connector") {
      const declaration = connectorDeclaration(
        policy,
        capability.connector.id
      );
      if (declaration === undefined) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied"
        });
        reasons.push(`unknown_connector:${capability.connector.id}`);
        continue;
      }
      if (!declaration.enabled) {
        setupRequired.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "setup_required",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`connector_disabled:${capability.connector.id}`);
        continue;
      }
      if (
        supportedConnectorSet !== undefined &&
        !supportedConnectorSet.has(capability.connector.id)
      ) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`agent_connector_unsupported:${capability.connector.id}`);
        continue;
      }
      if (!declaration.allowed_scopes.includes(capability.connector.scope)) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`connector_scope_denied:${capability.id}`);
        continue;
      }
      if (
        !trustLevelAllowsScope(
          declaration.trust_level,
          capability.connector.scope
        )
      ) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`connector_trust_insufficient:${capability.id}`);
        continue;
      }
      if (
        (capability.connector.scope === "external_read" ||
          capability.connector.scope === "external_write") &&
        !declaration.data_egress
      ) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`connector_data_egress_disabled:${capability.id}`);
        continue;
      }
      if (
        isWriteClass(capability.connector.scope) &&
        !declaration.write_actions
      ) {
        denied.push(capability.id);
        connectors.push({
          id: capability.connector.id,
          scope: capability.connector.scope,
          status: "denied",
          trust_level: declaration.trust_level,
          data_egress: declaration.data_egress,
          write_actions: declaration.write_actions
        });
        reasons.push(`connector_write_disabled:${capability.id}`);
        continue;
      }
      supported.push(capability.id);
    } else if (supportedSet.has(capability.id)) {
      supported.push(capability.id);
    } else {
      denied.push(capability.id);
      reasons.push(`agent_capability_unsupported:${capability.id}`);
      continue;
    }

    if (
      deniedCapabilities.has(capability.id) ||
      !allowedClasses.has(capability.class) ||
      (personaCapabilities !== undefined &&
        !personaCapabilities.has(capability.id)) ||
      (personaClasses !== undefined && !personaClasses.has(capability.class))
    ) {
      denied.push(capability.id);
      reasons.push(`policy_denied:${capability.id}`);
      if (capability.kind === "connector") {
        connectors.push(connectorResult(capability, policy, "denied"));
      }
      continue;
    }

    policyAllowed.push(capability.id);
    const needsApproval =
      approvalClasses.has(capability.class) ||
      approvalCapabilities.has(capability.id);
    if (needsApproval) {
      if (approvedByHuman) {
        approved.push(capability.id);
        effective.push(capability.id);
        if (capability.kind === "connector") {
          connectors.push(connectorResult(capability, policy, "allowed"));
        }
      } else if (rejectedByHuman) {
        denied.push(capability.id);
        reasons.push(`approval_rejected:${capability.id}`);
        if (capability.kind === "connector") {
          connectors.push(connectorResult(capability, policy, "denied"));
        }
      } else {
        approvalRequired.push(capability.id);
        reasons.push(`approval_required:${capability.id}`);
        if (capability.kind === "connector") {
          connectors.push(
            connectorResult(capability, policy, "approval_required")
          );
        }
      }
      continue;
    }

    effective.push(capability.id);
    if (capability.kind === "connector") {
      connectors.push(connectorResult(capability, policy, "allowed"));
    }
  }

  const status: CapabilityDecisionStatus =
    denied.length > 0
      ? "denied"
      : setupRequired.length > 0
        ? "setup_required"
        : approvalRequired.length > 0
          ? "approval_required"
          : "allowed";
  const approval = matchingApprovals
    .sort((left, right) =>
      String(right.updated_at ?? "").localeCompare(
        String(left.updated_at ?? "")
      )
    )
    .at(0);

  return {
    schema_version: "0.1",
    task_id: input.taskId,
    agent: input.agent,
    persona: input.persona,
    status,
    requested: requested.map((capability) => capability.id),
    supported: uniqueSorted(supported),
    policy_allowed: uniqueSorted(policyAllowed),
    approved: uniqueSorted(approved),
    effective: uniqueSorted(effective),
    denied: uniqueSorted(denied),
    approval_required: uniqueSorted(approvalRequired),
    setup_required: uniqueSorted(setupRequired),
    connectors,
    reasons: uniqueSorted(reasons),
    approval_id: approval?.id,
    approval_fingerprint: approvalRequired.length > 0
      ? approvalFingerprint
      : undefined,
    policy_source: policySource,
    evaluated_at: (input.now ?? new Date()).toISOString()
  };
}

export async function ensureCapabilityApproval(
  projectRoot: string,
  decision: CapabilityPolicyDecision
): Promise<CapabilityPolicyDecision> {
  if (
    decision.status !== "approval_required" ||
    decision.approval_id !== undefined ||
    decision.approval_fingerprint === undefined
  ) {
    return decision;
  }

  const approvalId = await nextId(projectRoot, "approval");
  await new StateApplier(projectRoot).appendEvent({
    type: "approval.requested",
    task_id: decision.task_id,
    actor: "kairon.capability-policy",
    payload: {
      approval: {
        id: approvalId,
        type: "capability_policy",
        title: `Capability approval for ${decision.task_id}`,
        task_id: decision.task_id,
        actions: ["approve", "reject", "request_changes", "snooze"],
        capability_fingerprint: decision.approval_fingerprint,
        requested_capabilities: decision.approval_required,
        agent: decision.agent,
        persona: decision.persona
      }
    },
    created_at: decision.evaluated_at
  });

  return { ...decision, approval_id: approvalId };
}

export async function writeCapabilityDecision(
  projectRoot: string,
  runId: string,
  decision: CapabilityPolicyDecision
): Promise<string> {
  const decisionPath = path.join(
    getKaironPaths(projectRoot).runsDir,
    runId,
    "capability-decision.json"
  );
  const relativePath = toPosixPath(path.relative(projectRoot, decisionPath));
  await writeJsonFileAtomic(decisionPath, decision);
  const correlation = await trackCorrelationMember(projectRoot, {
    approvalId: decision.approval_id,
    kind: "capability_decision",
    id: runId,
    status: decision.status,
    artifactPath: relativePath,
    createdAt: decision.evaluated_at
  });
  decision.correlation_id = correlation.correlation_id;
  await writeJsonFileAtomic(decisionPath, decision);
  return relativePath;
}

export async function inspectCapabilityPolicyConfig(
  projectRoot: string
): Promise<CapabilityPolicyInspection> {
  const [agentsConfig, policiesConfig] = await Promise.all([
    loadConfigFile<AgentsConfig>(projectRoot, "agents.json"),
    loadConfigFile<PoliciesConfig>(projectRoot, "policies.json")
  ]);
  const details: string[] = [];
  let invalid = false;

  if (policiesConfig.capability_policy === undefined) {
    details.push("capability_policy=missing (built-in compatibility policy active)");
  } else {
    details.push("capability_policy=configured");
    details.push(
      `connectors_declared=${Object.keys(
        policiesConfig.capability_policy.connectors ?? {}
      ).length}`
    );
    for (const [id, connector] of Object.entries(
      policiesConfig.capability_policy.connectors ?? {}
    )) {
      if (
        connector.allowed_scopes.some(
          (scope) => !trustLevelAllowsScope(connector.trust_level, scope)
        ) ||
        (connector.allowed_scopes.some(
          (scope) => scope === "external_read" || scope === "external_write"
        ) &&
          !connector.data_egress) ||
        (connector.allowed_scopes.some(isWriteClass) &&
          !connector.write_actions)
      ) {
        invalid = true;
        details.push(`invalid_connector=${id}:trust_or_scope_mismatch`);
      }
    }
  }

  for (const agent of ["codex", "claude", "gemini"] as const) {
    const supported =
      agentsConfig.agents?.[agent]?.supported_capabilities;
    if (supported === undefined) {
      details.push(`${agent}.supported_capabilities=missing (built-in defaults active)`);
    } else {
      details.push(`${agent}.supported_capabilities=${supported.length}`);
    }
  }

  return {
    status: invalid
      ? "invalid"
      : policiesConfig.capability_policy === undefined
        ? "compatibility"
        : "ready",
    details
  };
}

export function formatCapabilityDecision(
  decision: CapabilityPolicyDecision,
  options: { explain?: boolean; format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(decision, null, 2)}\n`;
  }

  const lines = [
    "Kairon capability decision.",
    `task_id=${decision.task_id}`,
    `agent=${decision.agent}`,
    `persona=${decision.persona}`,
    `status=${decision.status}`,
    `effective=${decision.effective.join(",") || "none"}`,
    `denied=${decision.denied.join(",") || "none"}`,
    `approval_required=${decision.approval_required.join(",") || "none"}`,
    `setup_required=${decision.setup_required.join(",") || "none"}`,
    `policy_source=${decision.policy_source}`
  ];

  if (decision.approval_id !== undefined) {
    lines.push(`approval_id=${decision.approval_id}`);
  }
  if (options.explain) {
    lines.push(`requested=${decision.requested.join(",") || "none"}`);
    lines.push(`supported=${decision.supported.join(",") || "none"}`);
    lines.push(
      `policy_allowed=${decision.policy_allowed.join(",") || "none"}`
    );
    lines.push(`approved=${decision.approved.join(",") || "none"}`);
    for (const reason of decision.reasons) {
      lines.push(`reason=${reason}`);
    }
  }

  return lines.join("\n");
}

export function buildCapabilityApprovalFingerprint(input: {
  taskId: string;
  agent: AgentId;
  requested: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        task_id: input.taskId,
        agent: input.agent,
        requested: [...new Set(input.requested)].sort()
      })
    )
    .digest("hex");
}

function uniqueResolved(values: string[]): ResolvedCapability[] {
  const byId = new Map<string, ResolvedCapability>();
  for (const value of values) {
    const resolved = resolveCapability(value);
    if (resolved.id.length > 0 && !byId.has(resolved.id)) {
      byId.set(resolved.id, resolved);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizePolicyCapability(value: string): string {
  return resolveCapability(value).id;
}

async function readCapabilityApprovals(
  projectRoot: string
): Promise<ApprovalRecord[]> {
  const approvalsDir = getKaironPaths(projectRoot).approvalsDir;
  let entries: string[];

  try {
    entries = await readdir(approvalsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const approvals = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        readJsonFile<ApprovalRecord>(resolveInside(approvalsDir, entry))
      )
  );
  return approvals.filter(
    (approval) =>
      typeof approval.id === "string" &&
      approval.type === "capability_policy"
  );
}

function isWriteClass(value: CapabilityClass): boolean {
  return (
    value === "workspace_write" ||
    value === "git_write" ||
    value === "external_write" ||
    value === "privileged"
  );
}

function trustLevelAllowsScope(
  trustLevel: ConnectorTrustLevel,
  scope: CapabilityClass
): boolean {
  const maximumRank: Record<ConnectorTrustLevel, number> = {
    untrusted: 0,
    restricted: 1,
    trusted: 2,
    privileged: 3
  };
  const requiredRank: Record<CapabilityClass, number> = {
    read: 0,
    external_read: 1,
    workspace_write: 2,
    git_write: 2,
    external_write: 2,
    privileged: 3
  };
  return maximumRank[trustLevel] >= requiredRank[scope];
}

function connectorResult(
  capability: Extract<ResolvedCapability, { kind: "connector" }>,
  policy: CapabilityPolicyConfig | undefined,
  status: CapabilityDecisionStatus
): CapabilityPolicyDecision["connectors"][number] {
  const declaration = connectorDeclaration(policy, capability.connector.id);
  return {
    id: capability.connector.id,
    scope: capability.connector.scope,
    status,
    trust_level: declaration?.trust_level,
    data_egress: declaration?.data_egress,
    write_actions: declaration?.write_actions
  };
}

function connectorDeclaration(
  policy: CapabilityPolicyConfig | undefined,
  connectorId: string
): ConnectorTrustDeclaration | undefined {
  return (policy?.connectors ?? defaultConnectorDeclarations)[connectorId];
}
