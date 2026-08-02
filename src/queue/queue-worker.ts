import { getScheduleStatus } from "../runtime/schedule-engine.js";
import {
  CommandInbox,
  type CommandEnvelope,
  type KaironCommand
} from "./command-inbox.js";
import {
  WorkQueue,
  type QueueItem,
  type QueueItemType,
  type ScheduleMode
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

export type ProcessNextOptions = {
  scheduleMode?: ScheduleMode;
  activeWorkClosed?: boolean;
  now?: Date;
  blocked?: (item: QueueItem) => boolean;
  commandsOnly?: boolean;
};

export class QueueWorker {
  constructor(
    private readonly projectRoot: string,
    private readonly workQueue: WorkQueue,
    private readonly commandInbox: CommandInbox,
    private readonly handlers: QueueWorkerHandlers
  ) {}

  async processNext(
    workerId: string,
    options: ProcessNextOptions = {}
  ): Promise<QueueWorkerResult> {
    const command = await this.commandInbox.claim(workerId);

    if (command !== null) {
      return this.processCommand(command);
    }

    if (options.commandsOnly === true) {
      return { status: "idle" };
    }

    await this.workQueue.expireStaleTestItems(options.now);

    const activeWorkClosed =
      options.activeWorkClosed ??
      (await getScheduleStatus(this.projectRoot, options.now)).activeWorkClosed;
    const item = await this.workQueue.claim(workerId, {
      now: options.now,
      blocked: (candidate) =>
        (options.blocked?.(candidate) ?? false) ||
        isBlockedBySchedule(candidate, {
          activeWorkClosed,
          scheduleMode: options.scheduleMode
        })
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
        message: String(error),
        code: `handler.${envelope.command.type}.failed`
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
        message: String(error),
        code: `handler.${item.type}.failed`
      });
    }

    return {
      status: "processed-item",
      item_id: item.id,
      item_type: item.type
    };
  }
}

export function isBlockedBySchedule(
  item: QueueItem,
  options: {
    activeWorkClosed?: boolean;
    scheduleMode?: ScheduleMode;
  }
): boolean {
  if (options.scheduleMode === "maintenance") {
    return item.type !== "maintenance.run";
  }

  if (options.scheduleMode === "standby_work") {
    return !isStandbyAllowedDispatch(item);
  }

  return options.activeWorkClosed === true && isActiveWorkDispatch(item);
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

function isStandbyAllowedDispatch(item: QueueItem): boolean {
  if (item.schedule_mode === "active_work") {
    return false;
  }

  if (item.schedule_mode === "standby_work") {
    return true;
  }

  if (item.schedule_mode === "maintenance") {
    return false;
  }

  if (["approval.command", "schedule.command", "maintenance.run"].includes(item.type)) {
    return true;
  }

  const payload = item.payload ?? {};
  return (
    payload.approved === true ||
    payload.approval_status === "approved" ||
    payload.approval_decision === "approve"
  );
}
