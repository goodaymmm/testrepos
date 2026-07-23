import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  workflowCheckpointFencingToken,
  workflowCheckpointStateHash,
  workflowCheckpointsDirectory,
  type WorkflowCheckpointIssue,
  type WorkflowCheckpointRecord,
  type WorkflowCheckpointScanResult,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite
} from "./checkpoint-store.js";
import type { WorkflowRunArtifact } from "./types.js";

const checkpointFilePattern = /^(.+)-(\d{6,})\.json$/u;

export class FileWorkflowCheckpointStore implements WorkflowCheckpointStore {
  readonly adapter = "file" as const;

  constructor(private readonly projectRoot: string) {}

  async upsert(write: WorkflowCheckpointWrite): Promise<void> {
    const metadata = write.artifact.checkpoint;
    if (
      metadata === undefined ||
      metadata.state_hash !== write.record.state_hash ||
      metadata.fencing_token !== write.record.fencing_token ||
      metadata.checkpoint_path !== write.record.checkpoint_path
    ) {
      throw new Error("Workflow checkpoint write metadata is inconsistent.");
    }
    await writeJsonFileAtomic(
      resolveInside(this.projectRoot, write.record.checkpoint_path),
      write.artifact
    );
  }

  async scan(): Promise<WorkflowCheckpointScanResult> {
    let entries;
    try {
      entries = await readdir(workflowCheckpointsDirectory(this.projectRoot), {
        withFileTypes: true
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { adapter: this.adapter, records: [], issues: [] };
      }
      throw error;
    }

    const records: WorkflowCheckpointRecord[] = [];
    const issues: WorkflowCheckpointIssue[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const checkpointPath = path.join(
        workflowCheckpointsDirectory(this.projectRoot),
        entry.name
      );
      const projectPath = toPosixPath(
        path.relative(this.projectRoot, checkpointPath)
      );
      const match = checkpointFilePattern.exec(entry.name);
      if (match === null) {
        issues.push({
          kind: "invalid_checkpoint_file",
          checkpoint_path: projectPath,
          message: "Checkpoint filename does not contain workflow id and sequence."
        });
        continue;
      }

      try {
        const artifact = await readJsonFile<WorkflowRunArtifact>(checkpointPath);
        const filenameWorkflowId = match[1];
        const filenameSequence = Number.parseInt(match[2], 10);
        if (
          artifact.workflow_id !== filenameWorkflowId ||
          artifact.sequence !== filenameSequence
        ) {
          issues.push({
            kind: "file_sequence_mismatch",
            workflow_id: artifact.workflow_id,
            sequence: artifact.sequence,
            checkpoint_path: projectPath,
            message: "Checkpoint filename and artifact identity do not match."
          });
        }

        const stateHash = workflowCheckpointStateHash(artifact);
        const fencingToken = workflowCheckpointFencingToken(artifact);
        if (
          artifact.checkpoint !== undefined &&
          artifact.checkpoint.state_hash !== stateHash
        ) {
          issues.push({
            kind: "file_hash_mismatch",
            workflow_id: artifact.workflow_id,
            sequence: artifact.sequence,
            checkpoint_path: projectPath,
            message: "Checkpoint state hash does not match canonical JSON."
          });
        }
        if (
          artifact.checkpoint !== undefined &&
          artifact.checkpoint.fencing_token !== fencingToken
        ) {
          issues.push({
            kind: "file_fencing_mismatch",
            workflow_id: artifact.workflow_id,
            sequence: artifact.sequence,
            checkpoint_path: projectPath,
            message: "Checkpoint fencing token does not match node locks."
          });
        }
        if (
          artifact.checkpoint !== undefined &&
          artifact.checkpoint.checkpoint_path !== projectPath
        ) {
          issues.push({
            kind: "invalid_checkpoint_file",
            workflow_id: artifact.workflow_id,
            sequence: artifact.sequence,
            checkpoint_path: projectPath,
            message: "Checkpoint metadata path does not match its file path."
          });
        }

        records.push({
          schema_version: "0.1",
          workflow_id: artifact.workflow_id,
          sequence: artifact.sequence,
          state_hash: stateHash,
          fencing_token: fencingToken,
          checkpoint_path: projectPath,
          recorded_at:
            artifact.checkpoint?.recorded_at ?? artifact.updated_at
        });
      } catch (error) {
        issues.push({
          kind: "invalid_checkpoint_file",
          checkpoint_path: projectPath,
          message: sanitizeCheckpointReadError(error)
        });
      }
    }

    records.sort(
      (left, right) =>
        left.workflow_id.localeCompare(right.workflow_id) ||
        left.sequence - right.sequence
    );
    return { adapter: this.adapter, records, issues };
  }

  async replace(_records: WorkflowCheckpointRecord[]): Promise<void> {
    throw new Error("Canonical file checkpoints cannot be replaced through rebuild.");
  }

  async close(): Promise<void> {}
}

function sanitizeCheckpointReadError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined
    ? "Checkpoint JSON is unreadable or invalid."
    : `Checkpoint JSON read failed with ${code}.`;
}
