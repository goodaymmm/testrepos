import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateExperimentalWorkflowRuntime,
  experimentalWorkflowArtifactPath,
  runExperimentalWorkflowRuntimeSpike
} from "../src/experimental/workflow-runtime.js";
import { createTempProject } from "./test-utils.js";

describe("experimental workflow runtime spike", () => {
  it("writes an isolated graph artifact without touching production state", async () => {
    const root = await createTempProject();

    const result = await runExperimentalWorkflowRuntimeSpike(
      root,
      {
        experimental: true,
        workflowId: "EXP-WF-0001",
        taskId: "TASK-0001",
        objective: "Evaluate a graph-shaped workflow without production dispatch.",
        agent: "codex",
        approvalRequired: true
      },
      {
        now: () => new Date("2026-07-01T00:00:00.000Z")
      }
    );

    expect(result).toMatchObject({
      artifact_kind: "experimental_workflow_runtime_spike",
      runtime: "langgraph_runtime_spike",
      experimental: true,
      workflow_id: "EXP-WF-0001",
      task_id: "TASK-0001",
      status: "waiting_for_approval",
      state_boundary: {
        production_runtime_touched: false,
        queue_touched: false,
        task_runner_touched: false,
        review_loop_touched: false,
        state_applier_touched: false,
        artifact_path: ".kairon/experimental/workflows/EXP-WF-0001.json"
      },
      dependency_assessment: {
        langgraph_dependency_added: false,
        recommendation: "defer_dependency_until_value_is_proven"
      },
      created_at: "2026-07-01T00:00:00.000Z"
    });
    expect(result.nodes.map((node) => node.id)).toEqual([
      "task_intake",
      "agent_run_placeholder",
      "approval_gate_placeholder"
    ]);
    expect(result.nodes.find((node) => node.id === "approval_gate_placeholder")).toMatchObject({
      status: "waiting",
      output: {
        approval_required: true
      }
    });
    await expect(
      readJson(experimentalWorkflowArtifactPath(root, "EXP-WF-0001"))
    ).resolves.toMatchObject({
      workflow_id: "EXP-WF-0001",
      status: "waiting_for_approval"
    });
    await expect(fileExists(path.join(root, ".kairon", "state", "queue.json"))).resolves.toBe(false);
    await expect(fileExists(path.join(root, ".kairon", "tasks"))).resolves.toBe(false);
    await expect(fileExists(path.join(root, ".kairon", "reviews"))).resolves.toBe(false);
  });

  it("requires the explicit experimental flag", () => {
    const root = path.resolve("project");

    expect(() =>
      evaluateExperimentalWorkflowRuntime(root, {
        workflowId: "EXP-WF-0002",
        taskId: "TASK-0002",
        objective: "Missing flag should be rejected."
      })
    ).toThrow("experimental=true");
  });

  it("can evaluate a completed placeholder graph without writing an artifact", async () => {
    const root = await createTempProject();

    const result = await runExperimentalWorkflowRuntimeSpike(
      root,
      {
        experimental: true,
        workflowId: "EXP-WF-0003",
        taskId: "TASK-0003",
        objective: "Evaluate completed graph.",
        agent: "claude"
      },
      {
        writeArtifact: false,
        now: () => new Date("2026-07-01T00:00:00.000Z")
      }
    );

    expect(result.status).toBe("completed");
    expect(result.nodes.find((node) => node.id === "agent_run_placeholder")).toMatchObject({
      status: "completed",
      output: {
        agent: "claude",
        outcome: "completed"
      }
    });
    expect(result.nodes.find((node) => node.id === "approval_gate_placeholder")).toMatchObject({
      status: "skipped"
    });
    await expect(fileExists(experimentalWorkflowArtifactPath(root, "EXP-WF-0003"))).resolves.toBe(false);
  });

  it("keeps failed agent placeholders from opening approval gates", () => {
    const root = path.resolve("project");

    const result = evaluateExperimentalWorkflowRuntime(root, {
      experimental: true,
      workflowId: "EXP-WF-0004",
      taskId: "TASK-0004",
      objective: "Evaluate failure path.",
      agentOutcome: "failed",
      approvalRequired: true
    });

    expect(result.status).toBe("failed");
    expect(result.nodes.find((node) => node.id === "agent_run_placeholder")).toMatchObject({
      status: "failed"
    });
    expect(result.nodes.find((node) => node.id === "approval_gate_placeholder")).toMatchObject({
      status: "skipped"
    });
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}
