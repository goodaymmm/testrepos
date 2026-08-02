import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  compareSnapshotToCurrentDiff,
  createDiffSnapshot,
  readDiffSnapshot
} from "../src/git/diff-snapshot.js";
import { createTempProject } from "./test-utils.js";

describe("diff snapshot", () => {
  it("saves changed file metadata and diff hash", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const diff = "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n";

    const snapshot = await createDiffSnapshot(root, {
      taskId: "TASK-0001",
      runId: "RUN-0001",
      branch: "auto/TASK-0001/codex",
      baseSha: "abc123",
      diff,
      changedFiles: [
        {
          path: "src\\a.ts",
          status: "added",
          additions: 1,
          deletions: 0
        }
      ]
    });

    expect(snapshot.diff_sha256).toMatch(/^sha256:/);
    expect(snapshot.changed_files[0]?.path).toBe("src/a.ts");
    await expect(readFile(path.join(root, snapshot.diff_path), "utf8")).resolves.toBe(
      diff
    );
    await expect(
      readJsonFile(path.join(root, ".kairon", "runs", "RUN-0001", "changed-files.json"))
    ).resolves.toMatchObject({
      changed_files: [{ path: "src/a.ts" }]
    });
    await expect(readDiffSnapshot(root, "RUN-0001")).resolves.toMatchObject({
      diff_sha256: snapshot.diff_sha256
    });
  });

  it("detects when review must be rerun after diff changes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const snapshot = await createDiffSnapshot(root, {
      taskId: "TASK-0001",
      runId: "RUN-0002",
      branch: "auto/TASK-0001/codex",
      diff: "old diff",
      changedFiles: []
    });

    await expect(compareSnapshotToCurrentDiff(snapshot, "old diff")).resolves.toMatchObject({
      status: "unchanged",
      next_action: "reuse_review"
    });
    await expect(compareSnapshotToCurrentDiff(snapshot, "new diff")).resolves.toMatchObject({
      status: "changed",
      next_action: "request_review"
    });
  });
});
