import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  formatMigrationResult,
  migrateConfigs
} from "../src/core/config/migrate-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("migrateConfigs", () => {
  it("reports Antigravity migration changes in dry-run mode without writing files", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeLegacyAgentsConfig(root);

    const result = await migrateConfigs({ projectRoot: root, dryRun: true });
    const agents = await readJsonFile<AgentsConfig>(agentsPath(root));

    expect(result).toMatchObject({
      dryRun: true,
      changed: true,
      backups: [],
      validation: { ok: true }
    });
    expect(result.changes).toEqual([
      expect.objectContaining({
        file: "agents.json",
        path: "agents.gemini.adapter",
        from: "gemini_cli",
        to: "antigravity_cli"
      }),
      expect.objectContaining({
        file: "agents.json",
        path: "agents.gemini.command",
        from: "gemini",
        to: "agy"
      })
    ]);
    expect(agents.agents.gemini).toMatchObject({
      adapter: "gemini_cli",
      command: "gemini"
    });
  });

  it("migrates legacy Gemini CLI config, writes a backup, and is idempotent", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeLegacyAgentsConfig(root);

    const result = await migrateConfigs({
      projectRoot: root,
      now: new Date("2026-05-26T03:28:35")
    });
    const agents = await readJsonFile<AgentsConfig>(agentsPath(root));

    expect(result).toMatchObject({
      dryRun: false,
      changed: true,
      backups: [path.join(".kairon", "config", "agents.json.bak-20260526032835").replaceAll("\\", "/")],
      validation: { ok: true }
    });
    expect(agents.agents.gemini).toMatchObject({
      adapter: "antigravity_cli",
      command: "agy"
    });
    await expect(access(path.join(root, result.backups[0] ?? ""))).resolves.toBeUndefined();

    const secondResult = await migrateConfigs({ projectRoot: root });

    expect(secondResult).toMatchObject({
      changed: false,
      backups: [],
      validation: { ok: true }
    });
  });

  it("formats migration results for CLI output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeLegacyAgentsConfig(root);

    const result = await migrateConfigs({ projectRoot: root, dryRun: true });
    const text = formatMigrationResult(result);

    expect(text).toContain("Kairon migration dry run.");
    expect(text).toContain("agents.json agents.gemini.adapter: gemini_cli -> antigravity_cli");
    expect(text).toContain("validation.ok=true");
  });
});

type AgentsConfig = {
  agents: {
    gemini: {
      adapter: string;
      command: string;
    };
  };
};

async function writeLegacyAgentsConfig(root: string): Promise<void> {
  const agents = await readJsonFile<Record<string, unknown>>(agentsPath(root));
  const agentMap = agents.agents as Record<string, unknown>;
  const gemini = agentMap.gemini as Record<string, unknown>;
  gemini.adapter = "gemini_cli";
  gemini.command = "gemini";
  await writeJsonFileAtomic(agentsPath(root), agents);
}

function agentsPath(root: string): string {
  return path.join(root, ".kairon", "config", "agents.json");
}
