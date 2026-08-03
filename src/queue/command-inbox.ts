import path from "node:path";
import { getKaironPaths } from "../core/fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../core/fs/lock-file.js";
import { nextId } from "../core/ids/counter.js";

export type CommandStatus = "queued" | "claimed" | "completed" | "failed";

export type CommandOrigin = {
  source?: "local" | "discord";
  actor?: unknown;
  received_at?: string;
  discord?: {
    transport?: "gateway" | "http_interactions";
    guild_id?: string;
    channel_id?: string;
    message_id?: string;
    interaction_id?: string;
    custom_id?: string;
  };
  nonce?: string;
};

export type ApprovalDecisionCommand = CommandOrigin & {
  type: "approval.decide";
  approval_id: string;
  decision: "approve" | "reject" | "request_changes";
  reason?: string;
};

export type ApprovalConfirmationCommand = CommandOrigin & {
  type: "approval.confirmation.request";
  approval_id: string;
  action: "approve";
  confirmation: "board" | "local";
  reason: string;
};

export type ApprovalSnoozeCommand = CommandOrigin & {
  type: "approval.snooze";
  approval_id: string;
  until: string;
};

export type CloseActiveWorkCommand = CommandOrigin & {
  type: "schedule.close_active_work";
  date: string;
  reason: string;
};

export type RuntimeStatusCommand = CommandOrigin & {
  type: "runtime.status";
  reason: string;
};

export type KaironCommand =
  | ApprovalConfirmationCommand
  | ApprovalDecisionCommand
  | ApprovalSnoozeCommand
  | CloseActiveWorkCommand
  | RuntimeStatusCommand;

export type CommandEnvelope = {
  command_id: string;
  status: CommandStatus;
  command: KaironCommand;
  idempotency_key?: string;
  created_at: string;
  updated_at: string;
  claimed_by?: string;
  claimed_at?: string;
  completed_at?: string;
  failed_at?: string;
  result?: Record<string, unknown>;
  error?: {
    message: string;
    code?: string;
  };
};

export type CommandInboxState = {
  schema_version: string;
  commands: CommandEnvelope[];
  idempotency: Record<string, string>;
};

export type EnqueueCommandResult = {
  envelope: CommandEnvelope;
  duplicate: boolean;
};

const defaultInboxState: CommandInboxState = {
  schema_version: "0.1",
  commands: [],
  idempotency: {}
};

export class CommandInbox {
  constructor(private readonly projectRoot: string) {}

  async enqueue(
    command: KaironCommand,
    options: { idempotencyKey?: string } = {}
  ): Promise<EnqueueCommandResult> {
    return this.withInboxLock(async (state) => {
      if (options.idempotencyKey !== undefined) {
        const existingId = state.idempotency[options.idempotencyKey];
        const existing = state.commands.find(
          (candidate) => candidate.command_id === existingId
        );

        if (existing !== undefined) {
          return { envelope: { ...existing }, duplicate: true };
        }
      }

      const now = new Date().toISOString();
      const envelope: CommandEnvelope = {
        command_id: await nextId(this.projectRoot, "command"),
        status: "queued",
        command,
        idempotency_key: options.idempotencyKey,
        created_at: now,
        updated_at: now
      };

      state.commands.push(envelope);

      if (options.idempotencyKey !== undefined) {
        state.idempotency[options.idempotencyKey] = envelope.command_id;
      }

      return { envelope: { ...envelope }, duplicate: false };
    });
  }

  async claim(workerId: string): Promise<CommandEnvelope | null> {
    return this.withInboxLock((state) => {
      const envelope = state.commands
        .filter((candidate) => candidate.status === "queued")
        .sort(
          (left, right) =>
            Date.parse(left.created_at) - Date.parse(right.created_at)
        )[0];

      if (envelope === undefined) {
        return null;
      }

      const now = new Date().toISOString();
      envelope.status = "claimed";
      envelope.claimed_by = workerId;
      envelope.claimed_at = now;
      envelope.updated_at = now;
      return { ...envelope };
    });
  }

  async complete(
    commandId: string,
    result: Record<string, unknown> = {}
  ): Promise<CommandEnvelope> {
    return this.update(commandId, (envelope) => {
      const now = new Date().toISOString();
      envelope.status = "completed";
      envelope.result = result;
      envelope.completed_at = now;
      envelope.updated_at = now;
    });
  }

  async fail(
    commandId: string,
    error: { message: string; code?: string }
  ): Promise<CommandEnvelope> {
    return this.update(commandId, (envelope) => {
      const now = new Date().toISOString();
      envelope.status = "failed";
      envelope.error = error;
      envelope.failed_at = now;
      envelope.updated_at = now;
    });
  }

  async list(status?: CommandStatus): Promise<CommandEnvelope[]> {
    const state = await this.readState();
    return state.commands
      .filter((command) => status === undefined || command.status === status)
      .map((command) => ({ ...command }));
  }

  private async update(
    commandId: string,
    update: (envelope: CommandEnvelope) => void
  ): Promise<CommandEnvelope> {
    return this.withInboxLock((state) => {
      const envelope = state.commands.find(
        (candidate) => candidate.command_id === commandId
      );

      if (envelope === undefined) {
        throw new Error(`Command not found: ${commandId}`);
      }

      update(envelope);
      return { ...envelope };
    });
  }

  private async withInboxLock<T>(
    callback: (state: CommandInboxState) => Promise<T> | T
  ): Promise<T> {
    const lock = await acquireLockFile(
      path.join(getKaironPaths(this.projectRoot).runtimeDir, "command-inbox.lock"),
      "command-inbox",
      30_000
    );

    try {
      const state = await this.readState();
      const result = await callback(state);
      await writeJsonFileAtomic(this.inboxPath(), state);
      return result;
    } finally {
      await releaseLockFile(lock);
    }
  }

  private async readState(): Promise<CommandInboxState> {
    try {
      return {
        ...defaultInboxState,
        ...(await readJsonFile<CommandInboxState>(this.inboxPath()))
      };
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return { ...defaultInboxState, commands: [], idempotency: {} };
      }

      throw error;
    }
  }

  private inboxPath(): string {
    return path.join(
      getKaironPaths(this.projectRoot).stateDir,
      "command-inbox.json"
    );
  }
}
