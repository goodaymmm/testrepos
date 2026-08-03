import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { loadAllConfigs, validateAllConfigs } from "../src/core/config/load-config.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
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
    expect(configs["project.json"]).toMatchObject({ schema_version: "0.3.0" });
    expect(configs["agents.json"]).toMatchObject({
      session_budget: {
        enabled: true,
        soft_limit: {
          prompt_bytes: 8_000_000,
          job_count: 40,
          elapsed_seconds: 21_600,
          compaction_count: 3
        },
        hard_limit: {
          prompt_bytes: 16_000_000,
          job_count: 80,
          elapsed_seconds: 43_200,
          compaction_count: 5
        },
        compaction_keep_runs: 10,
        resource_lock_ttl_seconds: 60
      },
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

  it("rejects session budget soft limits that are not below hard limits", () => {
    const validation = validateConfigFile("agents.json", {
      schema_version: "0.1",
      session_budget: {
        enabled: true,
        soft_limit: {
          prompt_bytes: 100,
          job_count: 10,
          elapsed_seconds: 60,
          compaction_count: 2
        },
        hard_limit: {
          prompt_bytes: 100,
          job_count: 20,
          elapsed_seconds: 120,
          compaction_count: 4
        },
        compaction_keep_runs: 10,
        resource_lock_ttl_seconds: 60
      },
      agents: {
        codex: { enabled: true },
        claude: { enabled: true },
        gemini: { enabled: true }
      }
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain(
      "agents.json: agent enablement, provider policy, or session budget settings are invalid"
    );
  });
});
