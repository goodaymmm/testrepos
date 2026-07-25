import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  doctorProjectsCommand,
  listProjectsCommand,
  registerProjectCommand,
  showProjectCommand,
  unregisterProjectCommand
} from "../src/cli/commands/projects.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("projects commands", () => {
  it("registers, reports, and unregisters through the CLI command contract", async () => {
    const projectRoot = await createTempProject();
    await initializeProject({ projectRoot });
    const projectConfigPath = path.join(
      projectRoot,
      ".kairon",
      "config",
      "project.json"
    );
    const config = await readJsonFile<Record<string, unknown>>(projectConfigPath);
    await writeJsonFileAtomic(projectConfigPath, {
      ...config,
      project_id: "command-project",
      root: projectRoot
    });
    const registryPath = path.join(
      await createTempProject(),
      "projects.json"
    );
    const options = { registryPath, format: "json" };

    const registered = JSON.parse(
      await registerProjectCommand(projectRoot, options)
    ) as { status: string; project: { project_id: string } };
    const listed = JSON.parse(await listProjectsCommand(options)) as {
      projects: { project_id: string }[];
    };
    const shown = JSON.parse(
      await showProjectCommand("command-project", options)
    ) as { project: { root: string } };
    const doctor = JSON.parse(await doctorProjectsCommand(options)) as {
      ok: boolean;
      projects: { project_id: string }[];
    };
    const unregistered = JSON.parse(
      await unregisterProjectCommand("command-project", options)
    ) as { status: string };

    expect(registered.status).toBe("registered");
    expect(registered.project.project_id).toBe("command-project");
    expect(listed.projects.map((project) => project.project_id)).toEqual([
      "command-project"
    ]);
    expect(shown.project.root).toBe(await realpath(projectRoot));
    expect(doctor.ok).toBe(true);
    expect(doctor.projects[0].project_id).toBe("command-project");
    expect(unregistered.status).toBe("unregistered");
  });

  it("rejects unsupported output formats", async () => {
    await expect(
      listProjectsCommand({
        registryPath: path.join(await createTempProject(), "projects.json"),
        format: "yaml"
      })
    ).rejects.toThrow("Invalid projects output format");
  });
});
