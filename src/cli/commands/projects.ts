import {
  ProjectRegistry,
  type ProjectRegistryEntry,
  type ProjectRegistryOptions
} from "../../projects/registry.js";
import {
  formatProjectSupervisorReport,
  ProjectSupervisor
} from "../../projects/supervisor.js";

export type ProjectsCommandOptions = {
  format?: string;
  registryPath?: string;
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
