import path from "node:path";
import { getKaironPaths } from "../core/fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../core/fs/lock-file.js";
import { nextId } from "../core/ids/counter.js";

export type QueueItemType =
  | "agent.run"
  | "review.run"
  | "git.transaction"
  | "approval.command"
  | "schedule.command"
  | "maintenance.run";

export type QueueStatus = "ready" | "claimed" | "completed" | "failed";

export type ScheduleMode = "active_work" | "standby_work" | "maintenance";

export type QueueItem = {
  id: string;
  type: QueueItemType;
  status: QueueStatus;
  priority: number;
  task_id?: string;
  payload?: Record<string, unknown>;
  schedule_mode?: ScheduleMode;
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
  task_id?: string;
  payload?: Record<string, unknown>;
  schedule_mode?: ScheduleMode;
  created_at?: string;
};

export type ClaimOptions = {
  now?: Date;
  claimTtlMs?: number;
  blocked?: (item: QueueItem) => boolean;
};

const defaultQueueState: QueueState = {
  schema_version: "0.1",
  items: []
};

export class WorkQueue {
  constructor(private readonly projectRoot: string) {}

  async enqueue(input: EnqueueInput): Promise<QueueItem> {
    return this.withQueueLock(async (state) => {
      const now = input.created_at ?? new Date().toISOString();
      const item: QueueItem = {
        id: await nextId(this.projectRoot, "job"),
        type: input.type,
        status: "ready",
        priority: input.priority ?? 50,
        task_id: input.task_id,
        payload: input.payload,
        schedule_mode: input.schedule_mode,
        attempts: 0,
        created_at: now,
        updated_at: now
      };

      state.items.push(item);
      return item;
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

  async list(status?: QueueStatus): Promise<QueueItem[]> {
    const state = await this.readState();
    return state.items
      .filter((item) => status === undefined || item.status === status)
      .map((item) => ({ ...item }));
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
