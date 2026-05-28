import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CliSessionRunner,
  type CliSessionRunRecord
} from "../agents/cli-session-runner.js";
import type { CommandRunner } from "../agents/command-runner.js";
import type { CommandAvailabilityChecker } from "../agents/session-host.js";
import type { AgentId } from "../agents/types.js";
import { nextId } from "../core/ids/counter.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  parseReviewResult,
  type QualityGateDecision,
  type ReviewFinding,
  type ReviewResult
} from "./quality-gate.js";
import {
  ReviewLoopManager,
  type ReviewLoopState,
  type ReviewNextAction
} from "./review-loop-manager.js";

export type ReviewLoopExecutionRequest = {
  loopId: string;
  date?: string;
  timeoutMs?: number;
};

export type ReviewLoopExecutionResult = {
  schema_version: string;
  loop_id: string;
  status: ReviewLoopState["status"];
  iteration: number;
  review_run_ids: string[];
  review_result_ids: string[];
  iteration_path: string;
  decision: QualityGateDecision;
  next_action: ReviewNextAction;
};

type ReviewOutbox = {
  review_result?: unknown;
};

export class ReviewLoopExecutor {
  private readonly manager: ReviewLoopManager;

  constructor(
    private readonly projectRoot: string,
    private readonly options: {
      commandAvailability?: CommandAvailabilityChecker;
      commandRunner?: CommandRunner;
      now?: () => Date;
    } = {}
  ) {
    this.manager = new ReviewLoopManager(projectRoot);
  }

  async run(request: ReviewLoopExecutionRequest): Promise<ReviewLoopExecutionResult> {
    const state = await this.manager.loadLoopState(request.loopId);

    if (!shouldRunReviews(state)) {
      const decision: QualityGateDecision = {
        status: "passed",
        reasons: [`review loop is ${state.status}`],
        blocking_findings: [],
        review_ids: []
      };
      const nextAction: ReviewNextAction = {
        action: "none",
        reason: `review loop is ${state.status}`
      };
      const artifactPath = await this.writeIterationArtifact(state, {
        reviewRunIds: [],
        reviewResults: [],
        decision,
        nextAction
      });

      return {
        schema_version: "0.1",
        loop_id: state.loop_id,
        status: state.status,
        iteration: state.iteration,
        review_run_ids: [],
        review_result_ids: [],
        iteration_path: artifactPath,
        decision,
        next_action: nextAction
      };
    }

    const reviewRuns: Array<{ runId: string; record: CliSessionRunRecord }> = [];
    const reviewResults: ReviewResult[] = [];
    const setupRequiredReviewers: AgentId[] = [];
    const setupRequiredReasons: string[] = [];
    const date = request.date ?? localDateKey(this.now());
    const allocatedRunIds = new Set(state.history.map((entry) => entry.run_id));

    for (const reviewer of state.reviewers) {
      const runId = await nextUniqueRunId(this.projectRoot, allocatedRunIds);
      allocatedRunIds.add(runId);
      const reviewId = await nextId(this.projectRoot, "review");
      const instructionPath = await this.writeReviewInstruction(state, {
        reviewer,
        reviewId,
        runId,
        date
      });
      const record = await new CliSessionRunner(this.projectRoot, {
        commandAvailability: this.options.commandAvailability,
        commandRunner: this.options.commandRunner,
        now: this.options.now
      }).runAgentJob({
        agent: reviewer,
        date,
        runId,
        taskId: state.task_id,
        persona: "reviewer",
        timeoutMs: request.timeoutMs,
        capabilities: ["review", "json.output"],
        extraSources: [instructionPath]
      });
      reviewRuns.push({ runId, record });

      if (record.status === "setup_required") {
        setupRequiredReviewers.push(reviewer);
        setupRequiredReasons.push(
          `${reviewer}: setup required for ${record.command}`
        );
        continue;
      }

      const result = await this.readOrSynthesizeReviewResult(state, {
        reviewer,
        reviewId,
        runId,
        record
      });

      await this.manager.saveReviewResult(result);
      reviewResults.push(result);
    }

    if (setupRequiredReviewers.length > 0) {
      const decision: QualityGateDecision = {
        status: "failed",
        reasons: setupRequiredReasons,
        blocking_findings: [],
        review_ids: reviewResults.map((result) => result.review_id)
      };
      const nextAction: ReviewNextAction = {
        action: "setup_required",
        reviewers: setupRequiredReviewers,
        reasons: setupRequiredReasons
      };
      const nextState = updateLoopState(state, {
        reviewRunIds: reviewRuns.map((run) => run.runId),
        decision,
        nextAction,
        now: this.now()
      });
      await this.manager.saveLoopState(nextState);
      const artifactPath = await this.writeIterationArtifact(nextState, {
        reviewRunIds: reviewRuns.map((run) => run.runId),
        reviewResults,
        decision,
        nextAction
      });

      return {
        schema_version: "0.1",
        loop_id: nextState.loop_id,
        status: nextState.status,
        iteration: nextState.iteration,
        review_run_ids: reviewRuns.map((run) => run.runId),
        review_result_ids: reviewResults.map((result) => result.review_id),
        iteration_path: artifactPath,
        decision,
        next_action: nextAction
      };
    }

    const decision = await this.manager.evaluate(reviewResults);
    const nextAction = await this.manager.nextAction(state, decision);
    const nextState = updateLoopState(state, {
      reviewRunIds: reviewRuns.map((run) => run.runId),
      decision,
      nextAction,
      now: this.now()
    });
    await this.manager.saveLoopState(nextState);
    const artifactPath = await this.writeIterationArtifact(nextState, {
      reviewRunIds: reviewRuns.map((run) => run.runId),
      reviewResults,
      decision,
      nextAction
    });

    return {
      schema_version: "0.1",
      loop_id: nextState.loop_id,
      status: nextState.status,
      iteration: nextState.iteration,
      review_run_ids: reviewRuns.map((run) => run.runId),
      review_result_ids: reviewResults.map((result) => result.review_id),
      iteration_path: artifactPath,
      decision,
      next_action: nextAction
    };
  }

  private async readOrSynthesizeReviewResult(
    state: ReviewLoopState,
    input: {
      reviewer: AgentId;
      reviewId: string;
      runId: string;
      record: CliSessionRunRecord;
    }
  ): Promise<ReviewResult> {
    if (input.record.outbox_path === undefined) {
      return synthesizeReviewResult(
        state,
        input,
        {
          severity: "high",
          body: "Review runner did not produce an outbox path."
        },
        this.now()
      );
    }

    try {
      const outbox = await readJsonFile<ReviewOutbox>(
        resolveInside(this.projectRoot, input.record.outbox_path)
      );
      const raw =
        outbox.review_result !== null &&
        typeof outbox.review_result === "object" &&
        !Array.isArray(outbox.review_result)
          ? (outbox.review_result as Record<string, unknown>)
          : undefined;

      if (raw === undefined) {
        return synthesizeReviewResult(
          state,
          input,
          {
            severity: "high",
            body: "Review outbox is missing review_result."
          },
          this.now()
        );
      }

      return parseReviewResult({
        schema_version: "0.1",
        target: {},
        findings: [],
        ...raw,
        review_id: input.reviewId,
        task_id: state.task_id,
        run_id: input.runId,
        reviewer: input.reviewer,
        created_at: this.now().toISOString()
      });
    } catch (error) {
      return synthesizeReviewResult(
        state,
        input,
        {
          severity: "high",
          body: `Review result could not be parsed: ${String(error)}`
        },
        this.now()
      );
    }
  }

  private async writeReviewInstruction(
    state: ReviewLoopState,
    input: {
      reviewer: AgentId;
      reviewId: string;
      runId: string;
      date: string;
    }
  ): Promise<string> {
    const paths = getKaironPaths(this.projectRoot);
    const instructionPath = resolveInside(
      paths.kaironDir,
      "reviews",
      "loops",
      `${state.loop_id}-iteration-${state.iteration}-${input.reviewer}.md`
    );
    const content = [
      "# Kairon Review Request",
      "",
      `Loop: ${state.loop_id}`,
      `Iteration: ${state.iteration}`,
      `Task: ${state.task_id}`,
      `Reviewer: ${input.reviewer}`,
      `Review ID: ${input.reviewId}`,
      `Review Run: ${input.runId}`,
      `Date: ${input.date}`,
      "",
      "Write the normal Kairon outbox JSON and include a top-level `review_result` object.",
      "Kairon will assign `review_id`, `task_id`, `run_id`, and `reviewer` from this request.",
      "",
      "Required `review_result` fields:",
      "- status: approved | changes_requested | commented",
      "- score.overall: number from 0 to 1",
      "- findings: array of { severity, file?, line?, body }",
      "- tests_passed: boolean",
      "- secret_scan_passed: boolean",
      "",
      "Do not modify source files during review execution.",
      ""
    ].join("\n");

    await writeTextFile(instructionPath, content);
    return toProjectPath(this.projectRoot, instructionPath);
  }

  private async writeIterationArtifact(
    state: ReviewLoopState,
    input: {
      reviewRunIds: string[];
      reviewResults: ReviewResult[];
      decision: QualityGateDecision;
      nextAction: ReviewNextAction;
    }
  ): Promise<string> {
    const artifactPath = resolveInside(
      getKaironPaths(this.projectRoot).kaironDir,
      "reviews",
      "loops",
      `${state.loop_id}-iteration-${state.iteration}.json`
    );
    await writeJsonFileAtomic(artifactPath, {
      schema_version: "0.1",
      loop_id: state.loop_id,
      iteration: state.iteration,
      status: state.status,
      review_run_ids: input.reviewRunIds,
      review_result_ids: input.reviewResults.map((result) => result.review_id),
      decision: input.decision,
      next_action: input.nextAction,
      created_at: this.now().toISOString()
    });
    return toProjectPath(this.projectRoot, artifactPath);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function formatReviewLoopExecutionResult(
  result: ReviewLoopExecutionResult
): string {
  return [
    "Kairon review loop executed.",
    `loop_id=${result.loop_id}`,
    `status=${result.status}`,
    `iteration=${result.iteration}`,
    `decision=${result.decision.status}`,
    `next_action=${result.next_action.action}`,
    `review_runs=${result.review_run_ids.join(",")}`,
    `review_results=${result.review_result_ids.join(",")}`,
    `iteration_artifact=${result.iteration_path}`,
    ...result.decision.reasons.map((reason) => `reason=${reason}`)
  ].join("\n");
}

function shouldRunReviews(state: ReviewLoopState): boolean {
  return (
    state.code_producing &&
    ["running", "changes_requested", "setup_required"].includes(state.status)
  );
}

function updateLoopState(
  state: ReviewLoopState,
  input: {
    reviewRunIds: string[];
    decision: QualityGateDecision;
    nextAction: ReviewNextAction;
    now: Date;
  }
): ReviewLoopState {
  const nextStatus: ReviewLoopState["status"] =
    input.nextAction.action === "approve"
      ? "approved"
      : input.nextAction.action === "setup_required"
        ? "setup_required"
      : input.nextAction.action === "escalate"
        ? "escalated"
        : input.nextAction.action === "request_fix"
          ? "changes_requested"
          : state.status;
  const nextIteration =
    input.nextAction.action === "request_fix" ? state.iteration + 1 : state.iteration;

  return {
    ...state,
    status: nextStatus,
    iteration: nextIteration,
    history: [
      ...state.history,
      ...input.reviewRunIds.map((runId) => ({
        run_id: runId,
        type: "review" as const
      }))
    ],
    updated_at: input.now.toISOString()
  };
}

function synthesizeReviewResult(
  state: ReviewLoopState,
  input: {
    reviewer: AgentId;
    reviewId: string;
    runId: string;
  },
  finding: ReviewFinding,
  now: Date
): ReviewResult {
  return {
    schema_version: "0.1",
    review_id: input.reviewId,
    task_id: state.task_id,
    run_id: input.runId,
    reviewer: input.reviewer,
    target: {},
    status: "changes_requested",
    score: { overall: 0 },
    findings: [finding],
    required_changes: [finding.body],
    tests_passed: false,
    secret_scan_passed: false,
    created_at: now.toISOString()
  };
}

async function nextUniqueRunId(
  projectRoot: string,
  allocatedRunIds: Set<string>
): Promise<string> {
  for (;;) {
    const runId = await nextId(projectRoot, "run");
    if (!allocatedRunIds.has(runId)) {
      return runId;
    }
  }
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
