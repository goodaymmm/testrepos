import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  workflowConfigProposeCommand,
  workflowConfigShowCommand
} from "../src/cli/commands/workflow.js";
import {
  applyConfigProposal,
  createWorkflowConfigProposal
} from "../src/core/config/config-proposals.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import {
  resolveWorkflowRuntimeConfig
} from "../src/workflow/config.js";
import {
  ProductionWorkflowRuntime,
  workflowCheckpointPath
} from "../src/workflow/runtime.js";
import { createTempProject } from "./test-utils.js";

describe("workflow runtime configuration", () => {
  it("uses explicit config before a conflicting environment value", async () => {
    const root = await createInitializedProject();

    const resolution = await resolveWorkflowRuntimeConfig(root, {
      KAIRON_WORKFLOW_RUNTIME: "1"
    });
    const text = await workflowConfigShowCommand(root, {
      KAIRON_WORKFLOW_RUNTIME: "1"
    });

    expect(resolution).toMatchObject({
      effective_enabled: false,
      effective_source: "config",
      explicit_enabled: true,
      conflict: true
    });
    expect(text).toContain("effective_source=config");
    expect(text).toContain("conflict=true");
  });

  it("keeps legacy enabled_env as an environment fallback", async () => {
    const root = await createInitializedProject();
    const runtimePath = configPath(root);
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    const workflow = runtime.workflow as Record<string, unknown>;
    delete workflow.enabled;
    workflow.enabled_env = "KAIRON_WORKFLOW_RUNTIME";
    await writeJsonFileAtomic(runtimePath, runtime);

    const resolution = await resolveWorkflowRuntimeConfig(root, {
      KAIRON_WORKFLOW_RUNTIME: "true"
    });

    expect(resolution).toMatchObject({
      effective_enabled: true,
      effective_source: "environment",
      explicit_enabled: false,
      legacy_enabled_env: true,
      conflict: false
    });
    expect(resolution.warnings.join("\n")).toContain("environment fallback");
  });

  it("creates and applies an explicit enable proposal without changing config first", async () => {
    const root = await createInitializedProject();
    const before = await readJsonFile<Record<string, unknown>>(configPath(root));
    const proposal = await createWorkflowConfigProposal({
      projectRoot: root,
      enabled: true,
      now: new Date("2026-07-23T01:00:00.000Z")
    });

    expect(proposal.artifact).toMatchObject({
      proposal_kind: "workflow_runtime_config",
      target_file: "runtime.json",
      requested_enabled: true,
      restart_required: true,
      risk: "medium"
    });
    expect(
      ((before.workflow as Record<string, unknown>).enabled)
    ).toBe(false);

    const applied = await applyConfigProposal({
      projectRoot: root,
      proposalId: proposal.proposal_id,
      now: new Date("2026-07-23T01:01:00.000Z")
    });
    const stored = await readJsonFile<Record<string, unknown>>(configPath(root));
    const storedWorkflow = stored.workflow as Record<string, unknown>;

    expect(applied).toMatchObject({
      applied: true,
      target_file: "runtime.json",
      validation: { ok: true }
    });
    expect(storedWorkflow.enabled).toBe(true);
    expect(storedWorkflow).not.toHaveProperty("enabled_env");
    expect(applied.backups).toHaveLength(1);
    expect(applied.backups[0]).toMatch(
      /^\.kairon\/config\/runtime\.json\.bak-20260723\d{6}$/
    );
  });

  it("does not auto-enable a legacy config in a disable migration proposal", async () => {
    const root = await createInitializedProject();
    const runtimePath = configPath(root);
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    const workflow = runtime.workflow as Record<string, unknown>;
    delete workflow.enabled;
    workflow.enabled_env = "KAIRON_WORKFLOW_RUNTIME";
    await writeJsonFileAtomic(runtimePath, runtime);

    const text = await workflowConfigProposeCommand(root, { disable: true });
    const proposalId = text.match(/proposal_id=(CFG-[0-9]{14}-[0-9a-f]{8})/)?.[1];
    const proposal = await readJsonFile<{
      migration_required: boolean;
      requested_enabled: boolean;
      runtime_config: { workflow: { enabled: boolean; enabled_env?: string } };
    }>(
      path.join(root, ".kairon", "config", "proposals", `${proposalId}.json`)
    );

    expect(text).toContain("migration_required=true");
    expect(proposal).toMatchObject({
      migration_required: true,
      requested_enabled: false,
      runtime_config: { workflow: { enabled: false } }
    });
    expect(proposal.runtime_config.workflow).not.toHaveProperty("enabled_env");
  });

  it("runs from config without env and honors retry and checkpoint settings", async () => {
    const root = await createInitializedProject();
    const runtimePath = configPath(root);
    const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
    const workflow = runtime.workflow as Record<string, unknown>;
    workflow.enabled = true;
    workflow.checkpoint_on_transition = false;
    workflow.retry = { max_attempts: 2, backoff_seconds: 7 };
    await writeJsonFileAtomic(runtimePath, runtime);
    const task = await new TaskRunner(root).createTask({
      title: "T167 config runtime",
      persona: "researcher"
    });

    const result = await new ProductionWorkflowRuntime(root, { env: {} }).run({
      workflowId: "WF-0167-CONFIG",
      taskId: task.task_id
    });

    expect(result.runtime_config).toMatchObject({
      effective_enabled: true,
      effective_source: "config"
    });
    expect(result.artifact.retry_policy).toEqual({
      max_attempts: 2,
      backoff_seconds: 7
    });
    expect(result.checkpoint_path).toBeUndefined();
    await expect(
      fileExists(workflowCheckpointPath(root, "WF-0167-CONFIG", 1))
    ).resolves.toBe(false);
  });

  it("requires exactly one proposal enablement option", async () => {
    const root = await createInitializedProject();

    await expect(
      workflowConfigProposeCommand(root, {})
    ).rejects.toThrow("exactly one");
    await expect(
      workflowConfigProposeCommand(root, { enable: true, disable: true })
    ).rejects.toThrow("exactly one");
  });

  it("rejects unsupported workflow mode and checkpoint store values", () => {
    const validation = validateConfigFile("runtime.json", {
      schema_version: "0.1",
      workflow: {
        enabled: true,
        mode: "experimental",
        checkpoint_store: "sqlite"
      }
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain(
      "runtime.json: runtime workflow or watchdog settings are invalid"
    );
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function configPath(root: string): string {
  return path.join(root, ".kairon", "config", "runtime.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
