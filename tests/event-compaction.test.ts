import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  stateEventsCompactCommand,
  stateEventsVerifyCommand
} from "../src/cli/commands/state.js";
import { appendEvent, readEventHistory } from "../src/core/events/event-log.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  inspectRuntimeRecoveryTargets,
  runRuntimeRecovery
} from "../src/recovery/runtime-recovery.js";
import {
  compactEventLogs,
  EventCompactionSafetyError,
  planEventCompaction,
  verifyEventCompaction,
  type EventCompactionMarker
} from "../src/state/event-compaction.js";
import { checkStateIntegrity } from "../src/state/integrity-check.js";
import { createTempProject } from "./test-utils.js";

const compactionNow = new Date("2026-07-15T12:00:00.000Z");

describe("event log compaction", () => {
  it("snapshots and archives closed segments without changing event history", async () => {
    const root = await createInitializedProject();
    await appendFixtureEvent(root, "2026-07-13T01:00:00.000Z", "closed-one");
    await appendFixtureEvent(root, "2026-07-14T01:00:00.000Z", "closed-two");
    await appendFixtureEvent(root, "2026-07-15T01:00:00.000Z", "active");
    const before = await readEventHistory(root);
    const activePath = path.join(root, ".kairon", "events", "2026-07-15.jsonl");
    const activeContent = await readFile(activePath, "utf8");

    const plan = await planEventCompaction(root, { now: () => compactionNow });
    expect(plan).toMatchObject({
      status: "planned",
      active_date: "2026-07-15",
      summary: { segments: 2, events: 2 }
    });
    expect(plan.checkpoint_id).toMatch(/^ECP-EVT-\d+-[0-9a-f]{12}$/);
    expect(plan.segments.map((segment) => segment.date)).toEqual([
      "2026-07-13",
      "2026-07-14"
    ]);

    const result = await compactEventLogs(root, {
      confirm: plan.checkpoint_id!,
      now: () => compactionNow
    });
    const verification = await verifyEventCompaction(root, result.checkpoint_id, {
      now: () => compactionNow
    });
    const after = await readEventHistory(root);

    expect(result).toMatchObject({
      status: "compacted",
      summary: { segments: 2, events: 2 }
    });
    expect(verification).toMatchObject({
      status: "verified",
      checkpoint_id: result.checkpoint_id,
      snapshot_id: result.snapshot_id,
      summary: { segments: 2, events: 2 }
    });
    expect(after).toEqual(before);
    await expect(readFile(activePath, "utf8")).resolves.toBe(activeContent);
    await expect(
      access(path.join(root, ".kairon", "events", "2026-07-13.jsonl"))
    ).rejects.toThrow();
    await expect(
      access(
        path.join(
          root,
          ".kairon",
          "events",
          "archive",
          result.checkpoint_id,
          "2026-07-13.jsonl"
        )
      )
    ).resolves.toBeUndefined();
    await expect(checkStateIntegrity(root)).resolves.toMatchObject({
      summary: { errors: 0 }
    });
    await expect(
      stateEventsVerifyCommand(root, result.checkpoint_id)
    ).resolves.toContain("status=verified");
  });

  it("requires a fresh deterministic checkpoint confirmation", async () => {
    const root = await createInitializedProject();
    await appendFixtureEvent(root, "2026-07-13T01:00:00.000Z", "first");
    const initial = await planEventCompaction(root, { now: () => compactionNow });

    await expect(stateEventsCompactCommand(root)).rejects.toThrow(
      "requires --dry-run or --confirm"
    );
    await expect(
      stateEventsCompactCommand(root, { dryRun: true })
    ).resolves.toContain("checkpoint_id=");
    await expect(
      compactEventLogs(root, {
        confirm: "ECP-EVT-999999-aaaaaaaaaaaa",
        now: () => compactionNow
      })
    ).rejects.toThrow(EventCompactionSafetyError);

    await appendFixtureEvent(root, "2026-07-14T01:00:00.000Z", "second");
    await expect(
      compactEventLogs(root, {
        confirm: initial.checkpoint_id!,
        now: () => compactionNow
      })
    ).rejects.toThrow("Checkpoint confirmation does not match");
  });

  it("keeps an interrupted move as a recovery target without deleting events", async () => {
    const root = await createInitializedProject();
    await appendFixtureEvent(root, "2026-07-13T01:00:00.000Z", "first");
    await appendFixtureEvent(root, "2026-07-14T01:00:00.000Z", "second");
    const before = await readEventHistory(root);
    const plan = await planEventCompaction(root, { now: () => compactionNow });

    await expect(
      compactEventLogs(root, {
        confirm: plan.checkpoint_id!,
        now: () => compactionNow,
        afterSegmentMoved: async (_segment, movedCount) => {
          if (movedCount === 1) {
            throw new Error("injected interruption");
          }
        }
      })
    ).rejects.toThrow("injected interruption");

    const marker = await readJsonFile<EventCompactionMarker>(
      path.join(root, ".kairon", "runtime", "state-compaction.json")
    );
    expect(marker).toMatchObject({
      checkpoint_id: plan.checkpoint_id,
      status: "moving_segments",
      moved_segments: [".kairon/events/2026-07-13.jsonl"]
    });
    expect(await readEventHistory(root)).toEqual(before);
    await expect(
      access(path.join(root, ".kairon", "events", "2026-07-14.jsonl"))
    ).resolves.toBeUndefined();

    const inspection = await inspectRuntimeRecoveryTargets(root, {
      now: compactionNow
    });
    expect(inspection.summary.state_compaction_issues).toBe(1);
    expect(inspection.issues).toEqual([
      expect.objectContaining({
        kind: "state_compaction_mid_state",
        target_id: plan.checkpoint_id,
        target_type: "state_compaction",
        moved_segments: 1,
        severity: "high"
      })
    ]);

    const recovery = await runRuntimeRecovery(root, {
      now: compactionNow,
      writeNoopArtifact: false
    });
    expect(recovery.summary.state_compaction_issues).toBe(1);
    expect(recovery.summary.approvals_requested).toBe(1);
    await expect(
      access(path.join(root, ".kairon", "runtime", "state-compaction.json"))
    ).resolves.toBeUndefined();
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function appendFixtureEvent(
  root: string,
  createdAt: string,
  body: string
): Promise<unknown> {
  return appendEvent(root, {
    type: "message.created",
    actor: "event-compaction-test",
    created_at: createdAt,
    payload: { body }
  });
}
