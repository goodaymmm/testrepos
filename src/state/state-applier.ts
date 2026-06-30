import { z } from "zod";
import { readJsonFile } from "../core/fs/json-file.js";
import { appendEvent } from "../core/events/event-log.js";
import {
  kaironEventTypes,
  type KaironEvent,
  type KaironEventDraft
} from "../core/events/event-types.js";
import { materializeEvent } from "./materializers.js";
import { acquireStateLock, releaseStateLock } from "./state-lock.js";

export type ApplyResult = {
  appliedEventIds: string[];
};

export type Outbox = {
  schema_version: string;
  run_id: string;
  task_id?: string;
  agent?: string;
  persona?: string;
  status: string;
  events?: Array<{
    type: KaironEventDraft["type"];
    task_id?: string;
    run_id?: string;
    payload?: Record<string, unknown>;
  }>;
  approvals?: Array<Record<string, unknown>>;
};

export type InternalCommand =
  | {
      type: "approval.confirmation.request";
      approval_id: string;
      action: "approve";
      confirmation: "board" | "local";
      reason: string;
      actor?: unknown;
      discord?: Record<string, unknown>;
      received_at?: string;
    }
  | {
      type: "approval.decide";
      approval_id: string;
      decision: "approve" | "reject" | "request_changes";
      reason?: string;
      actor?: unknown;
      received_at?: string;
    }
  | {
      type: "approval.snooze";
      approval_id: string;
      until: string;
      reason?: string;
      actor?: unknown;
      received_at?: string;
    }
  | {
      type: "schedule.close_active_work";
      date: string;
      reason: string;
      actor?: unknown;
      received_at?: string;
    };

const outboxSchema = z.object({
  schema_version: z.string().min(1),
  run_id: z.string().min(1),
  task_id: z.string().optional(),
  agent: z.string().optional(),
  persona: z.string().optional(),
  status: z.string().min(1),
  events: z
    .array(
      z.object({
        type: z.enum(kaironEventTypes),
        task_id: z.string().optional(),
        run_id: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional()
      })
    )
    .optional(),
  approvals: z.array(z.record(z.string(), z.unknown())).optional()
});

export class StateApplier {
  constructor(private readonly projectRoot: string) {}

  async applyOutbox(outboxPath: string): Promise<ApplyResult> {
    const rawOutbox = await readJsonFile<unknown>(outboxPath);
    const outbox = outboxSchema.parse(rawOutbox) satisfies Outbox;
    const events: KaironEventDraft[] = [
      {
        type: "run.completed",
        task_id: outbox.task_id,
        run_id: outbox.run_id,
        actor: outbox.agent,
        payload: {
          status: outbox.status,
          persona: outbox.persona,
          outbox: outboxPath
        }
      },
      ...(outbox.events ?? []).map((event) => ({
        type: event.type,
        task_id: event.task_id ?? outbox.task_id,
        run_id: event.run_id ?? outbox.run_id,
        actor: outbox.agent,
        payload: event.payload
      })),
      ...(outbox.approvals ?? []).map((approval) => ({
        type: "approval.requested" as const,
        task_id: outbox.task_id,
        run_id: outbox.run_id,
        actor: outbox.agent,
        payload: { approval }
      }))
    ];

    return this.applyEvents(events);
  }

  async applyCommand(command: InternalCommand): Promise<ApplyResult> {
    if (command.type === "approval.confirmation.request") {
      return this.applyEvents([
        {
          type: "approval.confirmation_requested",
          payload: {
            approval_id: command.approval_id,
            action: command.action,
            confirmation: command.confirmation,
            reason: command.reason,
            actor: command.actor,
            discord: command.discord
          },
          created_at: command.received_at
        }
      ]);
    }

    if (command.type === "approval.decide") {
      return this.applyEvents([
        {
          type: "approval.decided",
          payload: {
            approval_id: command.approval_id,
            decision: command.decision,
            reason: command.reason,
            actor: command.actor
          },
          created_at: command.received_at
        }
      ]);
    }

    if (command.type === "approval.snooze") {
      return this.applyEvents([
        {
          type: "approval.snoozed",
          payload: {
            approval_id: command.approval_id,
            until: command.until,
            reason: command.reason,
            actor: command.actor
          },
          created_at: command.received_at
        }
      ]);
    }

    return this.applyEvents([
      {
        type: "schedule.override.created",
        payload: {
          date: command.date,
          active_work_closed: true,
          reason: command.reason,
          created_by: command.actor
        },
        created_at: command.received_at
      },
      {
        type: "active_work.closed",
        payload: {
          date: command.date,
          reason: command.reason,
          actor: command.actor
        },
        created_at: command.received_at
      }
    ]);
  }

  async appendEvent(draft: KaironEventDraft): Promise<KaironEvent> {
    const event = (await this.applyEvents([draft])).events[0];

    if (event === undefined) {
      throw new Error("StateApplier failed to append event");
    }

    return event;
  }

  private async applyEvents(
    drafts: KaironEventDraft[]
  ): Promise<ApplyResult & { events: KaironEvent[] }> {
    const lock = await acquireStateLock(this.projectRoot);
    const appliedEventIds: string[] = [];
    const events: KaironEvent[] = [];

    try {
      for (const draft of drafts) {
        const event = await appendEvent(this.projectRoot, draft);
        await materializeEvent(this.projectRoot, event);
        appliedEventIds.push(event.event_id);
        events.push(event);
      }
    } finally {
      await releaseStateLock(lock);
    }

    return { appliedEventIds, events };
  }
}
