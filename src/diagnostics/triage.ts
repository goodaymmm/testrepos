import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  inspectAgentCertifications,
  type AgentCertificationInspection
} from "../agents/compatibility-certification.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  inspectCorrelationIntegrity,
  listCorrelations,
  type CorrelationArtifact,
  type CorrelationIntegrityResult
} from "../correlation/store.js";
import {
  listIncidents,
  type IncidentArtifact
} from "../incidents/store.js";
import {
  listWatchdogAlerts,
  type WatchdogAlert
} from "../runtime/watchdog.js";
import {
  sanitizeSupportText,
  scanSupportEntries,
  type SupportRedactionSummary
} from "./support-redaction.js";
import {
  runDoctor,
  type DoctorCheck,
  type DoctorResult
} from "./doctor.js";

export type DiagnosticsTriageSeverity =
  | "info"
  | "warning"
  | "high"
  | "critical";

export type DiagnosticsRootCauseCategory =
  | "configuration"
  | "credentials"
  | "agent_compatibility"
  | "runtime_health"
  | "incident_recovery"
  | "data_integrity"
  | "release_readiness"
  | "update_recovery"
  | "remote_connectivity"
  | "support_evidence";

export type DiagnosticsTriageSourceId =
  | "doctor"
  | "watchdog"
  | "incidents"
  | "correlations"
  | "stable_readiness"
  | "updates"
  | "agent_certifications"
  | "support_bundles";

export type DiagnosticsTriageSource = {
  id: DiagnosticsTriageSourceId;
  status: "available" | "unavailable";
  findings: number;
  evidence_paths: string[];
  reason?: "source_read_failed";
};

export type DiagnosticsTriageAction = {
  kind: "read_only" | "approval_required" | "external_manual";
  summary: string;
  command?: string;
};

export type DiagnosticsTriageItem = {
  id: string;
  severity: DiagnosticsTriageSeverity;
  root_cause_category: DiagnosticsRootCauseCategory;
  root_cause_key: string;
  related_finding_ids: string[];
  correlation: {
    project_id: string;
    correlation_ids: string[];
    incident_ids: string[];
    transaction_ids: string[];
    release_ids: string[];
  };
  evidence_paths: string[];
  operator_action: string;
  actions: DiagnosticsTriageAction[];
};

export type DiagnosticsTriageReport = {
  schema_version: "0.1";
  artifact_kind: "diagnostics_triage_report";
  report_id: string;
  project_id: string;
  status: "PASS" | "ATTENTION_REQUIRED" | "PARTIAL";
  generated_at: string;
  read_only: true;
  sources: DiagnosticsTriageSource[];
  items: DiagnosticsTriageItem[];
  summary: {
    items: number;
    critical: number;
    high: number;
    warning: number;
    info: number;
    unavailable_sources: number;
  };
  redaction: SupportRedactionSummary & {
    secret_scan_status: "passed";
    secret_finding_count: 0;
  };
};

export type DiagnosticsTriageFileArtifacts = {
  stableReadiness: Record<string, unknown> | null;
  updateTransactions: Array<Record<string, unknown>>;
  supportPlans: Array<Record<string, unknown>>;
};

export type DiagnosticsTriageDependencies = {
  now?: () => Date;
  projectId?: (projectRoot: string) => Promise<string>;
  doctor?: (projectRoot: string) => Promise<DoctorResult>;
  watchdogAlerts?: (projectRoot: string) => Promise<WatchdogAlert[]>;
  incidents?: (projectRoot: string) => Promise<IncidentArtifact[]>;
  correlations?: (projectRoot: string) => Promise<CorrelationArtifact[]>;
  correlationIntegrity?: (
    projectRoot: string
  ) => Promise<CorrelationIntegrityResult>;
  agentCertifications?: (
    projectRoot: string,
    now: Date
  ) => Promise<AgentCertificationInspection[]>;
  fileArtifacts?: (
    projectRoot: string
  ) => Promise<DiagnosticsTriageFileArtifacts>;
};

export type DiagnosticsTriageWriteResult = {
  json_path: string;
  markdown_path: string;
};

type Finding = {
  id: string;
  source: DiagnosticsTriageSourceId;
  severity: DiagnosticsTriageSeverity;
  category: DiagnosticsRootCauseCategory;
  grouping_key?: string;
  summary: string;
  project_id: string;
  correlation_ids?: string[];
  incident_ids?: string[];
  transaction_ids?: string[];
  release_ids?: string[];
  evidence_paths?: string[];
  actions?: DiagnosticsTriageAction[];
};

type SourceCollection = {
  source: DiagnosticsTriageSource;
  findings: Finding[];
};

type FindingContext = {
  projectRoot: string;
  projectId: string;
  incidents: IncidentArtifact[];
  correlations: CorrelationArtifact[];
};

const sourceOrder: DiagnosticsTriageSourceId[] = [
  "doctor",
  "watchdog",
  "incidents",
  "correlations",
  "stable_readiness",
  "updates",
  "agent_certifications",
  "support_bundles"
];

const severityOrder: Record<DiagnosticsTriageSeverity, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3
};

const prohibitedCommandPattern =
  /(?:^|\s)(?:rm|del|erase|Remove-Item|git\s+reset|git\s+clean|force-push|delete|unregister)(?:\s|$)/iu;

export async function generateDiagnosticsTriage(
  projectRoot: string,
  dependencies: DiagnosticsTriageDependencies = {}
): Promise<DiagnosticsTriageReport> {
  const now = (dependencies.now ?? (() => new Date()))();
  const projectId = await safeProjectId(projectRoot, dependencies.projectId);
  const doctorCollector = dependencies.doctor ?? defaultDoctorCollector;
  const watchdogCollector =
    dependencies.watchdogAlerts ??
    ((root: string) => listWatchdogAlerts(root));
  const incidentCollector =
    dependencies.incidents ??
    ((root: string) => listIncidents(root, { status: "all" }));
  const correlationCollector = dependencies.correlations ?? listCorrelations;
  const correlationIntegrityCollector =
    dependencies.correlationIntegrity ?? inspectCorrelationIntegrity;
  const certificationCollector =
    dependencies.agentCertifications ??
    ((root: string, current: Date) =>
      inspectAgentCertifications(root, { now: current }));
  const fileCollector = dependencies.fileArtifacts ?? collectFileArtifacts;

  const [doctorResult, watchdogResult, incidentResult, correlationResult,
    correlationIntegrityResult, certificationResult, fileResult] =
    await Promise.all([
    collectSafely("doctor", () => doctorCollector(projectRoot)),
    collectSafely("watchdog", () => watchdogCollector(projectRoot)),
    collectSafely("incidents", () => incidentCollector(projectRoot)),
    collectSafely("correlations", () => correlationCollector(projectRoot)),
    collectSafely("correlations", () =>
      correlationIntegrityCollector(projectRoot)),
    collectSafely("agent_certifications", () =>
      certificationCollector(projectRoot, now)),
    collectSafely("updates", () => fileCollector(projectRoot))
    ]);

  const incidents = incidentResult.value ?? [];
  const correlations = correlationResult.value ?? [];
  const context: FindingContext = {
    projectRoot,
    projectId,
    incidents,
    correlations
  };
  const collections: SourceCollection[] = [
    doctorResult.value === undefined
      ? unavailableCollection("doctor", projectId)
      : collectDoctorFindings(doctorResult.value, context),
    watchdogResult.value === undefined
      ? unavailableCollection("watchdog", projectId)
      : collectWatchdogFindings(watchdogResult.value, context),
    incidentResult.value === undefined
      ? unavailableCollection("incidents", projectId)
      : collectIncidentFindings(incidentResult.value, context),
    correlationResult.value === undefined ||
    correlationIntegrityResult.value === undefined
      ? unavailableCollection("correlations", projectId)
      : collectCorrelationFindings(
          correlationResult.value,
          correlationIntegrityResult.value,
          context
        ),
    fileResult.value === undefined
      ? unavailableCollection("stable_readiness", projectId)
      : collectStableReadinessFindings(fileResult.value.stableReadiness, context),
    fileResult.value === undefined
      ? unavailableCollection("updates", projectId)
      : collectUpdateFindings(fileResult.value.updateTransactions, context),
    certificationResult.value === undefined
      ? unavailableCollection("agent_certifications", projectId)
      : collectCertificationFindings(certificationResult.value, context),
    fileResult.value === undefined
      ? unavailableCollection("support_bundles", projectId)
      : collectSupportBundleFindings(fileResult.value.supportPlans, context)
  ];

  const supportEvidence = collections
    .find((collection) => collection.source.id === "support_bundles")
    ?.source.evidence_paths.at(-1);
  const findings = collections
    .flatMap((collection) => collection.findings)
    .map((finding) =>
      supportEvidence !== undefined &&
      severityOrder[finding.severity] >= severityOrder.high
        ? {
            ...finding,
            evidence_paths: uniqueStrings([
              ...(finding.evidence_paths ?? []),
              supportEvidence
            ])
          }
        : finding);
  const items = aggregateFindings(findings, projectRoot);
  const sources = collections
    .map((collection) => collection.source)
    .sort((left, right) =>
      sourceOrder.indexOf(left.id) - sourceOrder.indexOf(right.id));
  const unavailableSources = sources.filter(
    (source) => source.status === "unavailable"
  ).length;
  const redaction = createRedactionSummary();
  const sanitizedItems = items.map((item) =>
    sanitizeTriageItem(item, projectRoot, redaction));
  const secretScan = scanSupportEntries([
    {
      path: "triage.json",
      content: JSON.stringify(sanitizedItems)
    }
  ]);
  if (secretScan.status !== "passed") {
    throw new Error("Diagnostics triage secret scan failed.");
  }

  return {
    schema_version: "0.1",
    artifact_kind: "diagnostics_triage_report",
    report_id: createReportId(now),
    project_id: sanitizeSupportText(projectId, { projectRoot }, redaction),
    status:
      unavailableSources > 0
        ? "PARTIAL"
        : sanitizedItems.length === 0
          ? "PASS"
          : "ATTENTION_REQUIRED",
    generated_at: now.toISOString(),
    read_only: true,
    sources,
    items: sanitizedItems,
    summary: {
      items: sanitizedItems.length,
      critical: countSeverity(sanitizedItems, "critical"),
      high: countSeverity(sanitizedItems, "high"),
      warning: countSeverity(sanitizedItems, "warning"),
      info: countSeverity(sanitizedItems, "info"),
      unavailable_sources: unavailableSources
    },
    redaction: {
      ...redaction,
      secret_scan_status: "passed",
      secret_finding_count: 0
    }
  };
}

export function formatDiagnosticsTriage(
  report: DiagnosticsTriageReport,
  format: "text" | "json" | "markdown" = "text"
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatDiagnosticsTriageMarkdown(report);
  }

  const lines = [
    "Kairon diagnostics triage.",
    `report_id=${report.report_id}`,
    `project_id=${report.project_id}`,
    `status=${report.status}`,
    `read_only=${report.read_only}`,
    `items=${report.summary.items}`,
    `critical=${report.summary.critical}`,
    `high=${report.summary.high}`,
    `warning=${report.summary.warning}`,
    `info=${report.summary.info}`,
    `unavailable_sources=${report.summary.unavailable_sources}`
  ];
  for (const source of report.sources) {
    lines.push(
      `source.${source.id}=${source.status} findings=${source.findings}`
    );
  }
  for (const item of report.items) {
    lines.push(
      `item.id=${item.id} severity=${item.severity} root_cause=${item.root_cause_category} findings=${item.related_finding_ids.join(",")}`
    );
    lines.push(`  action=${item.operator_action}`);
    for (const action of item.actions) {
      lines.push(
        `  ${action.kind}=${action.command ?? action.summary}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeDiagnosticsTriage(
  report: DiagnosticsTriageReport,
  outputPath: string
): Promise<DiagnosticsTriageWriteResult> {
  const basePath = outputBasePath(outputPath);
  const jsonPath = `${basePath}.json`;
  const markdownPath = `${basePath}.md`;
  const json = formatDiagnosticsTriage(report, "json");
  const markdown = formatDiagnosticsTriage(report, "markdown");
  const scan = scanSupportEntries([
    { path: path.basename(jsonPath), content: json },
    { path: path.basename(markdownPath), content: markdown }
  ]);
  if (scan.status !== "passed") {
    throw new Error("Diagnostics triage output contains a secret-like value.");
  }
  await writeJsonFileAtomic(jsonPath, report);
  await writeTextAtomic(markdownPath, markdown);
  return {
    json_path: jsonPath,
    markdown_path: markdownPath
  };
}

export function parseDiagnosticsTriageFormat(
  value: string | undefined
): "text" | "json" | "markdown" {
  const normalized = (value ?? "text").trim().toLowerCase();
  if (
    normalized !== "text" &&
    normalized !== "json" &&
    normalized !== "markdown"
  ) {
    throw new Error("Diagnostics triage format must be text, json, or markdown.");
  }
  return normalized;
}

function collectDoctorFindings(
  result: DoctorResult,
  context: FindingContext
): SourceCollection {
  const findings = result.checks
    .filter((check) => check.status !== "pass")
    .map((check) => doctorFinding(check, context));
  return availableCollection("doctor", findings, []);
}

function doctorFinding(
  check: DoctorCheck,
  context: FindingContext
): Finding {
  const category = doctorRootCause(check.id);
  const severity: DiagnosticsTriageSeverity =
    check.status === "error" ? "high" : "warning";
  const actions = actionsForDoctorCheck(check, category);
  return {
    id: `doctor:${check.id}`,
    source: "doctor",
    severity,
    category,
    summary: `${check.title} requires operator attention.`,
    project_id: context.projectId,
    evidence_paths: evidencePathsFromDetails(
      context.projectRoot,
      check.details
    ),
    actions
  };
}

function collectWatchdogFindings(
  alerts: WatchdogAlert[],
  context: FindingContext
): SourceCollection {
  const findings = alerts
    .filter((alert) => alert.status !== "resolved")
    .map((alert): Finding => {
      const incident = findIncidentForResource(
        context.incidents,
        "watchdog_alert",
        alert.alert_id
      );
      return {
        id: `watchdog:${alert.alert_id}`,
        source: "watchdog",
        severity: alert.severity,
        category: watchdogRootCause(alert.rule),
        grouping_key:
          incident === undefined
            ? `fingerprint:${alert.fingerprint}`
            : `correlation:${incident.correlation_id}`,
        summary: alert.summary,
        project_id: context.projectId,
        correlation_ids:
          incident === undefined ? [] : [incident.correlation_id],
        incident_ids:
          incident === undefined ? [] : [incident.incident_id],
        evidence_paths: [
          `.kairon/runtime/watchdog/alerts/${alert.alert_id}.json`
        ],
        actions: [
          readOnlyAction(
            "Inspect the current watchdog alert.",
            `kairon watchdog alert show ${alert.alert_id}`
          )
        ]
      };
    });
  return availableCollection(
    "watchdog",
    findings,
    findings.flatMap((finding) => finding.evidence_paths ?? [])
  );
}

function collectIncidentFindings(
  incidents: IncidentArtifact[],
  context: FindingContext
): SourceCollection {
  const active = incidents.filter((incident) => incident.status !== "resolved");
  const findings = active.map((incident): Finding => ({
    id: `incident:${incident.incident_id}`,
    source: "incidents",
    severity: incident.severity,
    category: "incident_recovery",
    grouping_key: `correlation:${incident.correlation_id}`,
    summary: incident.summary,
    project_id: context.projectId,
    correlation_ids: [incident.correlation_id],
    incident_ids: [incident.incident_id],
    transaction_ids: incident.resources
      .filter((resource) => resource.kind === "update_transaction")
      .map((resource) => resource.id),
    evidence_paths: [
      `.kairon/incidents/${incident.incident_id}/incident.json`,
      ...incident.resources
        .map((resource) => resource.artifact_path)
        .filter((value): value is string => value !== undefined)
    ],
    actions: [
      readOnlyAction(
        "Inspect the incident and its timeline.",
        `kairon incident show ${incident.incident_id}`
      ),
      approvalAction(
        "Create an approval-gated assisted recovery plan.",
        `kairon incident recover ${incident.incident_id} --dry-run`
      )
    ]
  }));
  return availableCollection(
    "incidents",
    findings,
    active.map((incident) =>
      `.kairon/incidents/${incident.incident_id}/incident.json`)
  );
}

function collectCorrelationFindings(
  correlations: CorrelationArtifact[],
  integrity: CorrelationIntegrityResult,
  context: FindingContext
): SourceCollection {
  const findings = integrity.issues.map((issue): Finding => {
    const severity: DiagnosticsTriageSeverity =
      issue.kind === "duplicate_member" ||
      issue.kind === "orphan_follow_up" ||
      issue.kind === "missing_artifact"
        ? "high"
        : "warning";
    return {
      id: `correlation:${issue.correlation_id}:${issue.kind}:${issue.member_kind}:${issue.member_id}`,
      source: "correlations",
      severity,
      category: "data_integrity",
      grouping_key: `correlation:${issue.correlation_id}`,
      summary: `Correlation integrity reported ${issue.kind} for ${issue.member_kind}:${issue.member_id}.`,
      project_id: context.projectId,
      correlation_ids: [issue.correlation_id],
      evidence_paths: uniqueStrings([
        `.kairon/correlations/${issue.correlation_id}.json`,
        issue.artifact_path
      ]),
      actions: [
        readOnlyAction(
          "Run the correlation integrity diagnostic.",
          "kairon doctor"
        )
      ]
    };
  });
  return availableCollection(
    "correlations",
    findings,
    correlations.map((correlation) =>
      `.kairon/correlations/${correlation.correlation_id}.json`)
  );
}

function collectStableReadinessFindings(
  result: Record<string, unknown> | null,
  context: FindingContext
): SourceCollection {
  const evidencePath = ".kairon/readiness/stable-result.json";
  if (result === null) {
    return availableCollection("stable_readiness", [], []);
  }
  const status = stringValue(result.status) ?? "UNKNOWN";
  const ready = result.stable_ready === true;
  if (status === "PASS" && ready) {
    return availableCollection("stable_readiness", [], [evidencePath]);
  }
  const blockers = Array.isArray(result.blockers)
    ? result.blockers.filter(isRecord)
    : [];
  const releaseIds = uniqueStrings([
    stringValue(result.release_id),
    stringValue(result.release_manifest_id)
  ]);
  const finding: Finding = {
    id: "stable_readiness:unpassed",
    source: "stable_readiness",
    severity: status === "FAIL" ? "high" : "warning",
    category: "release_readiness",
    grouping_key:
      releaseIds[0] === undefined
        ? "root:release_readiness"
        : `release:${releaseIds[0]}`,
    summary:
      blockers.length === 0
        ? `Stable readiness is ${status}.`
        : `Stable readiness has ${blockers.length} blocker(s).`,
    project_id: context.projectId,
    release_ids: releaseIds,
    evidence_paths: [evidencePath],
    actions: [
      readOnlyAction(
        "Inspect the Stable readiness result and regenerate current evidence.",
        "kairon readiness stable check --format json"
      )
    ]
  };
  return availableCollection("stable_readiness", [finding], [evidencePath]);
}

function collectUpdateFindings(
  transactions: Array<Record<string, unknown>>,
  context: FindingContext
): SourceCollection {
  const findings: Finding[] = [];
  for (const transaction of transactions) {
    const transactionId = stringValue(transaction.transaction_id);
    const status = stringValue(transaction.status);
    if (
      transactionId === undefined ||
      status === undefined ||
      status === "completed"
    ) {
      continue;
    }
    const incidentId = stringValue(transaction.incident_id);
    const incident =
      incidentId === undefined
        ? findIncidentForResource(
            context.incidents,
            "update_transaction",
            transactionId
          )
        : context.incidents.find(
            (candidate) => candidate.incident_id === incidentId
          );
    const severity: DiagnosticsTriageSeverity =
      status === "recovery_required"
        ? "critical"
        : status === "running"
          ? "high"
          : "warning";
    const actions: DiagnosticsTriageAction[] = [
      readOnlyAction(
        "Inspect the update transaction and linked incident.",
        incident === undefined
          ? "kairon incident list --status all"
          : `kairon incident show ${incident.incident_id}`
      )
    ];
    if (incident !== undefined) {
      actions.push(
        approvalAction(
          "Create an approval-gated recovery plan; do not retry the update automatically.",
          `kairon incident recover ${incident.incident_id} --dry-run`
        )
      );
    }
    findings.push({
      id: `update:${transactionId}`,
      source: "updates",
      severity,
      category: "update_recovery",
      grouping_key:
        incident === undefined
          ? `transaction:${transactionId}`
          : `correlation:${incident.correlation_id}`,
      summary: `Update transaction ${transactionId} is ${status}.`,
      project_id: context.projectId,
      correlation_ids:
        incident === undefined ? [] : [incident.correlation_id],
      incident_ids:
        incident === undefined ? [] : [incident.incident_id],
      transaction_ids: [transactionId],
      evidence_paths: [
        `.kairon/update/transactions/${transactionId}.json`
      ],
      actions
    });
  }
  return availableCollection(
    "updates",
    findings,
    transactions
      .map((transaction) => stringValue(transaction.transaction_id))
      .filter((value): value is string => value !== undefined)
      .map((transactionId) =>
        `.kairon/update/transactions/${transactionId}.json`)
  );
}

function collectCertificationFindings(
  inspections: AgentCertificationInspection[],
  context: FindingContext
): SourceCollection {
  const findings = inspections
    .filter((inspection) => inspection.status !== "current")
    .map((inspection): Finding => {
      const status = inspection.status;
      return {
        id: `agent_certification:${inspection.agent}:${inspection.reason}`,
        source: "agent_certifications",
        severity: status === "failed" || status === "corrupt" ? "high" : "warning",
        category:
          status === "setup_required" ? "credentials" : "agent_compatibility",
        summary: `Agent ${inspection.agent} compatibility is ${status}.`,
        project_id: context.projectId,
        evidence_paths:
          inspection.certification === null
            ? []
            : [inspection.certification.artifact_path],
        actions: [
          status === "setup_required"
            ? externalAction(
                `Complete the official ${inspection.agent} CLI login or setup, then rerun certification.`
              )
            : readOnlyAction(
                "Rerun the official CLI compatibility certification.",
                inspection.rerun_command
              )
        ]
      };
    });
  return availableCollection(
    "agent_certifications",
    findings,
    findings.flatMap((finding) => finding.evidence_paths ?? [])
  );
}

function collectSupportBundleFindings(
  plans: Array<Record<string, unknown>>,
  context: FindingContext
): SourceCollection {
  const evidencePaths = plans
    .map((plan) => stringValue(plan.bundle_id))
    .filter((value): value is string => value !== undefined)
    .map((bundleId) => `.kairon/support/plans/${bundleId}.json`);
  const invalid = plans.filter(
    (plan) =>
      stringValue(plan.bundle_id) === undefined ||
      !["dry_run", "completed"].includes(stringValue(plan.status) ?? "")
  );
  const findings =
    invalid.length === 0
      ? []
      : [{
          id: "support_bundles:invalid_plan",
          source: "support_bundles" as const,
          severity: "warning" as const,
          category: "support_evidence" as const,
          summary: `${invalid.length} support bundle plan(s) are invalid.`,
          project_id: context.projectId,
          evidence_paths: evidencePaths,
          actions: [
            readOnlyAction(
              "Create a fresh sanitized support bundle plan.",
              "kairon support bundle --dry-run"
            )
          ]
        }];
  return availableCollection("support_bundles", findings, evidencePaths);
}

function aggregateFindings(
  findings: Finding[],
  projectRoot: string
): DiagnosticsTriageItem[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key =
      finding.grouping_key ??
      firstGroupingKey(finding) ??
      `root:${finding.category}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.entries()]
    .map(([key, group]) => aggregateFindingGroup(key, group, projectRoot))
    .sort(compareTriageItems)
    .map((item, index) => ({
      ...item,
      id: `TRI-${String(index + 1).padStart(3, "0")}`
    }));
}

function aggregateFindingGroup(
  key: string,
  findings: Finding[],
  projectRoot: string
): DiagnosticsTriageItem {
  const sorted = [...findings].sort((left, right) => {
    const severity = severityOrder[right.severity] - severityOrder[left.severity];
    return severity !== 0 ? severity : left.id.localeCompare(right.id);
  });
  const primary = sorted[0]!;
  const actions = uniqueActions(sorted.flatMap((finding) => finding.actions ?? []));
  if (
    severityOrder[primary.severity] >= severityOrder.high &&
    !actions.some((action) =>
      action.command === "kairon support bundle --dry-run")
  ) {
    actions.push(
      readOnlyAction(
        "Plan a sanitized support bundle before sharing diagnostics.",
        "kairon support bundle --dry-run"
      )
    );
  }
  return {
    id: "TRI-PENDING",
    severity: primary.severity,
    root_cause_category: primary.category,
    root_cause_key: sanitizeSupportText(key, { projectRoot }),
    related_finding_ids: sorted.map((finding) => finding.id).sort(),
    correlation: {
      project_id: primary.project_id,
      correlation_ids: uniqueStrings(
        sorted.flatMap((finding) => finding.correlation_ids ?? [])
      ),
      incident_ids: uniqueStrings(
        sorted.flatMap((finding) => finding.incident_ids ?? [])
      ),
      transaction_ids: uniqueStrings(
        sorted.flatMap((finding) => finding.transaction_ids ?? [])
      ),
      release_ids: uniqueStrings(
        sorted.flatMap((finding) => finding.release_ids ?? [])
      )
    },
    evidence_paths: uniqueStrings(
      sorted.flatMap((finding) => finding.evidence_paths ?? [])
    ),
    operator_action: primary.summary,
    actions
  };
}

function sanitizeTriageItem(
  item: DiagnosticsTriageItem,
  projectRoot: string,
  redaction: SupportRedactionSummary
): DiagnosticsTriageItem {
  return {
    ...item,
    root_cause_key: sanitizeSupportText(
      item.root_cause_key,
      { projectRoot },
      redaction
    ),
    related_finding_ids: item.related_finding_ids.map((value) =>
      sanitizeSupportText(value, { projectRoot }, redaction)),
    correlation: {
      project_id: sanitizeSupportText(
        item.correlation.project_id,
        { projectRoot },
        redaction
      ),
      correlation_ids: item.correlation.correlation_ids.map((value) =>
        sanitizeSupportText(value, { projectRoot }, redaction)),
      incident_ids: item.correlation.incident_ids.map((value) =>
        sanitizeSupportText(value, { projectRoot }, redaction)),
      transaction_ids: item.correlation.transaction_ids.map((value) =>
        sanitizeSupportText(value, { projectRoot }, redaction)),
      release_ids: item.correlation.release_ids.map((value) =>
        sanitizeSupportText(value, { projectRoot }, redaction))
    },
    evidence_paths: normalizeEvidencePaths(
      projectRoot,
      item.evidence_paths,
      redaction
    ),
    operator_action: sanitizeSupportText(
      item.operator_action,
      { projectRoot },
      redaction
    ),
    actions: item.actions
      .filter((action) =>
        action.command === undefined ||
        (!prohibitedCommandPattern.test(action.command) &&
          !containsSecretAssignment(action.command)))
      .map((action) => ({
        ...action,
        summary: sanitizeSupportText(
          action.summary,
          { projectRoot },
          redaction
        ),
        ...(action.command === undefined
          ? {}
          : {
              command: sanitizeSupportText(
                action.command,
                { projectRoot },
                redaction
              )
            })
      }))
  };
}

function actionsForDoctorCheck(
  check: DoctorCheck,
  category: DiagnosticsRootCauseCategory
): DiagnosticsTriageAction[] {
  if (check.next_action === undefined) {
    return [
      readOnlyAction(
        "Inspect the complete Doctor result.",
        "kairon doctor --format json"
      )
    ];
  }
  const candidate = check.next_action.trim();
  if (candidate.startsWith("kairon ") && isReadOnlyCommand(candidate)) {
    return [readOnlyAction("Run the suggested read-only diagnostic.", candidate)];
  }
  if (
    candidate.startsWith("kairon ") &&
    !prohibitedCommandPattern.test(candidate) &&
    !containsSecretAssignment(candidate)
  ) {
    return [
      approvalAction(
        "Review and approve the suggested state-changing command before execution.",
        candidate
      )
    ];
  }
  if (category === "credentials") {
    return [
      externalAction(
        "Complete the required credential or official CLI login setup outside Kairon."
      )
    ];
  }
  return [
    externalAction(
      sanitizeSupportText(candidate).replace(/\s+/gu, " ").trim()
    )
  ];
}

function doctorRootCause(id: string): DiagnosticsRootCauseCategory {
  if (/(?:api_key|credential|branch_protection|auth)/u.test(id)) {
    return "credentials";
  }
  if (/^agent\./u.test(id)) {
    return "agent_compatibility";
  }
  if (/(?:remote|discord|board)/u.test(id)) {
    return "remote_connectivity";
  }
  if (/(?:readiness|release|post_release)/u.test(id)) {
    return "release_readiness";
  }
  if (/^update\./u.test(id)) {
    return "update_recovery";
  }
  if (/(?:integrity|backup|correlation|rag)/u.test(id)) {
    return "data_integrity";
  }
  if (/(?:runtime|daemon|watchdog|queue)/u.test(id)) {
    return "runtime_health";
  }
  return "configuration";
}

function watchdogRootCause(rule: string): DiagnosticsRootCauseCategory {
  if (rule.startsWith("remote_")) {
    return "remote_connectivity";
  }
  if (rule.startsWith("dr_")) {
    return "data_integrity";
  }
  if (rule === "provider_suspended") {
    return "agent_compatibility";
  }
  return "runtime_health";
}

async function collectFileArtifacts(
  projectRoot: string
): Promise<DiagnosticsTriageFileArtifacts> {
  const [stableReadiness, updateTransactions, supportPlans] =
    await Promise.all([
      readOptionalRecord(
        resolveInside(projectRoot, ".kairon", "readiness", "stable-result.json")
      ),
      readRecordDirectory(
        resolveInside(projectRoot, ".kairon", "update", "transactions"),
        /^UTX-\d{4,}\.json$/u
      ),
      readRecordDirectory(
        resolveInside(projectRoot, ".kairon", "support", "plans"),
        /^SUP-\d{4,}\.json$/u
      )
    ]);
  return {
    stableReadiness,
    updateTransactions,
    supportPlans
  };
}

async function defaultDoctorCollector(
  projectRoot: string
): Promise<DoctorResult> {
  return runDoctor({
    projectRoot,
    env: {},
    secretResolver: {
      async resolve() {
        return {
          status: "missing",
          reason: "triage does not resolve credential values"
        };
      }
    }
  });
}

async function safeProjectId(
  projectRoot: string,
  reader: DiagnosticsTriageDependencies["projectId"]
): Promise<string> {
  try {
    return reader === undefined
      ? (
          await loadConfigFile<{ project_id?: string }>(
            projectRoot,
            "project.json"
          )
        ).project_id ?? "unknown-project"
      : await reader(projectRoot);
  } catch {
    return "unknown-project";
  }
}

async function collectSafely<T>(
  _source: DiagnosticsTriageSourceId,
  collector: () => Promise<T>
): Promise<{ value?: T }> {
  try {
    return { value: await collector() };
  } catch {
    return {};
  }
}

function availableCollection(
  id: DiagnosticsTriageSourceId,
  findings: Finding[],
  evidencePaths: string[]
): SourceCollection {
  return {
    source: {
      id,
      status: "available",
      findings: findings.length,
      evidence_paths: uniqueStrings(evidencePaths)
    },
    findings
  };
}

function unavailableCollection(
  id: DiagnosticsTriageSourceId,
  projectId: string
): SourceCollection {
  return {
    source: {
      id,
      status: "unavailable",
      findings: 1,
      evidence_paths: [],
      reason: "source_read_failed"
    },
    findings: [{
      id: `${id}:source_unavailable`,
      source: id,
      severity: "warning",
      category: "data_integrity",
      grouping_key: `source:${id}`,
      summary: `The ${id} diagnostic source could not be read safely.`,
      project_id: projectId,
      actions: [
        readOnlyAction(
          "Run Doctor and inspect the source artifact without modifying state.",
          "kairon doctor --format json"
        )
      ]
    }]
  };
}

function readOnlyAction(
  summary: string,
  command: string
): DiagnosticsTriageAction {
  return { kind: "read_only", summary, command };
}

function approvalAction(
  summary: string,
  command: string
): DiagnosticsTriageAction {
  return { kind: "approval_required", summary, command };
}

function externalAction(summary: string): DiagnosticsTriageAction {
  return { kind: "external_manual", summary };
}

function isReadOnlyCommand(command: string): boolean {
  return /^kairon\s+(?:doctor|status|remote\s+(?:status|doctor)|watchdog\s+alert\s+(?:list|show)|incident\s+(?:list|show)|readiness\s+\S+\s+check|agent\s+certification\s+show|agent\s+certify|support\s+bundle\s+--dry-run|metrics\s+(?:report|slo\s+check))/u
    .test(command);
}

function containsSecretAssignment(value: string): boolean {
  return /(?:token|secret|password|authorization|credential)\s*=/iu.test(value);
}

function evidencePathsFromDetails(
  projectRoot: string,
  details: string[]
): string[] {
  const candidates = details.flatMap((detail) =>
    [...detail.matchAll(/(?:^|[=\s])(\.kairon\/[A-Za-z0-9._\/-]+)/gu)]
      .map((match) => match[1]!)
  );
  return normalizeEvidencePaths(
    projectRoot,
    candidates,
    createRedactionSummary()
  );
}

function normalizeEvidencePaths(
  projectRoot: string,
  values: string[],
  redaction: SupportRedactionSummary
): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const absolute = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(projectRoot, trimmed);
    const relative = path.relative(path.resolve(projectRoot), absolute);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      /(?:credential|secret|token|cookie)/iu.test(trimmed)
    ) {
      redaction.omitted_fields += 1;
      continue;
    }
    normalized.push(toPosixPath(relative));
  }
  return uniqueStrings(normalized);
}

function findIncidentForResource(
  incidents: IncidentArtifact[],
  kind: string,
  id: string
): IncidentArtifact | undefined {
  return incidents.find((incident) =>
    incident.resources.some(
      (resource) => resource.kind === kind && resource.id === id
    ));
}

function firstGroupingKey(finding: Finding): string | undefined {
  const correlationId = finding.correlation_ids?.[0];
  if (correlationId !== undefined) {
    return `correlation:${correlationId}`;
  }
  const transactionId = finding.transaction_ids?.[0];
  if (transactionId !== undefined) {
    return `transaction:${transactionId}`;
  }
  const releaseId = finding.release_ids?.[0];
  return releaseId === undefined ? undefined : `release:${releaseId}`;
}

function uniqueActions(
  actions: DiagnosticsTriageAction[]
): DiagnosticsTriageAction[] {
  const unique = new Map<string, DiagnosticsTriageAction>();
  for (const action of actions) {
    const key = `${action.kind}:${action.command ?? action.summary}`;
    if (!unique.has(key)) {
      unique.set(key, action);
    }
  }
  return [...unique.values()].sort((left, right) => {
    const order = {
      read_only: 0,
      approval_required: 1,
      external_manual: 2
    };
    const kind = order[left.kind] - order[right.kind];
    return kind !== 0
      ? kind
      : (left.command ?? left.summary).localeCompare(
          right.command ?? right.summary
        );
  });
}

function compareTriageItems(
  left: DiagnosticsTriageItem,
  right: DiagnosticsTriageItem
): number {
  const severity = severityOrder[right.severity] - severityOrder[left.severity];
  if (severity !== 0) {
    return severity;
  }
  const category = left.root_cause_category.localeCompare(
    right.root_cause_category
  );
  return category !== 0
    ? category
    : left.root_cause_key.localeCompare(right.root_cause_key);
}

function countSeverity(
  items: DiagnosticsTriageItem[],
  severity: DiagnosticsTriageSeverity
): number {
  return items.filter((item) => item.severity === severity).length;
}

function createReportId(now: Date): string {
  const timestamp = now.toISOString().replace(/\D/gu, "").slice(0, 14);
  return `DTR-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function createRedactionSummary(): SupportRedactionSummary {
  return {
    policy_version: "0.1",
    redacted_fields: 0,
    redacted_values: 0,
    omitted_fields: 0,
    truncated_values: 0
  };
}

function outputBasePath(outputPath: string): string {
  const absolute = path.resolve(outputPath);
  const extension = path.extname(absolute).toLowerCase();
  return extension === ".json" || extension === ".md"
    ? absolute.slice(0, -extension.length)
    : absolute;
}

async function writeTextAtomic(
  filePath: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Failed to write diagnostics triage Markdown: ${String(error)}`);
  }
}

function formatDiagnosticsTriageMarkdown(
  report: DiagnosticsTriageReport
): string {
  const lines = [
    "# Kairon Diagnostics Triage",
    "",
    `- Report: \`${escapeMarkdown(report.report_id)}\``,
    `- Project: \`${escapeMarkdown(report.project_id)}\``,
    `- Generated: ${report.generated_at}`,
    `- Status: **${report.status}**`,
    `- Read-only: \`${report.read_only}\``,
    "",
    "## Summary",
    "",
    "| Severity | Count |",
    "| --- | ---: |",
    `| Critical | ${report.summary.critical} |`,
    `| High | ${report.summary.high} |`,
    `| Warning | ${report.summary.warning} |`,
    `| Info | ${report.summary.info} |`,
    `| Unavailable sources | ${report.summary.unavailable_sources} |`,
    "",
    "## Sources",
    "",
    "| Source | Status | Findings |",
    "| --- | --- | ---: |",
    ...report.sources.map((source) =>
      `| ${escapeMarkdown(source.id)} | ${source.status} | ${source.findings} |`),
    "",
    "## Prioritized Actions",
    ""
  ];
  if (report.items.length === 0) {
    lines.push("No operator action is required.", "");
  } else {
    for (const item of report.items) {
      lines.push(
        `### ${item.id}: ${item.severity.toUpperCase()} ${item.root_cause_category}`,
        "",
        item.operator_action,
        "",
        `- Findings: ${item.related_finding_ids.map((id) => `\`${escapeMarkdown(id)}\``).join(", ")}`,
        `- Evidence: ${
          item.evidence_paths.length === 0
            ? "none"
            : item.evidence_paths
                .map((value) => `\`${escapeMarkdown(value)}\``)
                .join(", ")
        }`,
        "- Actions:",
        ...item.actions.map((action) =>
          `  - **${action.kind}**: ${escapeMarkdown(action.summary)}${
            action.command === undefined
              ? ""
              : ` \`${escapeMarkdown(action.command)}\``
          }`),
        ""
      );
    }
  }
  lines.push(
    "## Redaction",
    "",
    `- Policy: ${report.redaction.policy_version}`,
    `- Secret scan: ${report.redaction.secret_scan_status}`,
    `- Secret findings: ${report.redaction.secret_finding_count}`,
    ""
  );
  return lines.join("\n");
}

async function readOptionalRecord(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const value = await readJsonFile<unknown>(filePath);
    if (!isRecord(value)) {
      throw new Error("artifact is not an object");
    }
    return value;
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function readRecordDirectory(
  directory: string,
  pattern: RegExp
): Promise<Array<Record<string, unknown>>> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records: Array<Record<string, unknown>> = [];
  for (const entry of entries.filter((value) => pattern.test(value)).sort()) {
    const value = JSON.parse(
      await readFile(resolveInside(directory, entry), "utf8")
    ) as unknown;
    if (!isRecord(value)) {
      throw new Error("diagnostic artifact is not an object");
    }
    records.push(value);
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(
    values.filter((value): value is string =>
      value !== undefined && value.trim().length > 0)
  )].sort();
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("`", "\\`");
}
