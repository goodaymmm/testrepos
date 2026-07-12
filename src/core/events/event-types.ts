export type KaironEventType =
  | "task.created"
  | "message.created"
  | "approval.requested"
  | "approval.confirmation_requested"
  | "approval.decided"
  | "approval.snoozed"
  | "approval.follow_up.updated"
  | "run.completed"
  | "schedule.override.created"
  | "active_work.closed";

export const kaironEventTypes = [
  "task.created",
  "message.created",
  "approval.requested",
  "approval.confirmation_requested",
  "approval.decided",
  "approval.snoozed",
  "approval.follow_up.updated",
  "run.completed",
  "schedule.override.created",
  "active_work.closed"
] as const satisfies readonly KaironEventType[];

export type KaironEventDraft = {
  type: KaironEventType;
  task_id?: string;
  run_id?: string;
  actor?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
  schema_version?: string;
};

export type KaironEvent = KaironEventDraft & {
  event_id: string;
  created_at: string;
  schema_version: string;
};
