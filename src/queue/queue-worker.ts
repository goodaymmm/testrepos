import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import {
  CommandInbox,
  type CommandEnvelope,
  type KaironCommand
} from "./command-inbox.js";
import {
  WorkQueue,
  type QueueItem,
  type QueueItemType
} from "./work-queue.js";

export type QueueWorkerResult =
  | {
      status: "processed-command";
      command_id: string;
      command_type: KaironCommand["type"];
    }
  | {
      status: "processed-item";
      item_id: string;
      item_type: QueueItemType;
    }
  | {
      status: "idle";
    };

export type QueueWorkerHandlers = {
  commands?: Partial<
    Record<KaironCommand["type"], (command: CommandEnvelope) => Promise<Record<string, unknown>>>
  >;
  items?: Partial<
    Record<QueueItemType, (item: QueueItem) => Promise<Record<string, unknown>>>
  >;
};

export class QueueWorker {
  constructor(
    private readonly projectRoot: string,
    private readonly workQueue: WorkQueue,
    private readonly commandInbox: CommandInbox,
    private readonly handlers: QueueWorkerHandlers
  ) {}

  async processNext(workerId: string): Promise<QueueWorkerResult> {
    const command = await this.commandInbox.claim(workerId);

    if (command !== null) {
      return this.processCommand(command);
    }

    const activeWorkClosed = await this.isActiveWorkClosed();
    const item = await this.workQueue.claim(workerId, {
      blocked: (candidate) => activeWorkClosed && isActiveWorkDispatch(candidate)
    });

    if (item === null) {
      return { status: "idle" };
    }

    return this.processItem(item);
  }

  private async processCommand(
    envelope: CommandEnvelope
  ): Promise<QueueWorkerResult> {
    const handler = this.handlers.commands?.[envelope.command.type];

    if (handler === undefined) {
      await this.commandInbox.fail(envelope.command_id, {
        message: `No command handler registered for ${envelope.command.type}`
      });
      return {
        status: "processed-command",
        command_id: envelope.command_id,
        command_type: envelope.command.type
      };
    }

    try {
      const result = await handler(envelope);
      await this.commandInbox.complete(envelope.command_id, result);
    } catch (error) {
      await this.commandInbox.fail(envelope.command_id, {
        message: String(error)
      });
    }

    return {
      status: "processed-command",
      command_id: envelope.command_id,
      command_type: envelope.command.type
    };
  }

  private async processItem(item: QueueItem): Promise<QueueWorkerResult> {
    const handler = this.handlers.items?.[item.type];

    if (handler === undefined) {
      await this.workQueue.fail(item.id, {
        message: `No queue handler registered for ${item.type}`
      });
      return {
        status: "processed-item",
        item_id: item.id,
        item_type: item.type
      };
    }

    try {
      const result = await handler(item);
      await this.workQueue.complete(item.id, result);
    } catch (error) {
      await this.workQueue.fail(item.id, {
        message: String(error)
      });
    }

    return {
      status: "processed-item",
      item_id: item.id,
      item_type: item.type
    };
  }

  private async isActiveWorkClosed(): Promise<boolean> {
    const overridePath = path.join(
      getKaironPaths(this.projectRoot).stateDir,
      "schedule_override.json"
    );

    try {
      const override = await readJsonFile<{
        active_work_closed?: boolean;
        expires_at?: string;
      }>(overridePath);

      if (!override.active_work_closed) {
        return false;
      }

      if (override.expires_at === undefined) {
        return true;
      }

      return Date.parse(override.expires_at) > Date.now();
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        return false;
      }

      throw error;
    }
  }
}

function isActiveWorkDispatch(item: QueueItem): boolean {
  if (item.schedule_mode === "active_work") {
    return true;
  }

  if (item.schedule_mode !== undefined) {
    return false;
  }

  return ["agent.run", "review.run", "git.transaction"].includes(item.type);
}
