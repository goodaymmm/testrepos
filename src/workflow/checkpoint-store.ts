import { createHash } from "node:crypto";
import path from "node:path";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import type { WorkflowRunArtifact } from "./types.js";

export type WorkflowCheckpointAdapterKind = "file" | "sqlite";

export type WorkflowCheckpointRecord = {
  schema_version: "0.1";
  workflow_id: string;
  sequence: number;
  state_hash: string;
  fencing_token: string;
  checkpoint_path: string;
  recorded_at: string;
};

export type WorkflowCheckpointWrite = {
  record: WorkflowCheckpointRecord;
  artifact: WorkflowRunArtifact;
};

export type WorkflowCheckpointIssueKind =
  | "invalid_checkpoint_file"
  | "file_hash_mismatch"
  | "file_fencing_mismatch"
  | "file_sequence_mismatch"
  | "missing_index_row"
  | "orphan_index_row"
  | "index_hash_mismatch"
  | "index_fencing_mismatch"
  | "index_path_mismatch"
  | "sqlite_unavailable";

export type WorkflowCheckpointIssue = {
  kind: WorkflowCheckpointIssueKind;
  workflow_id?: string;
  sequence?: number;
  checkpoint_path?: string;
  message: string;
};

export type WorkflowCheckpointScanResult = {
  adapter: WorkflowCheckpointAdapterKind;
  records: WorkflowCheckpointRecord[];
  issues: WorkflowCheckpointIssue[];
};

export interface WorkflowCheckpointStore {
  readonly adapter: WorkflowCheckpointAdapterKind;
  upsert(write: WorkflowCheckpointWrite): Promise<void>;
  scan(): Promise<WorkflowCheckpointScanResult>;
  replace(records: WorkflowCheckpointRecord[]): Promise<void>;
  close(): Promise<void>;
}

export function prepareWorkflowCheckpoint(
  projectRoot: string,
  artifact: WorkflowRunArtifact,
  recordedAt: string
): WorkflowCheckpointWrite {
  const checkpointPath = workflowCheckpointPath(
    projectRoot,
    artifact.workflow_id,
    artifact.sequence
  );
  const projectPath = toProjectPath(projectRoot, checkpointPath);
  artifact.recovery.last_checkpoint_path = projectPath;
  const fencingToken = workflowCheckpointFencingToken(artifact);
  const stateHash = workflowCheckpointStateHash(artifact);
  artifact.checkpoint = {
    schema_version: "0.1",
    state_hash: stateHash,
    fencing_token: fencingToken,
    checkpoint_path: projectPath,
    recorded_at: recordedAt
  };
  return {
    artifact,
    record: {
      schema_version: "0.1",
      workflow_id: artifact.workflow_id,
      sequence: artifact.sequence,
      state_hash: stateHash,
      fencing_token: fencingToken,
      checkpoint_path: projectPath,
      recorded_at: recordedAt
    }
  };
}

export function workflowCheckpointStateHash(
  artifact: WorkflowRunArtifact
): string {
  const comparable = structuredClone(artifact);
  delete comparable.checkpoint;
  return createHash("sha256")
    .update(JSON.stringify(comparable))
    .digest("hex");
}

export function workflowCheckpointFencingToken(
  artifact: WorkflowRunArtifact
): string {
  const tokens = artifact.nodes
    .flatMap((node) => node.resource_locks.map((lock) => lock.fencing_token))
    .sort();
  if (tokens.length === 0) {
    return "none";
  }
  if (tokens.length === 1) {
    return tokens[0];
  }
  return `multi:${createHash("sha256").update(tokens.join("\n")).digest("hex")}`;
}

export function workflowCheckpointsDirectory(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "checkpoints"
  );
}

export function workflowCheckpointPath(
  projectRoot: string,
  workflowId: string,
  sequence: number
): string {
  return resolveInside(
    workflowCheckpointsDirectory(projectRoot),
    `${workflowId}-${String(sequence).padStart(6, "0")}.json`
  );
}

export function workflowCheckpointSqlitePath(
  projectRoot: string,
  configuredPath: string
): string {
  if (path.isAbsolute(configuredPath)) {
    throw new Error("Workflow checkpoint sqlite path must be project-relative.");
  }
  const candidate = resolveInside(projectRoot, configuredPath);
  const workflowsRoot = resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows"
  );
  if (path.extname(candidate).toLowerCase() !== ".sqlite") {
    throw new Error("Workflow checkpoint sqlite path must end with .sqlite.");
  }
  try {
    return resolveInside(workflowsRoot, candidate);
  } catch {
    throw new Error(
      "Workflow checkpoint sqlite path must stay under .kairon/workflows."
    );
  }
}

export function workflowCheckpointStoreStatusPath(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "checkpoint-store-status.json"
  );
}

export function workflowCheckpointRebuildDirectory(projectRoot: string): string {
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "workflows",
    "checkpoint-rebuild"
  );
}

export function workflowCheckpointRebuildPath(
  projectRoot: string,
  rebuildId: string
): string {
  return resolveInside(
    workflowCheckpointRebuildDirectory(projectRoot),
    `${rebuildId}.json`
  );
}

export function workflowCheckpointRecordKey(
  record: Pick<WorkflowCheckpointRecord, "workflow_id" | "sequence">
): string {
  return `${record.workflow_id}:${record.sequence}`;
}

export function workflowCheckpointRecordsDigest(
  records: WorkflowCheckpointRecord[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...records].sort(
          (left, right) =>
            left.workflow_id.localeCompare(right.workflow_id) ||
            left.sequence - right.sequence
        )
      )
    )
    .digest("hex");
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(projectRoot, absolutePath));
}
