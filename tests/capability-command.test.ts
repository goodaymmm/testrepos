import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateCapabilityCommand,
  explainCapabilityCommand
} from "../src/cli/commands/capability.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import { createTempProject } from "./test-utils.js";

describe("capability commands", () => {
  it("evaluates a task with text and JSON output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root).createTask({
      title: "Review capability",
      persona: "reviewer",
      capabilities: ["review"]
    });

    const text = await evaluateCapabilityCommand(root, {
      task: task.task_id,
      agent: "codex"
    });
    const json = JSON.parse(
      await explainCapabilityCommand(root, {
        task: task.task_id,
        agent: "codex",
        format: "json"
      })
    ) as Record<string, unknown>;

    expect(text).toContain("Kairon capability decision.");
    expect(text).toContain("status=allowed");
    expect(json).toMatchObject({
      task_id: task.task_id,
      agent: "codex",
      requested: ["review"],
      effective: ["review"]
    });
  });

  it("explains default-deny reasons without exposing config values", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root).createTask({
      title: "Unknown capability",
      persona: "implementer",
      capabilities: ["unknown.superpower"]
    });

    const output = await explainCapabilityCommand(root, {
      task: task.task_id,
      agent: "codex"
    });

    expect(output).toContain("status=denied");
    expect(output).toContain("reason=unknown_capability:unknown.superpower");
    expect(output).not.toMatch(/authorization|cookie|password|token=/iu);
  });

  it("evaluates without persisting provider health", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root).createTask({
      title: "Read-only capability evaluation",
      persona: "reviewer",
      capabilities: ["review"]
    });
    const providerHealthDir = path.join(
      root,
      ".kairon",
      "runtime",
      "agents"
    );
    const before = await listProviderHealthFiles(providerHealthDir);

    await evaluateCapabilityCommand(root, {
      task: task.task_id
    });

    await expect(listProviderHealthFiles(providerHealthDir)).resolves.toEqual(
      before
    );
  });
});

async function listProviderHealthFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((entry) => entry.endsWith("-health.json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
