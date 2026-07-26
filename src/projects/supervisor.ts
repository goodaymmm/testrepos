import { access } from "node:fs/promises";
import path from "node:path";
import { sanitizeBoardRegistryUrl } from "../board/profile.js";
import {
  loadConfigFile,
  validateAllConfigs
} from "../core/config/load-config.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, normalizeProjectRoot } from "../core/fs/paths.js";
import { KAIRON_VERSION } from "../index.js";
import {
  getRuntimeStatus,
  summarizeRuntimeStatus,
  type RuntimeStatusSummary
} from "../runtime/status.js";
import { isReadableConfigSchemaVersion } from "../migration/schema-registry.js";
import {
  ProjectRegistry,
  type ProjectDoctorSummary,
  type ProjectObservation,
  type ProjectRegistryEntry,
  type ProjectRegistryOptions
} from "./registry.js";

export type ProjectEndpoint = {
  kind: "board" | "discord_http";
  status: string;
  host?: string;
  port?: number;
  external_url?: string;
};

export type ProjectHealthStatus = "pass" | "warning" | "error";

export type ProjectHealth = {
  project_id: string;
  root: string;
  status: ProjectHealthStatus;
  issues: string[];
  registered_version: string;
  observed_version?: string;
  config: {
    valid: boolean;
    warnings: number;
    errors: number;
  };
  runtime?: RuntimeStatusSummary;
  endpoints: ProjectEndpoint[];
  board_url?: string;
  provider_limits: Record<string, number>;
  last_seen_at: string;
};

export type ProjectConflict = {
  kind: "port" | "external_url";
  value: string;
  project_ids: string[];
  endpoints: string[];
};

export type ProviderLimitAggregate = {
  provider: string;
  configured_projects: number;
  aggregate_max_concurrent: number;
};

export type ProjectSupervisorReport = {
  schema_version: "0.1";
  generated_at: string;
  registry_path: string;
  ok: boolean;
  summary: {
    pass: number;
    warning: number;
    error: number;
  };
  projects: ProjectHealth[];
  conflicts: ProjectConflict[];
  provider_limits: ProviderLimitAggregate[];
};

export type ProjectSupervisorOptions = ProjectRegistryOptions & {
  registry?: ProjectRegistry;
  persistObservations?: boolean;
};

type ProjectConfig = {
  schema_version?: unknown;
  project_id?: unknown;
  root?: unknown;
};

type AgentsConfig = {
  provider_policies?: Record<
    string,
    {
      max_concurrent?: unknown;
    }
  >;
};

type EndpointStatus = {
  status?: unknown;
  host?: unknown;
  port?: unknown;
  board_url?: unknown;
  external_url?: unknown;
};

export class ProjectSupervisor {
  readonly registry: ProjectRegistry;
  private readonly now: () => Date;
  private readonly persistObservations: boolean;

  constructor(options: ProjectSupervisorOptions = {}) {
    this.registry = options.registry ?? new ProjectRegistry(options);
    this.now = options.now ?? (() => new Date());
    this.persistObservations = options.persistObservations ?? true;
  }

  async inspect(): Promise<ProjectSupervisorReport> {
    const entries = await this.registry.list();
    const projects: ProjectHealth[] = [];
    for (const entry of entries) {
      projects.push(await inspectProject(entry));
    }

    const conflicts = detectConflicts(projects);
    applyConflicts(projects, conflicts);
    for (const project of projects) {
      project.status = statusFromIssues(project.issues);
    }

    const generatedAt = this.now().toISOString();
    const summary = countStatuses(projects);
    const report: ProjectSupervisorReport = {
      schema_version: "0.1",
      generated_at: generatedAt,
      registry_path: this.registry.registryPath,
      ok: summary.error === 0,
      summary,
      projects,
      conflicts,
      provider_limits: aggregateProviderLimits(projects)
    };

    if (this.persistObservations) {
      await this.registry.updateObservations(
        projects.map((project) =>
          toObservation(project, generatedAt)
        )
      );
    }

    return report;
  }
}

export function formatProjectSupervisorReport(
  report: ProjectSupervisorReport,
  format: "text" | "json" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines = [
    `projects.doctor.ok=${report.ok}`,
    `registry.path=${report.registry_path}`,
    `summary.pass=${report.summary.pass}`,
    `summary.warning=${report.summary.warning}`,
    `summary.error=${report.summary.error}`,
    `conflicts.total=${report.conflicts.length}`
  ];
  for (const project of report.projects) {
    lines.push(
      `${project.status.toUpperCase()} project=${project.project_id} root=${project.root}`
    );
    lines.push(`  registered_version=${project.registered_version}`);
    lines.push(`  observed_version=${project.observed_version ?? "unavailable"}`);
    lines.push(`  config_valid=${project.config.valid}`);
    lines.push(`  runtime_locked=${project.runtime?.locked ?? "unavailable"}`);
    lines.push(`  board_url=${project.board_url ?? "none"}`);
    lines.push(`  issues=${project.issues.join(",") || "none"}`);
  }
  for (const conflict of report.conflicts) {
    lines.push(
      `CONFLICT kind=${conflict.kind} value=${conflict.value} projects=${conflict.project_ids.join(",")}`
    );
  }
  for (const provider of report.provider_limits) {
    lines.push(
      `PROVIDER name=${provider.provider} projects=${provider.configured_projects} aggregate_max_concurrent=${provider.aggregate_max_concurrent}`
    );
  }
  return lines.join("\n");
}

async function inspectProject(entry: ProjectRegistryEntry): Promise<ProjectHealth> {
  const health: ProjectHealth = {
    project_id: entry.project_id,
    root: entry.root,
    status: "pass",
    issues: [],
    registered_version: entry.kairon_version,
    config: {
      valid: false,
      warnings: 0,
      errors: 0
    },
    endpoints: [],
    provider_limits: {},
    last_seen_at: entry.last_seen_at
  };

  try {
    await access(entry.root);
  } catch (error) {
    health.issues.push(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "root_missing"
        : "root_unreadable"
    );
    health.status = "error";
    return health;
  }

  let projectConfig: ProjectConfig;
  try {
    projectConfig = await loadConfigFile<ProjectConfig>(entry.root, "project.json");
  } catch {
    health.issues.push("project_config_unreadable");
    health.status = "error";
    return health;
  }

  if (
    !isReadableConfigSchemaVersion(
      "project.json",
      projectConfig.schema_version
    ) ||
    projectConfig.project_id !== entry.project_id
  ) {
    health.issues.push("project_identity_mismatch");
  }
  if (
    typeof projectConfig.root === "string" &&
    normalizeRootKey(projectConfig.root) !== normalizeRootKey(entry.root)
  ) {
    health.issues.push("configured_root_mismatch");
  }

  try {
    const validation = await validateAllConfigs(entry.root);
    health.config = {
      valid: validation.ok,
      warnings: validation.warnings.length,
      errors: validation.errors.length
    };
    if (!validation.ok) {
      health.issues.push("config_invalid");
    } else if (validation.warnings.length > 0) {
      health.issues.push("config_warning");
    }
  } catch {
    health.config.errors = 1;
    health.issues.push("config_validation_unavailable");
  }

  try {
    health.runtime = summarizeRuntimeStatus(await getRuntimeStatus(entry.root));
    if (health.runtime.stale) {
      health.issues.push("runtime_lock_stale");
    }
  } catch {
    health.issues.push("runtime_status_unavailable");
  }

  const paths = getKaironPaths(entry.root);
  const board = await readOptionalStatus(
    path.join(paths.runtimeDir, "board", "server.json")
  );
  if (board !== undefined) {
    const endpoint = toEndpoint("board", board);
    health.endpoints.push(endpoint);
    health.board_url = sanitizeBoardRegistryUrl(
      asString(board.external_url) ?? asString(board.board_url)
    );
  } else if (entry.board_url !== undefined) {
    health.board_url = sanitizeBoardRegistryUrl(entry.board_url);
  }

  const discord = await readOptionalStatus(
    path.join(paths.runtimeDir, "discord", "http-server.json")
  );
  if (discord !== undefined) {
    health.endpoints.push(toEndpoint("discord_http", discord));
  }

  try {
    const agents = await loadConfigFile<AgentsConfig>(entry.root, "agents.json");
    for (const [provider, policy] of Object.entries(
      agents.provider_policies ?? {}
    )) {
      if (
        typeof policy.max_concurrent === "number" &&
        Number.isInteger(policy.max_concurrent) &&
        policy.max_concurrent >= 0
      ) {
        health.provider_limits[provider] = policy.max_concurrent;
      }
    }
  } catch {
    health.issues.push("provider_limits_unavailable");
  }

  health.observed_version = KAIRON_VERSION;
  if (entry.kairon_version !== KAIRON_VERSION) {
    health.issues.push("kairon_version_changed");
  }
  health.status = statusFromIssues(health.issues);
  return health;
}

function detectConflicts(projects: ProjectHealth[]): ProjectConflict[] {
  const candidates = new Map<
    string,
    {
      kind: ProjectConflict["kind"];
      value: string;
      records: { projectId: string; endpoint: string }[];
    }
  >();

  for (const project of projects) {
    for (const endpoint of project.endpoints) {
      if (
        endpoint.status === "ready" &&
        endpoint.host !== undefined &&
        endpoint.port !== undefined
      ) {
        const value = `${endpoint.host.toLowerCase()}:${endpoint.port}`;
        appendConflictCandidate(candidates, `port:${value}`, {
          kind: "port",
          value,
          projectId: project.project_id,
          endpoint: endpoint.kind
        });
      }
      if (endpoint.status === "ready" && endpoint.external_url !== undefined) {
        appendConflictCandidate(
          candidates,
          `external_url:${endpoint.external_url.toLowerCase()}`,
          {
            kind: "external_url",
            value: endpoint.external_url,
            projectId: project.project_id,
            endpoint: endpoint.kind
          }
        );
      }
    }
  }

  return [...candidates.values()]
    .filter(
      (candidate) =>
        new Set(candidate.records.map((record) => record.projectId)).size > 1
    )
    .map((candidate) => ({
      kind: candidate.kind,
      value: candidate.value,
      project_ids: [
        ...new Set(candidate.records.map((record) => record.projectId))
      ].sort(),
      endpoints: candidate.records
        .map((record) => `${record.projectId}:${record.endpoint}`)
        .sort()
    }))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.value.localeCompare(right.value)
    );
}

function appendConflictCandidate(
  candidates: Map<
    string,
    {
      kind: ProjectConflict["kind"];
      value: string;
      records: { projectId: string; endpoint: string }[];
    }
  >,
  key: string,
  input: {
    kind: ProjectConflict["kind"];
    value: string;
    projectId: string;
    endpoint: string;
  }
): void {
  const current = candidates.get(key) ?? {
    kind: input.kind,
    value: input.value,
    records: []
  };
  current.records.push({
    projectId: input.projectId,
    endpoint: input.endpoint
  });
  candidates.set(key, current);
}

function applyConflicts(
  projects: ProjectHealth[],
  conflicts: ProjectConflict[]
): void {
  for (const conflict of conflicts) {
    for (const projectId of conflict.project_ids) {
      const project = projects.find(
        (candidate) => candidate.project_id === projectId
      );
      project?.issues.push(`${conflict.kind}_collision`);
    }
  }
  for (const project of projects) {
    project.issues = [...new Set(project.issues)].sort();
  }
}

function aggregateProviderLimits(
  projects: ProjectHealth[]
): ProviderLimitAggregate[] {
  const providers = new Map<
    string,
    { projects: number; aggregate: number }
  >();
  for (const project of projects) {
    for (const [provider, maxConcurrent] of Object.entries(
      project.provider_limits
    )) {
      const current = providers.get(provider) ?? {
        projects: 0,
        aggregate: 0
      };
      current.projects += 1;
      current.aggregate += maxConcurrent;
      providers.set(provider, current);
    }
  }

  return [...providers.entries()]
    .map(([provider, value]) => ({
      provider,
      configured_projects: value.projects,
      aggregate_max_concurrent: value.aggregate
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function toObservation(
  project: ProjectHealth,
  checkedAt: string
): ProjectObservation {
  return {
    project_id: project.project_id,
    root: project.root,
    seen: !project.issues.includes("root_missing") &&
      !project.issues.includes("root_unreadable"),
    kairon_version: project.observed_version ?? project.registered_version,
    board_url: project.board_url,
    doctor_summary: doctorSummary(project, checkedAt)
  };
}

function doctorSummary(
  project: ProjectHealth,
  checkedAt: string
): ProjectDoctorSummary {
  return {
    checked_at: checkedAt,
    status: project.status,
    pass: project.status === "pass" ? 1 : 0,
    warning: project.status === "warning" ? 1 : 0,
    error: project.status === "error" ? 1 : 0
  };
}

function countStatuses(projects: ProjectHealth[]): {
  pass: number;
  warning: number;
  error: number;
} {
  return {
    pass: projects.filter((project) => project.status === "pass").length,
    warning: projects.filter((project) => project.status === "warning").length,
    error: projects.filter((project) => project.status === "error").length
  };
}

function statusFromIssues(issues: string[]): ProjectHealthStatus {
  if (
    issues.some((issue) =>
      [
        "root_missing",
        "root_unreadable",
        "project_config_unreadable",
        "project_identity_mismatch",
        "config_invalid"
      ].includes(issue)
    )
  ) {
    return "error";
  }
  return issues.length > 0 ? "warning" : "pass";
}

async function readOptionalStatus(
  filePath: string
): Promise<EndpointStatus | undefined> {
  try {
    return await readJsonFile<EndpointStatus>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    return undefined;
  }
}

function toEndpoint(
  kind: ProjectEndpoint["kind"],
  status: EndpointStatus
): ProjectEndpoint {
  return {
    kind,
    status: asString(status.status) ?? "unknown",
    host: asString(status.host),
    port: asInteger(status.port),
    external_url: sanitizeBoardRegistryUrl(asString(status.external_url))
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function normalizeRootKey(root: string): string {
  const normalized = normalizeProjectRoot(root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
