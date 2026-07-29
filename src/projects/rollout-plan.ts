import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  inspectLatestStableReleaseVerification,
  type StableReleaseVerificationResult
} from "../release/stable-verification.js";
import { compareCoreVersions, parseCoreVersion } from "../update/channel.js";
import {
  ProjectRegistry,
  type ProjectRegistryEntry,
  type ProjectRegistryOptions,
  type ProjectRolloutGroup
} from "./registry.js";
import {
  ProjectSupervisor,
  type ProjectHealth,
  type ProjectSupervisorReport
} from "./supervisor.js";

export type RolloutProjectStatus =
  | "completed"
  | "ready"
  | "blocked"
  | "deferred";

export type RolloutManualCommands = {
  working_directory: string;
  download: string;
  apply_template: string;
};

export type RolloutProjectPlan = {
  project_id: string;
  root: string;
  rollout_group: ProjectRolloutGroup;
  installed_version: string;
  registered_version: string;
  config_schema_version: string | null;
  doctor_status: ProjectHealth["status"];
  runtime_status: "active" | "stopped" | "unknown";
  state_integrity_errors: number;
  state_integrity_warnings: number;
  last_health_timestamp: string;
  status: RolloutProjectStatus;
  blockers: string[];
  manual_commands: RolloutManualCommands | null;
};

export type ProjectRolloutPlan = {
  schema_version: "0.1";
  artifact_kind: "multi_project_rollout_plan";
  plan_id: string;
  status: "ready" | "blocked" | "completed";
  target_version: string;
  source_project_root: string;
  registry_path: string;
  stable_verification: {
    status: "verified" | "missing" | "invalid";
    verification_id: string | null;
    version: string | null;
    release_id: number | null;
    state_digest: string | null;
    checked_at: string | null;
    expires_at: string | null;
  };
  canary_gate: {
    status: "satisfied" | "pending" | "blocked";
    project_ids: string[];
    completed_project_ids: string[];
    blockers: string[];
  };
  summary: {
    completed: number;
    ready: number;
    blocked: number;
    deferred: number;
  };
  projects: RolloutProjectPlan[];
  global_blockers: string[];
  input_digest: string;
  plan_digest: string;
  created_at: string;
  expires_at: string;
  execution_performed: false;
  automatic_update: false;
};

export type ProjectRolloutPlanView = {
  plan: ProjectRolloutPlan;
  plan_path: string;
  drift: {
    status: "current" | "stale";
    reasons: string[];
    expected_input_digest: string;
    observed_input_digest: string | null;
  };
  commands_available: boolean;
};

export type CreateProjectRolloutPlanOptions = ProjectRegistryOptions & {
  projectRoot: string;
  targetVersion: string;
  registry?: ProjectRegistry;
  supervisor?: ProjectSupervisor;
  stableVerification?: StableReleaseVerificationResult | null;
  now?: () => Date;
  lifetimeMs?: number;
};

export type ShowProjectRolloutPlanOptions = ProjectRegistryOptions & {
  registry?: ProjectRegistry;
  supervisor?: ProjectSupervisor;
  stableVerification?: StableReleaseVerificationResult | null;
  now?: () => Date;
};

type RolloutInputs = {
  registry: ProjectRegistry;
  entries: ProjectRegistryEntry[];
  report: ProjectSupervisorReport;
  stableVerification: StableReleaseVerificationResult | null;
  stableVerificationStatus: "available" | "missing" | "invalid";
  inputDigest: string;
};

const defaultPlanLifetimeMs = 24 * 60 * 60_000;

export function getProjectRolloutPlanPaths(
  registryPath: string,
  planId?: string
): {
  root: string;
  latestPath: string;
  planPath?: string;
} {
  if (
    planId !== undefined &&
    !/^RLP-\d{14}-[a-f0-9]{12}$/u.test(planId)
  ) {
    throw new Error(`Invalid rollout plan id: ${planId}`);
  }
  const root = path.join(
    path.dirname(path.resolve(registryPath)),
    "rollout-plans"
  );
  return {
    root,
    latestPath: path.join(root, "latest.json"),
    planPath:
      planId === undefined ? undefined : path.join(root, `${planId}.json`)
  };
}

export async function createProjectRolloutPlan(
  options: CreateProjectRolloutPlanOptions
): Promise<{ plan: ProjectRolloutPlan; plan_path: string; latest_path: string }> {
  parseCoreVersion(options.targetVersion);
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const inputs = await collectInputs({
    projectRoot: options.projectRoot,
    registryPath: options.registryPath,
    registry: options.registry,
    supervisor: options.supervisor,
    stableVerification: options.stableVerification
  });
  const unsigned = buildPlan({
    projectRoot: path.resolve(options.projectRoot),
    targetVersion: options.targetVersion,
    inputs,
    createdAt,
    expiresAt: resolvePlanExpiry(
      createdAt,
      options.lifetimeMs ?? defaultPlanLifetimeMs,
      inputs.stableVerification
    )
  });
  const plan: ProjectRolloutPlan = {
    ...unsigned,
    plan_digest: digest(unsigned)
  };
  const paths = getProjectRolloutPlanPaths(
    inputs.registry.registryPath,
    plan.plan_id
  );
  if (paths.planPath === undefined) {
    throw new Error("Rollout plan path could not be resolved.");
  }
  await writeJsonFileAtomic(paths.planPath, plan);
  await writeJsonFileAtomic(paths.latestPath, plan);
  return {
    plan,
    plan_path: paths.planPath,
    latest_path: paths.latestPath
  };
}

export async function showProjectRolloutPlan(
  planId: string,
  options: ShowProjectRolloutPlanOptions = {}
): Promise<ProjectRolloutPlanView> {
  const registry =
    options.registry ??
    new ProjectRegistry({
      registryPath: options.registryPath,
      env: options.env
    });
  const paths = getProjectRolloutPlanPaths(registry.registryPath, planId);
  if (paths.planPath === undefined) {
    throw new Error(`Invalid rollout plan id: ${planId}`);
  }
  const plan = await readPlan(paths.planPath, planId);
  const reasons: string[] = [];
  let observedInputDigest: string | null = null;
  try {
    const inputs = await collectInputs({
      projectRoot: plan.source_project_root,
      registry,
      supervisor: options.supervisor,
      stableVerification: options.stableVerification
    });
    observedInputDigest = inputs.inputDigest;
    if (observedInputDigest !== plan.input_digest) {
      reasons.push("rollout_input_drift");
    }
  } catch {
    reasons.push("rollout_input_unavailable");
  }
  const currentTime = options.now?.() ?? new Date();
  if (Date.parse(plan.expires_at) <= currentTime.getTime()) {
    reasons.push("rollout_plan_expired");
  }
  return {
    plan,
    plan_path: paths.planPath,
    drift: {
      status: reasons.length === 0 ? "current" : "stale",
      reasons: [...new Set(reasons)].sort(),
      expected_input_digest: plan.input_digest,
      observed_input_digest: observedInputDigest
    },
    commands_available:
      reasons.length === 0 && plan.projects.some((entry) => entry.status === "ready")
  };
}

export function formatProjectRolloutPlan(
  input:
    | { plan: ProjectRolloutPlan; plan_path: string }
    | ProjectRolloutPlanView,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(input, null, 2)}\n`;
  }
  const plan = input.plan;
  const view = "drift" in input ? input : undefined;
  const lines = [
    "Kairon multi-project rollout plan:",
    `plan_id=${plan.plan_id}`,
    `status=${view?.drift.status === "stale" ? "stale" : plan.status}`,
    `target_version=${plan.target_version}`,
    `stable_verification=${plan.stable_verification.status}`,
    `canary_gate=${plan.canary_gate.status}`,
    `projects.completed=${plan.summary.completed}`,
    `projects.ready=${plan.summary.ready}`,
    `projects.blocked=${plan.summary.blocked}`,
    `projects.deferred=${plan.summary.deferred}`,
    `execution_performed=${plan.execution_performed}`,
    `automatic_update=${plan.automatic_update}`,
    `plan_path=${input.plan_path}`
  ];
  for (const blocker of plan.global_blockers) {
    lines.push(`BLOCKER scope=global reason=${blocker}`);
  }
  if (view !== undefined) {
    lines.push(`drift=${view.drift.status}`);
    for (const reason of view.drift.reasons) {
      lines.push(`STALE reason=${reason}`);
    }
  }
  for (const project of plan.projects) {
    lines.push(
      `${project.status.toUpperCase()} project=${project.project_id} group=${project.rollout_group} installed=${project.installed_version} doctor=${project.doctor_status} runtime=${project.runtime_status} blockers=${project.blockers.join(",") || "none"}`
    );
    if (
      project.manual_commands !== null &&
      (view === undefined || view.drift.status === "current")
    ) {
      lines.push(
        `COMMAND project=${project.project_id} download=${project.manual_commands.download}`
      );
      lines.push(
        `COMMAND project=${project.project_id} apply=${project.manual_commands.apply_template}`
      );
    }
  }
  return lines.join("\n");
}

async function collectInputs(options: {
  projectRoot: string;
  registryPath?: string;
  registry?: ProjectRegistry;
  supervisor?: ProjectSupervisor;
  stableVerification?: StableReleaseVerificationResult | null;
}): Promise<RolloutInputs> {
  const registry =
    options.registry ??
    new ProjectRegistry({ registryPath: options.registryPath });
  const entries = await registry.list();
  const supervisor =
    options.supervisor ??
    new ProjectSupervisor({
      registry,
      persistObservations: false,
      concurrency: 4,
      projectTimeoutMs: 5_000
    });
  const report = await supervisor.inspect();
  const stable = await resolveStableVerification(
    options.projectRoot,
    options.stableVerification
  );
  const digestInput = {
    registry: entries.map((entry) => ({
      project_id: entry.project_id,
      root: entry.root,
      rollout_group: entry.rollout_group
    })),
    projects: report.projects.map(toDigestProject),
    stable_verification:
      stable.result === null
        ? { status: stable.status }
        : {
            status: stable.status,
            verification_id: stable.result.verification_id,
            version: stable.result.version,
            release_id: stable.result.release_id,
            state_digest: stable.result.state_digest,
            checked_at: stable.result.checked_at,
            expires_at: stable.result.expires_at
          }
  };
  return {
    registry,
    entries,
    report,
    stableVerification: stable.result,
    stableVerificationStatus: stable.status,
    inputDigest: digest(digestInput)
  };
}

async function resolveStableVerification(
  projectRoot: string,
  supplied: StableReleaseVerificationResult | null | undefined
): Promise<{
  status: "available" | "missing" | "invalid";
  result: StableReleaseVerificationResult | null;
}> {
  if (supplied !== undefined) {
    return supplied === null
      ? { status: "missing", result: null }
      : { status: "available", result: supplied };
  }
  const latest = await inspectLatestStableReleaseVerification(projectRoot);
  if (latest.status === "available") {
    return { status: "available", result: latest.result };
  }
  return {
    status: latest.status === "missing" ? "missing" : "invalid",
    result: null
  };
}

function buildPlan(input: {
  projectRoot: string;
  targetVersion: string;
  inputs: RolloutInputs;
  createdAt: Date;
  expiresAt: Date;
}): Omit<ProjectRolloutPlan, "plan_digest"> {
  const stable = summarizeStableVerification(
    input.inputs.stableVerificationStatus,
    input.inputs.stableVerification
  );
  const globalBlockers = stableBlockers(
    stable,
    input.targetVersion,
    input.createdAt
  );
  const canaryEntries = input.inputs.entries.filter(
    (entry) => entry.rollout_group === "canary"
  );
  if (canaryEntries.length === 0) {
    globalBlockers.push("canary_group_missing");
  }

  const healthById = new Map(
    input.inputs.report.projects.map((project) => [project.project_id, project])
  );
  const preliminary = input.inputs.entries.map((entry) =>
    preliminaryProjectPlan(
      entry,
      healthById.get(entry.project_id),
      input.targetVersion,
      input.inputs.report.generated_at,
      globalBlockers
    )
  );
  const canaryCompleted = preliminary
    .filter(
      (entry) =>
        entry.rollout_group === "canary" && entry.status === "completed"
    )
    .map((entry) => entry.project_id)
    .sort();
  const canaryProjectIds = canaryEntries
    .map((entry) => entry.project_id)
    .sort();
  const canaryGateSatisfied =
    globalBlockers.length === 0 &&
    canaryProjectIds.length > 0 &&
    canaryCompleted.length === canaryProjectIds.length;
  const canaryGateBlockers =
    globalBlockers.length > 0
      ? [...globalBlockers]
      : canaryGateSatisfied
        ? []
        : ["canary_not_completed"];

  const projects = preliminary.map((entry) => {
    if (
      entry.rollout_group !== "primary" ||
      entry.status === "completed" ||
      entry.status === "deferred"
    ) {
      return entry;
    }
    if (!canaryGateSatisfied) {
      return {
        ...entry,
        status: "blocked" as const,
        blockers: [...new Set([...entry.blockers, "canary_not_completed"])].sort(),
        manual_commands: null
      };
    }
    return entry;
  });
  const summary = countProjectStatuses(projects);
  const status =
    summary.ready > 0
      ? "ready"
      : globalBlockers.length > 0 || summary.blocked > 0
        ? "blocked"
        : "completed";
  const createdAt = input.createdAt.toISOString();
  const planId = rolloutPlanId(createdAt, {
    target_version: input.targetVersion,
    input_digest: input.inputs.inputDigest
  });
  return {
    schema_version: "0.1",
    artifact_kind: "multi_project_rollout_plan",
    plan_id: planId,
    status,
    target_version: input.targetVersion,
    source_project_root: input.projectRoot,
    registry_path: input.inputs.registry.registryPath,
    stable_verification: stable,
    canary_gate: {
      status:
        globalBlockers.length > 0
          ? "blocked"
          : canaryGateSatisfied
            ? "satisfied"
            : "pending",
      project_ids: canaryProjectIds,
      completed_project_ids: canaryCompleted,
      blockers: [...new Set(canaryGateBlockers)].sort()
    },
    summary,
    projects,
    global_blockers: [...new Set(globalBlockers)].sort(),
    input_digest: input.inputs.inputDigest,
    created_at: createdAt,
    expires_at: input.expiresAt.toISOString(),
    execution_performed: false,
    automatic_update: false
  };
}

function preliminaryProjectPlan(
  entry: ProjectRegistryEntry,
  health: ProjectHealth | undefined,
  targetVersion: string,
  generatedAt: string,
  globalBlockers: string[]
): RolloutProjectPlan {
  const blockers = [...globalBlockers];
  const installedVersion =
    health?.observed_version ?? entry.kairon_version;
  if (health === undefined) {
    blockers.push("project_health_missing");
  } else {
    if (
      health.issues.includes("root_missing") ||
      health.issues.includes("root_unreadable")
    ) {
      blockers.push("project_root_unavailable");
    }
    if (health.runtime?.locked === true) {
      blockers.push("runtime_active");
    }
    if (health.state_integrity.errors > 0) {
      blockers.push("state_integrity_error");
    }
    if (health.status === "error") {
      blockers.push("project_health_error");
    }
  }
  try {
    if (compareCoreVersions(installedVersion, targetVersion) > 0) {
      blockers.push("installed_version_ahead");
    }
  } catch {
    blockers.push("installed_version_invalid");
  }

  const atTarget = installedVersion === targetVersion;
  if (
    atTarget &&
    entry.rollout_group === "canary" &&
    health?.status !== "pass"
  ) {
    blockers.push("canary_health_not_passed");
  }
  const uniqueBlockers = [...new Set(blockers)].sort();
  let status: RolloutProjectStatus;
  if (entry.rollout_group === "deferred") {
    status = "deferred";
  } else if (atTarget && uniqueBlockers.length === 0) {
    status = "completed";
  } else if (uniqueBlockers.length > 0) {
    status = "blocked";
  } else {
    status = "ready";
  }
  return {
    project_id: entry.project_id,
    root: entry.root,
    rollout_group: entry.rollout_group,
    installed_version: installedVersion,
    registered_version: entry.kairon_version,
    config_schema_version: health?.config.schema_version ?? null,
    doctor_status: health?.status ?? "error",
    runtime_status:
      health?.runtime === undefined
        ? "unknown"
        : health.runtime.locked
          ? "active"
          : "stopped",
    state_integrity_errors: health?.state_integrity.errors ?? 1,
    state_integrity_warnings: health?.state_integrity.warnings ?? 0,
    last_health_timestamp: generatedAt,
    status,
    blockers: uniqueBlockers,
    manual_commands:
      status === "ready"
        ? manualCommands(entry.root, targetVersion)
        : null
  };
}

function summarizeStableVerification(
  status: RolloutInputs["stableVerificationStatus"],
  result: StableReleaseVerificationResult | null
): ProjectRolloutPlan["stable_verification"] {
  if (result === null) {
    return {
      status: status === "missing" ? "missing" : "invalid",
      verification_id: null,
      version: null,
      release_id: null,
      state_digest: null,
      checked_at: null,
      expires_at: null
    };
  }
  return {
    status:
      result.status === "PASS" &&
      result.integrity_status === "PASS" &&
      result.currentness_status === "PASS"
        ? "verified"
        : "invalid",
    verification_id: result.verification_id,
    version: result.version,
    release_id: result.release_id,
    state_digest: result.state_digest,
    checked_at: result.checked_at,
    expires_at: result.expires_at
  };
}

function stableBlockers(
  stable: ProjectRolloutPlan["stable_verification"],
  targetVersion: string,
  now: Date
): string[] {
  const blockers: string[] = [];
  if (stable.status === "missing") {
    blockers.push("stable_verification_missing");
  } else if (stable.status !== "verified") {
    blockers.push("stable_verification_invalid");
  }
  if (stable.version !== null && stable.version !== targetVersion) {
    blockers.push("stable_verification_version_mismatch");
  }
  if (
    stable.expires_at !== null &&
    Date.parse(stable.expires_at) <= now.getTime()
  ) {
    blockers.push("stable_verification_expired");
  }
  return blockers;
}

function resolvePlanExpiry(
  createdAt: Date,
  lifetimeMs: number,
  stableVerification: StableReleaseVerificationResult | null
): Date {
  const configuredExpiry = createdAt.getTime() + lifetimeMs;
  const stableExpiry =
    stableVerification === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(stableVerification.expires_at);
  return new Date(Math.min(configuredExpiry, stableExpiry));
}

function manualCommands(
  projectRoot: string,
  targetVersion: string
): RolloutManualCommands {
  return {
    working_directory: projectRoot,
    download: `kairon update download ${targetVersion}`,
    apply_template:
      "kairon update apply <download-id> --confirm <download-id>"
  };
}

function toDigestProject(project: ProjectHealth): Record<string, unknown> {
  return {
    project_id: project.project_id,
    status: project.status,
    issues: [...project.issues].sort(),
    registered_version: project.registered_version,
    observed_version: project.observed_version ?? null,
    config_schema_version: project.config.schema_version ?? null,
    runtime_locked: project.runtime?.locked ?? null,
    runtime_stale: project.runtime?.stale ?? null,
    state_integrity_errors: project.state_integrity.errors,
    state_integrity_warnings: project.state_integrity.warnings,
    last_seen_at: project.last_seen_at
  };
}

function countProjectStatuses(
  projects: RolloutProjectPlan[]
): ProjectRolloutPlan["summary"] {
  return {
    completed: projects.filter((entry) => entry.status === "completed").length,
    ready: projects.filter((entry) => entry.status === "ready").length,
    blocked: projects.filter((entry) => entry.status === "blocked").length,
    deferred: projects.filter((entry) => entry.status === "deferred").length
  };
}

async function readPlan(
  planPath: string,
  expectedPlanId: string
): Promise<ProjectRolloutPlan> {
  let value: unknown;
  try {
    value = await readJsonFile<unknown>(planPath);
  } catch {
    throw new Error(`Rollout plan was not found: ${expectedPlanId}`);
  }
  if (!isProjectRolloutPlan(value) || value.plan_id !== expectedPlanId) {
    throw new Error(`Rollout plan is invalid: ${expectedPlanId}`);
  }
  const { plan_digest: observedDigest, ...unsigned } = value;
  if (digest(unsigned) !== observedDigest) {
    throw new Error(`Rollout plan digest mismatch: ${expectedPlanId}`);
  }
  return value;
}

function isProjectRolloutPlan(value: unknown): value is ProjectRolloutPlan {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === "0.1" &&
    value.artifact_kind === "multi_project_rollout_plan" &&
    typeof value.plan_id === "string" &&
    /^RLP-\d{14}-[a-f0-9]{12}$/u.test(value.plan_id) &&
    (value.status === "ready" ||
      value.status === "blocked" ||
      value.status === "completed") &&
    typeof value.target_version === "string" &&
    typeof value.source_project_root === "string" &&
    path.isAbsolute(value.source_project_root) &&
    typeof value.registry_path === "string" &&
    path.isAbsolute(value.registry_path) &&
    Array.isArray(value.projects) &&
    value.projects.every(isRolloutProjectPlan) &&
    typeof value.input_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.input_digest) &&
    typeof value.plan_digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.plan_digest) &&
    typeof value.created_at === "string" &&
    !Number.isNaN(Date.parse(value.created_at)) &&
    typeof value.expires_at === "string" &&
    !Number.isNaN(Date.parse(value.expires_at)) &&
    value.execution_performed === false &&
    value.automatic_update === false &&
    isRecord(value.stable_verification) &&
    isRecord(value.canary_gate) &&
    isRecord(value.summary) &&
    Array.isArray(value.global_blockers) &&
    value.global_blockers.every((entry) => typeof entry === "string")
  );
}

function isRolloutProjectPlan(value: unknown): value is RolloutProjectPlan {
  return (
    isRecord(value) &&
    typeof value.project_id === "string" &&
    typeof value.root === "string" &&
    path.isAbsolute(value.root) &&
    (value.rollout_group === "canary" ||
      value.rollout_group === "primary" ||
      value.rollout_group === "deferred") &&
    typeof value.installed_version === "string" &&
    (value.status === "completed" ||
      value.status === "ready" ||
      value.status === "blocked" ||
      value.status === "deferred") &&
    Array.isArray(value.blockers) &&
    value.blockers.every((entry) => typeof entry === "string")
  );
}

function rolloutPlanId(
  createdAt: string,
  binding: Record<string, unknown>
): string {
  return `RLP-${createdAt.replace(/\D/gu, "").slice(0, 14)}-${digest(binding).slice(7, 19)}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableSerialize(value))
    .digest("hex")}`;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
