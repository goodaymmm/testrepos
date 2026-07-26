export type SchemaDomain = "config" | "state";

export type SchemaRegistryEntry = {
  domain: SchemaDomain;
  key: string;
  current_version: string;
  minimum_readable_version: string;
  minimum_writable_version: string;
  append_only: boolean;
  rewrite_policy: "migration" | "reader_compatibility";
};

export type SchemaCompatibility =
  | "current"
  | "migration_required"
  | "unsupported_older"
  | "unsupported_newer"
  | "invalid";

export const currentConfigSchemaVersion = "0.3.0";
export const minimumReadableConfigSchemaVersion = "0.1";
export const minimumWritableConfigSchemaVersion = "0.2.0";
export const currentStateSchemaVersion = "0.1";

const configFiles = [
  "project.json",
  "runtime.json",
  "schedule.json",
  "agents.json",
  "dispatch.json",
  "policies.json",
  "notifications.json",
  "rag.json"
] as const;

const stateArtifactKinds = [
  "event_record",
  "audit_record",
  "task",
  "run",
  "approval",
  "correlation",
  "workflow",
  "git_transaction",
  "review",
  "incident",
  "state_backup",
  "update",
  "release",
  "board",
  "runtime",
  "rag",
  "support_bundle",
  "migration"
] as const;

export const configSchemaRegistry: readonly SchemaRegistryEntry[] =
  configFiles.map((key) => ({
    domain: "config",
    key,
    current_version: currentConfigSchemaVersion,
    minimum_readable_version: minimumReadableConfigSchemaVersion,
    minimum_writable_version: minimumWritableConfigSchemaVersion,
    append_only: false,
    rewrite_policy: "migration"
  }));

export const stateSchemaRegistry: readonly SchemaRegistryEntry[] =
  stateArtifactKinds.map((key) => ({
    domain: "state",
    key,
    current_version: currentStateSchemaVersion,
    minimum_readable_version: currentStateSchemaVersion,
    minimum_writable_version: currentStateSchemaVersion,
    append_only: key === "event_record" || key === "audit_record",
    rewrite_policy: "reader_compatibility"
  }));

export function listSchemaRegistry(): readonly SchemaRegistryEntry[] {
  return [...configSchemaRegistry, ...stateSchemaRegistry];
}

export function inspectConfigSchemaVersion(
  fileName: string,
  version: unknown
): SchemaCompatibility {
  if (!configFiles.includes(fileName as (typeof configFiles)[number])) {
    return "invalid";
  }
  return inspectVersion(
    version,
    minimumReadableConfigSchemaVersion,
    currentConfigSchemaVersion
  );
}

export function inspectStateSchemaVersion(version: unknown): SchemaCompatibility {
  return inspectVersion(
    version,
    currentStateSchemaVersion,
    currentStateSchemaVersion
  );
}

export function isReadableConfigSchemaVersion(
  fileName: string,
  version: unknown
): boolean {
  const compatibility = inspectConfigSchemaVersion(fileName, version);
  return compatibility === "current" || compatibility === "migration_required";
}

export function formatSchemaCompatibilityError(
  fileName: string,
  version: unknown,
  compatibility: SchemaCompatibility
): string {
  const observed = typeof version === "string" ? version : "missing";
  if (compatibility === "unsupported_newer") {
    return `${fileName}: schema_version ${observed} is newer than supported ${currentConfigSchemaVersion}`;
  }
  if (compatibility === "unsupported_older") {
    return `${fileName}: schema_version ${observed} is older than readable ${minimumReadableConfigSchemaVersion}`;
  }
  return `${fileName}: schema_version ${observed} is invalid`;
}

function inspectVersion(
  value: unknown,
  minimumReadable: string,
  current: string
): SchemaCompatibility {
  const parsed = parseVersion(value);
  const minimum = parseVersion(minimumReadable);
  const maximum = parseVersion(current);
  if (parsed === undefined || minimum === undefined || maximum === undefined) {
    return "invalid";
  }
  if (compareVersion(parsed, minimum) < 0) {
    return "unsupported_older";
  }
  if (compareVersion(parsed, maximum) > 0) {
    return "unsupported_newer";
  }
  return compareVersion(parsed, maximum) === 0
    ? "current"
    : "migration_required";
}

function parseVersion(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3] ?? "0", 10)
  ];
}

function compareVersion(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
