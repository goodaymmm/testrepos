import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  stateCheckCommand,
  stateSnapshotCommand
} from "../src/cli/commands/state.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { appendJsonLine } from "../src/core/fs/jsonl-file.js";
import {
  checkStateIntegrity,
  formatStateIntegrityCheck
} from "../src/state/integrity-check.js";
import { collectStateSnapshotDryRun } from "../src/state/snapshot.js";
import { createTempProject } from "./test-utils.js";

describe("state integrity", () => {
  it("passes a healthy initialized state and reports snapshot targets", async () => {
    const root = await createInitializedProject();
    await seedHealthyState(root);

    const result = await checkStateIntegrity(root, {
      now: () => new Date("2026-06-14T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      status: "ok",
      summary: {
        errors: 0,
        warnings: 0
      },
      issues: []
    });
    expect(formatStateIntegrityCheck(result)).toContain("issues=none");

    const snapshot = await collectStateSnapshotDryRun(root, {
      now: () => new Date("2026-06-14T00:00:00.000Z")
    });
    expect(snapshot.dry_run).toBe(true);
    expect(snapshot.summary.files).toBeGreaterThan(0);
    expect(snapshot.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".kairon/tasks/TASK-0001/task.json",
          category: "tasks"
        }),
        expect.objectContaining({
          path: ".kairon/runs/RUN-0001/outbox.json",
          category: "runs"
        })
      ])
    );
  });

  it("reports corrupt JSON and JSONL without throwing a stack trace", async () => {
    const root = await createInitializedProject();
    await mkdir(path.join(root, ".kairon", "approvals"), { recursive: true });
    await writeFile(
      path.join(root, ".kairon", "approvals", "APR-BROKEN.json"),
      "{ broken json",
      "utf8"
    );
    await mkdir(path.join(root, ".kairon", "events"), { recursive: true });
    await writeFile(
      path.join(root, ".kairon", "events", "2026-06-14.jsonl"),
      "{\"schema_version\":\"0.1\"}\n{ broken jsonl\n",
      "utf8"
    );

    const output = await stateCheckCommand(root);

    expect(output).toContain("status=issues_found");
    expect(output).toContain("ERROR json_parse_error");
    expect(output).toContain("ERROR jsonl_parse_error");
    expect(output).not.toContain("at ");
    expect(output).not.toContain("Stack");
  });

  it("detects missing references and id mismatches", async () => {
    const root = await createInitializedProject();
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-0001.json"),
      {
        schema_version: "0.1",
        id: "APR-DIFFERENT",
        status: "pending",
        task_id: "TASK-MISSING",
        run_id: "RUN-MISSING"
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "reviews", "results", "REV-0001.json"),
      {
        schema_version: "0.1",
        review_id: "REV-0001",
        run_id: "RUN-MISSING"
      }
    );

    const result = await checkStateIntegrity(root);
    const json = formatStateIntegrityCheck(result, { format: "json" });

    expect(result.status).toBe("issues_found");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "id_mismatch",
          path: ".kairon/approvals/APR-0001.json"
        }),
        expect.objectContaining({
          code: "missing_reference",
          reference: "task:TASK-MISSING"
        }),
        expect.objectContaining({
          code: "missing_reference",
          reference: "run:RUN-MISSING"
        })
      ])
    );
    expect(JSON.parse(json)).toMatchObject({
      status: "issues_found"
    });
  });

  it("formats CLI check and snapshot dry-run output", async () => {
    const root = await createInitializedProject();
    await seedHealthyState(root);

    await expect(stateCheckCommand(root, { format: "json" })).resolves.toContain(
      "\"status\": \"ok\""
    );
    await expect(stateSnapshotCommand(root)).resolves.toContain(
      "status=not_implemented"
    );

    const snapshotText = await stateSnapshotCommand(root, { dryRun: true });
    expect(snapshotText).toContain("Kairon state snapshot dry-run.");
    expect(snapshotText).toContain("target category=tasks");

    const snapshotJson = await stateSnapshotCommand(root, {
      dryRun: true,
      format: "json"
    });
    expect(JSON.parse(snapshotJson)).toMatchObject({
      dry_run: true
    });
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function seedHealthyState(root: string): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"),
    {
      schema_version: "0.1",
      id: "TASK-0001",
      status: "ready",
      title: "State integrity smoke"
    }
  );
  const runDir = path.join(root, ".kairon", "runs", "RUN-0001");
  await mkdir(runDir, { recursive: true });
  await writeJsonFileAtomic(path.join(runDir, "runner.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    status: "completed"
  });
  await writeJsonFileAtomic(path.join(runDir, "outbox.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    status: "completed"
  });
  await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
    schema_version: "0.1",
    id: "APR-0001",
    status: "pending",
    task_id: "TASK-0001",
    run_id: "RUN-0001"
  });
  await appendJsonLine(path.join(root, ".kairon", "events", "2026-06-14.jsonl"), {
    schema_version: "0.1",
    event_id: "EVT-0001",
    type: "task.created",
    task_id: "TASK-0001",
    created_at: "2026-06-14T00:00:00.000Z"
  });
}
