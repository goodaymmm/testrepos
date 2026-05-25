import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { formatDoctorResult, runDoctor } from "../src/diagnostics/doctor.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("runDoctor", () => {
  it("passes a healthy initialized project", async () => {
    const root = await createInitializedGitProject();
    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ error: 0, warning: 0 });
    expect(statusById(result, "git.repository")).toBe("pass");
    expect(statusById(result, "git.gitignore")).toBe("pass");
    expect(statusById(result, "cli.availability")).toBe("pass");
    expect(statusById(result, "env.api_keys")).toBe("pass");
    expect(statusById(result, "discord.config")).toBe("pass");
  });

  it("warns when migration or subscription-only environment cleanup is needed", async () => {
    const root = await createInitializedGitProject({ gitignore: false });
    await writeLegacyAgentsConfig(root);

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: { OPENAI_API_KEY: "redacted" }
    });

    expect(result.ok).toBe(true);
    expect(statusById(result, "git.gitignore")).toBe("warning");
    expect(statusById(result, "config.agents")).toBe("warning");
    expect(statusById(result, "env.api_keys")).toBe("warning");
    expect(checkById(result, "config.agents")?.nextAction).toBe("Run kairon migrate.");
  });

  it("errors when required CLIs or enabled Discord env vars are missing", async () => {
    const root = await createInitializedGitProject();
    const notifications = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "config", "notifications.json")
    );
    const providers = notifications.providers as Record<string, unknown>;
    const discord = providers.discord as Record<string, unknown>;
    discord.enabled = true;
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "config", "notifications.json"),
      notifications
    );

    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async (command) => command !== "agy",
      env: {}
    });

    expect(result.ok).toBe(false);
    expect(statusById(result, "cli.availability")).toBe("error");
    expect(statusById(result, "discord.config")).toBe("error");
  });

  it("formats doctor output with summary, checks, and next actions", async () => {
    const root = await createInitializedGitProject({ gitignore: false });
    const result = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {}
    });
    const text = formatDoctorResult(result);

    expect(text).toContain("doctor.ok=true");
    expect(text).toContain("WARNING git.gitignore .gitignore");
    expect(text).toContain("next=Create .gitignore and add .kairon/.");
  });
});

type DoctorResult = Awaited<ReturnType<typeof runDoctor>>;

async function createInitializedGitProject(
  options: { gitignore?: boolean } = {}
): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await mkdir(path.join(root, ".git"));

  if (options.gitignore !== false) {
    await writeFile(path.join(root, ".gitignore"), ".kairon/\n", "utf8");
  }

  return root;
}

async function writeLegacyAgentsConfig(root: string): Promise<void> {
  const agentsPath = path.join(root, ".kairon", "config", "agents.json");
  const agents = await readJsonFile<Record<string, unknown>>(agentsPath);
  const agentMap = agents.agents as Record<string, unknown>;
  const gemini = agentMap.gemini as Record<string, unknown>;
  gemini.adapter = "gemini_cli";
  gemini.command = "gemini";
  await writeJsonFileAtomic(agentsPath, agents);
}

function checkById(result: DoctorResult, id: string) {
  return result.checks.find((check) => check.id === id);
}

function statusById(result: DoctorResult, id: string) {
  return checkById(result, id)?.status;
}
