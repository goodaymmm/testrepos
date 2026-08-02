import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../core/fs/lock-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";

export type DiscordIdempotencyStatus = "accepted" | "rejected";

export type DiscordIdempotencyRecord = {
  status: DiscordIdempotencyStatus;
  command_id?: string;
  reason?: string;
  created_at: string;
  expires_at: string;
};

export type DiscordIdempotencyState = {
  schema_version: string;
  keys: Record<string, DiscordIdempotencyRecord>;
};

export type DiscordIdempotencyResult =
  | {
      duplicate: false;
      record: DiscordIdempotencyRecord;
    }
  | {
      duplicate: true;
      record: DiscordIdempotencyRecord;
    };

const defaultState: DiscordIdempotencyState = {
  schema_version: "0.1",
  keys: {}
};

export class DiscordIdempotencyStore {
  constructor(private readonly projectRoot: string) {}

  async accept(
    key: string,
    options: {
      commandId?: string;
      ttlMinutes?: number;
      now?: Date;
    } = {}
  ): Promise<DiscordIdempotencyResult> {
    return this.withLock(async (state) => {
      const now = options.now ?? new Date();
      pruneExpired(state, now);

      const existing = state.keys[key];
      if (existing !== undefined) {
        return { duplicate: true, record: existing };
      }

      const record: DiscordIdempotencyRecord = {
        status: "accepted",
        command_id: options.commandId,
        created_at: now.toISOString(),
        expires_at: new Date(
          now.getTime() + (options.ttlMinutes ?? 60) * 60_000
        ).toISOString()
      };
      state.keys[key] = record;
      return { duplicate: false, record };
    });
  }

  async reject(
    key: string,
    reason: string,
    options: { ttlMinutes?: number; now?: Date } = {}
  ): Promise<DiscordIdempotencyResult> {
    return this.withLock(async (state) => {
      const now = options.now ?? new Date();
      pruneExpired(state, now);

      const existing = state.keys[key];
      if (existing !== undefined) {
        return { duplicate: true, record: existing };
      }

      const record: DiscordIdempotencyRecord = {
        status: "rejected",
        reason,
        created_at: now.toISOString(),
        expires_at: new Date(
          now.getTime() + (options.ttlMinutes ?? 60) * 60_000
        ).toISOString()
      };
      state.keys[key] = record;
      return { duplicate: false, record };
    });
  }

  private async withLock<T>(
    callback: (state: DiscordIdempotencyState) => Promise<T> | T
  ): Promise<T> {
    const paths = getKaironPaths(this.projectRoot);
    const lock = await acquireLockFile(
      resolveInside(paths.runtimeDir, "discord", "idempotency.lock"),
      "discord-idempotency",
      30_000
    );

    try {
      const state = await this.readState();
      const result = await callback(state);
      await writeJsonFileAtomic(this.statePath(), state);
      return result;
    } finally {
      await releaseLockFile(lock);
    }
  }

  private async readState(): Promise<DiscordIdempotencyState> {
    try {
      return {
        ...defaultState,
        ...(await readJsonFile<DiscordIdempotencyState>(this.statePath()))
      };
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return { ...defaultState, keys: {} };
      }

      throw error;
    }
  }

  private statePath(): string {
    return path.join(
      getKaironPaths(this.projectRoot).runtimeDir,
      "discord",
      "idempotency.json"
    );
  }
}

export function discordInteractionKey(interactionId: string): string {
  return `discord:interaction:${interactionId}`;
}

export function discordApprovalActionKey(input: {
  approvalId: string;
  action: string;
  nonce: string;
}): string {
  return `discord:approval:${input.approvalId}:${input.action}:${input.nonce}`;
}

function pruneExpired(state: DiscordIdempotencyState, now: Date): void {
  const nowMs = now.getTime();

  for (const [key, record] of Object.entries(state.keys)) {
    if (Date.parse(record.expires_at) <= nowMs) {
      delete state.keys[key];
    }
  }
}
