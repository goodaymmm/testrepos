import { copyFile } from "node:fs/promises";
import path from "node:path";
import { getConfigPath, normalizeProjectRoot, toPosixPath } from "../fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../fs/json-file.js";
import { validateAllConfigs } from "./load-config.js";
import type { ValidationResult } from "./validate-config.js";
import { normalizeWorkflowRuntimeConfig } from "../../workflow/config.js";

type JsonObject = Record<string, unknown>;

export type ConfigMigrationOptions = {
  projectRoot: string;
  dryRun?: boolean;
  now?: Date;
};

export type ConfigMigrationChange = {
  file: string;
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
};

export type ConfigMigrationResult = {
  dryRun: boolean;
  changed: boolean;
  changes: ConfigMigrationChange[];
  backups: string[];
  validation: ValidationResult;
};

export type WorkflowRuntimeConfigMigrationPlan = {
  migration_required: boolean;
  runtime_config: JsonObject;
  changes: ConfigMigrationChange[];
};

export async function migrateConfigs(
  options: ConfigMigrationOptions
): Promise<ConfigMigrationResult> {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const changes: ConfigMigrationChange[] = [];
  const backups: string[] = [];

  const agentsPath = getConfigPath(projectRoot, "agents.json");
  const agentsConfig = await readJsonFile<JsonObject>(agentsPath);

  migrateGeminiToAntigravity(agentsConfig, changes);

  if (changes.length > 0 && !dryRun) {
    const backupPath = `${agentsPath}.bak-${formatTimestamp(now)}`;
    await copyFile(agentsPath, backupPath);
    backups.push(toPosixPath(path.relative(projectRoot, backupPath)));
    await writeJsonFileAtomic(agentsPath, agentsConfig);
  }

  const validation = await validateAllConfigs(projectRoot);

  return {
    dryRun,
    changed: changes.length > 0,
    changes,
    backups,
    validation
  };
}

export function formatMigrationResult(result: ConfigMigrationResult): string {
  const lines: string[] = [];

  if (!result.changed) {
    lines.push("Kairon migrations are up to date.");
  } else if (result.dryRun) {
    lines.push("Kairon migration dry run. Planned changes:");
  } else {
    lines.push("Kairon migration completed.");
  }

  for (const change of result.changes) {
    lines.push(
      `- ${change.file} ${change.path}: ${formatValue(change.from)} -> ${formatValue(change.to)}`
    );
  }

  if (result.backups.length > 0) {
    lines.push(`backups=${result.backups.join(",")}`);
  }

  lines.push(`validation.ok=${result.validation.ok}`);

  for (const warning of result.validation.warnings) {
    lines.push(`warning=${warning}`);
  }

  for (const error of result.validation.errors) {
    lines.push(`error=${error}`);
  }

  return lines.join("\n");
}

export function planWorkflowRuntimeConfigMigration(
  runtimeConfig: JsonObject,
  enabled: boolean
): WorkflowRuntimeConfigMigrationPlan {
  const workflow = asObject(runtimeConfig.workflow) ?? {};
  const normalized = normalizeWorkflowRuntimeConfig(
    workflow as Parameters<typeof normalizeWorkflowRuntimeConfig>[0],
    enabled
  );
  const nextRuntimeConfig = structuredClone(runtimeConfig);
  nextRuntimeConfig.workflow = normalized;
  const changes: ConfigMigrationChange[] = [];

  if (typeof workflow.enabled !== "boolean") {
    changes.push({
      file: "runtime.json",
      path: "workflow.enabled",
      from: workflow.enabled,
      to: enabled,
      reason:
        "Production workflow enablement is graduated to an explicit config value."
    });
  } else if (workflow.enabled !== enabled) {
    changes.push({
      file: "runtime.json",
      path: "workflow.enabled",
      from: workflow.enabled,
      to: enabled,
      reason: "Production workflow enablement is changed by operator proposal."
    });
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (key === "enabled" || valuesEqual(workflow[key], value)) {
      continue;
    }
    changes.push({
      file: "runtime.json",
      path: `workflow.${key}`,
      from: workflow[key],
      to: value,
      reason: "Production workflow config is normalized to the supported schema."
    });
  }

  if (workflow.enabled_env !== undefined) {
    changes.push({
      file: "runtime.json",
      path: "workflow.enabled_env",
      from: workflow.enabled_env,
      to: undefined,
      reason:
        "Legacy environment enablement remains a runtime fallback only until this proposal is applied."
    });
  }

  return {
    migration_required:
      workflow.enabled_env !== undefined || typeof workflow.enabled !== "boolean",
    runtime_config: nextRuntimeConfig,
    changes
  };
}

function migrateGeminiToAntigravity(
  agentsConfig: JsonObject,
  changes: ConfigMigrationChange[]
): void {
  const agents = asObject(agentsConfig.agents);
  const gemini = asObject(agents?.gemini);

  if (gemini === undefined) {
    return;
  }

  replaceValue({
    target: gemini,
    key: "adapter",
    expectedCurrent: "gemini_cli",
    next: "antigravity_cli",
    file: "agents.json",
    path: "agents.gemini.adapter",
    reason: "Legacy gemini_cli adapter is migrated to AntigravityCLI."
  }, changes);

  replaceValue({
    target: gemini,
    key: "command",
    expectedCurrent: "gemini",
    next: "agy",
    file: "agents.json",
    path: "agents.gemini.command",
    reason: "AntigravityCLI is launched with agy."
  }, changes);
}

function replaceValue(
  migration: {
    target: JsonObject;
    key: string;
    expectedCurrent: unknown;
    next: unknown;
    file: string;
    path: string;
    reason: string;
  },
  changes: ConfigMigrationChange[]
): void {
  const current = migration.target[migration.key];

  if (current !== migration.expectedCurrent) {
    return;
  }

  migration.target[migration.key] = migration.next;
  changes.push({
    file: migration.file,
    path: migration.path,
    from: current,
    to: migration.next,
    reason: migration.reason
  });
}

function asObject(value: unknown): JsonObject | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return undefined;
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
