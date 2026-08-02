import { copyFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  analyzeProjectDocking,
  type ProjectConfigProposal,
  type ProjectDockingAnalysis
} from "../../docking/project-analyzer.js";
import { readJsonFile, writeJsonFileAtomic } from "../fs/json-file.js";
import {
  getConfigPath,
  getKaironPaths,
  normalizeProjectRoot,
  resolveInside,
  toPosixPath
} from "../fs/paths.js";
import { validateAllConfigs } from "./load-config.js";
import { planWorkflowRuntimeConfigMigration } from "./migrate-config.js";
import { validateConfigFile, type ValidationResult } from "./validate-config.js";

export type ConfigProposalArtifact = ProjectDockingAnalysis & {
  proposal_id: string;
  target_file: "project.json";
  created_at: string;
  expires_at: string;
};

export type WorkflowConfigProposalArtifact = {
  schema_version: "0.1";
  proposal_kind: "workflow_runtime_config";
  proposal_id: string;
  target_file: "runtime.json";
  project_root: string;
  runtime_config: Record<string, unknown>;
  requested_enabled: boolean;
  migration_required: boolean;
  risk: "medium";
  restart_required: true;
  created_at: string;
  expires_at: string;
};

type AnyConfigProposalArtifact =
  | ConfigProposalArtifact
  | WorkflowConfigProposalArtifact;

export type ConfigProposalChange = {
  path: string;
  from: unknown;
  to: unknown;
};

export type ConfigProposalCreateResult = {
  proposal_id: string;
  proposal_path: string;
  artifact: ConfigProposalArtifact;
  changes: ConfigProposalChange[];
};

export type ConfigProposalApplyOptions = {
  projectRoot: string;
  proposalId: string;
  dryRun?: boolean;
  now?: Date;
};

export type ConfigProposalApplyResult = {
  dryRun: boolean;
  applied: boolean;
  proposal_id: string;
  proposal_path: string;
  target_file: "project.json" | "runtime.json";
  stale: boolean;
  changes: ConfigProposalChange[];
  backups: string[];
  validation: ValidationResult;
};

export type WorkflowConfigProposalCreateResult = {
  proposal_id: string;
  proposal_path: string;
  artifact: WorkflowConfigProposalArtifact;
  changes: ConfigProposalChange[];
};

const proposalTtlMs = 24 * 60 * 60 * 1000;
const unorderedStringArrayPaths = new Set([
  "frameworks",
  "package_managers",
  "paths.protected",
  "paths.generated",
  "paths.source"
]);

export async function createConfigProposal(options: {
  projectRoot: string;
  now?: Date;
}): Promise<ConfigProposalCreateResult> {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? new Date();
  const analysis = await analyzeProjectDocking(projectRoot);
  const currentProjectConfig = await readJsonFile<ProjectConfigProposal>(
    getConfigPath(projectRoot, "project.json")
  );
  const projectConfig = preserveCurrentProjectPaths(
    currentProjectConfig,
    analysis.project_config
  );
  const proposalId = `CFG-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const proposalPath = configProposalPath(projectRoot, proposalId);
  const artifact: ConfigProposalArtifact = {
    ...analysis,
    project_config: projectConfig,
    proposal_id: proposalId,
    target_file: "project.json",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + proposalTtlMs).toISOString()
  };
  const changes = diffValues("", currentProjectConfig, artifact.project_config);

  await mkdir(path.dirname(proposalPath), { recursive: true });
  await writeJsonFileAtomic(proposalPath, artifact);

  return {
    proposal_id: proposalId,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    artifact,
    changes
  };
}

export async function createWorkflowConfigProposal(options: {
  projectRoot: string;
  enabled: boolean;
  now?: Date;
}): Promise<WorkflowConfigProposalCreateResult> {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? new Date();
  const currentRuntimeConfig = await readJsonFile<Record<string, unknown>>(
    getConfigPath(projectRoot, "runtime.json")
  );
  const migration = planWorkflowRuntimeConfigMigration(
    currentRuntimeConfig,
    options.enabled
  );
  const proposalId = `CFG-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const proposalPath = configProposalPath(projectRoot, proposalId);
  const artifact: WorkflowConfigProposalArtifact = {
    schema_version: "0.1",
    proposal_kind: "workflow_runtime_config",
    proposal_id: proposalId,
    target_file: "runtime.json",
    project_root: toPosixPath(projectRoot),
    runtime_config: migration.runtime_config,
    requested_enabled: options.enabled,
    migration_required: migration.migration_required,
    risk: "medium",
    restart_required: true,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + proposalTtlMs).toISOString()
  };
  const changes = diffValues(
    "",
    currentRuntimeConfig,
    artifact.runtime_config
  );

  await mkdir(path.dirname(proposalPath), { recursive: true });
  await writeJsonFileAtomic(proposalPath, artifact);

  return {
    proposal_id: proposalId,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    artifact,
    changes
  };
}

export async function applyConfigProposal(
  options: ConfigProposalApplyOptions
): Promise<ConfigProposalApplyResult> {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const proposalPath = configProposalPath(projectRoot, options.proposalId);
  const artifact = await readJsonFile<AnyConfigProposalArtifact>(proposalPath);

  validateProposalArtifact(projectRoot, artifact, options.proposalId, now);

  const proposedConfig =
    artifact.target_file === "project.json"
      ? artifact.project_config
      : artifact.runtime_config;
  const validation = validateConfigFile(artifact.target_file, proposedConfig);
  if (!validation.ok) {
    throw new Error(`Invalid config proposal: ${validation.errors.join("; ")}`);
  }

  const targetPath = getConfigPath(projectRoot, artifact.target_file);
  const currentConfig = await readJsonFile<unknown>(targetPath);
  const changes = diffValues("", currentConfig, proposedConfig);
  const backups: string[] = [];

  if (!dryRun && changes.length > 0) {
    const backupPath = `${targetPath}.bak-${formatTimestamp(now)}`;
    await copyFile(targetPath, backupPath);
    backups.push(toProjectPath(projectRoot, backupPath));
    await writeJsonFileAtomic(targetPath, proposedConfig);
  }

  return {
    dryRun,
    applied: !dryRun && changes.length > 0,
    proposal_id: artifact.proposal_id,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    target_file: artifact.target_file,
    stale: false,
    changes,
    backups,
    validation: dryRun ? validation : await validateAllConfigs(projectRoot)
  };
}

export function formatConfigProposalCreateResult(
  result: ConfigProposalCreateResult
): string {
  const lines = [
    "Kairon config proposal created.",
    `proposal_id=${result.proposal_id}`,
    `proposal_path=${result.proposal_path}`,
    `target=${result.artifact.target_file}`,
    `changes=${result.changes.length}`
  ];

  lines.push(...formatChanges(result.artifact.target_file, result.changes));
  return lines.join("\n");
}

export function formatWorkflowConfigProposalCreateResult(
  result: WorkflowConfigProposalCreateResult
): string {
  return [
    "Kairon workflow runtime config proposal created.",
    `proposal_id=${result.proposal_id}`,
    `proposal_path=${result.proposal_path}`,
    "target=runtime.json",
    `requested_enabled=${result.artifact.requested_enabled}`,
    `migration_required=${result.artifact.migration_required}`,
    `risk=${result.artifact.risk}`,
    `restart_required=${result.artifact.restart_required}`,
    `changes=${result.changes.length}`,
    ...formatChanges("runtime.json", result.changes)
  ].join("\n");
}

export function formatConfigProposalApplyResult(
  result: ConfigProposalApplyResult
): string {
  const lines: string[] = [];

  if (result.dryRun) {
    lines.push("Kairon config apply dry run. Planned changes:");
  } else if (result.applied) {
    lines.push("Kairon config proposal applied.");
  } else {
    lines.push("Kairon config proposal has no changes.");
  }

  lines.push(`proposal_id=${result.proposal_id}`);
  lines.push(`proposal_path=${result.proposal_path}`);
  lines.push(`target=${result.target_file}`);
  lines.push(`changes=${result.changes.length}`);
  lines.push(...formatChanges(result.target_file, result.changes));

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

function validateProposalArtifact(
  projectRoot: string,
  artifact: AnyConfigProposalArtifact,
  expectedProposalId: string,
  now: Date
): void {
  if (artifact.proposal_id !== expectedProposalId) {
    throw new Error("Config proposal id does not match the requested proposal.");
  }
  if (artifact.target_file === "project.json") {
    if (artifact.proposal_kind !== "project_config") {
      throw new Error(
        "Only project.json or workflow runtime config proposals can be applied."
      );
    }
    if (!artifact.project_config || typeof artifact.project_config !== "object") {
      throw new Error("Config proposal is missing project_config.");
    }
    if (artifact.project_config.root !== toPosixPath(projectRoot)) {
      throw new Error("Config proposal root does not match this project.");
    }
  } else if (artifact.target_file === "runtime.json") {
    if (
      artifact.proposal_kind !== "workflow_runtime_config" ||
      !artifact.runtime_config ||
      typeof artifact.runtime_config !== "object"
    ) {
      throw new Error("Config proposal is missing runtime_config.");
    }
    if (artifact.project_root !== toPosixPath(projectRoot)) {
      throw new Error("Config proposal root does not match this project.");
    }
  } else {
    throw new Error(
      "Only project.json or workflow runtime config proposals can be applied."
    );
  }

  const expiresAt = Date.parse(artifact.expires_at);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    throw new Error("Config proposal is stale. Regenerate it with `kairon config propose`.");
  }
}

function configProposalPath(projectRoot: string, proposalId: string): string {
  if (!/^[A-Z]+-[0-9]{14}-[0-9a-f]{8}$/.test(proposalId)) {
    throw new Error("Invalid config proposal id.");
  }

  const paths = getKaironPaths(projectRoot);
  return resolveInside(paths.configDir, "proposals", `${proposalId}.json`);
}

function diffValues(
  prefix: string,
  current: unknown,
  next: unknown
): ConfigProposalChange[] {
  if (valuesEquivalent(prefix, current, next)) {
    return [];
  }

  if (isPlainObject(current) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
    return [...keys]
      .sort()
      .flatMap((key) =>
        diffValues(prefix ? `${prefix}.${key}` : key, current[key], next[key])
      );
  }

  return [{ path: prefix || "$", from: current, to: next }];
}

function formatChanges(
  targetFile: "project.json" | "runtime.json",
  changes: ConfigProposalChange[]
): string[] {
  return changes.map(
    (change) =>
      `- ${targetFile} ${change.path}: ${formatValue(change.from)} -> ${formatValue(change.to)}`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preserveCurrentProjectPaths(
  current: ProjectConfigProposal,
  analyzed: ProjectConfigProposal
): ProjectConfigProposal {
  return {
    ...analyzed,
    paths: {
      protected: mergeStringArrays(analyzed.paths.protected, current.paths.protected),
      generated: mergeStringArrays(analyzed.paths.generated, current.paths.generated),
      source: mergeStringArrays(analyzed.paths.source, current.paths.source)
    }
  };
}

function mergeStringArrays(primary: string[], preserved: string[]): string[] {
  return sortStringSet([...primary, ...preserved]);
}

function valuesEquivalent(prefix: string, current: unknown, next: unknown): boolean {
  return stableStringify(normalizeComparable(prefix, current)) ===
    stableStringify(normalizeComparable(prefix, next));
}

function normalizeComparable(prefix: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    if (unorderedStringArrayPaths.has(prefix) && value.every(isString)) {
      return sortStringSet(value);
    }

    return value.map((item) => normalizeComparable(prefix, item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          normalizeComparable(prefix ? `${prefix}.${key}` : key, value[key])
        ])
    );
  }

  return value;
}

function sortStringSet(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
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
