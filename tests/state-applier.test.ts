import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import { StateApplier } from "../src/state/state-applier.js";
import { createTempProject } from "./test-utils.js";

describe("StateApplier", () => {
  it("materializes task, message, approval, and schedule state", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const applier = new StateApplier(root);

    await applier.appendEvent({
      type: "task.created",
      task_id: "TASK-0001",
      payload: {
        task: {
          id: "TASK-0001",
          title: "Create approval queue",
          status: "ready"
        }
      }
    });

    await applier.appendEvent({
      type: "message.created",
      task_id: "TASK-0001",
      payload: {
        message_type: "implementation.result",
        body: "Implemented."
      }
    });

    await applier.appendEvent({
      type: "approval.requested",
      task_id: "TASK-0001",
      payload: {
        approval: {
          id: "APR-0001",
          type: "merge",
          title: "Merge approval"
        }
      }
    });

    await applier.applyCommand({
      type: "approval.decide",
      approval_id: "APR-0001",
      decision: "approve",
      actor: { mapped_user_id: "user:owner" }
    });

    await applier.applyCommand({
      type: "schedule.close_active_work",
      date: "2026-05-24",
      reason: "test",
      actor: { mapped_user_id: "user:owner" }
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"))
    ).resolves.toMatchObject({
      id: "TASK-0001",
      title: "Create approval queue"
    });

    await expect(
      readJsonLines(path.join(root, ".kairon", "messages", "TASK-0001.jsonl"))
    ).resolves.toHaveLength(1);

    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "decided",
      decision: "approve"
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "state", "schedule_override.json"))
    ).resolves.toMatchObject({
      active_work_closed: true,
      reason: "test"
    });
  });

  it("materializes approval snooze commands", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const applier = new StateApplier(root);

    await applier.appendEvent({
      type: "approval.requested",
      task_id: "TASK-0001",
      payload: {
        approval: {
          id: "APR-0001",
          type: "merge",
          title: "Merge approval"
        }
      }
    });
    await applier.applyCommand({
      type: "approval.snooze",
      approval_id: "APR-0001",
      until: "2026-05-26T09:00:00.000Z",
      reason: "review later"
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0001.json"))
    ).resolves.toMatchObject({
      status: "snoozed",
      snooze_until: "2026-05-26T09:00:00.000Z",
      reason: "review later"
    });
  });

  it("preserves high-risk approval metadata when materializing requests", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const applier = new StateApplier(root);

    await applier.appendEvent({
      type: "approval.requested",
      task_id: "TASK-0001",
      payload: {
        approval: {
          id: "APR-HIGH",
          type: "deploy",
          risk_level: "high",
          title: "Deploy approval"
        }
      }
    });

    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-HIGH.json"))
    ).resolves.toMatchObject({
      id: "APR-HIGH",
      status: "pending",
      type: "deploy",
      risk_level: "high"
    });
  });

  it("applies outbox events and approvals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0001", "outbox.json");
    await mkdir(path.dirname(outboxPath), { recursive: true });
    await writeJsonFileAtomic(outboxPath, {
      schema_version: "0.1",
      run_id: "RUN-0001",
      task_id: "TASK-0002",
      agent: "codex",
      persona: "implementer",
      status: "completed",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "implementation.result",
            body: "Done."
          }
        }
      ],
      approvals: [
        {
          id: "APR-0002",
          title: "Merge approval",
          type: "merge"
        }
      ]
    });

    const result = await new StateApplier(root).applyOutbox(outboxPath);

    expect(result.appliedEventIds.length).toBe(3);
    await expect(
      readJsonLines(path.join(root, ".kairon", "messages", "TASK-0002.jsonl"))
    ).resolves.toHaveLength(1);
    await expect(
      readJsonFile(path.join(root, ".kairon", "approvals", "APR-0002.json"))
    ).resolves.toMatchObject({
      status: "pending",
      type: "merge"
    });
  });

  it("rejects invalid outbox files", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0003", "outbox.json");
    await mkdir(path.dirname(outboxPath), { recursive: true });
    await writeJsonFileAtomic(outboxPath, {
      schema_version: "0.1",
      status: "completed"
    });

    await expect(new StateApplier(root).applyOutbox(outboxPath)).rejects.toThrow();
  });
});
