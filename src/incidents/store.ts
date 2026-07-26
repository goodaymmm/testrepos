import { mkdir, readdir } from "node:fs/promises";
import { appendJsonLine, readJsonLines } from "../core/fs/jsonl-file.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  withResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import { nextId } from "../core/ids/counter.js";
import {
  sanitizeSupportText,
  sanitizeSupportValue
} from "../diagnostics/support-redaction.js";
import { trackCorrelationMember } from "../correlation/store.js";

export type IncidentStatus = "open" | "acknowledged" | "recovering" | "resolved";
export type IncidentSeverity = "info" | "warning" | "high" | "critical";
export type IncidentResourceKind =
  | "watchdog_alert"
  | "recovery_target"
  | "approval"
  | "support_bundle"
  | "recovery_plan"
  | "recovery_result"
  | "update_transaction";

export type IncidentResourceReference = {
  kind: IncidentResourceKind;
  id: string;
  status: string;
  artifact_path?: string;
  fingerprint?: string;
  severity?: IncidentSeverity;
  attached_at: string;
  updated_at: string;
  details?: Record<string, unknown>;
};

export type IncidentRecoveryState = {
  plan_id: string;
  status: "planned" | "running" | "completed" | "partial" | "failed";
  approval_id?: string;
  recovery_id?: string;
  verification_status?: "pending" | "passed" | "failed";
  updated_at: string;
};

export type IncidentArtifact = {
  schema_version: "0.1";
  artifact_kind: "incident";
  incident_id: string;
  fingerprint: string;
  correlation_id: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  resources: IncidentResourceReference[];
  recurrence_count: number;
  created_at: string;
  updated_at: string;
  acknowledged_at?: string;
  acknowledgement_reason?: string;
  resolved_at?: string;
  resolution_reason?: string;
  recovery?: IncidentRecoveryState;
};

export type IncidentTimelineEvent = {
  schema_version: "0.1";
  incident_id: string;
  event:
    | "incident.created"
    | "incident.reopened"
    | "incident.acknowledged"
    | "incident.resolved"
    | "resource.attached"
    | "resource.updated"
    | "notification.policy"
    | "bundle.created"
    | "recovery.planned"
    | "recovery.started"
    | "recovery.completed"
    | "recovery.partial"
    | "recovery.failed";
  status: IncidentStatus;
  severity: IncidentSeverity;
  resource?: Pick<
    IncidentResourceReference,
    "kind" | "id" | "status" | "artifact_path" | "fingerprint"
  >;
  reason?: string;
  details?: Record<string, unknown>;
  created_at: string;
};

export type AttachIncidentResourceInput = {
  fingerprint: string;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  resource: {
    kind: IncidentResourceKind;
    id: string;
    status: string;
    artifactPath?: string;
    fingerprint?: string;
    severity?: IncidentSeverity;
    details?: Record<string, unknown>;
  };
  event?: Extract<
    IncidentTimelineEvent["event"],
    | "resource.attached"
    | "resource.updated"
    | "notification.policy"
    | "bundle.created"
    | "recovery.planned"
    | "recovery.started"
    | "recovery.completed"
    | "recovery.partial"
    | "recovery.failed"
  >;
  now?: Date;
};

export type IncidentListOptions = {
  status?: IncidentStatus | "all";
};

const incidentIdPattern = /^INC-\d{4}$/u;
const safeStatusPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const severityOrder: Record<IncidentSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3
};

export async function attachIncidentResource(
  projectRoot: string,
  input: AttachIncidentResourceInput
): Promise<IncidentArtifact> {
  const fingerprint = normalizeFingerprint(input.fingerprint);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const resource = normalizeResource(projectRoot, input.resource, timestamp);

  return withIncidentMutation(projectRoot, now, async (lock) => {
    const incidents = await listIncidentsUnlocked(projectRoot);
    let incident = incidents.find((candidate) => candidate.fingerprint === fingerprint);
    let event: IncidentTimelineEvent["event"];

    if (incident === undefined) {
      const incidentId = await nextId(projectRoot, "incident");
      const correlation = await trackCorrelationMember(projectRoot, {
        kind: "incident",
        id: incidentId,
        status: "open",
        artifactPath: incidentProjectPath(projectRoot, incidentId),
        createdAt: timestamp
      });
      incident = {
        schema_version: "0.1",
        artifact_kind: "incident",
        incident_id: incidentId,
        fingerprint,
        correlation_id: correlation.correlation_id,
        status: "open",
        severity: input.severity,
        title: sanitizeSupportText(input.title, { projectRoot }),
        summary: sanitizeSupportText(input.summary, { projectRoot }),
        resources: [resource],
        recurrence_count: 0,
        created_at: timestamp,
        updated_at: timestamp
      };
      event = "incident.created";
    } else {
      const resourceIndex = incident.resources.findIndex(
        (candidate) =>
          candidate.kind === resource.kind && candidate.id === resource.id
      );
      const previous = incident.resources[resourceIndex];
      const reopened = incident.status === "resolved" && isActiveResource(resource.status);
      const sanitizedTitle = sanitizeSupportText(input.title, { projectRoot });
      const sanitizedSummary = sanitizeSupportText(input.summary, { projectRoot });
      const resourceChanged =
        previous === undefined ||
        previous.status !== resource.status ||
        previous.artifact_path !== resource.artifact_path ||
        previous.fingerprint !== resource.fingerprint ||
        previous.severity !== resource.severity ||
        JSON.stringify(previous.details ?? {}) !== JSON.stringify(resource.details ?? {});
      const incidentChanged =
        incident.severity !== maxSeverity(incident.severity, input.severity) ||
        incident.title !== sanitizedTitle ||
        incident.summary !== sanitizedSummary;
      if (!reopened && !resourceChanged && !incidentChanged) {
        return incident;
      }
      const nextResource: IncidentResourceReference = {
        ...resource,
        attached_at: previous?.attached_at ?? resource.attached_at
      };
      if (resourceIndex === -1) {
        incident.resources.push(nextResource);
        event = reopened
          ? "incident.reopened"
          : input.event ?? "resource.attached";
      } else {
        incident.resources[resourceIndex] = nextResource;
        event = reopened
          ? "incident.reopened"
          : input.event ?? "resource.updated";
      }
      incident = {
        ...incident,
        status: reopened ? "open" : incident.status,
        severity: maxSeverity(incident.severity, input.severity),
        title: sanitizedTitle,
        summary: sanitizedSummary,
        recurrence_count: incident.recurrence_count + (reopened ? 1 : 0),
        updated_at: timestamp,
        acknowledged_at: reopened ? undefined : incident.acknowledged_at,
        acknowledgement_reason: reopened
          ? undefined
          : incident.acknowledgement_reason,
        resolved_at: reopened ? undefined : incident.resolved_at,
        resolution_reason: reopened ? undefined : incident.resolution_reason
      };
    }

    await writeJsonFileFenced(
      lock,
      incidentArtifactPath(projectRoot, incident.incident_id),
      incident
    );
    await appendIncidentTimeline(projectRoot, incident, {
      event,
      resource: toTimelineResource(resource),
      created_at: timestamp
    });
    await syncIncidentCorrelation(projectRoot, incident, timestamp);
    return incident;
  });
}

export async function updateIncidentResource(
  projectRoot: string,
  input: {
    kind: IncidentResourceKind;
    id: string;
    fingerprint?: string;
    status: string;
    details?: Record<string, unknown>;
    now?: Date;
  }
): Promise<IncidentArtifact | null> {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const resourceId = normalizeResourceId(input.id);
  return withIncidentMutation(projectRoot, now, async (lock) => {
    const incident = (await listIncidentsUnlocked(projectRoot)).find((candidate) =>
      candidate.resources.some(
        (resource) =>
          resource.kind === input.kind &&
          resource.id === resourceId &&
          (input.fingerprint === undefined ||
            resource.fingerprint === input.fingerprint)
      )
    );
    if (incident === undefined) {
      return null;
    }
    const resourceIndex = incident.resources.findIndex(
      (resource) =>
        resource.kind === input.kind &&
        resource.id === resourceId &&
        (input.fingerprint === undefined ||
          resource.fingerprint === input.fingerprint)
    );
    const previous = incident.resources[resourceIndex]!;
    const nextStatus = normalizeStatus(input.status);
    const nextDetails =
      input.details === undefined
        ? previous.details
        : sanitizeDetails(projectRoot, input.details);
    if (
      previous.status === nextStatus &&
      JSON.stringify(previous.details ?? {}) ===
        JSON.stringify(nextDetails ?? {})
    ) {
      return incident;
    }
    const reopened =
      incident.status === "resolved" && isActiveResource(nextStatus);
    const resource: IncidentResourceReference = {
      ...previous,
      status: nextStatus,
      updated_at: timestamp,
      details: nextDetails
    };
    incident.resources[resourceIndex] = resource;
    incident.status = reopened ? "open" : incident.status;
    incident.recurrence_count += reopened ? 1 : 0;
    if (reopened) {
      delete incident.acknowledged_at;
      delete incident.acknowledgement_reason;
      delete incident.resolved_at;
      delete incident.resolution_reason;
    }
    incident.updated_at = timestamp;
    await writeJsonFileFenced(
      lock,
      incidentArtifactPath(projectRoot, incident.incident_id),
      incident
    );
    await appendIncidentTimeline(projectRoot, incident, {
      event: reopened ? "incident.reopened" : "resource.updated",
      resource: toTimelineResource(resource),
      created_at: timestamp
    });
    await syncIncidentCorrelation(projectRoot, incident, timestamp);
    return incident;
  });
}

export async function listIncidents(
  projectRoot: string,
  options: IncidentListOptions = {}
): Promise<IncidentArtifact[]> {
  const status = options.status ?? "all";
  const incidents = await listIncidentsUnlocked(projectRoot);
  return incidents.filter((incident) =>
    status === "all" ? true : incident.status === status
  );
}

export async function getIncident(
  projectRoot: string,
  incidentId: string
): Promise<IncidentArtifact> {
  validateIncidentId(incidentId);
  try {
    return await readJsonFile<IncidentArtifact>(
      incidentArtifactPath(projectRoot, incidentId)
    );
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      throw new Error(`Incident was not found: ${incidentId}`);
    }
    throw error;
  }
}

export async function readIncidentTimeline(
  projectRoot: string,
  incidentId: string
): Promise<IncidentTimelineEvent[]> {
  validateIncidentId(incidentId);
  return readJsonLines<IncidentTimelineEvent>(
    incidentTimelinePath(projectRoot, incidentId)
  );
}

export async function acknowledgeIncident(
  projectRoot: string,
  incidentId: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<IncidentArtifact> {
  return mutateIncidentLifecycle(
    projectRoot,
    incidentId,
    "acknowledged",
    reason,
    "incident.acknowledged",
    options.now
  );
}

export async function resolveIncident(
  projectRoot: string,
  incidentId: string,
  reason: string,
  options: { now?: Date } = {}
): Promise<IncidentArtifact> {
  return mutateIncidentLifecycle(
    projectRoot,
    incidentId,
    "resolved",
    reason,
    "incident.resolved",
    options.now
  );
}

export async function updateIncidentRecovery(
  projectRoot: string,
  incidentId: string,
  recovery: IncidentRecoveryState,
  event: Extract<
    IncidentTimelineEvent["event"],
    | "recovery.planned"
    | "recovery.started"
    | "recovery.completed"
    | "recovery.partial"
    | "recovery.failed"
  >,
  options: {
    reason?: string;
    details?: Record<string, unknown>;
    now?: Date;
  } = {}
): Promise<IncidentArtifact> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return withIncidentMutation(projectRoot, now, async (lock) => {
    const incident = await getIncident(projectRoot, incidentId);
    incident.recovery = {
      ...recovery,
      updated_at: timestamp
    };
    incident.status =
      recovery.status === "running" || recovery.status === "planned"
        ? "recovering"
        : incident.status;
    incident.updated_at = timestamp;
    await writeJsonFileFenced(
      lock,
      incidentArtifactPath(projectRoot, incidentId),
      incident
    );
    await appendIncidentTimeline(projectRoot, incident, {
      event,
      reason: sanitizeOptionalText(projectRoot, options.reason),
      details: sanitizeDetails(projectRoot, options.details),
      created_at: timestamp
    });
    await syncIncidentCorrelation(projectRoot, incident, timestamp);
    return incident;
  });
}

export function incidentArtifactPath(
  projectRoot: string,
  incidentId: string
): string {
  return resolveInside(
    incidentsDirectory(projectRoot),
    `${validateIncidentId(incidentId)}.json`
  );
}

export function incidentTimelinePath(
  projectRoot: string,
  incidentId: string
): string {
  return resolveInside(
    incidentsDirectory(projectRoot),
    `${validateIncidentId(incidentId)}-timeline.jsonl`
  );
}

export function incidentProjectPath(
  _projectRoot: string,
  incidentId: string
): string {
  return `.kairon/incidents/${validateIncidentId(incidentId)}.json`;
}

async function mutateIncidentLifecycle(
  projectRoot: string,
  incidentId: string,
  status: Extract<IncidentStatus, "acknowledged" | "resolved">,
  rawReason: string,
  event: Extract<
    IncidentTimelineEvent["event"],
    "incident.acknowledged" | "incident.resolved"
  >,
  nowInput?: Date
): Promise<IncidentArtifact> {
  const reason = sanitizeSupportText(rawReason.trim(), { projectRoot });
  if (reason.length === 0) {
    throw new Error("Incident reason is required.");
  }
  const now = nowInput ?? new Date();
  const timestamp = now.toISOString();
  return withIncidentMutation(projectRoot, now, async (lock) => {
    const incident = await getIncident(projectRoot, incidentId);
    if (incident.status === "resolved" && status === "acknowledged") {
      throw new Error(`Resolved incident cannot be acknowledged: ${incidentId}`);
    }
    const updated: IncidentArtifact = {
      ...incident,
      status,
      updated_at: timestamp,
      ...(status === "acknowledged"
        ? {
            acknowledged_at: timestamp,
            acknowledgement_reason: reason
          }
        : {
            resolved_at: timestamp,
            resolution_reason: reason
          })
    };
    await writeJsonFileFenced(
      lock,
      incidentArtifactPath(projectRoot, incidentId),
      updated
    );
    await appendIncidentTimeline(projectRoot, updated, {
      event,
      reason,
      created_at: timestamp
    });
    await syncIncidentCorrelation(projectRoot, updated, timestamp);
    return updated;
  });
}

async function listIncidentsUnlocked(
  projectRoot: string
): Promise<IncidentArtifact[]> {
  let entries: string[];
  try {
    entries = await readdir(incidentsDirectory(projectRoot));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return [];
    }
    throw error;
  }
  const incidents = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.endsWith(".json") &&
          incidentIdPattern.test(entry.slice(0, -5))
      )
      .map((entry) =>
        readJsonFile<IncidentArtifact>(
          resolveInside(incidentsDirectory(projectRoot), entry)
        )
      )
  );
  return incidents.sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

async function withIncidentMutation<T>(
  projectRoot: string,
  _now: Date,
  run: Parameters<typeof withResourceLock<T>>[3]
): Promise<T> {
  await mkdir(incidentsDirectory(projectRoot), { recursive: true });
  return withResourceLock(
    projectRoot,
    incidentStatePath(projectRoot),
    { owner: "incident-store", ttlMs: 30_000 },
    run
  );
}

async function appendIncidentTimeline(
  projectRoot: string,
  incident: IncidentArtifact,
  input: Pick<
    IncidentTimelineEvent,
    "event" | "resource" | "reason" | "details" | "created_at"
  >
): Promise<void> {
  await appendJsonLine(
    incidentTimelinePath(projectRoot, incident.incident_id),
    {
      schema_version: "0.1",
      incident_id: incident.incident_id,
      event: input.event,
      status: incident.status,
      severity: incident.severity,
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.details === undefined ? {} : { details: input.details }),
      created_at: input.created_at
    } satisfies IncidentTimelineEvent
  );
}

async function syncIncidentCorrelation(
  projectRoot: string,
  incident: IncidentArtifact,
  createdAt: string
): Promise<void> {
  await trackCorrelationMember(projectRoot, {
    correlationId: incident.correlation_id,
    kind: "incident",
    id: incident.incident_id,
    status: incident.status,
    artifactPath: incidentProjectPath(projectRoot, incident.incident_id),
    createdAt
  });
}

function normalizeResource(
  projectRoot: string,
  input: AttachIncidentResourceInput["resource"],
  timestamp: string
): IncidentResourceReference {
  const artifactPath =
    input.artifactPath === undefined
      ? undefined
      : normalizeArtifactPath(input.artifactPath);
  return {
    kind: input.kind,
    id: normalizeResourceId(input.id),
    status: normalizeStatus(input.status),
    ...(artifactPath === undefined ? {} : { artifact_path: artifactPath }),
    ...(input.fingerprint === undefined
      ? {}
      : { fingerprint: normalizeFingerprint(input.fingerprint) }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    attached_at: timestamp,
    updated_at: timestamp,
    ...(input.details === undefined
      ? {}
      : { details: sanitizeDetails(projectRoot, input.details) })
  };
}

function normalizeResourceId(value: string): string {
  const normalized = toPosixPath(value.trim());
  if (
    normalized.length === 0 ||
    normalized.length > 260 ||
    /[\r\n\0?#]/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Invalid incident resource id: ${value}`);
  }
  return normalized;
}

function normalizeArtifactPath(value: string): string {
  const normalized = toPosixPath(value.trim());
  if (
    !normalized.startsWith(".kairon/") ||
    normalized.includes("..") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.length > 260
  ) {
    throw new Error(`Invalid incident artifact path: ${value}`);
  }
  return normalized;
}

function normalizeFingerprint(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new Error("Invalid incident fingerprint.");
  }
  return normalized;
}

function normalizeStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  return safeStatusPattern.test(normalized) ? normalized : "unknown";
}

function sanitizeDetails(
  projectRoot: string,
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const sanitized = sanitizeSupportValue(value, { projectRoot }).value;
  return typeof sanitized === "object" &&
    sanitized !== null &&
    !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function sanitizeOptionalText(
  projectRoot: string,
  value: string | undefined
): string | undefined {
  return value === undefined
    ? undefined
    : sanitizeSupportText(value, { projectRoot });
}

function maxSeverity(
  left: IncidentSeverity,
  right: IncidentSeverity
): IncidentSeverity {
  return severityOrder[right] > severityOrder[left] ? right : left;
}

function isActiveResource(status: string): boolean {
  return !["resolved", "completed", "passed"].includes(status);
}

function toTimelineResource(
  resource: IncidentResourceReference
): IncidentTimelineEvent["resource"] {
  return {
    kind: resource.kind,
    id: resource.id,
    status: resource.status,
    ...(resource.artifact_path === undefined
      ? {}
      : { artifact_path: resource.artifact_path }),
    ...(resource.fingerprint === undefined
      ? {}
      : { fingerprint: resource.fingerprint })
  };
}

function incidentsDirectory(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).kaironDir, "incidents");
}

function incidentStatePath(projectRoot: string): string {
  return resolveInside(incidentsDirectory(projectRoot), "state.json");
}

function validateIncidentId(value: string): string {
  if (!incidentIdPattern.test(value)) {
    throw new Error(`Invalid incident id: ${value}`);
  }
  return value;
}
