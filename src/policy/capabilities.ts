import type { AgentId } from "../agents/types.js";

export const capabilityClasses = [
  "read",
  "workspace_write",
  "git_write",
  "external_read",
  "external_write",
  "privileged"
] as const;

export type CapabilityClass = (typeof capabilityClasses)[number];

export type CapabilityDefinition = {
  id: string;
  class: CapabilityClass;
  aliases?: string[];
};

export type ConnectorCapabilityRequest = {
  id: string;
  scope: CapabilityClass;
};

export type ResolvedCapability =
  | {
      kind: "capability";
      requested: string;
      id: string;
      class: CapabilityClass;
      known: true;
    }
  | {
      kind: "connector";
      requested: string;
      id: string;
      class: CapabilityClass;
      connector: ConnectorCapabilityRequest;
      known: true;
    }
  | {
      kind: "unknown";
      requested: string;
      id: string;
      known: false;
    };

const definitions: CapabilityDefinition[] = [
  { id: "read", class: "read" },
  { id: "json.output", class: "read", aliases: ["json_output"] },
  { id: "planning", class: "read" },
  { id: "qa", class: "read" },
  { id: "review", class: "read" },
  { id: "resume", class: "read" },
  { id: "smoke.test", class: "read", aliases: ["smoke_test"] },
  { id: "large.context", class: "read", aliases: ["large_context"] },
  { id: "multimodal", class: "read" },
  { id: "research", class: "external_read" },
  {
    id: "google.ecosystem",
    class: "external_read",
    aliases: ["google_ecosystem"]
  },
  { id: "external.read", class: "external_read", aliases: ["external_read"] },
  { id: "coding", class: "workspace_write" },
  {
    id: "filesystem.write",
    class: "workspace_write",
    aliases: ["filesystem_write"]
  },
  {
    id: "workspace.write",
    class: "workspace_write",
    aliases: ["workspace_write"]
  },
  { id: "git.write", class: "git_write", aliases: ["git_write"] },
  { id: "merge", class: "git_write" },
  {
    id: "external.write",
    class: "external_write",
    aliases: ["external_write"]
  },
  { id: "deploy", class: "external_write" },
  { id: "privileged", class: "privileged" },
  { id: "secret.access", class: "privileged", aliases: ["secret_access"] },
  { id: "billing.write", class: "privileged", aliases: ["billing_write"] }
];

const definitionById = new Map<string, CapabilityDefinition>();

for (const definition of definitions) {
  definitionById.set(definition.id, definition);
  for (const alias of definition.aliases ?? []) {
    definitionById.set(normalizeCapabilityId(alias), definition);
  }
}

export const defaultAgentCapabilities: Record<AgentId, string[]> = {
  codex: [
    "coding",
    "filesystem.write",
    "workspace.write",
    "git.write",
    "json.output",
    "qa",
    "read",
    "resume",
    "research",
    "review"
  ],
  claude: [
    "coding",
    "filesystem.write",
    "workspace.write",
    "git.write",
    "json.output",
    "planning",
    "qa",
    "read",
    "research",
    "review"
  ],
  gemini: [
    "external.read",
    "filesystem.write",
    "google.ecosystem",
    "json.output",
    "large.context",
    "multimodal",
    "qa",
    "read",
    "research",
    "review"
  ]
};

export function normalizeCapabilityId(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]/gu, ".");
}

export function isCapabilityClass(value: string): value is CapabilityClass {
  return (capabilityClasses as readonly string[]).includes(value);
}

export function resolveCapability(value: string): ResolvedCapability {
  const trimmed = value.trim();
  const connector =
    parseConnectorCapability(trimmed) ??
    parseBuiltInConnectorCapability(trimmed);

  if (connector !== undefined) {
    return {
      kind: "connector",
      requested: value,
      id: `connector:${connector.id}:${connector.scope}`,
      class: connector.scope,
      connector,
      known: true
    };
  }

  const normalized = normalizeCapabilityId(trimmed);
  const definition = definitionById.get(normalized);
  if (definition === undefined) {
    return {
      kind: "unknown",
      requested: value,
      id: normalized,
      known: false
    };
  }

  return {
    kind: "capability",
    requested: value,
    id: definition.id,
    class: definition.class,
    known: true
  };
}

export function normalizeCapabilityList(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => resolveCapability(value).id)
        .filter((value) => value.length > 0)
    )
  ].sort();
}

function parseConnectorCapability(
  value: string
): ConnectorCapabilityRequest | undefined {
  const match = /^connector:([a-z0-9][a-z0-9._-]*):([a-z_]+)$/iu.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  const scope = match[2].toLowerCase();
  if (!isCapabilityClass(scope)) {
    return undefined;
  }

  return {
    id: match[1].toLowerCase(),
    scope
  };
}

function parseBuiltInConnectorCapability(
  value: string
): ConnectorCapabilityRequest | undefined {
  return normalizeCapabilityId(value) === "native.mcp"
    ? { id: "native.mcp", scope: "external_read" }
    : undefined;
}
