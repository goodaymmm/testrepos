import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import {
  isCodeProducingJob,
  ReviewLoopManager,
  selectReviewers
} from "../src/review/review-loop-manager.js";
import { loadReviewPolicy } from "../src/review/quality-gate.js";
import { createTempProject } from "./test-utils.js";

describe("ReviewLoopManager", () => {
  it("detects code-producing jobs", () => {
    expect(
      isCodeProducingJob({
        taskId: "TASK-0001",
        runId: "RUN-0001",
        implementer: "codex",
        changedFiles: [{ path: "src/example.ts", status: "modified" }]
      })
    ).toBe(true);
    expect(
      isCodeProducingJob({
        taskId: "TASK-0002",
        runId: "RUN-0002",
        implementer: "codex",
        changedFiles: [{ path: "docs/research.md", status: "modified" }]
      })
    ).toBe(false);
  });

  it("selects Codex review through codex-plugin-cc for Claude Opus implementation", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const policy = await loadReviewPolicy(root);

    expect(
      selectReviewers(
        {
          taskId: "TASK-0001",
          runId: "RUN-0001",
          implementer: "claude",
          modelClass: "opus",
          commitRequested: true
        },
        policy
      )
    ).toEqual(["codex"]);

    await expect(
      new ReviewLoopManager(root).start({
        taskId: "TASK-0001",
        runId: "RUN-0001",
        implementer: "claude",
        modelClass: "opus",
        commitRequested: true
      })
    ).resolves.toMatchObject({
      reviewers: ["codex"],
      integration: "codex-plugin-cc",
      status: "running"
    });
  });

  it("queues a fix job when quality gate fails before max iterations", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const manager = new ReviewLoopManager(root);
    const state = await manager.start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "codex",
      commitRequested: true
    });

    const action = await manager.nextAction(state, {
      status: "failed",
      reasons: ["score is below threshold"],
      blocking_findings: [],
      review_ids: ["REV-0001"]
    });

    expect(action).toMatchObject({ action: "request_fix" });
    await expect(new WorkQueue(root).list("ready")).resolves.toHaveLength(1);
  });

  it("creates an escalated approval when max iterations are exceeded", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const manager = new ReviewLoopManager(root);
    const state = await manager.start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "codex",
      commitRequested: true
    });
    state.iteration = state.max_iterations;

    const action = await manager.nextAction(state, {
      status: "failed",
      reasons: ["high severity remains"],
      blocking_findings: [],
      review_ids: ["REV-0001"]
    });

    expect(action).toMatchObject({ action: "escalate" });
    if (action.action !== "escalate") {
      throw new Error("Expected escalation action");
    }
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", `${action.approval_id}.json`))
    ).resolves.toMatchObject({
      status: "pending",
      type: "review_escalation"
    });
  });
});
