import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { getProjectsRegistryPath } from "../src/core/fs/paths.js";
import {
  ProjectRegistrationConflictError,
  ProjectRegistry,
  ProjectRegistryCorruptError,
  type ProjectRegistryDocument
} from "../src/projects/registry.js";
import { createTempProject } from "./test-utils.js";

describe("ProjectRegistry", () => {
  it("resolves an overridable user-local registry path", () => {
    const explicit = path.join(os.tmpdir(), "kairon-registry", "projects.json");
    expect(
      getProjectsRegistryPath({
        KAIRON_PROJECTS_REGISTRY_PATH: explicit
      })
    ).toBe(path.resolve(explicit));
    expect(
      getProjectsRegistryPath(
        { KAIRON_USER_DATA_DIR: path.dirname(explicit) },
        path.join(os.tmpdir(), "home")
      )
    ).toBe(path.resolve(path.dirname(explicit), "projects.json"));
  });

  it("registers, lists, shows, and unregisters isolated projects", async () => {
    const registryRoot = await createTempProject();
    const registryPath = path.join(registryRoot, "user-state", "projects.json");
    const alpha = await createProject("alpha");
    const beta = await createProject("beta");
    const registry = new ProjectRegistry({
      registryPath,
      now: tickingClock("2026-07-25T00:00:00.000Z")
    });

    const first = await registry.register(alpha);
    const idempotent = await registry.register(alpha);
    const second = await registry.register(beta);

    expect(first.status).toBe("registered");
    expect(idempotent.status).toBe("already_registered");
    expect(second.entry.project_id).toBe("beta");
    expect((await registry.list()).map((entry) => entry.project_id)).toEqual([
      "alpha",
      "beta"
    ]);
    expect((await registry.show("alpha"))?.root).toBe(await realpath(alpha));

    const removed = await registry.unregister("alpha");
    expect(removed.project_id).toBe("alpha");
    expect((await registry.list()).map((entry) => entry.project_id)).toEqual([
      "beta"
    ]);

    const raw = await readFile(registryPath, "utf8");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("approval");
    expect(raw).not.toContain("task");
  });

  it("rejects a live duplicate id and relocates a missing project root", async () => {
    const registryPath = path.join(
      await createTempProject(),
      "projects.json"
    );
    const original = await createProject("shared");
    const duplicate = await createProject("shared");
    const registry = new ProjectRegistry({ registryPath });
    await registry.register(original);
    const canonicalOriginal = await realpath(original);
    const canonicalDuplicate = await realpath(duplicate);

    await expect(registry.register(duplicate)).rejects.toBeInstanceOf(
      ProjectRegistrationConflictError
    );

    await rm(original, { recursive: true, force: true });
    const moved = await registry.register(duplicate);
    expect(moved.status).toBe("moved");
    expect(moved.entry.previous_root).toBe(canonicalOriginal);
    expect(moved.entry.root).toBe(canonicalDuplicate);
  });

  it("does not overwrite a corrupt registry", async () => {
    const registryRoot = await createTempProject();
    const registryPath = path.join(registryRoot, "projects.json");
    await writeFile(registryPath, "{not-json", "utf8");
    const registry = new ProjectRegistry({ registryPath });

    await expect(registry.list()).rejects.toBeInstanceOf(
      ProjectRegistryCorruptError
    );
    expect(await readFile(registryPath, "utf8")).toBe("{not-json");
  });

  it("migrates a legacy registry without a schema marker on the next mutation", async () => {
    const registryRoot = await createTempProject();
    const registryPath = path.join(registryRoot, "projects.json");
    await writeJsonFileAtomic(registryPath, {
      updated_at: "2026-07-25T00:00:00.000Z",
      projects: []
    });
    const project = await createProject("migrated");
    const registry = new ProjectRegistry({ registryPath });

    expect((await registry.read()).schema_version).toBe("0.1");
    await registry.register(project);

    const stored = await readJsonFile<ProjectRegistryDocument>(registryPath);
    expect(stored.schema_version).toBe("0.1");
    expect(stored.projects[0].project_id).toBe("migrated");
  });

  it("rejects duplicate ids and roots already present in the registry document", async () => {
    const registryRoot = await createTempProject();
    const registryPath = path.join(registryRoot, "projects.json");
    await mkdir(path.dirname(registryPath), { recursive: true });
    const duplicate: ProjectRegistryDocument = {
      schema_version: "0.1",
      updated_at: "2026-07-25T00:00:00.000Z",
      projects: [
        {
          project_id: "same",
          root: path.join(registryRoot, "one"),
          registered_at: "2026-07-25T00:00:00.000Z",
          last_seen_at: "2026-07-25T00:00:00.000Z",
          kairon_version: "0.2.0"
        },
        {
          project_id: "same",
          root: path.join(registryRoot, "two"),
          registered_at: "2026-07-25T00:00:00.000Z",
          last_seen_at: "2026-07-25T00:00:00.000Z",
          kairon_version: "0.2.0"
        }
      ]
    };
    await writeJsonFileAtomic(registryPath, duplicate);

    await expect(
      new ProjectRegistry({ registryPath }).read()
    ).rejects.toBeInstanceOf(ProjectRegistryCorruptError);
  });
});

async function createProject(projectId: string): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const configPath = path.join(root, ".kairon", "config", "project.json");
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  await writeJsonFileAtomic(configPath, {
    ...config,
    project_id: projectId,
    root
  });
  return root;
}

function tickingClock(start: string): () => Date {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value);
    value += 1_000;
    return current;
  };
}
