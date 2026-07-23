import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import {
  assertResourceLockFencingToken,
  withResourceLock
} from "../core/fs/resource-lock.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  getKaironPaths,
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";
import type {
  SessionContextManifest,
  SessionMetadata
} from "./session-host.js";
import {
  createSessionHandoffSummary,
  renderSessionHandoffSummary,
  type SessionHandoffSummary
} from "./session-handoff.js";
import type { AgentId } from "./types.js";

export type SessionBudgetSource =
  | "unavailable"
  | "kairon_estimated"
  | "provider_observed"
  | "mixed";

export type SessionBudgetStatus =
  | "within_limit"
  | "soft_limit"
  | "hard_limit"
  | "compacting"
  | "rotating";

export type SessionBudgetMetricName =
  | "prompt_bytes"
  | "job_count"
  | "elapsed_seconds"
  | "compaction_count";

export type SessionBudgetThreshold = Record<SessionBudgetMetricName, number>;

export type SessionBudgetConfig = {
  enabled: boolean;
  soft_limit: SessionBudgetThreshold;
  hard_limit: SessionBudgetThreshold;
  compaction_keep_runs: number;
  resource_lock_ttl_seconds: number;
};

export type SessionBudgetEvaluation = {
  status: "within_limit" | "soft_limit" | "hard_limit";
  reasons: string[];
};

export type SessionBudgetReport = {
  schema_version: "0.1";
  date: string;
  agent: AgentId;
  session_id: string;
  status: SessionBudgetStatus;
  dispatch_allowed: boolean;
  prompt_bytes: number;
  job_count: number;
  elapsed_seconds: number;
  compaction_count: number;
  rotation_count: number;
  budget_source: SessionBudgetSource;
  reasons: string[];
  active_compaction_plan_id: string | null;
  thresholds: {
    soft_limit: SessionBudgetThreshold;
    hard_limit: SessionBudgetThreshold;
  };
  updated_at: string;
};

export type SessionCompactionPlanStatus =
  | "planned"
  | "compacting"
  | "completed"
  | "rejected_stale"
  | "failed";

export type SessionCompactionPlan = {
  schema_version: "0.1";
  kind: "session_compaction_plan";
  plan_id: string;
  date: string;
  agent: AgentId;
  session_id: string;
  status: SessionCompactionPlanStatus;
  trigger: "manual" | "soft_limit" | "hard_limit";
  source_hash: string;
  metrics: {
    prompt_bytes: number;
    job_count: number;
    elapsed_seconds: number;
    compaction_count: number;
    budget_source: SessionBudgetSource;
  };
  summary: SessionHandoffSummary;
  keep_runs: number;
  drop_run_count: number;
  handoff_json_path: string;
  handoff_markdown_path: string;
  created_at: string;
  updated_at: string;
  operation_pid?: number;
  completed_at?: string;
  failure_reason?: string;
};

export type SessionRotationArtifact = {
  schema_version: "0.1";
  kind: "session_rotation";
  rotation_id: string;
  date: string;
  agent: AgentId;
  status: "rotating" | "completed" | "recovered_old_active" | "failed";
  operator_reason: string;
  previous_session_id: string;
  new_session_id: string;
  previous_budget: {
    prompt_bytes: number;
    job_count: number;
    elapsed_seconds: number;
    compaction_count: number;
    budget_source: SessionBudgetSource;
  };
  handoff: SessionHandoffSummary;
  handoff_json_path: string;
  handoff_markdown_path: string;
  created_at: string;
  updated_at: string;
  operation_pid?: number;
  completed_at?: string;
  failure_reason?: string;
};

type AgentsBudgetConfig = {
  session_budget?: Partial<SessionBudgetConfig> & {
    soft_limit?: Partial<SessionBudgetThreshold>;
    hard_limit?: Partial<SessionBudgetThreshold>;
  };
};

const defaultSessionBudgetConfig: SessionBudgetConfig = {
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
};

export class SessionBudgetDispatchBlockedError extends Error {
  constructor(
    readonly agent: AgentId,
    readonly date: string,
    readonly status: SessionBudgetStatus,
    readonly reasons: string[]
  ) {
    super(
      `Agent session dispatch is blocked by context budget: ${agent}/${date} status=${status}`
    );
    this.name = "SessionBudgetDispatchBlockedError";
  }
}

export async function loadSessionBudgetConfig(
  projectRoot: string
): Promise<SessionBudgetConfig> {
  const config = await loadConfigFile<AgentsBudgetConfig>(
    projectRoot,
    "agents.json"
  );
  const configured = config.session_budget;
  return {
    enabled: configured?.enabled ?? defaultSessionBudgetConfig.enabled,
    soft_limit: mergeThreshold(
      defaultSessionBudgetConfig.soft_limit,
      configured?.soft_limit
    ),
    hard_limit: mergeThreshold(
      defaultSessionBudgetConfig.hard_limit,
      configured?.hard_limit
    ),
    compaction_keep_runs:
      configured?.compaction_keep_runs ??
      defaultSessionBudgetConfig.compaction_keep_runs,
    resource_lock_ttl_seconds:
      configured?.resource_lock_ttl_seconds ??
      defaultSessionBudgetConfig.resource_lock_ttl_seconds
  };
}

export function evaluateSessionBudget(
  metrics: Pick<
    SessionMetadata,
    "prompt_bytes" | "job_count" | "elapsed_seconds" | "compaction_count"
  >,
  config: SessionBudgetConfig
): SessionBudgetEvaluation {
  if (!config.enabled) {
    return { status: "within_limit", reasons: [] };
  }

  const hardReasons = thresholdReasons(metrics, config.hard_limit, "hard");
  if (hardReasons.length > 0) {
    return { status: "hard_limit", reasons: hardReasons };
  }

  const softReasons = thresholdReasons(metrics, config.soft_limit, "soft");
  return softReasons.length === 0
    ? { status: "within_limit", reasons: [] }
    : { status: "soft_limit", reasons: softReasons };
}

export function normalizeSessionBudgetMetadata(
  metadata: SessionMetadata,
  now: Date,
  config: SessionBudgetConfig = defaultSessionBudgetConfig
): SessionMetadata {
  const budgetStartedAt =
    metadata.budget_started_at ?? metadata.created_at ?? now.toISOString();
  const elapsedSeconds = Math.max(
    metadata.elapsed_seconds ?? 0,
    secondsBetween(budgetStartedAt, now)
  );
  const normalized: SessionMetadata = {
    ...metadata,
    prompt_bytes: nonnegative(metadata.prompt_bytes),
    job_count: nonnegative(metadata.job_count),
    elapsed_seconds: elapsedSeconds,
    compaction_count: nonnegative(metadata.compaction_count),
    rotation_count: nonnegative(metadata.rotation_count),
    budget_source: metadata.budget_source ?? "unavailable",
    budget_started_at: budgetStartedAt,
    budget_reasons: metadata.budget_reasons ?? [],
    active_compaction_plan_id: metadata.active_compaction_plan_id ?? null,
    budget_updated_at: now.toISOString()
  };
  const evaluation = evaluateSessionBudget(normalized, config);
  const preserveTransient =
    metadata.budget_status === "compacting" ||
    metadata.budget_status === "rotating" ||
    metadata.budget_status === "hard_limit";
  return {
    ...normalized,
    budget_status: preserveTransient
      ? metadata.budget_status
      : evaluation.status,
    budget_reasons: preserveTransient
      ? normalized.budget_reasons
      : evaluation.reasons
  };
}

export function isSessionBudgetDispatchBlocked(
  metadata: Pick<SessionMetadata, "budget_status">
): boolean {
  return (
    metadata.budget_status === "hard_limit" ||
    metadata.budget_status === "compacting" ||
    metadata.budget_status === "rotating"
  );
}

export async function reconcileSessionBudgetState(
  projectRoot: string,
  metadata: SessionMetadata,
  now: Date
): Promise<SessionMetadata> {
  const config = await loadSessionBudgetConfig(projectRoot);
  let next = normalizeSessionBudgetMetadata(metadata, now, config);
  const rotation = await latestIncompleteRotation(
    projectRoot,
    metadata.agent,
    metadata.date
  );

  if (rotation !== null) {
    if (isOperationProcessAlive(rotation.operation_pid)) {
      return {
        ...next,
        budget_status: "rotating",
        budget_reasons: ["rotation_in_progress"],
        budget_updated_at: now.toISOString()
      };
    }
    await repairRotatedSessionReferences(
      projectRoot,
      next,
      next.session_id,
      rotation
    );
    if (next.session_id === rotation.new_session_id) {
      await writeJsonFileAtomic(rotationPath(projectRoot, rotation), {
        ...rotation,
        status: "completed",
        completed_at: now.toISOString(),
        updated_at: now.toISOString()
      } satisfies SessionRotationArtifact);
    } else {
      await writeJsonFileAtomic(rotationPath(projectRoot, rotation), {
        ...rotation,
        status: "recovered_old_active",
        updated_at: now.toISOString(),
        failure_reason: "canonical session remained on the previous session id"
      } satisfies SessionRotationArtifact);
      if (next.budget_status === "rotating") {
        const evaluation = evaluateSessionBudget(next, config);
        next = {
          ...next,
          budget_status: evaluation.status,
          budget_reasons: evaluation.reasons,
          budget_updated_at: now.toISOString()
        };
      }
    }
  }

  if (next.budget_status === "compacting") {
    const plan =
      next.active_compaction_plan_id === null ||
      next.active_compaction_plan_id === undefined
        ? null
        : await readCompactionPlanIfExists(
            projectRoot,
            next.agent,
            next.date,
            next.active_compaction_plan_id
          );
    if (plan === null || plan.status !== "compacting") {
      const evaluation = evaluateSessionBudget(next, config);
      next = {
        ...next,
        budget_status: evaluation.status,
        budget_reasons: evaluation.reasons,
        active_compaction_plan_id: null,
        budget_updated_at: now.toISOString()
      };
    } else if (!isOperationProcessAlive(plan.operation_pid)) {
      await writeJsonFileAtomic(
        compactionPlanPath(projectRoot, next.agent, next.date, plan.plan_id),
        {
          ...plan,
          status: "failed",
          failure_reason: "compaction_process_interrupted",
          updated_at: now.toISOString()
        } satisfies SessionCompactionPlan
      );
      const evaluation = evaluateSessionBudget(next, config);
      next = {
        ...next,
        budget_status: evaluation.status,
        budget_reasons: evaluation.reasons,
        active_compaction_plan_id: null,
        budget_updated_at: now.toISOString()
      };
    }
  }

  return next;
}

export async function assertSessionBudgetDispatchAllowed(
  projectRoot: string,
  agent: AgentId,
  date: string,
  now: Date
): Promise<SessionBudgetReport> {
  const metadata = await readSessionMetadata(projectRoot, agent, date);
  const reconciled = await reconcileSessionBudgetState(projectRoot, metadata, now);
  if (isSessionBudgetDispatchBlocked(reconciled)) {
    throw new SessionBudgetDispatchBlockedError(
      agent,
      date,
      reconciled.budget_status ?? "hard_limit",
      reconciled.budget_reasons ?? []
    );
  }
  return budgetReport(
    reconciled,
    await loadSessionBudgetConfig(projectRoot),
    now
  );
}

export async function recordSessionPromptBudget(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    promptBytes: number;
    jobIncrement: number;
    providerPromptBytes?: number;
    now: Date;
  }
): Promise<SessionBudgetReport> {
  const sessionPath = sessionMetadataPath(projectRoot, input.agent, input.date);
  return withResourceLock(
    projectRoot,
    sessionPath,
    {
      owner: "session-budget-observer",
      now: input.now,
      ttlMs:
        (await loadSessionBudgetConfig(projectRoot)).resource_lock_ttl_seconds *
        1_000
    },
    async (lock) => {
      const config = await loadSessionBudgetConfig(projectRoot);
      const current = await readSessionMetadata(
        projectRoot,
        input.agent,
        input.date
      );
      const normalized = await reconcileSessionBudgetState(
        projectRoot,
        current,
        input.now
      );
      if (isSessionBudgetDispatchBlocked(normalized)) {
        throw new SessionBudgetDispatchBlockedError(
          input.agent,
          input.date,
          normalized.budget_status ?? "hard_limit",
          normalized.budget_reasons ?? []
        );
      }

      const observedBytes =
        input.providerPromptBytes === undefined
          ? input.promptBytes
          : input.providerPromptBytes;
      const source = nextBudgetSource(
        normalized.budget_source ?? "unavailable",
        input.providerPromptBytes === undefined
          ? "kairon_estimated"
          : "provider_observed"
      );
      let updated: SessionMetadata = {
        ...normalized,
        prompt_bytes: nonnegative(normalized.prompt_bytes) + observedBytes,
        job_count:
          nonnegative(normalized.job_count) + nonnegative(input.jobIncrement),
        budget_source: source,
        elapsed_seconds: secondsBetween(
          normalized.budget_started_at ?? normalized.created_at,
          input.now
        ),
        budget_updated_at: input.now.toISOString()
      };
      const evaluation = evaluateSessionBudget(updated, config);
      updated = {
        ...updated,
        budget_status: evaluation.status,
        budget_reasons: evaluation.reasons
      };

      if (
        evaluation.status !== "within_limit" &&
        input.jobIncrement > 0 &&
        updated.active_run_id === null &&
        updated.active_compaction_plan_id === null
      ) {
        const plan = await buildCompactionPlan(projectRoot, updated, {
          trigger:
            evaluation.status === "hard_limit" ? "hard_limit" : "soft_limit",
          config,
          now: input.now
        });
        await writeJsonFileAtomic(
          compactionPlanPath(
            projectRoot,
            updated.agent,
            updated.date,
            plan.plan_id
          ),
          plan
        );
        updated = {
          ...updated,
          active_compaction_plan_id: plan.plan_id
        };
      }

      await assertResourceLockFencingToken(lock, { now: input.now });
      await writeJsonFileAtomic(sessionPath, updated);
      return budgetReport(updated, config, input.now);
    }
  );
}

export async function ensureSessionBudgetCompactionPlan(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    now: Date;
  }
): Promise<SessionCompactionPlan | null> {
  const sessionPath = sessionMetadataPath(projectRoot, input.agent, input.date);
  const config = await loadSessionBudgetConfig(projectRoot);
  return withResourceLock(
    projectRoot,
    sessionPath,
    {
      owner: "session-budget-planner",
      now: input.now,
      ttlMs: config.resource_lock_ttl_seconds * 1_000
    },
    async (lock) => {
      const current = await readSessionMetadata(
        projectRoot,
        input.agent,
        input.date
      );
      const metadata = await reconcileSessionBudgetState(
        projectRoot,
        current,
        input.now
      );
      if (
        metadata.active_run_id !== null ||
        metadata.budget_status === "within_limit" ||
        metadata.budget_status === "compacting" ||
        metadata.budget_status === "rotating"
      ) {
        return null;
      }

      const activePlanId = metadata.active_compaction_plan_id;
      if (activePlanId !== null && activePlanId !== undefined) {
        return readCompactionPlanIfExists(
          projectRoot,
          input.agent,
          input.date,
          activePlanId
        );
      }

      const plan = await buildCompactionPlan(projectRoot, metadata, {
        trigger:
          metadata.budget_status === "hard_limit"
            ? "hard_limit"
            : "soft_limit",
        config,
        now: input.now
      });
      await assertResourceLockFencingToken(lock, { now: input.now });
      await writeJsonFileAtomic(
        compactionPlanPath(
          projectRoot,
          input.agent,
          input.date,
          plan.plan_id
        ),
        plan
      );
      await writeJsonFileAtomic(sessionPath, {
        ...metadata,
        active_compaction_plan_id: plan.plan_id,
        budget_updated_at: input.now.toISOString()
      } satisfies SessionMetadata);
      return plan;
    }
  );
}

export async function getSessionBudgetReport(
  projectRoot: string,
  agent: AgentId,
  date: string,
  now = new Date()
): Promise<SessionBudgetReport> {
  const config = await loadSessionBudgetConfig(projectRoot);
  const metadata = await readSessionMetadata(projectRoot, agent, date);
  return budgetReport(
    await reconcileSessionBudgetState(projectRoot, metadata, now),
    config,
    now
  );
}

export async function planSessionCompaction(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    now?: Date;
  }
): Promise<SessionCompactionPlan> {
  const now = input.now ?? new Date();
  const config = await loadSessionBudgetConfig(projectRoot);
  const sessionPath = sessionMetadataPath(projectRoot, input.agent, input.date);
  return withResourceLock(
    projectRoot,
    sessionPath,
    {
      owner: "session-compaction-planner",
      now,
      ttlMs: config.resource_lock_ttl_seconds * 1_000
    },
    async (lock) => {
      const current = await readSessionMetadata(
        projectRoot,
        input.agent,
        input.date
      );
      const metadata = await reconcileSessionBudgetState(
        projectRoot,
        current,
        now
      );
      if (metadata.active_run_id !== null) {
        throw new Error(
          `Cannot compact a busy session: ${input.agent}/${input.date}`
        );
      }
      const plan = await buildCompactionPlan(projectRoot, metadata, {
        trigger: "manual",
        config,
        now
      });
      await assertResourceLockFencingToken(lock, { now });
      await mkdir(path.dirname(compactionPlanPath(
        projectRoot,
        input.agent,
        input.date,
        plan.plan_id
      )), { recursive: true });
      await writeJsonFileAtomic(
        compactionPlanPath(
          projectRoot,
          input.agent,
          input.date,
          plan.plan_id
        ),
        plan
      );
      await writeJsonFileAtomic(sessionPath, {
        ...metadata,
        active_compaction_plan_id: plan.plan_id,
        budget_updated_at: now.toISOString()
      } satisfies SessionMetadata);
      return plan;
    }
  );
}

export async function confirmSessionCompaction(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    planId: string;
    now?: Date;
  }
): Promise<SessionCompactionPlan> {
  assertPlanId(input.planId);
  const now = input.now ?? new Date();
  const config = await loadSessionBudgetConfig(projectRoot);
  const planPath = compactionPlanPath(
    projectRoot,
    input.agent,
    input.date,
    input.planId
  );
  const sessionPath = sessionMetadataPath(projectRoot, input.agent, input.date);
  return withResourceLock(
    projectRoot,
    sessionPath,
    {
      owner: "session-compaction-executor",
      now,
      ttlMs: config.resource_lock_ttl_seconds * 1_000
    },
    async (lock) => {
      let plan = await readJsonFile<SessionCompactionPlan>(planPath);
      if (
        plan.plan_id !== input.planId ||
        plan.agent !== input.agent ||
        plan.date !== input.date
      ) {
        throw new Error("Session compaction confirmation does not match the plan.");
      }
      if (plan.status === "completed") {
        return plan;
      }
      if (plan.status !== "planned") {
        throw new Error(`Session compaction plan is not executable: ${plan.status}`);
      }

      const current = await readSessionMetadata(
        projectRoot,
        input.agent,
        input.date
      );
      const metadata = await reconcileSessionBudgetState(
        projectRoot,
        current,
        now
      );
      if (metadata.active_run_id !== null) {
        throw new Error(
          `Cannot compact a busy session: ${input.agent}/${input.date}`
        );
      }
      const sourceHash = await sessionBudgetSourceHash(projectRoot, metadata);
      if (
        metadata.session_id !== plan.session_id ||
        sourceHash !== plan.source_hash
      ) {
        plan = {
          ...plan,
          status: "rejected_stale",
          failure_reason: "session source changed after dry-run",
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(planPath, plan);
        throw new Error("Session compaction plan is stale; run --dry-run again.");
      }

      plan = {
        ...plan,
        status: "compacting",
        operation_pid: process.pid,
        updated_at: now.toISOString()
      };
      await writeJsonFileAtomic(planPath, plan);
      await writeJsonFileAtomic(sessionPath, {
        ...metadata,
        budget_status: "compacting",
        active_compaction_plan_id: plan.plan_id,
        budget_updated_at: now.toISOString()
      } satisfies SessionMetadata);

      try {
        await writeHandoffArtifacts(
          projectRoot,
          plan.handoff_json_path,
          plan.handoff_markdown_path,
          plan.summary
        );
        const manifest = await readSessionManifest(
          projectRoot,
          input.agent,
          input.date,
          metadata
        );
        const keptRuns = manifest.runs.slice(-plan.keep_runs);
        await assertResourceLockFencingToken(lock, { now });
        await writeJsonFileAtomic(
          sessionManifestPath(projectRoot, input.agent, input.date),
          {
            ...manifest,
            session_id: metadata.session_id,
            latest_context_path: plan.handoff_markdown_path,
            runs: keptRuns,
            updated_at: now.toISOString()
          } satisfies SessionContextManifest
        );

        const summaryBytes = Buffer.byteLength(
          renderSessionHandoffSummary(plan.summary),
          "utf8"
        );
        let updated: SessionMetadata = {
          ...metadata,
          prompt_bytes: summaryBytes,
          job_count: 0,
          elapsed_seconds: 0,
          compaction_count: nonnegative(metadata.compaction_count) + 1,
          budget_source: "kairon_estimated",
          budget_started_at: now.toISOString(),
          active_compaction_plan_id: null,
          budget_updated_at: now.toISOString()
        };
        const evaluation = evaluateSessionBudget(updated, config);
        updated = {
          ...updated,
          budget_status: evaluation.status,
          budget_reasons: evaluation.reasons
        };
        await writeJsonFileAtomic(sessionPath, updated);
        plan = {
          ...plan,
          status: "completed",
          completed_at: now.toISOString(),
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(planPath, plan);
        return plan;
      } catch (error) {
        const failureReason = sanitizeFailure(error);
        plan = {
          ...plan,
          status: "failed",
          failure_reason: failureReason,
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(planPath, plan);
        const evaluation = evaluateSessionBudget(metadata, config);
        await writeJsonFileAtomic(sessionPath, {
          ...metadata,
          budget_status: evaluation.status,
          budget_reasons: evaluation.reasons,
          active_compaction_plan_id: null,
          budget_updated_at: now.toISOString()
        } satisfies SessionMetadata);
        throw error;
      }
    }
  );
}

export async function rotateSessionBudget(
  projectRoot: string,
  input: {
    agent: AgentId;
    date: string;
    reason: string;
    now?: Date;
  }
): Promise<SessionRotationArtifact> {
  const now = input.now ?? new Date();
  const reason = sanitizeOperatorReason(input.reason);
  const config = await loadSessionBudgetConfig(projectRoot);
  const sessionPath = sessionMetadataPath(projectRoot, input.agent, input.date);
  return withResourceLock(
    projectRoot,
    sessionPath,
    {
      owner: "session-budget-rotation",
      now,
      ttlMs: config.resource_lock_ttl_seconds * 1_000
    },
    async (lock) => {
      const current = await readSessionMetadata(
        projectRoot,
        input.agent,
        input.date
      );
      const metadata = await reconcileSessionBudgetState(
        projectRoot,
        current,
        now
      );
      if (metadata.active_run_id !== null) {
        throw new Error(
          `Cannot rotate a busy session: ${input.agent}/${input.date}`
        );
      }

      const rotationCount = nonnegative(metadata.rotation_count) + 1;
      const newSessionId = `SESSION-${input.date}-${input.agent}-R${rotationCount}`;
      const handoff = await buildSessionSummary(
        projectRoot,
        metadata,
        "budget_rotation",
        now
      );
      const rotationId = createOperationId("ROT", now, handoff.source_hash);
      const handoffJsonPath = toArtifactPath(
        projectRoot,
        resolveInside(
          sessionDirectory(projectRoot, input.agent, input.date),
          "rotations",
          `${rotationId}-handoff.json`
        )
      );
      const handoffMarkdownPath = handoffJsonPath.replace(/\.json$/, ".md");
      let artifact: SessionRotationArtifact = {
        schema_version: "0.1",
        kind: "session_rotation",
        rotation_id: rotationId,
        date: input.date,
        agent: input.agent,
        status: "rotating",
        operator_reason: reason,
        previous_session_id: metadata.session_id,
        new_session_id: newSessionId,
        previous_budget: metricsFromMetadata(metadata),
        handoff,
        handoff_json_path: handoffJsonPath,
        handoff_markdown_path: handoffMarkdownPath,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        operation_pid: process.pid
      };
      const artifactPath = rotationArtifactPath(
        projectRoot,
        input.agent,
        input.date,
        rotationId
      );
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeJsonFileAtomic(artifactPath, artifact);
      await writeJsonFileAtomic(sessionPath, {
        ...metadata,
        budget_status: "rotating",
        budget_updated_at: now.toISOString()
      } satisfies SessionMetadata);

      try {
        await writeHandoffArtifacts(
          projectRoot,
          handoffJsonPath,
          handoffMarkdownPath,
          handoff
        );
        await assertResourceLockFencingToken(lock, { now });
        const next: SessionMetadata = {
          ...metadata,
          session_id: newSessionId,
          status: metadata.command_available ? "ready" : "setup_required",
          native: {
            ...metadata.native,
            resume_id: null,
            thread_id: null
          },
          active_run_id: null,
          last_run_id: null,
          last_task_id: null,
          last_persona: null,
          last_context_path: handoffMarkdownPath,
          last_prompt_path: null,
          last_stdout_log: null,
          last_stderr_log: null,
          last_runner_metadata_path: null,
          last_status: null,
          pause: null,
          terminal_id: `TERM-${input.agent}-${input.date.replaceAll("-", "")}-R${rotationCount}`,
          prompt_bytes: 0,
          job_count: 0,
          elapsed_seconds: 0,
          compaction_count: 0,
          rotation_count: rotationCount,
          budget_source: "unavailable",
          budget_status: "within_limit",
          budget_reasons: [],
          budget_started_at: now.toISOString(),
          budget_updated_at: now.toISOString(),
          active_compaction_plan_id: null,
          rotation_handoff_path: handoffMarkdownPath,
          created_at: now.toISOString(),
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(sessionPath, next);
        await writeJsonFileAtomic(
          sessionManifestPath(projectRoot, input.agent, input.date),
          {
            schema_version: "0.1",
            kind: "session_context_manifest",
            session_id: newSessionId,
            date: input.date,
            agent: input.agent,
            scratch: metadata.scratch,
            latest_context_path: handoffMarkdownPath,
            runs: [],
            updated_at: now.toISOString()
          } satisfies SessionContextManifest
        );
        await updateHealthSessionId(
          projectRoot,
          input.agent,
          input.date,
          newSessionId
        );
        artifact = {
          ...artifact,
          status: "completed",
          completed_at: now.toISOString(),
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(artifactPath, artifact);
        return artifact;
      } catch (error) {
        const currentSession = await readSessionMetadata(
          projectRoot,
          input.agent,
          input.date
        );
        const completed = currentSession.session_id === newSessionId;
        artifact = {
          ...artifact,
          status: completed ? "rotating" : "failed",
          failure_reason: sanitizeFailure(error),
          updated_at: now.toISOString()
        };
        await writeJsonFileAtomic(artifactPath, artifact);
        if (!completed) {
          const evaluation = evaluateSessionBudget(metadata, config);
          await writeJsonFileAtomic(sessionPath, {
            ...metadata,
            budget_status: evaluation.status,
            budget_reasons: evaluation.reasons,
            budget_updated_at: now.toISOString()
          } satisfies SessionMetadata);
        }
        throw error;
      }
    }
  );
}

export function formatSessionBudgetReport(report: SessionBudgetReport): string {
  return [
    "Kairon agent session budget.",
    `date=${report.date}`,
    `agent=${report.agent}`,
    `session_id=${report.session_id}`,
    `status=${report.status}`,
    `dispatch_allowed=${report.dispatch_allowed}`,
    `prompt_bytes=${report.prompt_bytes}`,
    `job_count=${report.job_count}`,
    `elapsed_seconds=${report.elapsed_seconds}`,
    `compaction_count=${report.compaction_count}`,
    `rotation_count=${report.rotation_count}`,
    `budget_source=${report.budget_source}`,
    `reasons=${report.reasons.join(",")}`,
    `active_compaction_plan_id=${report.active_compaction_plan_id ?? ""}`,
    `soft_limit=${formatThreshold(report.thresholds.soft_limit)}`,
    `hard_limit=${formatThreshold(report.thresholds.hard_limit)}`
  ].join("\n");
}

export function formatSessionCompactionPlan(plan: SessionCompactionPlan): string {
  return [
    "Kairon agent session compaction.",
    `plan_id=${plan.plan_id}`,
    `date=${plan.date}`,
    `agent=${plan.agent}`,
    `session_id=${plan.session_id}`,
    `status=${plan.status}`,
    `trigger=${plan.trigger}`,
    `source_hash=${plan.source_hash}`,
    `keep_runs=${plan.keep_runs}`,
    `drop_run_count=${plan.drop_run_count}`,
    `handoff=${plan.handoff_markdown_path}`,
    `plan_path=.kairon/sessions/${plan.date}/${plan.agent}/compactions/${plan.plan_id}.json`
  ].join("\n");
}

export function formatSessionRotation(
  artifact: SessionRotationArtifact
): string {
  return [
    "Kairon agent session rotated.",
    `rotation_id=${artifact.rotation_id}`,
    `date=${artifact.date}`,
    `agent=${artifact.agent}`,
    `status=${artifact.status}`,
    `previous_session_id=${artifact.previous_session_id}`,
    `new_session_id=${artifact.new_session_id}`,
    `handoff=${artifact.handoff_markdown_path}`
  ].join("\n");
}

async function buildCompactionPlan(
  projectRoot: string,
  metadata: SessionMetadata,
  input: {
    trigger: SessionCompactionPlan["trigger"];
    config: SessionBudgetConfig;
    now: Date;
  }
): Promise<SessionCompactionPlan> {
  const sourceHash = await sessionBudgetSourceHash(projectRoot, metadata);
  const planId = createOperationId("CMP", input.now, sourceHash);
  const summary = await buildSessionSummary(
    projectRoot,
    metadata,
    "budget_compaction",
    input.now
  );
  const manifest = await readSessionManifest(
    projectRoot,
    metadata.agent,
    metadata.date,
    metadata
  );
  const handoffJsonPath = toArtifactPath(
    projectRoot,
    resolveInside(
      sessionDirectory(projectRoot, metadata.agent, metadata.date),
      "compactions",
      `${planId}-handoff.json`
    )
  );
  return {
    schema_version: "0.1",
    kind: "session_compaction_plan",
    plan_id: planId,
    date: metadata.date,
    agent: metadata.agent,
    session_id: metadata.session_id,
    status: "planned",
    trigger: input.trigger,
    source_hash: sourceHash,
    metrics: metricsFromMetadata(metadata),
    summary,
    keep_runs: input.config.compaction_keep_runs,
    drop_run_count: Math.max(
      0,
      manifest.runs.length - input.config.compaction_keep_runs
    ),
    handoff_json_path: handoffJsonPath,
    handoff_markdown_path: handoffJsonPath.replace(/\.json$/, ".md"),
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString()
  };
}

async function buildSessionSummary(
  projectRoot: string,
  metadata: SessionMetadata,
  reason: "budget_compaction" | "budget_rotation",
  now: Date
): Promise<SessionHandoffSummary> {
  const objective = await readTaskObjective(projectRoot, metadata.last_task_id);
  const unfinishedWork = [
    ...(metadata.active_run_id === null
      ? []
      : [`run ${metadata.active_run_id} remains active`]),
    ...(metadata.last_task_id === null || metadata.last_task_id === undefined
      ? []
      : metadata.last_status === "completed"
        ? []
        : [`task ${metadata.last_task_id} last_status=${metadata.last_status ?? "unknown"}`])
  ];
  const decisions =
    metadata.last_run_id === null
      ? []
      : [
          {
            kind: "run_status" as const,
            reference: metadata.last_run_id,
            status: metadata.last_status ?? "unknown"
          }
        ];
  const artifactReferences = [
    metadata.last_context_path,
    metadata.last_prompt_path,
    metadata.last_runner_metadata_path,
    metadata.session_context_manifest,
    metadata.health_path
  ].filter((value): value is string => value !== undefined && value !== null);

  return createSessionHandoffSummary({
    reason,
    objective,
    unfinishedWork,
    decisions,
    artifactReferences,
    createdAt: now
  });
}

async function sessionBudgetSourceHash(
  projectRoot: string,
  metadata: SessionMetadata
): Promise<string> {
  const manifest = await readSessionManifest(
    projectRoot,
    metadata.agent,
    metadata.date,
    metadata
  );
  const source = {
    session_id: metadata.session_id,
    active_run_id: metadata.active_run_id,
    last_run_id: metadata.last_run_id,
    last_task_id: metadata.last_task_id,
    last_status: metadata.last_status,
    prompt_bytes: nonnegative(metadata.prompt_bytes),
    job_count: nonnegative(metadata.job_count),
    compaction_count: nonnegative(metadata.compaction_count),
    runs: manifest.runs.map((run) => ({
      kind: run.kind,
      run_id: run.run_id,
      task_id: run.task_id,
      status: run.status,
      context_path: run.context_path,
      runner_metadata_path: run.runner_metadata_path
    }))
  };
  return sha256(JSON.stringify(source));
}

async function readSessionManifest(
  projectRoot: string,
  agent: AgentId,
  date: string,
  metadata: SessionMetadata
): Promise<SessionContextManifest> {
  try {
    return await readJsonFile<SessionContextManifest>(
      sessionManifestPath(projectRoot, agent, date)
    );
  } catch (error) {
    if (!String(error).includes("ENOENT")) {
      throw error;
    }
    return {
      schema_version: "0.1",
      kind: "session_context_manifest",
      session_id: metadata.session_id,
      date,
      agent,
      scratch: metadata.scratch,
      latest_context_path: metadata.last_context_path ?? null,
      runs: [],
      updated_at: metadata.updated_at
    };
  }
}

async function writeHandoffArtifacts(
  projectRoot: string,
  jsonArtifactPath: string,
  markdownArtifactPath: string,
  summary: SessionHandoffSummary
): Promise<void> {
  const jsonPath = resolveInside(projectRoot, jsonArtifactPath);
  const markdownPath = resolveInside(projectRoot, markdownArtifactPath);
  const sessionDir = path.dirname(path.dirname(jsonPath));
  const activeJsonPath = resolveInside(sessionDir, "active-handoff.json");
  const activeMarkdownPath = resolveInside(sessionDir, "active-handoff.md");
  const markdown = renderSessionHandoffSummary(summary);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeJsonFileAtomic(jsonPath, summary);
  await writeFile(markdownPath, markdown, "utf8");
  await writeJsonFileAtomic(activeJsonPath, summary);
  await writeFile(activeMarkdownPath, markdown, "utf8");
}

async function readTaskObjective(
  projectRoot: string,
  taskId: string | null | undefined
): Promise<string | null> {
  if (taskId === null || taskId === undefined) {
    return null;
  }
  try {
    const task = await readJsonFile<Record<string, unknown>>(
      resolveInside(getKaironPaths(projectRoot).tasksDir, taskId, "task.json")
    );
    const title = typeof task.title === "string" ? task.title.trim() : "";
    return title.length === 0 ? taskId : `${taskId}: ${title.slice(0, 300)}`;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return taskId;
    }
    throw error;
  }
}

async function updateHealthSessionId(
  projectRoot: string,
  agent: AgentId,
  date: string,
  sessionId: string
): Promise<void> {
  const healthPath = resolveInside(
    sessionDirectory(projectRoot, agent, date),
    "health.json"
  );
  try {
    const health = await readJsonFile<Record<string, unknown>>(healthPath);
    await writeJsonFileAtomic(healthPath, {
      ...health,
      session_id: sessionId
    });
  } catch (error) {
    if (!String(error).includes("ENOENT")) {
      throw error;
    }
  }
}

async function repairRotatedSessionReferences(
  projectRoot: string,
  metadata: SessionMetadata,
  sessionId: string,
  rotation: SessionRotationArtifact
): Promise<void> {
  const manifest = await readSessionManifest(
    projectRoot,
    metadata.agent,
    metadata.date,
    metadata
  );
  if (sessionId === rotation.new_session_id) {
    await writeJsonFileAtomic(
      sessionManifestPath(projectRoot, metadata.agent, metadata.date),
      {
        schema_version: "0.1",
        kind: "session_context_manifest",
        session_id: sessionId,
        date: metadata.date,
        agent: metadata.agent,
        scratch: metadata.scratch,
        latest_context_path: rotation.handoff_markdown_path,
        runs: [],
        updated_at: metadata.updated_at
      } satisfies SessionContextManifest
    );
  } else if (manifest.session_id !== sessionId) {
    await writeJsonFileAtomic(
      sessionManifestPath(projectRoot, metadata.agent, metadata.date),
      {
        ...manifest,
        session_id: sessionId,
        updated_at: metadata.updated_at
      } satisfies SessionContextManifest
    );
  }
  await updateHealthSessionId(
    projectRoot,
    metadata.agent,
    metadata.date,
    sessionId
  );
}

async function latestIncompleteRotation(
  projectRoot: string,
  agent: AgentId,
  date: string
): Promise<SessionRotationArtifact | null> {
  const directory = resolveInside(
    sessionDirectory(projectRoot, agent, date),
    "rotations"
  );
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }

  for (const name of names.filter((value) => value.endsWith(".json")).sort().reverse()) {
    if (name.endsWith("-handoff.json")) {
      continue;
    }
    const artifact = await readJsonFile<SessionRotationArtifact>(
      resolveInside(directory, name)
    );
    if (artifact.kind === "session_rotation" && artifact.status === "rotating") {
      return artifact;
    }
  }
  return null;
}

async function readCompactionPlanIfExists(
  projectRoot: string,
  agent: AgentId,
  date: string,
  planId: string
): Promise<SessionCompactionPlan | null> {
  try {
    return await readJsonFile<SessionCompactionPlan>(
      compactionPlanPath(projectRoot, agent, date, planId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function rotationPath(
  projectRoot: string,
  artifact: Pick<SessionRotationArtifact, "agent" | "date" | "rotation_id">
): string {
  return rotationArtifactPath(
    projectRoot,
    artifact.agent,
    artifact.date,
    artifact.rotation_id
  );
}

function sessionDirectory(
  projectRoot: string,
  agent: AgentId,
  date: string
): string {
  return resolveInside(getKaironPaths(projectRoot).sessionsDir, date, agent);
}

function sessionMetadataPath(
  projectRoot: string,
  agent: AgentId,
  date: string
): string {
  return resolveInside(sessionDirectory(projectRoot, agent, date), "session.json");
}

function sessionManifestPath(
  projectRoot: string,
  agent: AgentId,
  date: string
): string {
  return resolveInside(
    sessionDirectory(projectRoot, agent, date),
    "session_context_manifest.json"
  );
}

function compactionPlanPath(
  projectRoot: string,
  agent: AgentId,
  date: string,
  planId: string
): string {
  return resolveInside(
    sessionDirectory(projectRoot, agent, date),
    "compactions",
    `${planId}.json`
  );
}

function rotationArtifactPath(
  projectRoot: string,
  agent: AgentId,
  date: string,
  rotationId: string
): string {
  return resolveInside(
    sessionDirectory(projectRoot, agent, date),
    "rotations",
    `${rotationId}.json`
  );
}

async function readSessionMetadata(
  projectRoot: string,
  agent: AgentId,
  date: string
): Promise<SessionMetadata> {
  return readJsonFile<SessionMetadata>(
    sessionMetadataPath(projectRoot, agent, date)
  );
}

function budgetReport(
  metadata: SessionMetadata,
  config: SessionBudgetConfig,
  now: Date
): SessionBudgetReport {
  const normalized = normalizeSessionBudgetMetadata(metadata, now, config);
  return {
    schema_version: "0.1",
    date: normalized.date,
    agent: normalized.agent,
    session_id: normalized.session_id,
    status: normalized.budget_status ?? "within_limit",
    dispatch_allowed: !isSessionBudgetDispatchBlocked(normalized),
    prompt_bytes: nonnegative(normalized.prompt_bytes),
    job_count: nonnegative(normalized.job_count),
    elapsed_seconds: nonnegative(normalized.elapsed_seconds),
    compaction_count: nonnegative(normalized.compaction_count),
    rotation_count: nonnegative(normalized.rotation_count),
    budget_source: normalized.budget_source ?? "unavailable",
    reasons: normalized.budget_reasons ?? [],
    active_compaction_plan_id: normalized.active_compaction_plan_id ?? null,
    thresholds: {
      soft_limit: config.soft_limit,
      hard_limit: config.hard_limit
    },
    updated_at: now.toISOString()
  };
}

function metricsFromMetadata(
  metadata: SessionMetadata
): SessionCompactionPlan["metrics"] {
  return {
    prompt_bytes: nonnegative(metadata.prompt_bytes),
    job_count: nonnegative(metadata.job_count),
    elapsed_seconds: nonnegative(metadata.elapsed_seconds),
    compaction_count: nonnegative(metadata.compaction_count),
    budget_source: metadata.budget_source ?? "unavailable"
  };
}

function mergeThreshold(
  defaults: SessionBudgetThreshold,
  configured: Partial<SessionBudgetThreshold> | undefined
): SessionBudgetThreshold {
  return {
    prompt_bytes: configured?.prompt_bytes ?? defaults.prompt_bytes,
    job_count: configured?.job_count ?? defaults.job_count,
    elapsed_seconds: configured?.elapsed_seconds ?? defaults.elapsed_seconds,
    compaction_count:
      configured?.compaction_count ?? defaults.compaction_count
  };
}

function thresholdReasons(
  metrics: Pick<
    SessionMetadata,
    "prompt_bytes" | "job_count" | "elapsed_seconds" | "compaction_count"
  >,
  threshold: SessionBudgetThreshold,
  level: "soft" | "hard"
): string[] {
  return (
    [
      "prompt_bytes",
      "job_count",
      "elapsed_seconds",
      "compaction_count"
    ] as const
  )
    .filter((metric) => nonnegative(metrics[metric]) >= threshold[metric])
    .map((metric) => `${metric}_${level}_limit`);
}

function nextBudgetSource(
  current: SessionBudgetSource,
  observed: Exclude<SessionBudgetSource, "unavailable" | "mixed">
): SessionBudgetSource {
  if (current === "unavailable" || current === observed) {
    return observed;
  }
  return "mixed";
}

function createOperationId(
  prefix: "CMP" | "ROT",
  now: Date,
  sourceHash: string
): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${timestamp}-${sourceHash.replace("sha256:", "").slice(0, 10)}`;
}

function assertPlanId(planId: string): void {
  if (!/^CMP-[0-9TZ]+-[a-f0-9]{10}$/.test(planId)) {
    throw new Error("Invalid session compaction plan id.");
  }
}

function formatThreshold(threshold: SessionBudgetThreshold): string {
  return [
    `prompt_bytes:${threshold.prompt_bytes}`,
    `job_count:${threshold.job_count}`,
    `elapsed_seconds:${threshold.elapsed_seconds}`,
    `compaction_count:${threshold.compaction_count}`
  ].join(",");
}

function secondsBetween(startedAt: string, now: Date): number {
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now.getTime() - parsed) / 1_000))
    : 0;
}

function nonnegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

function sanitizeOperatorReason(reason: string): string {
  const sanitized = reason.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  if (sanitized.length === 0) {
    throw new Error("Session rotation requires a non-empty reason.");
  }
  return sanitized;
}

function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.name : "unknown_error";
  return message.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

function isOperationProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toArtifactPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
