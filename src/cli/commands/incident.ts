import {
  acknowledgeIncidentLifecycle,
  bundleIncidentLifecycle,
  executeIncidentRecovery,
  listIncidentLifecycle,
  planIncidentRecovery,
  resolveIncidentLifecycle,
  showIncidentLifecycle
} from "../../incidents/lifecycle.js";

export async function listIncidentsCommand(
  projectRoot: string,
  options: { status?: string } = {}
): Promise<string> {
  const status = normalizeStatus(options.status);
  const incidents = await listIncidentLifecycle(projectRoot, { status });
  if (incidents.length === 0) {
    return "No Kairon incidents found.";
  }
  return [
    "Kairon incidents:",
    ...incidents.map((incident) =>
      [
        `incident_id=${incident.incident_id}`,
        `status=${incident.status}`,
        `severity=${incident.severity}`,
        `resources=${incident.resources.length}`,
        `correlation_id=${incident.correlation_id}`,
        `fingerprint=${incident.fingerprint}`
      ].join(" ")
    )
  ].join("\n");
}

export async function showIncidentCommand(
  projectRoot: string,
  incidentId: string
): Promise<string> {
  const detail = await showIncidentLifecycle(projectRoot, incidentId);
  return [
    "Kairon incident:",
    `incident_id=${detail.incident.incident_id}`,
    `status=${detail.incident.status}`,
    `severity=${detail.incident.severity}`,
    `correlation_id=${detail.incident.correlation_id}`,
    `resources=${detail.incident.resources.length}`,
    `timeline_events=${detail.timeline.length}`,
    `detail=${JSON.stringify(detail, null, 2)}`
  ].join("\n");
}

export async function acknowledgeIncidentCommand(
  projectRoot: string,
  incidentId: string,
  options: { reason?: string }
): Promise<string> {
  const incident = await acknowledgeIncidentLifecycle(
    projectRoot,
    incidentId,
    options.reason ?? ""
  );
  return [
    "Kairon incident acknowledged.",
    `incident_id=${incident.incident_id}`,
    `status=${incident.status}`,
    `reason=${incident.acknowledgement_reason}`
  ].join("\n");
}

export async function bundleIncidentCommand(
  projectRoot: string,
  incidentId: string,
  options: { dryRun?: boolean; output?: string } = {}
): Promise<string> {
  const result = await bundleIncidentLifecycle(projectRoot, incidentId, {
    dryRun: options.dryRun,
    outputDirectory: options.output
  });
  return [
    options.dryRun === true
      ? "Kairon incident support bundle dry run."
      : "Kairon incident support bundle created.",
    `incident_id=${result.incident.incident_id}`,
    `bundle_id=${result.bundle.plan.bundle_id}`,
    `status=${result.bundle.plan.status}`,
    `archive=${result.bundle.archive_path ?? "not_created"}`,
    `sha256=${result.bundle.plan.archive?.sha256 ?? "not_created"}`
  ].join("\n");
}

export async function recoverIncidentCommand(
  projectRoot: string,
  incidentId: string,
  options: {
    dryRun?: boolean;
    approvalId?: string;
    confirm?: string;
  }
): Promise<string> {
  if (options.dryRun === true) {
    if (options.approvalId !== undefined || options.confirm !== undefined) {
      throw new Error(
        "Incident recovery dry-run cannot be combined with approval or confirmation."
      );
    }
    const plan = await planIncidentRecovery(projectRoot, incidentId);
    return [
      "Kairon incident recovery dry run.",
      `incident_id=${plan.incident_id}`,
      `plan_id=${plan.plan_id}`,
      `approval_id=${plan.approval_id}`,
      `risk=${plan.risk}`,
      `targets=${plan.target_fingerprints.length}`,
      `confirm=${plan.confirmation}`,
      `expires_at=${plan.expires_at}`,
      ...plan.actions.map((action) =>
        [
          `action=${action.action}`,
          `target_id=${action.target_id}`,
          `fingerprint=${action.fingerprint}`,
          `risk=${action.risk}`
        ].join(" ")
      )
    ].join("\n");
  }
  if (
    options.approvalId === undefined ||
    options.confirm === undefined
  ) {
    throw new Error(
      "Incident recovery execution requires --approval-id and --confirm."
    );
  }
  const result = await executeIncidentRecovery(projectRoot, incidentId, {
    approvalId: options.approvalId,
    confirm: options.confirm
  });
  return [
    "Kairon incident recovery executed.",
    `incident_id=${result.incident.incident_id}`,
    `plan_id=${result.plan.plan_id}`,
    `recovery_id=${result.recovery.recovery_id}`,
    `status=${result.status}`,
    `remaining=${result.remaining_fingerprints.length}`,
    ...result.remaining_fingerprints.map(
      (fingerprint) => `remaining_fingerprint=${fingerprint}`
    )
  ].join("\n");
}

export async function resolveIncidentCommand(
  projectRoot: string,
  incidentId: string,
  options: { reason?: string }
): Promise<string> {
  const incident = await resolveIncidentLifecycle(
    projectRoot,
    incidentId,
    options.reason ?? ""
  );
  return [
    "Kairon incident resolved.",
    `incident_id=${incident.incident_id}`,
    `status=${incident.status}`,
    `reason=${incident.resolution_reason}`
  ].join("\n");
}

function normalizeStatus(
  value: string | undefined
): "all" | "open" | "acknowledged" | "recovering" | "resolved" {
  const normalized = value?.trim().toLowerCase() ?? "all";
  if (
    !["all", "open", "acknowledged", "recovering", "resolved"].includes(
      normalized
    )
  ) {
    throw new Error(`Invalid incident status: ${value}`);
  }
  return normalized as
    | "all"
    | "open"
    | "acknowledged"
    | "recovering"
    | "resolved";
}
