import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createDefaultConfigs } from "../core/config/defaults.js";
import {
  configFileNames,
  validateAllConfigs,
  type ConfigFileName
} from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  getConfigPath,
  getKaironPaths,
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import {
  runDoctor,
  type DoctorResult
} from "../diagnostics/doctor.js";
import { readRuntimeLockStatus } from "../runtime/runtime-lock.js";
import {
  createStateBackup,
  type StateBackupCreateResult
} from "../state/backup.js";
import {
  checkStateIntegrity,
  type StateIntegrityCheckResult
} from "../state/integrity-check.js";
import type { ValidationResult } from "../core/config/validate-config.js";
import {
  currentConfigSchemaVersion,
  inspectConfigSchemaVersion
} from "./schema-registry.js";

type JsonObject = Record<string, unknown>;

export type MigrationChange = {
  path: string;
  action: "add" | "update" | "remove";
  reason: string;
};

export type MigrationStep = {
  step_id: string;
  file: ConfigFileName;
  from_schema_version: string;
  to_schema_version: string;
  input_sha256: string;
  output_sha256: string;
  reversible: false;
  changes: MigrationChange[];
};

export type MigrationConfigInventory = {
  file: ConfigFileName;
  schema_version: string;
  input_sha256: string;
};

export type SchemaMigrationPlan = {
  schema_version: "0.1";
  artifact_kind: "schema_migration_plan";
  plan_id: string;
  status: "ready";
  target_config_schema_version: string;
  runtime_must_be_stopped: true;
  backup_required: true;
  config_inventory: MigrationConfigInventory[];
  steps: MigrationStep[];
  non_reversible_steps: string[];
  plan_digest: string;
  created_at: string;
};

export type SchemaMigrationPostChecks = {
  config_validation_ok: boolean;
  state_integrity_errors: number;
  doctor_ok: boolean;
  doctor_required_checks_ok: boolean;
};

export type SchemaMigrationResultArtifact = {
  schema_version: "0.1";
  artifact_kind: "schema_migration_result";
  plan_id: string;
  plan_digest: string;
  status: "applied" | "already_applied" | "blocked" | "failed";
  reason?: string;
  backup_id?: string;
  backup_manifest_path?: string;
  changed_files: string[];
  post_checks?: SchemaMigrationPostChecks;
  restore_command?: string;
  created_at: string;
  updated_at: string;
};

export type MigrationPlanCommandResult = {
  status: "plan_created" | "up_to_date" | "blocked";
  reason?: string;
  plan?: SchemaMigrationPlan;
  execution_performed: false;
};

export type MigrationApplyCommandResult = {
  status: "applied" | "already_applied" | "blocked" | "failed";
  reason?: string;
  result?: SchemaMigrationResultArtifact;
  execution_performed: boolean;
};

export type MigrationDependencies = {
  now?: () => Date;
  runtimeStatus?: typeof readRuntimeLockStatus;
  createBackup?: typeof createStateBackup;
  validateConfigs?: typeof validateAllConfigs;
  checkIntegrity?: typeof checkStateIntegrity;
  doctor?: (projectRoot: string) => Promise<DoctorResult>;
  writeConfig?: typeof writeJsonFileAtomic;
};

const planIdPattern = /^MIG-\d{4,}$/u;

export async function createSchemaMigrationPlan(
  projectRoot: string,
  dependencies: MigrationDependencies = {}
): Promise<MigrationPlanCommandResult> {
  const defaults = createDefaultConfigs(projectRoot);
  const steps: MigrationStep[] = [];
  const configInventory: MigrationConfigInventory[] = [];

  for (const fileName of configFileNames) {
    const filePath = getConfigPath(projectRoot, fileName);
    let raw: string;
    let input: JsonObject;
    try {
      raw = await readFile(filePath, "utf8");
      input = parseConfig(raw, fileName);
    } catch {
      return blockedPlan(`config_unreadable:${fileName}`);
    }
    const compatibility = inspectConfigSchemaVersion(
      fileName,
      input.schema_version
    );
    if (
      compatibility === "unsupported_newer" ||
      compatibility === "unsupported_older" ||
      compatibility === "invalid"
    ) {
      return blockedPlan(`${compatibility}:${fileName}`);
    }
    configInventory.push({
      file: fileName,
      schema_version: readSchemaVersion(input),
      input_sha256: sha256(raw)
    });

    const output = migrateConfigValue(fileName, input, defaults[fileName]);
    const outputText = formatJson(output);
    if (sha256(raw) === sha256(outputText)) {
      continue;
    }
    const fromVersion = readSchemaVersion(input);
    const changes = collectChanges(input, output);
    steps.push({
      step_id: `${fileName}:schema-${fromVersion}-to-${currentConfigSchemaVersion}`,
      file: fileName,
      from_schema_version: fromVersion,
      to_schema_version: currentConfigSchemaVersion,
      input_sha256: sha256(raw),
      output_sha256: sha256(outputText),
      reversible: false,
      changes
    });
  }

  if (steps.length === 0) {
    return {
      status: "up_to_date",
      execution_performed: false
    };
  }

  const now = dependencies.now?.() ?? new Date();
  const planId = await nextId(projectRoot, "migration");
  const base = {
    schema_version: "0.1" as const,
    artifact_kind: "schema_migration_plan" as const,
    plan_id: planId,
    status: "ready" as const,
    target_config_schema_version: currentConfigSchemaVersion,
    runtime_must_be_stopped: true as const,
    backup_required: true as const,
    config_inventory: configInventory,
    steps,
    non_reversible_steps: steps.map((step) => step.step_id),
    created_at: now.toISOString()
  };
  const plan: SchemaMigrationPlan = {
    ...base,
    plan_digest: digestObject(base)
  };
  await writeJsonFileAtomic(schemaMigrationPlanPath(projectRoot, planId), plan);
  return {
    status: "plan_created",
    plan,
    execution_performed: false
  };
}

export async function applySchemaMigrationPlan(
  projectRoot: string,
  input: { planId: string; confirm?: string },
  dependencies: MigrationDependencies = {}
): Promise<MigrationApplyCommandResult> {
  const now = dependencies.now?.() ?? new Date();
  let plan: SchemaMigrationPlan;
  try {
    plan = await readSchemaMigrationPlan(projectRoot, input.planId);
  } catch {
    return blockedApply("migration_plan_not_found");
  }
  if (input.confirm !== plan.plan_id) {
    return blockedApply("exact_confirmation_required");
  }
  if (!planDigestMatches(plan)) {
    return blockedApply("migration_plan_digest_mismatch");
  }
  const runtime = await (dependencies.runtimeStatus ?? readRuntimeLockStatus)(
    projectRoot
  );
  if (runtime.locked) {
    return blockedApply("runtime_must_be_stopped");
  }

  const sourceState = await inspectPlanSource(projectRoot, plan);
  if (sourceState === "already_applied") {
    const existing = await readOptionalResult(projectRoot, plan.plan_id);
    if (existing !== undefined && existing.status === "applied") {
      return {
        status: "already_applied",
        result: existing,
        execution_performed: false
      };
    }
    const result = await persistResult(projectRoot, plan, {
      status: "already_applied",
      changedFiles: [],
      now
    });
    return {
      status: "already_applied",
      result,
      execution_performed: false
    };
  }
  if (sourceState !== "ready") {
    return blockedApply(sourceState);
  }

  let backup: StateBackupCreateResult;
  try {
    backup = await (dependencies.createBackup ?? createStateBackup)(projectRoot, {
      now: () => now
    });
  } catch {
    return blockedApply("pre_migration_backup_failed");
  }

  const markerPath = schemaMigrationMarkerPath(projectRoot);
  const markerBase = {
    schema_version: "0.1" as const,
    artifact_kind: "schema_migration_marker" as const,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    status: "in_progress" as const,
    backup_id: backup.backup_id,
    backup_manifest_path: toProjectPath(projectRoot, backup.manifest_path),
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
    next_action: `If migration fails, inspect the marker and run kairon state backup restore ${backup.backup_id} --confirm ${backup.backup_id}.`
  };
  await writeJsonFileAtomic(markerPath, markerBase);

  try {
    const defaults = createDefaultConfigs(projectRoot);
    for (const step of plan.steps) {
      const filePath = getConfigPath(projectRoot, step.file);
      const raw = await readFile(filePath, "utf8");
      if (sha256(raw) !== step.input_sha256) {
        throw new MigrationFailure("migration_input_digest_drift");
      }
      const current = parseConfig(raw, step.file);
      const output = migrateConfigValue(step.file, current, defaults[step.file]);
      if (sha256(formatJson(output)) !== step.output_sha256) {
        throw new MigrationFailure("migration_output_digest_drift");
      }
      await (dependencies.writeConfig ?? writeJsonFileAtomic)(filePath, output);
    }

    const validation = await (
      dependencies.validateConfigs ?? validateAllConfigs
    )(projectRoot);
    const integrity = await (
      dependencies.checkIntegrity ?? checkStateIntegrity
    )(projectRoot, { now: () => now });
    const doctor = await (
      dependencies.doctor ??
      ((root: string) => runDoctor({ projectRoot: root }))
    )(projectRoot);
    const postChecks = summarizePostChecks(validation, integrity, doctor);
    if (!postChecks.config_validation_ok) {
      throw new MigrationFailure("post_migration_config_validation_failed");
    }
    if (postChecks.state_integrity_errors > 0) {
      throw new MigrationFailure("post_migration_state_integrity_failed");
    }
    if (!postChecks.doctor_required_checks_ok) {
      throw new MigrationFailure("post_migration_doctor_failed");
    }

    const result = await persistResult(projectRoot, plan, {
      status: "applied",
      backup,
      changedFiles: plan.steps.map((step) => step.file),
      postChecks,
      now
    });
    await rm(markerPath, { force: true });
    return {
      status: "applied",
      result,
      execution_performed: true
    };
  } catch (error) {
    const reason =
      error instanceof MigrationFailure
        ? error.code
        : "migration_apply_failed";
    const restoreCommand =
      `kairon state backup restore ${backup.backup_id} --confirm ${backup.backup_id}`;
    await writeJsonFileAtomic(markerPath, {
      ...markerBase,
      status: "failed",
      reason,
      failed_at: now.toISOString(),
      updated_at: now.toISOString(),
      restore_command: restoreCommand,
      next_action: `Review the failure, then explicitly restore with: ${restoreCommand}`
    });
    const result = await persistResult(projectRoot, plan, {
      status: "failed",
      reason,
      backup,
      changedFiles: plan.steps.map((step) => step.file),
      restoreCommand,
      now
    });
    return {
      status: "failed",
      reason,
      result,
      execution_performed: true
    };
  }
}

export async function readSchemaMigrationPlan(
  projectRoot: string,
  planId: string
): Promise<SchemaMigrationPlan> {
  const validatedId = validatePlanId(planId);
  const plan = await readJsonFile<SchemaMigrationPlan>(
    schemaMigrationPlanPath(projectRoot, validatedId)
  );
  if (
    plan.schema_version !== "0.1" ||
    plan.artifact_kind !== "schema_migration_plan" ||
    plan.plan_id !== validatedId ||
    plan.status !== "ready" ||
    !Array.isArray(plan.config_inventory) ||
    !Array.isArray(plan.steps)
  ) {
    throw new Error(`Invalid schema migration plan: ${validatedId}`);
  }
  return plan;
}

export function schemaMigrationPlanPath(
  projectRoot: string,
  planId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "migrations",
    "plans",
    `${validatePlanId(planId)}.json`
  );
}

export function schemaMigrationResultPath(
  projectRoot: string,
  planId: string
): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "migrations",
    "results",
    `${validatePlanId(planId)}.json`
  );
}

export function schemaMigrationMarkerPath(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "migrations",
    "in-progress.json"
  );
}

export function formatMigrationPlanCommandResult(
  projectRoot: string,
  result: MigrationPlanCommandResult
): string {
  if (result.status === "up_to_date") {
    return [
      "Kairon schema migration is up to date.",
      `target_schema_version=${currentConfigSchemaVersion}`,
      "execution_performed=false"
    ].join("\n");
  }
  if (result.status === "blocked") {
    return [
      "Kairon schema migration plan blocked.",
      `reason=${result.reason ?? "unknown"}`,
      "execution_performed=false"
    ].join("\n");
  }
  const plan = result.plan!;
  return [
    "Kairon schema migration plan created.",
    `plan_id=${plan.plan_id}`,
    `plan_path=${toProjectPath(projectRoot, schemaMigrationPlanPath(projectRoot, plan.plan_id))}`,
    `target_schema_version=${plan.target_config_schema_version}`,
    `steps=${plan.steps.length}`,
    `backup_required=${plan.backup_required}`,
    `runtime_must_be_stopped=${plan.runtime_must_be_stopped}`,
    `non_reversible_steps=${plan.non_reversible_steps.length}`,
    `confirm=${plan.plan_id}`,
    "execution_performed=false"
  ].join("\n");
}

export function formatMigrationApplyCommandResult(
  result: MigrationApplyCommandResult
): string {
  const lines = [
    result.status === "applied"
      ? "Kairon schema migration applied."
      : result.status === "already_applied"
        ? "Kairon schema migration is already applied."
        : result.status === "blocked"
          ? "Kairon schema migration apply blocked."
          : "Kairon schema migration apply failed.",
    `status=${result.status}`,
    `execution_performed=${result.execution_performed}`
  ];
  if (result.reason !== undefined) {
    lines.push(`reason=${result.reason}`);
  }
  if (result.result !== undefined) {
    lines.push(`plan_id=${result.result.plan_id}`);
    lines.push(`backup_id=${result.result.backup_id ?? "none"}`);
    lines.push(
      `post_check.config=${result.result.post_checks?.config_validation_ok ?? "not_run"}`
    );
    lines.push(
      `post_check.state_errors=${result.result.post_checks?.state_integrity_errors ?? "not_run"}`
    );
    lines.push(
      `post_check.doctor=${result.result.post_checks?.doctor_required_checks_ok ?? "not_run"}`
    );
    if (result.result.restore_command !== undefined) {
      lines.push(`restore_command=${result.result.restore_command}`);
    }
  }
  return lines.join("\n");
}

function migrateConfigValue(
  fileName: ConfigFileName,
  input: JsonObject,
  defaults: unknown
): JsonObject {
  const output = mergeMissingDefaults(
    structuredClone(input),
    toObject(defaults)
  );
  output.schema_version = currentConfigSchemaVersion;
  if (fileName === "agents.json") {
    const agents = toObject(output.agents);
    const gemini = toObject(agents.gemini);
    if (gemini.adapter === "gemini_cli") {
      gemini.adapter = "antigravity_cli";
    }
    if (gemini.command === "gemini") {
      gemini.command = "agy";
    }
  }
  if (fileName === "runtime.json") {
    const workflow = toObject(output.workflow);
    if (typeof workflow.enabled !== "boolean") {
      workflow.enabled = false;
    }
    delete workflow.enabled_env;
  }
  return output;
}

function mergeMissingDefaults(target: JsonObject, defaults: JsonObject): JsonObject {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const current = target[key];
    if (current === undefined) {
      target[key] = structuredClone(defaultValue);
      continue;
    }
    if (isObject(current) && isObject(defaultValue)) {
      target[key] = mergeMissingDefaults(current, defaultValue);
    }
  }
  return target;
}

function collectChanges(before: JsonObject, after: JsonObject): MigrationChange[] {
  const changes: MigrationChange[] = [];
  collectObjectChanges(before, after, "", changes);
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function collectObjectChanges(
  before: JsonObject,
  after: JsonObject,
  prefix: string,
  changes: MigrationChange[]
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const pathName = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (!(key in before)) {
      changes.push({
        path: pathName,
        action: "add",
        reason: "Current schema default is added."
      });
      continue;
    }
    if (!(key in after)) {
      changes.push({
        path: pathName,
        action: "remove",
        reason: "Legacy field is removed by the current schema."
      });
      continue;
    }
    if (isObject(before[key]) && isObject(after[key])) {
      collectObjectChanges(before[key], after[key], pathName, changes);
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes.push({
        path: pathName,
        action: "update",
        reason:
          pathName === "schema_version"
            ? "Config schema is advanced to the current version."
            : "Legacy value is normalized to the current schema."
      });
    }
  }
}

async function inspectPlanSource(
  projectRoot: string,
  plan: SchemaMigrationPlan
): Promise<"ready" | "already_applied" | string> {
  const stepFiles = new Set(plan.steps.map((step) => step.file));
  for (const entry of plan.config_inventory) {
    if (stepFiles.has(entry.file)) {
      continue;
    }
    let digest: string;
    try {
      digest = sha256(
        await readFile(getConfigPath(projectRoot, entry.file), "utf8")
      );
    } catch {
      return `config_unreadable:${entry.file}`;
    }
    if (digest !== entry.input_sha256) {
      return `migration_input_digest_drift:${entry.file}`;
    }
  }
  let inputs = 0;
  let outputs = 0;
  for (const step of plan.steps) {
    let digest: string;
    try {
      digest = sha256(await readFile(getConfigPath(projectRoot, step.file), "utf8"));
    } catch {
      return `config_unreadable:${step.file}`;
    }
    if (digest === step.input_sha256) {
      inputs += 1;
    } else if (digest === step.output_sha256) {
      outputs += 1;
    } else {
      return `migration_input_digest_drift:${step.file}`;
    }
  }
  if (outputs === plan.steps.length) {
    return "already_applied";
  }
  if (inputs !== plan.steps.length) {
    return "partial_migration_state";
  }
  return "ready";
}

function summarizePostChecks(
  validation: ValidationResult,
  integrity: StateIntegrityCheckResult,
  doctor: DoctorResult
): SchemaMigrationPostChecks {
  const requiredDoctorChecks = doctor.checks.filter((check) =>
    ["config.validation", "workflow.config"].includes(check.id)
  );
  return {
    config_validation_ok: validation.ok,
    state_integrity_errors: integrity.summary.errors,
    doctor_ok: doctor.ok,
    doctor_required_checks_ok:
      requiredDoctorChecks.length === 2 &&
      requiredDoctorChecks.every((check) => check.status !== "error")
  };
}

async function persistResult(
  projectRoot: string,
  plan: SchemaMigrationPlan,
  input: {
    status: SchemaMigrationResultArtifact["status"];
    reason?: string;
    backup?: StateBackupCreateResult;
    changedFiles: string[];
    postChecks?: SchemaMigrationPostChecks;
    restoreCommand?: string;
    now: Date;
  }
): Promise<SchemaMigrationResultArtifact> {
  const existing = await readOptionalResult(projectRoot, plan.plan_id);
  const result: SchemaMigrationResultArtifact = {
    schema_version: "0.1",
    artifact_kind: "schema_migration_result",
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.backup === undefined
      ? {}
      : {
          backup_id: input.backup.backup_id,
          backup_manifest_path: toProjectPath(
            projectRoot,
            input.backup.manifest_path
          )
        }),
    changed_files: [...input.changedFiles].sort(),
    ...(input.postChecks === undefined
      ? {}
      : { post_checks: input.postChecks }),
    ...(input.restoreCommand === undefined
      ? {}
      : { restore_command: input.restoreCommand }),
    created_at: existing?.created_at ?? input.now.toISOString(),
    updated_at: input.now.toISOString()
  };
  await writeJsonFileAtomic(
    schemaMigrationResultPath(projectRoot, plan.plan_id),
    result
  );
  return result;
}

async function readOptionalResult(
  projectRoot: string,
  planId: string
): Promise<SchemaMigrationResultArtifact | undefined> {
  try {
    return await readJsonFile<SchemaMigrationResultArtifact>(
      schemaMigrationResultPath(projectRoot, planId)
    );
  } catch {
    return undefined;
  }
}

function planDigestMatches(plan: SchemaMigrationPlan): boolean {
  const { plan_digest: _digest, ...base } = plan;
  return digestObject(base) === plan.plan_digest;
}

function digestObject(value: object): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseConfig(raw: string, fileName: string): JsonObject {
  const value = JSON.parse(stripUtf8Bom(raw)) as unknown;
  if (!isObject(value)) {
    throw new Error(`Config root is not an object: ${fileName}`);
  }
  return value;
}

function readSchemaVersion(value: JsonObject): string {
  return typeof value.schema_version === "string"
    ? value.schema_version
    : "missing";
}

function validatePlanId(value: string): string {
  if (!planIdPattern.test(value)) {
    throw new Error(`Invalid migration plan id: ${value}`);
  }
  return value;
}

function blockedPlan(reason: string): MigrationPlanCommandResult {
  return {
    status: "blocked",
    reason,
    execution_performed: false
  };
}

function blockedApply(reason: string): MigrationApplyCommandResult {
  return {
    status: "blocked",
    reason,
    execution_performed: false
  };
}

function toProjectPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? filePath
    : toPosixPath(relative);
}

function toObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

class MigrationFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MigrationFailure";
  }
}
