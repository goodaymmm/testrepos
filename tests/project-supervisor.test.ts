import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { ProjectSupervisor } from "../src/projects/supervisor.js";
import { createTempProject } from "./test-utils.js";

describe("ProjectSupervisor", () => {
  it("diagnoses two projects without mutating either project state", async () => {
    const alpha = await createProject("alpha");
    const beta = await createProject("beta");
    await new WorkQueue(alpha).enqueue({ type: "maintenance.run" });
    await writeServerStatuses(alpha, "https://shared.example.test/");
    await writeServerStatuses(beta, "https://shared.example.test/");

    const registryPath = path.join(
      await createTempProject(),
      "projects.json"
    );
    const registry = new ProjectRegistry({ registryPath });
    await registry.register(alpha);
    await registry.register(beta);
    const beforeAlpha = await treeDigest(alpha);
    const beforeBeta = await treeDigest(beta);

    const report = await new ProjectSupervisor({
      registry,
      now: () => new Date("2026-07-25T01:00:00.000Z")
    }).inspect();

    expect(report.projects).toHaveLength(2);
    expect(report.conflicts.map((conflict) => conflict.kind)).toEqual([
      "external_url",
      "external_url",
      "port",
      "port"
    ]);
    expect(
      report.projects.find((project) => project.project_id === "alpha")?.runtime
        ?.queue.ready
    ).toBe(1);
    expect(
      report.projects.find((project) => project.project_id === "beta")?.runtime
        ?.queue.ready
    ).toBe(0);
    expect(report.provider_limits).toEqual(
      expect.arrayContaining([
        {
          provider: "codex",
          configured_projects: 2,
          aggregate_max_concurrent: 2
        }
      ])
    );
    expect(await treeDigest(alpha)).toBe(beforeAlpha);
    expect(await treeDigest(beta)).toBe(beforeBeta);

    const stored = await registry.list();
    expect(stored.every((entry) => entry.last_doctor_summary !== undefined)).toBe(
      true
    );
    expect(stored[0].board_url).toBe("https://shared.example.test/");
    expect(await readFile(registryPath, "utf8")).not.toContain(
      "SHOULD_NOT_LEAK"
    );
    expect(await readFile(registryPath, "utf8")).not.toContain("?token=NO");
  });

  it("classifies a missing registered root without touching other projects", async () => {
    const alpha = await createProject("alpha");
    const missing = await createProject("missing");
    const registry = new ProjectRegistry({
      registryPath: path.join(await createTempProject(), "projects.json")
    });
    await registry.register(alpha);
    await registry.register(missing);
    await rm(missing, { recursive: true, force: true });
    const beforeAlpha = await treeDigest(alpha);

    const report = await new ProjectSupervisor({ registry }).inspect();
    const missingHealth = report.projects.find(
      (project) => project.project_id === "missing"
    );

    expect(report.ok).toBe(false);
    expect(missingHealth?.status).toBe("error");
    expect(missingHealth?.issues).toContain("root_missing");
    expect(await treeDigest(alpha)).toBe(beforeAlpha);
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

async function writeServerStatuses(
  root: string,
  externalUrl: string
): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "runtime", "board", "server.json"),
    {
      schema_version: "0.1",
      status: "ready",
      host: "127.0.0.1",
      port: 8787,
      board_url: "http://127.0.0.1:8787/?access_token=SHOULD_NOT_LEAK",
      external_url: externalUrl
    }
  );
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "runtime", "discord", "http-server.json"),
    {
      schema_version: "0.1",
      status: "ready",
      host: "127.0.0.1",
      port: 18777,
      external_url: "https://discord.shared.example.test/interactions?token=NO"
    }
  );
}

async function treeDigest(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  return output.sort();
}
