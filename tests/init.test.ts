import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { loadAllConfigs, validateAllConfigs } from "../src/core/config/load-config.js";
import { createTempProject } from "./test-utils.js";

describe("initializeProject", () => {
  it("creates .kairon directories, config defaults, and rules", async () => {
    const root = await createTempProject();
    const result = await initializeProject({ projectRoot: root });

    expect(result.createdDirectories.length).toBeGreaterThan(0);
    expect(result.writtenFiles).toContain(path.join(".kairon", "config", "project.json"));
    expect(result.writtenFiles).toContain(path.join(".kairon", "rules", "common.md"));
    expect(result.gitignoreSuggestionNeeded).toBe(true);

    const configs = await loadAllConfigs(root);
    expect(configs["project.json"]).toMatchObject({ schema_version: "0.1" });
    expect(configs["agents.json"]).toMatchObject({
      provider_policies: {
        codex: {
          unattended_allowed: true,
          max_concurrent: 1,
          cooldown_seconds: 300,
          daily_run_limit: 100
        },
        claude: expect.any(Object),
        gemini: expect.objectContaining({ daily_run_limit: 50 })
      }
    });
    expect(configs["policies.json"]).toMatchObject({
      cleanup: {
        delete_directly: false,
        proposal_required: true,
        retention: {
          enabled: true,
          categories: {
            runs: expect.objectContaining({ min_keep: 10 }),
            daemon_logs: expect.objectContaining({ min_keep: 7 })
          }
        }
      }
    });
    expect(await validateAllConfigs(root)).toMatchObject({ ok: true, errors: [] });
  });

  it("does not overwrite existing root rule files", async () => {
    const root = await createTempProject();
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, "existing root rule", "utf8");

    await initializeProject({ projectRoot: root });

    await expect(readFile(agentsPath, "utf8")).resolves.toBe("existing root rule");
  });

  it("does not overwrite existing Kairon config files", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    await writeFile(projectConfigPath, "{\n  \"schema_version\": \"custom\"\n}\n", "utf8");
    await initializeProject({ projectRoot: root });

    await expect(readFile(projectConfigPath, "utf8")).resolves.toContain(
      "\"schema_version\": \"custom\""
    );
  });
});
