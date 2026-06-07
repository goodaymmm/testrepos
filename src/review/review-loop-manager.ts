import path from "node:path";
import {
  loadReviewPolicy,
  evaluateQualityGate,
  parseReviewResult,
  type QualityGateDecision,
  type ReviewPolicy,
  type ReviewResult
} from "./quality-gate.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { WorkQueue } from "../queue/work-queue.js";
import { StateApplier } from "../state/state-applier.js";
import type { AgentId } from "../agents/types.js";
import type { ChangedFile } from "../git/diff-snapshot.js";

export type ReviewLoopRequest = {
  taskId: string;
  runId: string;
  implementer: AgentId;
  modelClass?: string;
  changedFiles?: Array<Pick<ChangedFile, "path" | "status">>;
  commitRequested?: boolean;
  codeProducing?: boolean;
  tags?: string[];
};

export type ReviewLoopState = {
  schema_version: string;
  loop_id: string;
  task_id: string;
  status:
    | "not_required"
    | "running"
    | "approved"
    | "changes_requested"
    | "setup_required"
    | "escalated";
  iteration: number;
  max_iterations: number;
  implementer: AgentId;
  reviewers: AgentId[];
  integration?: string;
  code_producing: boolean;
  history: Array<{
    run_id: string;
    type: "implementation" | "review" | "fix" | "escalation";
  }>;
  created_at: string;
  updated_at: string;
};

export type ReviewNextAction =
  | {
      action: "none";
      reason: string;
    }
  | {
      action: "request_review";
      reviewers: AgentId[];
      integration?: string;
    }
  | {
      action: "request_fix";
      queue_item_id: string;
      reasons: string[];
    }
  | {
      action: "setup_required";
      reviewers: AgentId[];
      reasons: string[];
    }
  | {
      action: "approve";
      review_ids: string[];
    }
  | {
      action: "escalate";
      approval_id: string;
      reasons: string[];
    };

export type ReviewFixRunStatus =
  | "completed"
  | "failed"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited"
  | "timeout"
  | "no_output";

export type ReviewFixRunUpdate = {
  state: ReviewLoopState;
  next_review_queue_item_id?: string;
};

const codePathPatterns = [
  /^src\//,
  /^tests?\//,
  /^scripts?\//,
  /^migrations?\//,
  /^schema\//,
  /^\.github\/workflows\//,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)vite\.config\./,
  /(^|\/)eslint\.config\./,
  /(^|\/)Dockerfile$/,
  /\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|php|py|rb|rs|sh|sql|swift|ts|tsx|yaml|yml)$/
];

const antigravityReviewSignals = [
  "google_ecosystem",
  "google",
  "gcp",
  "firebase",
  "multimodal",
  "large_context",
  "large-context"
];

export class ReviewLoopManager {
  constructor(private readonly projectRoot: string) {}

  async start(request: ReviewLoopRequest): Promise<ReviewLoopState> {
    const policy = await loadReviewPolicy(this.projectRoot);
    const codeProducing = isCodeProducingJob(request);
    const reviewers = selectReviewers(request, policy);
    const now = new Date().toISOString();
    const state: ReviewLoopState = {
      schema_version: "0.1",
      loop_id: await nextId(this.projectRoot, "review"),
      task_id: request.taskId,
      status: codeProducing && policy.required_for_code ? "running" : "not_required",
      iteration: codeProducing && policy.required_for_code ? 1 : 0,
      max_iterations: policy.max_iterations,
      implementer: request.implementer,
      reviewers,
      integration: selectReviewIntegration(request, policy),
      code_producing: codeProducing,
      history: [{ run_id: request.runId, type: "implementation" }],
      created_at: now,
      updated_at: now
    };

    await this.saveLoopState(state);
    return state;
  }

  async saveReviewResult(result: ReviewResult): Promise<ReviewResult> {
    const stored = {
      ...parseReviewResult(result),
      created_at: result.created_at ?? new Date().toISOString()
    };
    await writeJsonFileAtomic(
      resolveInside(
        getKaironPaths(this.projectRoot).kaironDir,
        "reviews",
        "results",
        `${stored.review_id}.json`
      ),
      stored
    );
    return stored;
  }

  async loadLoopState(loopId: string): Promise<ReviewLoopState> {
    return readJsonFile<ReviewLoopState>(
      resolveInside(
        getKaironPaths(this.projectRoot).kaironDir,
        "reviews",
        "loops",
        `${loopId}.json`
      )
    );
  }

  async evaluate(results: ReviewResult[]): Promise<QualityGateDecision> {
    const policy = await loadReviewPolicy(this.projectRoot);
    return evaluateQualityGate(policy, results);
  }

  async nextAction(
    state: ReviewLoopState,
    decision: QualityGateDecision
  ): Promise<ReviewNextAction> {
    if (!state.code_producing || state.status === "not_required") {
      return { action: "none", reason: "review is not required" };
    }

    if (decision.status === "passed") {
      return { action: "approve", review_ids: decision.review_ids };
    }

    if (state.iteration >= state.max_iterations) {
      return this.escalate(state, decision);
    }

    const item = await new WorkQueue(this.projectRoot).enqueue({
      type: "agent.run",
      task_id: state.task_id,
      priority: 80,
      payload: {
        purpose: "review_fix",
        review_loop_id: state.loop_id,
        iteration: state.iteration + 1,
        reasons: decision.reasons
      }
    });

    return {
      action: "request_fix",
      queue_item_id: item.id,
      reasons: decision.reasons
    };
  }

  async recordFixRun(request: {
    loopId: string;
    runId: string;
    status: ReviewFixRunStatus;
  }): Promise<ReviewFixRunUpdate> {
    const state = await this.loadLoopState(request.loopId);
    const now = new Date().toISOString();
    const history = state.history.some((entry) => entry.run_id === request.runId)
      ? state.history
      : [...state.history, { run_id: request.runId, type: "fix" as const }];

    if (request.status === "completed") {
      const nextState: ReviewLoopState = {
        ...state,
        status: "running",
        history,
        updated_at: now
      };
      await this.saveLoopState(nextState);
      const item = await new WorkQueue(this.projectRoot).enqueue({
        type: "review.run",
        task_id: nextState.task_id,
        priority: 80,
        payload: {
          loop_id: nextState.loop_id,
          purpose: "post_fix_review",
          fix_run_id: request.runId,
          iteration: nextState.iteration
        }
      });

      return {
        state: nextState,
        next_review_queue_item_id: item.id
      };
    }

    const nextState: ReviewLoopState = {
      ...state,
      status:
        request.status === "failed" ? "changes_requested" : "setup_required",
      history,
      updated_at: now
    };
    await this.saveLoopState(nextState);

    return { state: nextState };
  }

  private async escalate(
    state: ReviewLoopState,
    decision: QualityGateDecision
  ): Promise<ReviewNextAction> {
    const approvalId = await nextId(this.projectRoot, "approval");
    await new StateApplier(this.projectRoot).appendEvent({
      type: "approval.requested",
      task_id: state.task_id,
      actor: "review-loop-manager",
      payload: {
        approval: {
          id: approvalId,
          type: "review_escalation",
          title: `Escalated review for ${state.task_id}`,
          review_loop_id: state.loop_id,
          iteration: state.iteration,
          max_iterations: state.max_iterations,
          reasons: decision.reasons
        }
      }
    });

    return {
      action: "escalate",
      approval_id: approvalId,
      reasons: decision.reasons
    };
  }

  async saveLoopState(state: ReviewLoopState): Promise<void> {
    await writeJsonFileAtomic(
      resolveInside(
        getKaironPaths(this.projectRoot).kaironDir,
        "reviews",
        "loops",
        `${state.loop_id}.json`
      ),
      state
    );
  }
}

export function isCodeProducingJob(request: ReviewLoopRequest): boolean {
  if (request.codeProducing !== undefined) {
    return request.codeProducing;
  }

  if (request.commitRequested) {
    return true;
  }

  return (request.changedFiles ?? []).some((file) =>
    codePathPatterns.some((pattern) => pattern.test(toPosix(file.path)))
  );
}

export function selectReviewers(
  request: ReviewLoopRequest,
  policy: ReviewPolicy
): AgentId[] {
  const reviewers: AgentId[] =
    request.implementer === "claude" && request.modelClass === "opus"
      ? ["codex"]
      : request.implementer === "codex"
        ? ["claude"]
        : request.implementer === "gemini"
          ? ["codex", "claude"]
          : toAgentIds(policy.recommended_reviewers);

  if (shouldIncludeAntigravity(request) && !reviewers.includes("gemini")) {
    reviewers.push("gemini");
  }

  return reviewers;
}

function selectReviewIntegration(
  request: ReviewLoopRequest,
  policy: ReviewPolicy
): string | undefined {
  if (request.implementer === "claude" && request.modelClass === "opus") {
    return policy.claude_opus_review_path ?? "codex-plugin-cc";
  }

  return undefined;
}

function shouldIncludeAntigravity(request: ReviewLoopRequest): boolean {
  return (request.tags ?? []).some((tag) =>
    antigravityReviewSignals.includes(tag.toLowerCase())
  );
}

function toAgentIds(values: string[]): AgentId[] {
  return values.filter((value): value is AgentId =>
    ["codex", "claude", "gemini"].includes(value)
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
