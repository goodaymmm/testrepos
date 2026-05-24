import { CommandInbox } from "../../queue/command-inbox.js";
import { loadConfigFile } from "../../core/config/load-config.js";
import { StateApplier } from "../../state/state-applier.js";
import {
  getLocalDateKey,
  type ScheduleConfig
} from "../../runtime/schedule-engine.js";

export async function closeActiveWork(projectRoot: string): Promise<string> {
  const now = new Date();
  const schedule = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  const today = getLocalDateKey(now, schedule.timezone);
  const command = {
    type: "schedule.close_active_work" as const,
    date: today,
    reason: "user_leave_command",
    actor: { mapped_user_id: "user:owner" },
    received_at: now.toISOString()
  };

  const inbox = new CommandInbox(projectRoot);
  const result = await inbox.enqueue(command, {
    idempotencyKey: `local:kairon-leave:${today}`
  });

  if (!result.duplicate) {
    const applyResult = await new StateApplier(projectRoot).applyCommand(command);
    await inbox.complete(result.envelope.command_id, {
      applied_event_ids: applyResult.appliedEventIds
    });
  }

  return result.duplicate
    ? "Active Work is already closed for today."
    : "Active Work closed for today.";
}
