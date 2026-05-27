import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { ReviewLoopExecutor } from "../src/review/review-loop-executor.js";
import { ReviewLoopManager } from "../src/review/review-loop-manager.js";
import { createTempProject } from "./test-utils.js";

describe("ReviewLoopExecutor", () => {
  it("runs reviewers, saves review results, and approves passing loops", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const manager = new ReviewLoopManager(root);
    const loop = await manager.start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "codex",
      codeProducing: true
    });

    const result = await new ReviewLoopExecutor(root, {
      commandAvailability: async () => true,
      commandRunner: reviewCommandRunner(root, {
        status: "approved",
        score: { overall: 0.95 },
        findings: [],
        tests_passed: true,
        secret_scan_passed: true
      })
    }).run({ loopId: loop.loop_id, date: "2026-05-26" });

    expect(result).toMatchObject({
      loop_id: "REV-0001",
      status: "approved",
      decision: { status: "passed" },
      next_action: { action: "approve" },
      review_run_ids: ["RUN-0002"],
      review_result_ids: ["REV-0002"]
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "reviews", "results", "REV-0002.json"))
    ).resolves.toMatchObject({
      review_id: "REV-0002",
      task_id: "TASK-0001",
      reviewer: "claude",
      status: "approved"
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"))
    ).resolves.toMatchObject({
      status: "approved",
      history: expect.arrayContaining([{ run_id: "RUN-0002", type: "review" }])
    });
  });

  it("blocks high findings and queues a fix before max iterations", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const loop = await new ReviewLoopManager(root).start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "codex",
      codeProducing: true
    });

    const result = await new ReviewLoopExecutor(root, {
      commandAvailability: async () => true,
      commandRunner: reviewCommandRunner(root, {
        status: "approved",
        score: { overall: 0.95 },
        findings: [{ severity: "high", body: "Unsafe change remains." }],
        tests_passed: true,
        secret_scan_passed: true
      })
    }).run({ loopId: loop.loop_id, date: "2026-05-26" });

    expect(result).toMatchObject({
      status: "changes_requested",
      decision: { status: "failed" },
      next_action: { action: "request_fix" }
    });
    expect(result.decision.reasons.join("\n")).toContain("high finding blocks gate");
    await expect(new WorkQueue(root).list("ready")).resolves.toMatchObject([
      {
        type: "agent.run",
        task_id: "TASK-0001",
        payload: {
          purpose: "review_fix",
          review_loop_id: "REV-0001",
          iteration: 2
        }
      }
    ]);
    await expect(
      readJsonFile(path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"))
    ).resolves.toMatchObject({
      status: "changes_requested",
      iteration: 2
    });
  });

  it("escalates when max iterations are exceeded", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const manager = new ReviewLoopManager(root);
    const loop = await manager.start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "codex",
      codeProducing: true
    });
    await manager.saveLoopState({
      ...loop,
      iteration: loop.max_iterations
    });

    const result = await new ReviewLoopExecutor(root, {
      commandAvailability: async () => true,
      commandRunner: reviewCommandRunner(root, {
        status: "changes_requested",
        score: { overall: 0.2 },
        findings: [{ severity: "medium", body: "Score remains low." }],
        tests_passed: true,
        secret_scan_passed: true
      })
    }).run({ loopId: loop.loop_id, date: "2026-05-26" });

    expect(result).toMatchObject({
      status: "escalated",
      decision: { status: "failed" },
      next_action: { action: "escalate", approval_id: "APR-0001" }
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "pending",
      type: "review_escalation",
      review_loop_id: "REV-0001"
    });
  });

  it("routes Claude Opus implementation review through Codex", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const invocations: CliInvocation[] = [];
    const loop = await new ReviewLoopManager(root).start({
      taskId: "TASK-0001",
      runId: "RUN-0001",
      implementer: "claude",
      modelClass: "opus",
      commitRequested: true
    });

    await new ReviewLoopExecutor(root, {
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return reviewCommandRunner(root, {
          status: "approved",
          score: { overall: 0.98 },
          findings: [],
          tests_passed: true,
          secret_scan_passed: true
        })(invocation);
      }
    }).run({ loopId: loop.loop_id, date: "2026-05-26" });

    expect(loop).toMatchObject({
      reviewers: ["codex"],
      integration: "codex-plugin-cc"
    });
    expect(invocations[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"]
    });
  });
});

function reviewCommandRunner(
  root: string,
  reviewResult: Record<string, unknown>
): (invocation: CliInvocation) => Promise<CommandRunResult> {
  return async (invocation) => {
    const prompt = invocation.stdin ?? invocation.args.join("\n");
    const outboxPath = /Expected outbox: (.+)/.exec(prompt)?.[1];
    const runId = /KAIRON_JOB_START (RUN-\d+)/.exec(prompt)?.[1];
    const taskId = /Task: (TASK-\d+)/.exec(prompt)?.[1];

    if (outboxPath === undefined || runId === undefined || taskId === undefined) {
      throw new Error("Review prompt is missing run, task, or outbox path.");
    }

    await writeJsonFileAtomic(path.join(root, outboxPath), {
      schema_version: "0.1",
      run_id: runId,
      task_id: taskId,
      agent: invocation.command === "codex" ? "codex" : "claude",
      persona: "reviewer",
      status: "completed",
      review_result: {
        target: {},
        ...reviewResult
      }
    });

    return commandResult(invocation);
  };
}

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-05-26T00:00:00.000Z",
    finishedAt: "2026-05-26T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}
