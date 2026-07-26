import {
  ProjectRegistry,
  type ProjectRegistryEntry,
  type ProjectRegistryOptions
} from "../../projects/registry.js";
import {
  formatProjectSupervisorReport,
  ProjectSupervisor
} from "../../projects/supervisor.js";
import {
  readLatestScheduledHealth,
  scanScheduledProjectHealth,
  type ScheduledHealthAlertThreshold,
  type ScheduledHealthSnapshot
} from "../../projects/scheduled-health.js";
import {
  createScheduledHealthTaskPlan,
  runScheduledHealthTaskAction
} from "../../projects/scheduled-health-task.js";

export type ProjectsCommandOptions = {
  format?: string;
  registryPath?: string;
};

export type ProjectsHealthCommandOptions = ProjectsCommandOptions & {
  projectTimeoutMs?: string;
  concurrency?: string;
  retentionDays?: string;
  alertThreshold?: string;
  providerPressureThreshold?: string;
};

export type ProjectsHealthScheduleOptions = ProjectsHealthCommandOptions & {
  taskName?: string;
  kaironCommand?: string;
  intervalMinutes?: string;
  confirm?: string;
};

export async function registerProjectCommand(
  root: string,
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const result = await registry.register(root);
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(
      {
        schema_version: "0.1",
        status: result.status,
        registry_path: registry.registryPath,
        project: result.entry
      },
      null,
      2
    )}\n`;
  }

  return [
    "Kairon project registered.",
    `status=${result.status}`,
    `project_id=${result.entry.project_id}`,
    `root=${result.entry.root}`,
    `registry_path=${registry.registryPath}`
  ].join("\n");
}

export async function unregisterProjectCommand(
  projectId: string,
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const entry = await registry.unregister(projectId);
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(
      {
        schema_version: "0.1",
        status: "unregistered",
        registry_path: registry.registryPath,
        project: entry
      },
      null,
      2
    )}\n`;
  }

  return [
    "Kairon project unregistered.",
    `project_id=${entry.project_id}`,
    `root=${entry.root}`,
    `registry_path=${registry.registryPath}`
  ].join("\n");
}

export async function listProjectsCommand(
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const projects = await registry.list();
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(
      {
        schema_version: "0.1",
        registry_path: registry.registryPath,
        projects
      },
      null,
      2
    )}\n`;
  }

  return formatProjectsList(registry.registryPath, projects);
}

export async function showProjectCommand(
  projectId: string,
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const entry = await registry.show(projectId);
  if (entry === undefined) {
    throw new Error(`Project is not registered: ${projectId}`);
  }
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(
      {
        schema_version: "0.1",
        registry_path: registry.registryPath,
        project: entry
      },
      null,
      2
    )}\n`;
  }

  return formatProject(registry.registryPath, entry);
}

export async function doctorProjectsCommand(
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const report = await new ProjectSupervisor({ registry }).inspect();
  return formatProjectSupervisorReport(report, parseFormat(options.format));
}

export async function scanProjectsHealthCommand(
  options: ProjectsHealthCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const result = await scanScheduledProjectHealth({
    registryPath: registry.registryPath,
    profile: {
      project_timeout_ms: parsePositiveInteger(
        options.projectTimeoutMs,
        "project-timeout-ms",
        5_000
      ),
      concurrency: parsePositiveInteger(
        options.concurrency,
        "concurrency",
        4
      ),
      retention_days: parsePositiveInteger(
        options.retentionDays,
        "retention-days",
        30
      ),
      alert_threshold: parseAlertThreshold(options.alertThreshold),
      provider_pressure_threshold: parsePositiveInteger(
        options.providerPressureThreshold,
        "provider-pressure-threshold",
        8
      )
    }
  });
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (result.status === "busy") {
    return [
      "Kairon scheduled project health scan is busy.",
      "status=busy",
      `reason=${result.reason}`,
      `lock_path=${result.lock_path}`
    ].join("\n");
  }
  return [
    "Kairon scheduled project health scan completed.",
    `status=${result.status}`,
    `snapshot_id=${result.snapshot.snapshot_id}`,
    `snapshot=${result.snapshot_path}`,
    `latest=${result.latest_path}`,
    `projects.pass=${result.snapshot.summary.pass}`,
    `projects.warning=${result.snapshot.summary.warning}`,
    `projects.error=${result.snapshot.summary.error}`,
    `changes=${result.snapshot.diff.changed.length}`
  ].join("\n");
}

export async function reportProjectsHealthCommand(
  options: ProjectsCommandOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const snapshot = await readLatestScheduledHealth(registry.registryPath);
  if (snapshot === undefined) {
    return [
      "Kairon scheduled project health report unavailable.",
      "status=not_run",
      "guidance=Run kairon projects health scan."
    ].join("\n");
  }
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }
  return formatScheduledHealthSnapshot(snapshot);
}

export async function planProjectsHealthScheduleCommand(
  options: ProjectsHealthScheduleOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  const result = await createScheduledHealthTaskPlan({
    registryPath: registry.registryPath,
    taskName: options.taskName,
    kaironCommand: options.kaironCommand,
    intervalMinutes: parsePositiveInteger(
      options.intervalMinutes,
      "interval-minutes",
      60
    ),
    projectTimeoutMs: parsePositiveInteger(
      options.projectTimeoutMs,
      "project-timeout-ms",
      5_000
    ),
    concurrency: parsePositiveInteger(options.concurrency, "concurrency", 4),
    retentionDays: parsePositiveInteger(
      options.retentionDays,
      "retention-days",
      30
    ),
    alertThreshold: parseAlertThreshold(options.alertThreshold),
    providerPressureThreshold: parsePositiveInteger(
      options.providerPressureThreshold,
      "provider-pressure-threshold",
      8
    )
  });
  if (parseFormat(options.format) === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon scheduled health task plan created.",
    `plan_id=${result.plan.plan_id}`,
    `plan_path=${result.plan_path}`,
    `task_name=${result.plan.task_name}`,
    `interval_minutes=${result.plan.profile.interval_minutes}`,
    `confirm=Use --confirm ${result.plan.plan_id} when registering.`
  ].join("\n");
}

export async function runProjectsHealthScheduleCommand(
  action: "register" | "verify" | "unregister",
  planId: string | undefined,
  options: ProjectsHealthScheduleOptions = {}
): Promise<string> {
  const registry = createRegistry(options);
  return runScheduledHealthTaskAction(action, {
    registryPath: registry.registryPath,
    planId,
    confirm: options.confirm,
    taskName: options.taskName
  });
}

function createRegistry(options: ProjectsCommandOptions): ProjectRegistry {
  const registryOptions: ProjectRegistryOptions = {
    registryPath: options.registryPath
  };
  return new ProjectRegistry(registryOptions);
}

function parseFormat(value: string | undefined): "text" | "json" {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }
  throw new Error(`Invalid projects output format: ${value}`);
}

function parsePositiveInteger(
  value: string | undefined,
  optionName: string,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return parsed;
}

function parseAlertThreshold(
  value: string | undefined
): ScheduledHealthAlertThreshold {
  if (value === undefined || value === "warning") {
    return "warning";
  }
  if (value === "error") {
    return "error";
  }
  throw new Error(`Invalid alert-threshold: ${value}`);
}

function formatScheduledHealthSnapshot(
  snapshot: ScheduledHealthSnapshot
): string {
  const lines = [
    "Kairon scheduled project health:",
    `status=${snapshot.status}`,
    `snapshot_id=${snapshot.snapshot_id}`,
    `generated_at=${snapshot.generated_at}`,
    `ok=${snapshot.ok}`,
    `summary.pass=${snapshot.summary.pass}`,
    `summary.warning=${snapshot.summary.warning}`,
    `summary.error=${snapshot.summary.error}`,
    `diff.added=${snapshot.diff.added.length}`,
    `diff.removed=${snapshot.diff.removed.length}`,
    `diff.changed=${snapshot.diff.changed.length}`
  ];
  for (const project of snapshot.projects) {
    lines.push(
      `${project.status.toUpperCase()} project=${project.project_id} issues=${project.issues.join(",") || "none"}`
    );
  }
  return lines.join("\n");
}

function formatProjectsList(
  registryPath: string,
  projects: ProjectRegistryEntry[]
): string {
  const lines = [
    "Kairon projects:",
    `registry_path=${registryPath}`,
    `projects.total=${projects.length}`
  ];
  for (const project of projects) {
    lines.push(
      `project_id=${project.project_id} root=${project.root} version=${project.kairon_version} doctor=${project.last_doctor_summary?.status ?? "not_run"}`
    );
  }
  return lines.join("\n");
}

function formatProject(
  registryPath: string,
  project: ProjectRegistryEntry
): string {
  return [
    "Kairon project:",
    `registry_path=${registryPath}`,
    `project_id=${project.project_id}`,
    `root=${project.root}`,
    `registered_at=${project.registered_at}`,
    `last_seen_at=${project.last_seen_at}`,
    `kairon_version=${project.kairon_version}`,
    `board_url=${project.board_url ?? "none"}`,
    `previous_root=${project.previous_root ?? "none"}`,
    `doctor_status=${project.last_doctor_summary?.status ?? "not_run"}`,
    `doctor_checked_at=${project.last_doctor_summary?.checked_at ?? "none"}`
  ].join("\n");
}
