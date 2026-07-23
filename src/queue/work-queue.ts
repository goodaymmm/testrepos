import path from "node:path";
import { getKaironPaths } from "../core/fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../core/fs/lock-file.js";
import { nextId } from "../core/ids/counter.js";
import type {
  ProductionWorkflowCompensationQueueMetadata,
  ProductionWorkflowQueueMetadata
} from "../workflow/types.js";

export type QueueItemType =
  | "agent.run"
  | "review.run"
  | "git.transaction"
  | "approval.command"
  | "schedule.command"
  | "maintenance.run";

export type QueueStatus = "ready" | "claimed" | "completed" | "failed";

export type ScheduleMode = "active_work" | "standby_work" | "maintenance";

export type QueueTestScope = {
  kind: "operation_test" | "manual_test";
  tags: string[];
  expires_at: string;
};

export type WorkflowRuntimeQueueMetadata = {
  schema_version: "0.1";
  workflow_id: string;
  candidate_artifact_path: string;
  feature_flag: "KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME";
  approval_gate: {
    required: boolean;
    approval_id?: string;
    status: string;
  };
  resource_locks: {
    mode: "exclusive";
    keys: string[];
    release_on: ["completed", "failed"];
  };
  retry_policy: {
    max_attempts: number;
    backoff_seconds: number;
  };
  recovery_artifact_path: string;
  rollback: {
    strategy: "fail_queue_item_before_claim";
    automatic: false;
  };
};

export type QueueMetadata = {
  workflow_runtime?: WorkflowRuntimeQueueMetadata;
  production_workflow?: ProductionWorkflowQueueMetadata;
  workflow_compensation?: ProductionWorkflowCompensationQueueMetadata;
};

export type QueueItem = {
  id: string;
  type: QueueItemType;
  status: QueueStatus;
  priority: number;
  idempotency_key?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
  metadata?: QueueMetadata;
  schedule_mode?: ScheduleMode;
  test_scope?: QueueTestScope;
  attempts: number;
  created_at: string;
  updated_at: string;
  claimed_by?: string;
  claimed_at?: string;
  claim_expires_at?: string;
  completed_at?: string;
  failed_at?: string;
  result?: Record<string, unknown>;
  error?: QueueError;
};

export type QueueError = {
  message: string;
  code?: string;
};

export type QueueState = {
  schema_version: string;
  items: QueueItem[];
};

export type EnqueueInput = {
  type: QueueItemType;
  priority?: number;
  idempotency_key?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
  metadata?: QueueMetadata;
  schedule_mode?: ScheduleMode;
  test_scope?: QueueTestScope;
  created_at?: string;
};

export type ClaimOptions = {
  now?: Date;
  claimTtlMs?: number;
  blocked?: (item: QueueItem) => boolean;
};

export type ExpireReadyTestItemsOptions = {
  now?: Date;
  kinds?: QueueTestScope["kind"][];
  tags?: string[];
  excludeIds?: string[];
  includeLegacy?: boolean;
  message?: string;
  code?: string;
};

export type RequeueClaimOptions = {
  now?: Date;
  reason?: string;
  code?: string;
};

const defaultQueueState: QueueState = {
  schema_version: "0.1",
  items: []
};
const legacyTestQueueTtlMs = 24 * 60 * 60 * 1000;

export class WorkQueue {
  constructor(private readonly projectRoot: string) {}

  async enqueue(input: EnqueueInput): Promise<QueueItem> {
    return this.withQueueLock(async (state) => {
      const item = await this.createItem(input);

      state.items.push(item);
      return item;
    });
  }

  async enqueueIdempotent(
    input: EnqueueInput & { idempotency_key: string }
  ): Promise<{ item: QueueItem; created: boolean }> {
    if (input.idempotency_key.trim().length === 0) {
      throw new Error("Queue idempotency key must not be empty.");
    }

    return this.withQueueLock(async (state) => {
      const existing = state.items.find(
        (item) => item.idempotency_key === input.idempotency_key
      );
      if (existing !== undefined) {
        return { item: { ...existing }, created: false };
      }

      const item = await this.createItem(input);
      state.items.push(item);
      return { item, created: true };
    });
  }

  async claim(
    workerId: string,
    options: ClaimOptions = {}
  ): Promise<QueueItem | null> {
    return this.withQueueLock(async (state) => {
      const now = options.now ?? new Date();
      const claimTtlMs = options.claimTtlMs ?? 300_000;
      recoverExpiredClaims(state, now);

      const item = state.items
        .filter((candidate) => candidate.status === "ready")
        .filter((candidate) => !(options.blocked?.(candidate) ?? false))
        .sort(compareReadyItems)[0];

      if (item === undefined) {
        return null;
      }

      const nowIso = now.toISOString();
      item.status = "claimed";
      item.claimed_by = workerId;
      item.claimed_at = nowIso;
      item.claim_expires_at = new Date(now.getTime() + claimTtlMs).toISOString();
      item.attempts += 1;
      item.updated_at = nowIso;
      return { ...item };
    });
  }

  async claimById(
    itemId: string,
    workerId: string,
    options: Omit<ClaimOptions, "blocked"> = {}
  ): Promise<QueueItem | null> {
    return this.withQueueLock(async (state) => {
      const now = options.now ?? new Date();
      const claimTtlMs = options.claimTtlMs ?? 300_000;
      recoverExpiredClaims(state, now);

      const item = state.items.find((candidate) => candidate.id === itemId);
      if (item === undefined || item.status !== "ready") {
        return null;
      }

      const nowIso = now.toISOString();
      item.status = "claimed";
      item.claimed_by = workerId;
      item.claimed_at = nowIso;
      item.claim_expires_at = new Date(now.getTime() + claimTtlMs).toISOString();
      item.attempts += 1;
      item.updated_at = nowIso;
      return { ...item };
    });
  }

  async complete(
    itemId: string,
    result: Record<string, unknown> = {}
  ): Promise<QueueItem> {
    return this.updateItem(itemId, (item) => {
      const now = new Date().toISOString();
      item.status = "completed";
      item.result = result;
      item.completed_at = now;
      item.updated_at = now;
      delete item.claim_expires_at;
    });
  }

  async fail(itemId: string, error: QueueError): Promise<QueueItem> {
    return this.updateItem(itemId, (item) => {
      const now = new Date().toISOString();
      item.status = "failed";
      item.error = error;
      item.failed_at = now;
      item.updated_at = now;
      delete item.claim_expires_at;
    });
  }

  async requeueClaim(
    itemId: string,
    options: RequeueClaimOptions = {}
  ): Promise<QueueItem> {
    return this.updateItem(itemId, (item) => {
      if (item.status !== "claimed") {
        throw new Error(`Queue item is not claimed: ${itemId}`);
      }

      const now = options.now ?? new Date();
      item.status = "ready";
      item.updated_at = now.toISOString();
      item.result = {
        ...(item.result ?? {}),
        recovery: {
          reason: options.reason ?? "Recovered expired queue claim.",
          code: options.code ?? "runtime_recovery_requeued",
          recovered_at: now.toISOString()
        }
      };
      delete item.claimed_by;
      delete item.claimed_at;
      delete item.claim_expires_at;
    });
  }

  async list(status?: QueueStatus): Promise<QueueItem[]> {
    const state = await this.readState();
    return state.items
      .filter((item) => status === undefined || item.status === status)
      .map((item) => ({ ...item }));
  }

  async expireStaleTestItems(now = new Date()): Promise<QueueItem[]> {
    return this.withQueueLock(async (state) => {
      recoverExpiredClaims(state, now);

      const expired: QueueItem[] = [];
      const nowIso = now.toISOString();

      for (const item of state.items) {
        if (item.status !== "ready" || !isStaleTestItem(item, now)) {
          continue;
        }

        failReadyItem(item, nowIso, {
          message: "Stale test queue item expired before runtime dispatch.",
          code: "stale_test_queue_item"
        });
        expired.push({ ...item });
      }

      return expired;
    });
  }

  async expireReadyTestItems(
    options: ExpireReadyTestItemsOptions = {}
  ): Promise<QueueItem[]> {
    return this.withQueueLock(async (state) => {
      const now = options.now ?? new Date();
      recoverExpiredClaims(state, now);

      const expired: QueueItem[] = [];
      const nowIso = now.toISOString();
      const excludeIds = new Set(options.excludeIds ?? []);

      for (const item of state.items) {
        if (
          item.status !== "ready" ||
          excludeIds.has(item.id) ||
          !matchesReadyTestItem(item, options)
        ) {
          continue;
        }

        failReadyItem(item, nowIso, {
          message:
            options.message ??
            "Ready test queue item isolated before operation test dispatch.",
          code: options.code ?? "isolated_test_queue_item"
        });
        expired.push({ ...item });
      }

      return expired;
    });
  }

  private async updateItem(
    itemId: string,
    update: (item: QueueItem) => void
  ): Promise<QueueItem> {
    return this.withQueueLock(async (state) => {
      const item = state.items.find((candidate) => candidate.id === itemId);

      if (item === undefined) {
        throw new Error(`Queue item not found: ${itemId}`);
      }

      update(item);
      return { ...item };
    });
  }

  private async createItem(input: EnqueueInput): Promise<QueueItem> {
    const now = input.created_at ?? new Date().toISOString();
    return {
      id: await nextId(this.projectRoot, "job"),
      type: input.type,
      status: "ready",
      priority: input.priority ?? 50,
      idempotency_key: input.idempotency_key,
      task_id: input.task_id,
      payload: input.payload,
      metadata: input.metadata,
      schedule_mode: input.schedule_mode,
      test_scope: input.test_scope,
      attempts: 0,
      created_at: now,
      updated_at: now
    };
  }

  private async withQueueLock<T>(
    callback: (state: QueueState) => Promise<T> | T
  ): Promise<T> {
    const lock = await acquireLockFile(
      path.join(getKaironPaths(this.projectRoot).runtimeDir, "queue.lock"),
      "work-queue",
      30_000
    );

    try {
      const state = await this.readState();
      const result = await callback(state);
      await this.writeState(state);
      return result;
    } finally {
      await releaseLockFile(lock);
    }
  }

  private async readState(): Promise<QueueState> {
    try {
      return {
        ...defaultQueueState,
        ...(await readJsonFile<QueueState>(this.queuePath()))
      };
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return { ...defaultQueueState, items: [] };
      }

      throw error;
    }
  }

  private async writeState(state: QueueState): Promise<void> {
    await writeJsonFileAtomic(this.queuePath(), state);
  }

  private queuePath(): string {
    return path.join(getKaironPaths(this.projectRoot).stateDir, "queue.json");
  }
}

function compareReadyItems(left: QueueItem, right: QueueItem): number {
  if (right.priority !== left.priority) {
    return right.priority - left.priority;
  }

  return Date.parse(left.created_at) - Date.parse(right.created_at);
}

function recoverExpiredClaims(state: QueueState, now: Date): void {
  const nowMs = now.getTime();

  for (const item of state.items) {
    if (
      item.status === "claimed" &&
      item.claim_expires_at !== undefined &&
      Date.parse(item.claim_expires_at) <= nowMs
    ) {
      item.status = "ready";
      item.updated_at = now.toISOString();
      delete item.claimed_by;
      delete item.claimed_at;
      delete item.claim_expires_at;
    }
  }
}

function isStaleTestItem(item: QueueItem, now: Date): boolean {
  if (item.test_scope !== undefined) {
    const expiresAt = Date.parse(item.test_scope.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
  }

  return hasLegacyTestTag(item) &&
    Date.parse(item.created_at) + legacyTestQueueTtlMs <= now.getTime();
}

function hasLegacyTestTag(item: QueueItem): boolean {
  const tags = item.payload?.tags;
  return Array.isArray(tags) &&
    tags.some((tag) => tag === "operation-test" || tag === "manual-test");
}

function matchesReadyTestItem(
  item: QueueItem,
  options: ExpireReadyTestItemsOptions
): boolean {
  if (item.test_scope !== undefined) {
    return (
      matchesKind(item.test_scope.kind, options.kinds) &&
      matchesTags(item.test_scope.tags, options.tags)
    );
  }

  if (options.includeLegacy === false) {
    return false;
  }

  const legacyTags = readLegacyTestTags(item);
  if (legacyTags.length === 0) {
    return false;
  }

  return (
    matchesKind(inferLegacyTestKind(legacyTags), options.kinds) &&
    matchesTags(legacyTags, options.tags)
  );
}

function matchesKind(
  kind: QueueTestScope["kind"],
  allowed: QueueTestScope["kind"][] | undefined
): boolean {
  return allowed === undefined || allowed.includes(kind);
}

function matchesTags(itemTags: string[], required: string[] | undefined): boolean {
  return (
    required === undefined ||
    required.length === 0 ||
    required.some((tag) => itemTags.includes(tag))
  );
}

function readLegacyTestTags(item: QueueItem): string[] {
  const tags = item.payload?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string => tag === "operation-test" || tag === "manual-test"
      )
    : [];
}

function inferLegacyTestKind(tags: string[]): QueueTestScope["kind"] {
  return tags.includes("manual-test") ? "manual_test" : "operation_test";
}

function failReadyItem(item: QueueItem, nowIso: string, error: QueueError): void {
  item.status = "failed";
  item.failed_at = nowIso;
  item.updated_at = nowIso;
  item.error = error;
  delete item.claimed_by;
  delete item.claimed_at;
  delete item.claim_expires_at;
}
