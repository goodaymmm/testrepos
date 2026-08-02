import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied";

export type ChangedFile = {
  path: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  previous_path?: string;
};

export type DiffSnapshot = {
  schema_version: string;
  task_id: string;
  run_id: string;
  branch: string;
  base_sha?: string;
  diff_path: string;
  changed_files_path: string;
  snapshot_path: string;
  diff_sha256: string;
  changed_files: ChangedFile[];
  created_at: string;
};

export type CreateDiffSnapshotRequest = {
  taskId: string;
  runId: string;
  branch: string;
  baseSha?: string;
  diff: string;
  changedFiles: ChangedFile[];
};

export type DiffReviewState =
  | {
      status: "unchanged";
      diff_sha256: string;
      next_action: "reuse_review";
    }
  | {
      status: "changed";
      expected_diff_sha256: string;
      actual_diff_sha256: string;
      next_action: "request_review";
    };

export async function createDiffSnapshot(
  projectRoot: string,
  request: CreateDiffSnapshotRequest
): Promise<DiffSnapshot> {
  const paths = getKaironPaths(projectRoot);
  const runDir = resolveInside(paths.runsDir, request.runId);
  const diffPath = resolveInside(runDir, "diff.patch");
  const changedFilesPath = resolveInside(runDir, "changed-files.json");
  const snapshotPath = resolveInside(runDir, "diff-snapshot.json");
  const diffSha256 = sha256(request.diff);
  const snapshot: DiffSnapshot = {
    schema_version: "0.1",
    task_id: request.taskId,
    run_id: request.runId,
    branch: request.branch,
    base_sha: request.baseSha,
    diff_path: toProjectPath(paths.root, diffPath),
    changed_files_path: toProjectPath(paths.root, changedFilesPath),
    snapshot_path: toProjectPath(paths.root, snapshotPath),
    diff_sha256: diffSha256,
    changed_files: normalizeChangedFiles(request.changedFiles),
    created_at: new Date().toISOString()
  };

  await writeTextFile(diffPath, request.diff);
  await writeJsonFileAtomic(changedFilesPath, {
    schema_version: "0.1",
    task_id: request.taskId,
    run_id: request.runId,
    changed_files: snapshot.changed_files
  });
  await writeJsonFileAtomic(snapshotPath, snapshot);

  return snapshot;
}

export async function readDiffSnapshot(
  projectRoot: string,
  runId: string
): Promise<DiffSnapshot> {
  return readJsonFile<DiffSnapshot>(
    resolveInside(getKaironPaths(projectRoot).runsDir, runId, "diff-snapshot.json")
  );
}

export async function compareSnapshotToCurrentDiff(
  snapshot: DiffSnapshot,
  currentDiff: string
): Promise<DiffReviewState> {
  const currentHash = sha256(currentDiff);

  if (currentHash === snapshot.diff_sha256) {
    return {
      status: "unchanged",
      diff_sha256: snapshot.diff_sha256,
      next_action: "reuse_review"
    };
  }

  return {
    status: "changed",
    expected_diff_sha256: snapshot.diff_sha256,
    actual_diff_sha256: currentHash,
    next_action: "request_review"
  };
}

export async function compareSnapshotToStoredDiff(
  projectRoot: string,
  snapshot: DiffSnapshot
): Promise<DiffReviewState> {
  const currentDiff = await readFile(
    resolveInside(projectRoot, snapshot.diff_path),
    "utf8"
  );
  return compareSnapshotToCurrentDiff(snapshot, currentDiff);
}

function normalizeChangedFiles(changedFiles: ChangedFile[]): ChangedFile[] {
  return changedFiles.map((file) => ({
    ...file,
    path: toPosixPath(file.path),
    previous_path:
      file.previous_path === undefined ? undefined : toPosixPath(file.previous_path)
  }));
}

async function writeTextFile(
  filePath: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
