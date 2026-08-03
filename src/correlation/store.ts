import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine } from "../core/fs/jsonl-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { withResourceLock, writeJsonFileFenced } from "../core/fs/resource-lock.js";
import { nextId } from "../core/ids/counter.js";

export type CorrelationMemberKind =
  | "approval"
  | "discord_message"
  | "discord_interaction"
  | "follow_up"
  | "workflow"
  | "release_plan"
  | "release_result"
  | "stable_promotion_plan"
  | "stable_promotion_result"
  | "incident"
  | "capability_decision";

export type CorrelationMember = {
  kind: CorrelationMemberKind;
  id: string;
  status: string;
  artifact_path?: string;
  created_at: string;
  updated_at: string;
};

export type CorrelationTimelineEvent = {
  kind: CorrelationMemberKind;
  member_id: string;
  action: "linked" | "updated" | "migrated";
  status: string;
  artifact_path?: string;
  created_at: string;
};

export type CorrelationArtifact = {
  schema_version: "0.1";
  artifact_kind: "correlation";
  correlation_id: string;
  status: string;
  members: CorrelationMember[];
  timeline: CorrelationTimelineEvent[];
  created_at: string;
  updated_at: string;
};

export type TrackCorrelationMemberInput = {
  correlationId?: string;
  approvalId?: string;
  kind: CorrelationMemberKind;
  id: string;
  status: string;
  artifactPath?: string;
  createdAt?: string;
  action?: CorrelationTimelineEvent["action"];
  replacesId?: string;
};

export type CorrelationIntegrityIssue = {
  correlation_id: string;
  kind:
    | "missing_artifact"
    | "stale_discord_message"
    | "orphan_follow_up"
    | "duplicate_member";
  member_kind: CorrelationMemberKind;
  member_id: string;
  artifact_path?: string;
};

export type CorrelationIntegrityResult = {
  total: number;
  healthy: number;
  missing_artifacts: number;
  stale_messages: number;
  orphan_follow_ups: number;
  duplicate_members: number;
  issues: CorrelationIntegrityIssue[];
};

type ApprovalArtifact = Record<string, unknown> & {
  id?: string;
  approval_id?: string;
  status?: string;
  correlation_id?: string;
  created_at?: string;
  updated_at?: string;
};

const correlationIdPattern = /^COR-\d{6}$/u;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeStatusPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const terminalApprovalStatuses = new Set(["decided", "completed", "rejected", "cancelled"]);
const terminalDiscordStatuses = new Set(["decided", "completed", "rejected", "cancelled", "updated"]);
const mutationLocks = new Map<string, Promise<void>>();

export async function ensureApprovalCorrelation(
  projectRoot: string,
  approval: ApprovalArtifact,
  options: { now?: Date; migrated?: boolean } = {}
): Promise<CorrelationArtifact> {
  return withMutationLock(projectRoot, () =>
    ensureApprovalCorrelationUnlocked(projectRoot, approval, options)
  );
}

async function ensureApprovalCorrelationUnlocked(
  projectRoot: string,
  approval: ApprovalArtifact,
  options: { now?: Date; migrated?: boolean } = {}
): Promise<CorrelationArtifact> {
  const approvalId = validateMemberId(readString(approval.id ?? approval.approval_id));
  const now = options.now ?? new Date();
  const approvalPath = approvalArtifactPath(projectRoot, approvalId);
  const explicitCorrelationId = readString(approval.correlation_id);
  const existing =
    explicitCorrelationId === undefined
      ? await findCorrelationByMember(projectRoot, "approval", approvalId)
      : await readCorrelation(projectRoot, validateCorrelationId(explicitCorrelationId));
  const correlationId =
    explicitCorrelationId === undefined
      ? existing?.correlation_id ?? (await nextId(projectRoot, "correlation"))
      : validateCorrelationId(explicitCorrelationId);

  if (approval.correlation_id !== correlationId) {
    await withResourceLock(
      projectRoot,
      approvalPath,
      { owner: "correlation-approval-link", ttlMs: 30_000 },
      async (lock) => {
        let current = approval;
        try {
          current = await readJsonFile<ApprovalArtifact>(approvalPath);
        } catch (error) {
          if (!String(error).includes("ENOENT")) {
            throw error;
          }
        }
        await writeJsonFileFenced(lock, approvalPath, {
          ...current,
          correlation_id: correlationId
        });
      }
    );
  }

  return trackCorrelationMemberUnlocked(projectRoot, {
    correlationId,
    kind: "approval",
    id: approvalId,
    status: normalizeStatus(readString(approval.status) ?? "unknown"),
    artifactPath: toProjectPath(projectRoot, approvalPath),
    createdAt: readString(approval.updated_at ?? approval.created_at) ?? now.toISOString(),
    action: options.migrated === true ? "migrated" : undefined
  });
}

export async function ensureWorkflowCorrelation(
  projectRoot: string,
  input: {
    workflowId: string;
    status: string;
    artifactPath: string;
    correlationId?: string;
    approvalId?: string;
    createdAt?: string;
  }
): Promise<CorrelationArtifact> {
  return withMutationLock(projectRoot, () =>
    ensureWorkflowCorrelationUnlocked(projectRoot, input)
  );
}

async function ensureWorkflowCorrelationUnlocked(
  projectRoot: string,
  input: {
    workflowId: string;
    status: string;
    artifactPath: string;
    correlationId?: string;
    approvalId?: string;
    createdAt?: string;
  }
): Promise<CorrelationArtifact> {
  let correlationId = input.correlationId;
  if (correlationId === undefined && input.approvalId !== undefined) {
    const approval = await readApproval(projectRoot, input.approvalId);
    if (approval !== null) {
      correlationId = (
        await ensureApprovalCorrelationUnlocked(projectRoot, approval)
      ).correlation_id;
    }
  }
  if (correlationId === undefined) {
    correlationId = (
      await findCorrelationByMember(projectRoot, "workflow", input.workflowId)
    )?.correlation_id;
  }

  return trackCorrelationMemberUnlocked(projectRoot, {
    correlationId,
    approvalId: input.approvalId,
    kind: "workflow",
    id: input.workflowId,
    status: input.status,
    artifactPath: input.artifactPath,
    createdAt: input.createdAt
  });
}

export async function trackCorrelationMember(
  projectRoot: string,
  input: TrackCorrelationMemberInput
): Promise<CorrelationArtifact> {
  return withMutationLock(projectRoot, () =>
    trackCorrelationMemberUnlocked(projectRoot, input)
  );
}

async function trackCorrelationMemberUnlocked(
  projectRoot: string,
  input: TrackCorrelationMemberInput
): Promise<CorrelationArtifact> {
  const id = validateMemberId(input.id);
  const status = normalizeStatus(input.status);
  const artifactPath = normalizeArtifactPath(input.artifactPath);
  const now = input.createdAt ?? new Date().toISOString();
  const correlationId = await resolveCorrelationIdUnlocked(projectRoot, input, id);
  const filePath = correlationArtifactPath(projectRoot, correlationId);

  return withResourceLock(
    projectRoot,
    filePath,
    { owner: "correlation-store", ttlMs: 30_000 },
    async (lock) => {
      const current =
        (await readCorrelation(projectRoot, correlationId)) ??
        createCorrelation(correlationId, now);
      if (input.replacesId !== undefined && input.replacesId !== id) {
        const replacedId = validateMemberId(input.replacesId);
        current.members = current.members.filter(
          (member) => !(member.kind === input.kind && member.id === replacedId)
        );
      }
      const memberIndex = current.members.findIndex(
        (member) => member.kind === input.kind && member.id === id
      );
      const previous = current.members[memberIndex];
      const member: CorrelationMember = {
        kind: input.kind,
        id,
        status,
        artifact_path: artifactPath,
        created_at: previous?.created_at ?? now,
        updated_at: now
      };
      const changed =
        previous === undefined ||
        previous.status !== member.status ||
        previous.artifact_path !== member.artifact_path;
      if (memberIndex === -1) {
        current.members.push(member);
      } else {
        current.members[memberIndex] = member;
      }

      if (changed || input.action === "migrated") {
        const action = input.action ?? (previous === undefined ? "linked" : "updated");
        current.timeline = [
          ...current.timeline,
          {
            kind: input.kind,
            member_id: id,
            action,
            status,
            artifact_path: artifactPath,
            created_at: now
          }
        ].slice(-200);
        current.updated_at = now;
        current.status = deriveCorrelationStatus(current.members);
        await writeJsonFileFenced(lock, filePath, current);
        await appendCorrelationAudit(projectRoot, correlationId, member, action, now);
      }
      return current;
    }
  );
}

export async function listCorrelations(projectRoot: string): Promise<CorrelationArtifact[]> {
  const directory = correlationsDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return [];
    }
    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => correlationIdPattern.test(entry.slice(0, -5)) && entry.endsWith(".json"))
      .map((entry) => readJsonFile<CorrelationArtifact>(resolveInside(directory, entry)))
  );
  return artifacts.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
}

export async function inspectCorrelationIntegrity(
  projectRoot: string
): Promise<CorrelationIntegrityResult> {
  const correlations = await listCorrelations(projectRoot);
  const issues: CorrelationIntegrityIssue[] = [];
  const owners = new Map<string, string>();

  for (const correlation of correlations) {
    const approval = correlation.members.find((member) => member.kind === "approval");
    for (const member of correlation.members) {
      const key = `${member.kind}:${member.id}`;
      const owner = owners.get(key);
      if (owner !== undefined && owner !== correlation.correlation_id) {
        issues.push(toIssue(correlation, member, "duplicate_member"));
      } else {
        owners.set(key, correlation.correlation_id);
      }
      if (member.artifact_path !== undefined && !(await projectPathExists(projectRoot, member.artifact_path))) {
        issues.push(toIssue(correlation, member, "missing_artifact"));
      }
      if (member.kind === "follow_up" && approval === undefined) {
        issues.push(toIssue(correlation, member, "orphan_follow_up"));
      }
      if (
        member.kind === "discord_message" &&
        approval !== undefined &&
        terminalApprovalStatuses.has(approval.status) &&
        !terminalDiscordStatuses.has(member.status)
      ) {
        issues.push(toIssue(correlation, member, "stale_discord_message"));
      }
    }
  }

  const affected = new Set(issues.map((issue) => issue.correlation_id));
  return {
    total: correlations.length,
    healthy: correlations.length - affected.size,
    missing_artifacts: issues.filter((issue) => issue.kind === "missing_artifact").length,
    stale_messages: issues.filter((issue) => issue.kind === "stale_discord_message").length,
    orphan_follow_ups: issues.filter((issue) => issue.kind === "orphan_follow_up").length,
    duplicate_members: issues.filter((issue) => issue.kind === "duplicate_member").length,
    issues
  };
}

export function correlationArtifactPath(projectRoot: string, correlationId: string): string {
  return resolveInside(correlationsDirectory(projectRoot), `${validateCorrelationId(correlationId)}.json`);
}

export function correlationAuditPath(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "audit", "correlation-events.jsonl");
}

async function resolveCorrelationIdUnlocked(
  projectRoot: string,
  input: TrackCorrelationMemberInput,
  memberId: string
): Promise<string> {
  if (input.correlationId !== undefined) {
    return validateCorrelationId(input.correlationId);
  }
  if (input.approvalId !== undefined) {
    const approval = await readApproval(projectRoot, input.approvalId);
    if (approval !== null) {
      return (
        await ensureApprovalCorrelationUnlocked(projectRoot, approval)
      ).correlation_id;
    }
  }
  const existing = await findCorrelationByMember(projectRoot, input.kind, memberId);
  return existing?.correlation_id ?? nextId(projectRoot, "correlation");
}

async function findCorrelationByMember(
  projectRoot: string,
  kind: CorrelationMemberKind,
  id: string
): Promise<CorrelationArtifact | undefined> {
  const artifacts = await listCorrelations(projectRoot);
  return artifacts.find((artifact) =>
    artifact.members.some((member) => member.kind === kind && member.id === id)
  );
}

async function readCorrelation(
  projectRoot: string,
  correlationId: string
): Promise<CorrelationArtifact | null> {
  try {
    return await readJsonFile<CorrelationArtifact>(
      correlationArtifactPath(projectRoot, correlationId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function readApproval(
  projectRoot: string,
  approvalId: string
): Promise<ApprovalArtifact | null> {
  try {
    return await readJsonFile<ApprovalArtifact>(approvalArtifactPath(projectRoot, approvalId));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function createCorrelation(correlationId: string, now: string): CorrelationArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "correlation",
    correlation_id: correlationId,
    status: "active",
    members: [],
    timeline: [],
    created_at: now,
    updated_at: now
  };
}

async function appendCorrelationAudit(
  projectRoot: string,
  correlationId: string,
  member: CorrelationMember,
  action: CorrelationTimelineEvent["action"],
  recordedAt: string
): Promise<void> {
  await appendJsonLine(correlationAuditPath(projectRoot), {
    schema_version: "0.1",
    correlation_id: correlationId,
    member_kind: member.kind,
    member_id: member.id,
    action,
    status: member.status,
    artifact_path: member.artifact_path,
    recorded_at: recordedAt
  });
}

function deriveCorrelationStatus(members: CorrelationMember[]): string {
  const approval = members.find((member) => member.kind === "approval");
  const workflow = members.find((member) => member.kind === "workflow");
  const incident = members.find((member) => member.kind === "incident");
  return workflow?.status ?? approval?.status ?? incident?.status ?? "active";
}

function correlationsDirectory(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "correlations");
}

function approvalArtifactPath(projectRoot: string, approvalId: string): string {
  return resolveInside(getKaironPaths(projectRoot).approvalsDir, `${validateMemberId(approvalId)}.json`);
}

function normalizeArtifactPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = toPosixPath(value.trim());
  if (
    !normalized.startsWith(".kairon/") ||
    normalized.includes("..") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.length > 240
  ) {
    throw new Error(`Invalid correlation artifact path: ${value}`);
  }
  return normalized;
}

function validateCorrelationId(value: string): string {
  if (!correlationIdPattern.test(value)) {
    throw new Error(`Invalid correlation id: ${value}`);
  }
  return value;
}

function validateMemberId(value: string | undefined): string {
  if (value === undefined || !safeIdPattern.test(value)) {
    throw new Error(`Invalid correlation member id: ${value ?? "missing"}`);
  }
  return value;
}

function normalizeStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!safeStatusPattern.test(normalized)) {
    return "unknown";
  }
  return normalized;
}

function toProjectPath(projectRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(getKaironPaths(projectRoot).root, absolutePath));
}

async function projectPathExists(projectRoot: string, artifactPath: string): Promise<boolean> {
  try {
    await access(resolveInside(getKaironPaths(projectRoot).root, artifactPath));
    return true;
  } catch {
    return false;
  }
}

function toIssue(
  correlation: CorrelationArtifact,
  member: CorrelationMember,
  kind: CorrelationIntegrityIssue["kind"]
): CorrelationIntegrityIssue {
  return {
    correlation_id: correlation.correlation_id,
    kind,
    member_kind: member.kind,
    member_id: member.id,
    artifact_path: member.artifact_path
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function withMutationLock<T>(
  projectRoot: string,
  run: () => Promise<T>
): Promise<T> {
  const key = path.resolve(projectRoot);
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  mutationLocks.set(key, queued);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (mutationLocks.get(key) === queued) {
      mutationLocks.delete(key);
    }
  }
}
