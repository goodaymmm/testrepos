import { createHash } from "node:crypto";
import { mkdir, readFile, rm, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import { nextId } from "../core/ids/counter.js";
import { attachIncidentResource } from "../incidents/store.js";
import { readRuntimeLockStatus } from "../runtime/runtime-lock.js";
import { checkStateIntegrity } from "../state/integrity-check.js";

export type UpdateTransactionAction = "apply" | "rollback";
export type UpdateTransactionPhase =
  | "preflight"
  | "staging"
  | "switch"
  | "post_check"
  | "rollback"
  | "completed";
export type UpdateTransactionStatus =
  | "running"
  | "completed"
  | "rolled_back"
  | "recovery_required";

export type UpdateTransactionTimelineEntry = {
  phase: UpdateTransactionPhase;
  status: "started" | "passed" | "failed";
  code: string;
  recorded_at: string;
};

export type UpdateTransactionArtifact = {
  schema_version: "0.1";
  artifact_kind: "update_transaction";
  transaction_id: string;
  action: UpdateTransactionAction;
  status: UpdateTransactionStatus;
  phase: UpdateTransactionPhase;
  current_version: string;
  target_version: string;
  download_id: string;
  package_sha256: string;
  package_size_bytes: number;
  staging_path: string;
  artifact_path: string;
  state_backup_id?: string;
  rollback_package_sha256?: string;
  error_code?: string;
  incident_id?: string;
  timeline: UpdateTransactionTimelineEntry[];
  created_at: string;
  updated_at: string;
};

export type UpdateTransactionDependencies = {
  now?: () => Date;
  stagingRoot?: string;
  minimumFreeBytes?: number;
  freeSpaceReader?: (directory: string) => Promise<number>;
  runtimeStatusReader?: typeof readRuntimeLockStatus;
  stateIntegrityReader?: typeof checkStateIntegrity;
};

export type BeginUpdateTransactionInput = {
  action: UpdateTransactionAction;
  currentVersion: string;
  targetVersion: string;
  downloadId: string;
  packageSha256: string;
  packageSizeBytes: number;
};

export type UpdateTransactionLifecycleOutcome = {
  status: "completed" | "rolled_back" | "recovery_required";
  phase: UpdateTransactionPhase;
  failedPhase?: UpdateTransactionPhase;
  stateBackupId?: string;
  rollbackPackageSha256?: string;
  errorCode?: string;
};

export type PatchCompatibilityTransactions = {
  update: UpdateTransactionArtifact;
  rollback: UpdateTransactionArtifact;
  reapply: UpdateTransactionArtifact;
};

export type PatchCompatibilityVerification = {
  ok: boolean;
  reasons: string[];
  transaction_ids: [string, string, string];
};

export async function beginUpdateTransaction(
  projectRoot: string,
  input: BeginUpdateTransactionInput,
  deps: UpdateTransactionDependencies = {}
): Promise<UpdateTransactionArtifact> {
  await assertNoActiveUpdateTransaction(projectRoot);
  const now = deps.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const stagingRoot = resolveStagingRoot(deps.stagingRoot);
  await mkdir(stagingRoot, { recursive: true });

  const runtimeStatusReader = deps.runtimeStatusReader ?? readRuntimeLockStatus;
  const runtime = await runtimeStatusReader(projectRoot);
  if (runtime.locked) {
    throw new Error("Update transaction requires the Kairon runtime to be stopped.");
  }

  const stateIntegrityReader = deps.stateIntegrityReader ?? checkStateIntegrity;
  const integrity = await stateIntegrityReader(projectRoot);
  if (integrity.summary.errors > 0) {
    throw new Error(
      `Update transaction preflight found ${integrity.summary.errors} state integrity error(s).`
    );
  }

  const minimumFreeBytes =
    deps.minimumFreeBytes ??
    Math.max(input.packageSizeBytes * 4, 64 * 1024 * 1024);
  const freeBytes = await (deps.freeSpaceReader ?? readFreeBytes)(stagingRoot);
  if (freeBytes < minimumFreeBytes) {
    throw new Error(
      `Update transaction staging requires ${minimumFreeBytes} free bytes; available=${freeBytes}.`
    );
  }

  const transactionId = await nextId(projectRoot, "update_transaction");
  const projectKey = createHash("sha256")
    .update(path.resolve(projectRoot).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  const stagingPath = path.join(stagingRoot, projectKey, transactionId);
  await mkdir(path.dirname(stagingPath), { recursive: true });
  await mkdir(stagingPath, { recursive: false });
  const artifactPath = updateTransactionArtifactPath(projectRoot, transactionId);
  const artifact: UpdateTransactionArtifact = {
    schema_version: "0.1",
    artifact_kind: "update_transaction",
    transaction_id: transactionId,
    action: input.action,
    status: "running",
    phase: "preflight",
    current_version: input.currentVersion,
    target_version: input.targetVersion,
    download_id: input.downloadId,
    package_sha256: input.packageSha256,
    package_size_bytes: input.packageSizeBytes,
    staging_path: stagingPath,
    artifact_path: toPosixPath(path.relative(projectRoot, artifactPath)),
    timeline: [
      {
        phase: "preflight",
        status: "passed",
        code: "preflight_passed",
        recorded_at: timestamp
      },
      {
        phase: "staging",
        status: "started",
        code: "staging_started",
        recorded_at: timestamp
      }
    ],
    created_at: timestamp,
    updated_at: timestamp
  };
  await writeJsonFileAtomic(artifactPath, artifact);
  await writeJsonFileAtomic(updateTransactionMarkerPath(projectRoot), artifact);
  return artifact;
}

export async function finalizeUpdateTransaction(
  projectRoot: string,
  transactionId: string,
  outcome: UpdateTransactionLifecycleOutcome,
  deps: Pick<UpdateTransactionDependencies, "now"> = {}
): Promise<UpdateTransactionArtifact> {
  const transaction = await readUpdateTransaction(projectRoot, transactionId);
  if (transaction.status !== "running") {
    throw new Error(
      `Update transaction ${transactionId} is already ${transaction.status}.`
    );
  }

  const now = deps.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const outcomeTimeline = buildOutcomeTimeline(outcome, timestamp);
  const next: UpdateTransactionArtifact = {
    ...transaction,
    status: outcome.status,
    phase: outcome.phase,
    ...(outcome.stateBackupId === undefined
      ? {}
      : { state_backup_id: outcome.stateBackupId }),
    ...(outcome.rollbackPackageSha256 === undefined
      ? {}
      : { rollback_package_sha256: outcome.rollbackPackageSha256 }),
    ...(outcome.errorCode === undefined ? {} : { error_code: outcome.errorCode }),
    timeline: [
      ...transaction.timeline,
      ...outcomeTimeline
    ],
    updated_at: timestamp
  };

  if (outcome.status === "recovery_required") {
    const incident = await attachIncidentResource(projectRoot, {
      fingerprint: `update-transaction:${transactionId}`,
      severity: "critical",
      title: `Update transaction recovery required: ${transactionId}`,
      summary:
        "The active package or project state could not be restored conclusively. Automatic retry is blocked.",
      resource: {
        kind: "update_transaction",
        id: transactionId,
        status: "recovery_required",
        artifactPath: next.artifact_path,
        severity: "critical",
        details: {
          error_code: outcome.errorCode ?? "rollback_recovery_required",
          current_version: transaction.current_version,
          target_version: transaction.target_version
        }
      },
      now: now()
    });
    next.incident_id = incident.incident_id;
  }

  await writeJsonFileAtomic(
    updateTransactionArtifactPath(projectRoot, transactionId),
    next
  );
  if (outcome.status === "recovery_required") {
    await writeJsonFileAtomic(updateTransactionMarkerPath(projectRoot), next);
  } else {
    await rm(updateTransactionMarkerPath(projectRoot), { force: true });
    await rm(transaction.staging_path, { recursive: true, force: true });
  }
  return next;
}

function buildOutcomeTimeline(
  outcome: UpdateTransactionLifecycleOutcome,
  timestamp: string
): UpdateTransactionTimelineEntry[] {
  if (outcome.status === "completed") {
    return [
      timelineEntry("staging", "passed", "staging_health_passed", timestamp),
      timelineEntry("switch", "passed", "active_switch_completed", timestamp),
      timelineEntry("post_check", "passed", "post_check_passed", timestamp),
      timelineEntry("completed", "passed", "transaction_completed", timestamp)
    ];
  }

  const failedPhase = outcome.failedPhase ?? "switch";
  return [
    timelineEntry(
      failedPhase,
      "failed",
      outcome.errorCode ?? "lifecycle_failed",
      timestamp
    ),
    timelineEntry(
      "rollback",
      outcome.status === "rolled_back" ? "passed" : "failed",
      outcome.status === "rolled_back"
        ? "rollback_completed"
        : "rollback_recovery_required",
      timestamp
    )
  ];
}

function timelineEntry(
  phase: UpdateTransactionPhase,
  status: UpdateTransactionTimelineEntry["status"],
  code: string,
  recordedAt: string
): UpdateTransactionTimelineEntry {
  return {
    phase,
    status,
    code,
    recorded_at: recordedAt
  };
}

export async function readUpdateTransaction(
  projectRoot: string,
  transactionId: string
): Promise<UpdateTransactionArtifact> {
  if (!/^UTX-\d{4,}$/u.test(transactionId)) {
    throw new Error(`Invalid update transaction id: ${transactionId}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        updateTransactionArtifactPath(projectRoot, transactionId),
        "utf8"
      )
    ) as unknown;
  } catch {
    throw new Error(`Update transaction was not found: ${transactionId}`);
  }
  if (!isUpdateTransactionArtifact(value) || value.transaction_id !== transactionId) {
    throw new Error(`Update transaction artifact is invalid: ${transactionId}`);
  }
  return value;
}

export async function readActiveUpdateTransaction(
  projectRoot: string
): Promise<UpdateTransactionArtifact | null> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(updateTransactionMarkerPath(projectRoot), "utf8")
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error("Failed to read the active update transaction marker.");
  }
  if (!isUpdateTransactionArtifact(value)) {
    throw new Error(
      "Active update transaction marker is invalid and requires recovery."
    );
  }
  return value;
}

export function verifyPatchCompatibilityTransactions(
  baseVersion: string,
  targetVersion: string,
  transactions: PatchCompatibilityTransactions
): PatchCompatibilityVerification {
  const reasons: string[] = [];
  verifyCompatibilityStep(
    transactions.update,
    "apply",
    baseVersion,
    targetVersion,
    "update",
    reasons
  );
  verifyCompatibilityStep(
    transactions.rollback,
    "rollback",
    targetVersion,
    baseVersion,
    "rollback",
    reasons
  );
  verifyCompatibilityStep(
    transactions.reapply,
    "apply",
    baseVersion,
    targetVersion,
    "reapply",
    reasons
  );
  const transactionIds: [string, string, string] = [
    transactions.update.transaction_id,
    transactions.rollback.transaction_id,
    transactions.reapply.transaction_id
  ];
  if (new Set(transactionIds).size !== transactionIds.length) {
    reasons.push("patch_transaction_ids_not_unique");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    transaction_ids: transactionIds
  };
}

export function updateTransactionArtifactPath(
  projectRoot: string,
  transactionId: string
): string {
  return resolveInside(
    projectRoot,
    ".kairon",
    "update",
    "transactions",
    `${transactionId}.json`
  );
}

export function updateTransactionMarkerPath(projectRoot: string): string {
  return resolveInside(projectRoot, ".kairon", "update", "in-progress.json");
}

async function assertNoActiveUpdateTransaction(projectRoot: string): Promise<void> {
  const active = await readActiveUpdateTransaction(projectRoot);
  if (active !== null) {
    throw new Error(
      `Update transaction ${active.transaction_id} is ${active.status}; recover it before applying another update.`
    );
  }
}

async function readFreeBytes(directory: string): Promise<number> {
  const info = await statfs(directory, { bigint: true });
  const freeBytes = info.bavail * info.bsize;
  return freeBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(freeBytes);
}

function resolveStagingRoot(override?: string): string {
  if (override !== undefined) {
    return path.resolve(override);
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Kairon", "update-staging");
  }
  return path.join(os.homedir(), ".kairon", "update-staging");
}

function verifyCompatibilityStep(
  transaction: UpdateTransactionArtifact,
  action: UpdateTransactionAction,
  currentVersion: string,
  targetVersion: string,
  label: string,
  reasons: string[]
): void {
  if (transaction.action !== action) {
    reasons.push(`${label}_action_mismatch`);
  }
  if (transaction.status !== "completed") {
    reasons.push(`${label}_transaction_not_completed`);
  }
  if (transaction.phase !== "completed") {
    reasons.push(`${label}_phase_not_completed`);
  }
  if (transaction.current_version !== currentVersion) {
    reasons.push(`${label}_current_version_mismatch`);
  }
  if (transaction.target_version !== targetVersion) {
    reasons.push(`${label}_target_version_mismatch`);
  }
  if (
    !transaction.timeline.some(
      (entry) =>
        entry.phase === "post_check" &&
        entry.status === "passed"
    )
  ) {
    reasons.push(`${label}_post_check_missing`);
  }
}

function isUpdateTransactionArtifact(
  value: unknown
): value is UpdateTransactionArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<UpdateTransactionArtifact>;
  return candidate.schema_version === "0.1" &&
    candidate.artifact_kind === "update_transaction" &&
    typeof candidate.transaction_id === "string" &&
    /^UTX-\d{4,}$/u.test(candidate.transaction_id) &&
    (candidate.action === "apply" || candidate.action === "rollback") &&
    ["running", "completed", "rolled_back", "recovery_required"].includes(
      candidate.status ?? ""
    ) &&
    typeof candidate.current_version === "string" &&
    typeof candidate.target_version === "string" &&
    typeof candidate.download_id === "string" &&
    typeof candidate.package_sha256 === "string" &&
    typeof candidate.package_size_bytes === "number" &&
    typeof candidate.staging_path === "string" &&
    path.isAbsolute(candidate.staging_path) &&
    typeof candidate.artifact_path === "string" &&
    Array.isArray(candidate.timeline) &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string";
}
