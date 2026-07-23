import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  workflowCheckpointRebuildCommand,
  workflowCheckpointStatusCommand,
  workflowCheckpointVerifyCommand
} from "../src/cli/commands/workflow.js";
import {
  acquireResourceLock,
  releaseResourceLock
} from "../src/core/fs/resource-lock.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import {
  executeWorkflowCheckpointRebuild,
  inspectWorkflowCheckpointStore,
  planWorkflowCheckpointRebuild,
  verifyWorkflowCheckpointStore
} from "../src/workflow/checkpoint-manager.js";
import { SqliteWorkflowCheckpointStore } from "../src/workflow/checkpoint-sqlite-store.js";
import {
  workflowCheckpointRebuildPath,
  workflowCheckpointSqlitePath
} from "../src/workflow/checkpoint-store.js";
import {
  ProductionWorkflowRuntime,
  workflowCheckpointPath
} from "../src/workflow/runtime.js";
import type { WorkflowRunArtifact } from "../src/workflow/types.js";
import { createTempProject } from "./test-utils.js";

describe("workflow checkpoint store", () => {
  it("keeps canonical file checkpoints as the default replay source", async () => {
    const root = await createInitializedProject("file");
    const taskId = await createTask(root);

    const result = await new ProductionWorkflowRuntime(root).run({
      workflowId: "WF-T169-FILE",
      taskId
    });
    const checkpoint = await readJsonFile<WorkflowRunArtifact>(
      workflowCheckpointPath(root, "WF-T169-FILE", 1)
    );
    const verification = await verifyWorkflowCheckpointStore(root);

    expect(result.artifact.checkpoint).toMatchObject({
      schema_version: "0.1",
      checkpoint_path: ".kairon/workflows/checkpoints/WF-T169-FILE-000001.json"
    });
    expect(checkpoint.checkpoint?.state_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification).toMatchObject({
      status: "verified",
      configured_store: "file",
      canonical_records: 1,
      indexed_records: 0,
      rebuild_required: false
    });
    await expect(workflowCheckpointStatusCommand(root)).resolves.toContain(
      "status=healthy"
    );
    await expect(workflowCheckpointVerifyCommand(root)).resolves.toContain(
      "status=verified"
    );
  });

  it("mirrors checkpoints to SQLite and rebuilds a deleted index with exact confirmation", async () => {
    const root = await createInitializedProject("file+sqlite");
    const taskId = await createTask(root);
    await new ProductionWorkflowRuntime(root).run({
      workflowId: "WF-T169-REBUILD",
      taskId
    });
    const sqlitePath = checkpointSqlitePath(root);

    await expect(verifyWorkflowCheckpointStore(root)).resolves.toMatchObject({
      status: "verified",
      canonical_records: 1,
      indexed_records: 1
    });
    await removeSqlite(sqlitePath);
    await expect(verifyWorkflowCheckpointStore(root)).resolves.toMatchObject({
      status: "mismatch",
      rebuild_required: true,
      summary: { missing_rows: 1 }
    });

    const plan = await planWorkflowCheckpointRebuild(root, process.env, {
      now: () => new Date("2026-07-23T01:02:03.004Z")
    });
    expect(plan).toMatchObject({
      status: "planned",
      dry_run: true,
      source: { records: 1 }
    });
    await expect(fileExists(sqlitePath)).resolves.toBe(false);
    await expect(
      executeWorkflowCheckpointRebuild(root, "WCR-WRONG")
    ).rejects.toThrow("Invalid workflow checkpoint rebuild id");

    const rebuilt = await executeWorkflowCheckpointRebuild(
      root,
      plan.rebuild_id,
      process.env,
      { now: () => new Date("2026-07-23T01:03:00.000Z") }
    );
    expect(rebuilt).toMatchObject({
      status: "completed",
      dry_run: false,
      result: { indexed_records: 1 }
    });
    await expect(verifyWorkflowCheckpointStore(root)).resolves.toMatchObject({
      status: "verified",
      canonical_records: 1,
      indexed_records: 1
    });
    await expect(
      readJsonFile(workflowCheckpointRebuildPath(root, plan.rebuild_id))
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("detects index checksum and canonical fencing mismatches", async () => {
    const root = await createInitializedProject("file+sqlite");
    const taskId = await createTask(root);
    await new ProductionWorkflowRuntime(root).run({
      workflowId: "WF-T169-MISMATCH",
      taskId,
      resourceKeys: ["src/t169-lock.ts"]
    });

    const sqlite = await SqliteWorkflowCheckpointStore.open(
      checkpointSqlitePath(root),
      { busyTimeoutMs: 500 }
    );
    try {
      const scan = await sqlite.scan();
      await sqlite.upsert({
        record: { ...scan.records[0], state_hash: "0".repeat(64) },
        artifact: {} as WorkflowRunArtifact
      });
    } finally {
      await sqlite.close();
    }
    const indexMismatch = await verifyWorkflowCheckpointStore(root);
    expect(indexMismatch.status).toBe("mismatch");
    expect(indexMismatch.issues.map((issue) => issue.kind)).toContain(
      "index_hash_mismatch"
    );

    const checkpointPath = workflowCheckpointPath(
      root,
      "WF-T169-MISMATCH",
      1
    );
    const checkpoint = await readJsonFile<WorkflowRunArtifact>(checkpointPath);
    checkpoint.nodes[1].resource_locks[0].fencing_token = "tampered-fence";
    await writeJsonFileAtomic(checkpointPath, checkpoint);
    const canonicalMismatch = await verifyWorkflowCheckpointStore(root);
    expect(canonicalMismatch.status).toBe("failed");
    expect(canonicalMismatch.rebuild_required).toBe(false);
    expect(canonicalMismatch.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(["file_hash_mismatch", "file_fencing_mismatch"])
    );
  });

  it("records a locked SQLite mirror as degraded without failing the workflow", async () => {
    const root = await createInitializedProject("file+sqlite");
    const taskId = await createTask(root);
    const lock = await acquireResourceLock(
      root,
      "workflow-checkpoint-sqlite",
      {
        owner: "T169-lock-test",
        now: new Date(),
        ttlMs: 60_000
      }
    );
    try {
      const result = await new ProductionWorkflowRuntime(root).run({
        workflowId: "WF-T169-LOCKED",
        taskId
      });
      expect(result.artifact.sequence).toBe(1);
      await expect(
        fileExists(workflowCheckpointPath(root, "WF-T169-LOCKED", 1))
      ).resolves.toBe(true);
      await expect(inspectWorkflowCheckpointStore(root)).resolves.toMatchObject({
        status: "rebuild_required",
        rebuild_required: true,
        error_code: "sqlite_busy"
      });
    } finally {
      await releaseResourceLock(lock);
    }
  });

  it("keeps canonical progress when SQLite itself is busy", async () => {
    const root = await createInitializedProject("file+sqlite");
    const firstTaskId = await createTask(root);
    await new ProductionWorkflowRuntime(root).run({
      workflowId: "WF-T169-BUSY-FIRST",
      taskId: firstTaskId
    });
    const { DatabaseSync } = await import("node:sqlite");
    const blocker = new DatabaseSync(checkpointSqlitePath(root), {
      timeout: 0
    });
    blocker.exec("BEGIN EXCLUSIVE;");
    try {
      const secondTaskId = await createTask(root);
      const result = await new ProductionWorkflowRuntime(root).run({
        workflowId: "WF-T169-BUSY-SECOND",
        taskId: secondTaskId
      });
      expect(result.artifact.sequence).toBe(1);
      await expect(
        fileExists(workflowCheckpointPath(root, "WF-T169-BUSY-SECOND", 1))
      ).resolves.toBe(true);
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }
    await expect(inspectWorkflowCheckpointStore(root)).resolves.toMatchObject({
      status: "rebuild_required",
      error_code: "sqlite_busy"
    });
  });

  it("initializes metadata for a compatible pre-metadata SQLite schema", async () => {
    const root = await createInitializedProject("file+sqlite");
    const sqlitePath = checkpointSqlitePath(root);
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(sqlitePath);
    legacy.exec(`
      CREATE TABLE workflow_checkpoints (
        workflow_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        state_hash TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        checkpoint_path TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, sequence)
      );
    `);
    legacy.close();

    const migrated = await SqliteWorkflowCheckpointStore.open(sqlitePath, {
      busyTimeoutMs: 200,
      create: false
    });
    await migrated.close();

    const inspected = new DatabaseSync(sqlitePath);
    const metadata = inspected
      .prepare(
        "SELECT value FROM checkpoint_store_metadata WHERE key = 'schema_version'"
      )
      .get() as { value: string };
    inspected.close();
    expect(metadata.value).toBe("1");
  });

  it("replaces a corrupt SQLite mirror from verified canonical files", async () => {
    const root = await createInitializedProject("file+sqlite");
    const taskId = await createTask(root);
    await new ProductionWorkflowRuntime(root).run({
      workflowId: "WF-T169-CORRUPT",
      taskId
    });
    const sqlitePath = checkpointSqlitePath(root);
    await removeSqlite(sqlitePath);
    await writeFile(sqlitePath, "not-a-sqlite-database", "utf8");

    const verification = await verifyWorkflowCheckpointStore(root);
    expect(verification.status).toBe("mismatch");
    expect(verification.rebuild_required).toBe(true);
    expect(verification.issues.map((issue) => issue.kind)).toContain(
      "sqlite_unavailable"
    );

    const dryRunText = await workflowCheckpointRebuildCommand(root, {
      dryRun: true
    });
    const rebuildId = /rebuild_id=(WCR-[^\s]+)/u.exec(dryRunText)?.[1];
    expect(rebuildId).toBeDefined();
    await expect(
      workflowCheckpointRebuildCommand(root, {
        dryRun: true,
        confirm: rebuildId
      })
    ).rejects.toThrow("cannot be combined");
    const rebuiltText = await workflowCheckpointRebuildCommand(root, {
      confirm: rebuildId
    });
    expect(rebuiltText).toContain("status=completed");
    await expect(verifyWorkflowCheckpointStore(root)).resolves.toMatchObject({
      status: "verified"
    });
  });
});

async function createInitializedProject(
  checkpointStore: "file" | "file+sqlite"
): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const runtimePath = path.join(root, ".kairon", "config", "runtime.json");
  const runtime = await readJsonFile<Record<string, unknown>>(runtimePath);
  const workflow = runtime.workflow as Record<string, unknown>;
  workflow.enabled = true;
  workflow.checkpoint_store = checkpointStore;
  workflow.checkpoint_sqlite_busy_timeout_ms = 200;
  await writeJsonFileAtomic(runtimePath, runtime);
  return root;
}

async function createTask(root: string): Promise<string> {
  const task = await new TaskRunner(root, {
    now: () => new Date("2026-07-23T00:00:00.000Z")
  }).createTask({
    title: "T169 checkpoint task",
    persona: "researcher"
  });
  return task.task_id;
}

function checkpointSqlitePath(root: string): string {
  return workflowCheckpointSqlitePath(
    root,
    ".kairon/workflows/checkpoints.sqlite"
  );
}

async function removeSqlite(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
