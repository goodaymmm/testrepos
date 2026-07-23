import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProviderPolicyHealth, type ProviderPolicyHealth } from "../agents/provider-policy.js";
import { runDoctor, type DoctorResult } from "./doctor.js";
import { nextId } from "../core/ids/counter.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { KAIRON_VERSION } from "../index.js";
import { verifyRagIndex, type RagIntegrityArtifact } from "../rag/integrity.js";
import { getRuntimeStatus, type RuntimeStatus } from "../runtime/status.js";
import {
  getIncident,
  readIncidentTimeline
} from "../incidents/store.js";
import {
  sanitizeSupportText,
  sanitizeSupportValue,
  scanSupportEntries,
  type SupportRedactionSummary,
  type SupportSecretScan
} from "./support-redaction.js";

export type SupportCategory =
  | "system"
  | "runtime"
  | "queue"
  | "provider"
  | "workflow"
  | "notification"
  | "incident"
  | "integrity";

export type SupportBundlePlanFile = {
  path: string;
  category: SupportCategory | "summary";
  source: "sanitized_summary";
  estimated_size_bytes: number;
};

export type SupportBundlePlan = {
  schema_version: "0.1";
  artifact_kind: "support_bundle_plan";
  bundle_id: string;
  status: "dry_run" | "completed";
  created_at: string;
  output_directory: string;
  archive_name: string;
  incident_id?: string;
  files: SupportBundlePlanFile[];
  exclusions: Array<{ kind: string; reason: string }>;
  estimated_payload_size_bytes: number;
  archive?: {
    path: string;
    sha256: string;
    size_bytes: number;
  };
};

export type SupportBundleManifest = {
  schema_version: "0.1";
  artifact_kind: "support_bundle";
  bundle_id: string;
  incident_id?: string;
  created_at: string;
  generator: { name: "kairon"; version: string };
  local_only: true;
  upload_performed: false;
  redaction: SupportRedactionSummary & {
    secret_scan_status: "passed";
    secret_finding_count: 0;
  };
  files: Array<{
    path: string;
    category: SupportCategory | "summary";
    size_bytes: number;
    sha256: string;
  }>;
};

export type SupportBundleResult = {
  plan: SupportBundlePlan;
  archive_path?: string;
  manifest?: SupportBundleManifest;
};

export type SupportBundleVerification = {
  ok: boolean;
  bundle_id?: string;
  archive_path: string;
  archive_sha256: string;
  size_bytes: number;
  files: number;
  secret_scan: SupportSecretScan;
  checks: Array<{
    id: "archive" | "paths" | "manifest" | "hashes" | "secret_scan";
    status: "pass" | "error";
    details: string;
  }>;
};

export type SupportBundleDependencies = {
  doctor?: (projectRoot: string) => Promise<DoctorResult>;
  runtimeStatus?: (projectRoot: string) => Promise<RuntimeStatus>;
  providerHealth?: (projectRoot: string) => Promise<ProviderPolicyHealth[]>;
  ragIntegrity?: (projectRoot: string) => Promise<RagIntegrityArtifact>;
  now?: () => Date;
};

export type SupportBundleOptions = {
  outputDirectory?: string;
  incidentId?: string;
};

type SupportEntry = {
  path: string;
  category: SupportCategory | "summary";
  content: Buffer;
};

type ZipEntry = { path: string; content: Buffer; crc32: number };

const bundleIdPattern = /^SUP-\d{4}$/u;
const maxArchiveBytes = 10 * 1024 * 1024;
const maxEntryBytes = 1024 * 1024;
const maxZipEntries = 32;
const maxWorkflowRecords = 500;
const requiredDiagnosticPaths = [
  "diagnostics/system.json",
  "diagnostics/runtime.json",
  "diagnostics/queue.json",
  "diagnostics/provider.json",
  "diagnostics/workflow.json",
  "diagnostics/notification.json",
  "diagnostics/integrity.json"
] as const;

const exclusions = [
  { kind: "project_source", reason: "project source is outside the support bundle allowlist" },
  { kind: "protected_paths", reason: ".env, credentials, keys, and protected paths are never collected" },
  { kind: "agent_output", reason: "raw stdout, stderr, prompts, context, and agent output are never copied" },
  { kind: "change_content", reason: "diffs, patches, and working tree content are never copied" },
  { kind: "raw_logs", reason: "daemon and runtime logs are summarized by allowlisted counters only" }
];

export async function planSupportBundle(
  projectRoot: string,
  options: SupportBundleOptions = {},
  dependencies: SupportBundleDependencies = {}
): Promise<SupportBundleResult> {
  const now = dependencies.now?.() ?? new Date();
  const bundleId = "SUP-DRY-RUN";
  const outputDirectory = resolveOutputDirectory(projectRoot, options.outputDirectory);
  const entries = await collectSupportEntries(
    projectRoot,
    now,
    dependencies,
    options.incidentId
  );
  return {
    plan: createPlan(
      projectRoot,
      bundleId,
      "dry_run",
      outputDirectory,
      now,
      entries,
      options.incidentId
    )
  };
}

export async function createSupportBundle(
  projectRoot: string,
  options: SupportBundleOptions = {},
  dependencies: SupportBundleDependencies = {}
): Promise<SupportBundleResult> {
  const now = dependencies.now?.() ?? new Date();
  const bundleId = await nextId(projectRoot, "support_bundle");
  const outputDirectory = resolveOutputDirectory(projectRoot, options.outputDirectory);
  await ensureSafeDirectory(outputDirectory);
  const archiveName = `kairon-support-${bundleId}.zip`;
  const archivePath = path.join(outputDirectory, archiveName);
  await assertMissing(archivePath);

  const paths = getKaironPaths(projectRoot);
  const stagingRoot = resolveInside(
    paths.tmpDir,
    `support-${bundleId}-${randomUUID()}`
  );
  const temporaryArchive = path.join(outputDirectory, `.${archiveName}.${randomUUID()}.tmp`);
  let finalized = false;
  let completed = false;

  try {
    await assertNoLinkedSegments(paths.tmpDir);
    const entries = await collectSupportEntries(
      projectRoot,
      now,
      dependencies,
      options.incidentId
    );
    const redaction = mergeRedaction(entries.map((entry) => entry.redaction));
    const payloadEntries: SupportEntry[] = entries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      content: entry.content
    }));
    const preArchiveScan = scanSupportEntries(payloadEntries);
    assertSecretScanPassed(preArchiveScan, "sanitized payload");

    const manifest = createManifest(
      bundleId,
      now,
      payloadEntries,
      redaction,
      options.incidentId
    );
    const manifestContent = jsonBuffer(manifest);
    const hashesContent = createHashesFile(manifest);
    const finalEntries: SupportEntry[] = [
      ...payloadEntries,
      { path: "hashes.sha256", category: "summary" as const, content: hashesContent },
      { path: "manifest.json", category: "summary" as const, content: manifestContent }
    ];
    finalEntries.sort((left, right) => left.path.localeCompare(right.path));

    const finalScan = scanSupportEntries(finalEntries);
    assertSecretScanPassed(finalScan, "final bundle entries");
    await writeStagingEntries(stagingRoot, finalEntries);
    const stagedEntries = await readStagingEntries(stagingRoot, finalEntries);
    const archiveBytes = createZip(stagedEntries);
    const verification = verifySupportBundleBytes(archiveBytes, archivePath);
    if (!verification.ok) {
      throw new Error("Generated support bundle did not pass post-archive verification.");
    }

    await writeFile(temporaryArchive, archiveBytes, { flag: "wx" });
    await link(temporaryArchive, archivePath);
    finalized = true;
    await rm(temporaryArchive, { force: true });
    const plan = createPlan(
      projectRoot,
      bundleId,
      "completed",
      outputDirectory,
      now,
      payloadEntries,
      options.incidentId
    );
    plan.archive = {
      path: toProjectOrExternalPath(projectRoot, archivePath),
      sha256: sha256(archiveBytes),
      size_bytes: archiveBytes.length
    };
    const planPath = supportPlanPath(projectRoot, bundleId);
    await ensureSafeDirectory(path.dirname(planPath));
    await writeJsonFileAtomic(planPath, plan);
    completed = true;
    return { plan, archive_path: archivePath, manifest };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });
    if (finalized && !completed) {
      await rm(archivePath, { force: true });
    }
  }
}

export async function verifySupportBundle(
  bundlePath: string
): Promise<SupportBundleVerification> {
  const resolved = path.resolve(bundlePath);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maxArchiveBytes) {
    throw new Error("Support bundle must be a regular ZIP file no larger than 10 MiB.");
  }
  return verifySupportBundleBytes(await readFile(resolved), resolved);
}

export function formatSupportBundle(result: SupportBundleResult): string {
  const plan = result.plan;
  return [
    plan.status === "dry_run"
      ? "Kairon support bundle dry run."
      : "Kairon support bundle created.",
    `bundle_id=${plan.bundle_id}`,
    ...(plan.incident_id === undefined ? [] : [`incident_id=${plan.incident_id}`]),
    `status=${plan.status}`,
    `archive=${result.archive_path ?? "not_created"}`,
    `output_directory=${plan.output_directory}`,
    `files=${plan.files.length}`,
    `estimated_payload_size_bytes=${plan.estimated_payload_size_bytes}`,
    `excluded=${plan.exclusions.length}`,
    "upload_performed=false",
    ...plan.files.map((entry) =>
      `include=${entry.path} category=${entry.category} size_bytes=${entry.estimated_size_bytes}`),
    ...plan.exclusions.map((entry) =>
      `exclude=${entry.kind} reason=${entry.reason}`)
  ].join("\n");
}

export function formatSupportVerification(
  result: SupportBundleVerification
): string {
  return [
    "Kairon support bundle verification:",
    `verification.ok=${result.ok}`,
    `bundle_id=${result.bundle_id ?? "unknown"}`,
    `archive=${result.archive_path}`,
    `sha256=${result.archive_sha256}`,
    `size_bytes=${result.size_bytes}`,
    `files=${result.files}`,
    `secret_scan=${result.secret_scan.status}`,
    `secret_findings=${result.secret_scan.finding_count}`,
    ...result.checks.map((check) =>
      `${check.status.toUpperCase()} ${check.id} ${check.details}`)
  ].join("\n");
}

export function supportPlanPath(projectRoot: string, bundleId: string): string {
  return resolveInside(projectRoot, ".kairon", "support", "plans", `${bundleId}.json`);
}

async function collectSupportEntries(
  projectRoot: string,
  now: Date,
  dependencies: SupportBundleDependencies,
  incidentId?: string
): Promise<Array<SupportEntry & { redaction: SupportRedactionSummary }>> {
  const doctorCollector = dependencies.doctor ?? ((root: string) => runDoctor({
    projectRoot: root,
    env: {},
    secretResolver: {
      async resolve() {
        return { status: "missing", reason: "support bundle does not resolve credentials" };
      }
    }
  }));
  const runtimeCollector = dependencies.runtimeStatus ?? getRuntimeStatus;
  const providerCollector = dependencies.providerHealth ?? ((root: string) =>
    listProviderPolicyHealth(root, { persist: false }));
  const ragCollector = dependencies.ragIntegrity ?? ((root: string) =>
    verifyRagIndex(root, { writeArtifact: false }));

  const [doctor, runtime, providers, rag, workflow] = await Promise.all([
    doctorCollector(projectRoot),
    runtimeCollector(projectRoot),
    providerCollector(projectRoot),
    ragCollector(projectRoot),
    collectWorkflowSummary(projectRoot)
  ]);
  const doctorChecks = (prefixes: string[]) => doctor.checks
    .filter((check) => prefixes.some((prefix) => check.id.startsWith(prefix)))
    .map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      details: check.details,
      next_action: check.next_action
    }));

  const categoryValues: Array<{ category: SupportCategory; value: unknown }> = [
    {
      category: "system",
      value: {
        schema_version: "0.1",
        category: "system",
        collected_at: now.toISOString(),
        kairon_version: KAIRON_VERSION,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        doctor: {
          ok: doctor.ok,
          summary: doctor.summary,
          checks: doctorChecks(["git.", "config.", "cli.", "env."])
        }
      }
    },
    {
      category: "runtime",
      value: {
        schema_version: "0.1",
        category: "runtime",
        schedule: {
          mode: runtime.schedule.mode,
          base_mode: runtime.schedule.baseMode,
          active_work_closed: runtime.schedule.activeWorkClosed
        },
        lock: {
          locked: runtime.runtimeLock.locked,
          stale: runtime.runtimeLock.stale ?? false,
          mode: runtime.runtimeLock.mode,
          heartbeat_at: runtime.runtimeLock.heartbeat_at,
          stop_requested: runtime.runtimeLock.stop_requested,
          tick_count: runtime.runtimeLock.tick_count,
          idle_count: runtime.runtimeLock.idle_count,
          last_action: runtime.runtimeLock.last_action,
          next_tick_at: runtime.runtimeLock.next_tick_at,
          last_error_code: runtime.runtimeLock.last_error?.code,
          last_error_message: runtime.runtimeLock.last_error?.message,
          last_error_at: runtime.runtimeLock.last_error?.at
        },
        daemon: runtime.daemonHealth === undefined ? null : {
          status: runtime.daemonHealth.status,
          started_at: runtime.daemonHealth.started_at,
          latest_event_at: runtime.daemonHealth.latest_event_at,
          ticks: runtime.daemonHealth.ticks,
          idle_ticks: runtime.daemonHealth.idle_ticks,
          processed_ticks: runtime.daemonHealth.processed_ticks,
          fatal_errors: runtime.daemonHealth.fatal_errors,
          stop_reason: runtime.daemonHealth.stop_reason,
          last_action: runtime.daemonHealth.last_action,
          stale_lock_suspected: runtime.daemonHealth.stale_lock_suspected,
          last_error_code: runtime.daemonHealth.last_error?.code,
          last_error_message: runtime.daemonHealth.last_error?.message,
          last_error_at: runtime.daemonHealth.last_error?.at
        },
        recovery: runtime.recovery,
        doctor_checks: doctorChecks(["runtime.", "daemon."])
      }
    },
    {
      category: "queue",
      value: {
        schema_version: "0.1",
        category: "queue",
        queue: runtime.queue,
        approvals: runtime.approvals,
        follow_ups: runtime.followUps,
        sessions: runtime.sessions === undefined ? null : {
          date: runtime.sessions.date,
          initialized: runtime.sessions.initialized,
          ready: runtime.sessions.ready,
          idle: runtime.sessions.idle,
          busy: runtime.sessions.busy,
          setup_required: runtime.sessions.setup_required,
          permission_required: runtime.sessions.permission_required,
          rate_limited: runtime.sessions.rate_limited,
          usage_limited: runtime.sessions.usage_limited
        }
      }
    },
    {
      category: "provider",
      value: {
        schema_version: "0.1",
        category: "provider",
        providers: providers.map((provider) => ({
          agent: provider.agent,
          status: provider.status,
          available: provider.available,
          failure_category: provider.failure_category,
          suspended: provider.suspended,
          next_retry_at: provider.next_retry_at,
          daily_date: provider.daily_date,
          daily_run_count: provider.daily_run_count,
          active_run_count: provider.active_run_ids.length,
          last_run_status: provider.last_run_status,
          policy: provider.policy,
          updated_at: provider.updated_at
        })),
        doctor_checks: doctorChecks(["agent."])
      }
    },
    { category: "workflow", value: workflow },
    {
      category: "notification",
      value: {
        schema_version: "0.1",
        category: "notification",
        discord_gateway: runtime.discordGateway ?? null,
        doctor_checks: doctorChecks(["discord.", "board."])
      }
    },
    {
      category: "integrity",
      value: {
        schema_version: "0.1",
        category: "integrity",
        rag: {
          status: rag.status,
          source_count: rag.source_count,
          chunk_count: rag.chunk_count,
          issue_count: rag.issue_count,
          issue_codes: rag.issues.map((issue) => issue.code),
          index_checksum: rag.index_checksum,
          source_manifest_checksum: rag.source_manifest_checksum,
          checked_at: rag.checked_at
        },
        doctor_checks: doctor.checks
          .filter((check) => /(?:integrity|secret_scan|backup|readiness)/u.test(check.id))
          .map((check) => ({
            id: check.id,
            title: check.title,
            status: check.status,
            details: check.details,
            next_action: check.next_action
          }))
      }
    }
  ];

  const entries: Array<SupportEntry & { redaction: SupportRedactionSummary }> =
    categoryValues.map(({ category, value }) => {
    const sanitized = sanitizeSupportValue(value, { projectRoot });
    return {
      path: `diagnostics/${category}.json`,
      category,
      content: jsonBuffer(sanitized.value),
      redaction: sanitized.redaction
    };
  });
  if (incidentId !== undefined) {
    const [incident, timeline] = await Promise.all([
      getIncident(projectRoot, incidentId),
      readIncidentTimeline(projectRoot, incidentId)
    ]);
    const sanitizedIncident = sanitizeSupportValue(
      {
        schema_version: "0.1",
        category: "incident",
        incident,
        timeline
      },
      { projectRoot }
    );
    entries.push({
      path: "diagnostics/incident.json",
      category: "incident",
      content: jsonBuffer(sanitizedIncident.value),
      redaction: sanitizedIncident.redaction
    });
  }
  const summary = buildSummary(now, entries);
  const sanitizedSummary = sanitizeSupportValue(summary, { projectRoot });
  entries.push({
    path: "summary.md",
    category: "summary",
    content: Buffer.from(String(sanitizedSummary.value), "utf8"),
    redaction: sanitizedSummary.redaction
  });
  return entries;
}

async function collectWorkflowSummary(projectRoot: string): Promise<unknown> {
  const paths = getKaironPaths(projectRoot);
  const [tasks, runs, reviews] = await Promise.all([
    summarizeNestedArtifacts(paths.tasksDir, "task.json"),
    summarizeNestedArtifacts(paths.runsDir, "runner.json"),
    summarizeFlatArtifacts(resolveInside(projectRoot, ".kairon", "reviews", "loops"))
  ]);
  return {
    schema_version: "0.1",
    category: "workflow",
    tasks,
    runs,
    reviews
  };
}

async function summarizeNestedArtifacts(
  directory: string,
  fileName: string
): Promise<unknown> {
  const names = await safeReadDirectory(directory);
  const selected = names.filter(isSafeRecordName).sort().slice(-maxWorkflowRecords);
  const records = await Promise.all(selected.map(async (name) => {
    const container = path.join(directory, name);
    try {
      const info = await lstat(container);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return "unreadable";
      }
    } catch {
      return "unreadable";
    }
    return readArtifactStatus(path.join(container, fileName));
  }));
  return summarizeStatuses(names.length, records);
}

async function summarizeFlatArtifacts(directory: string): Promise<unknown> {
  const names = (await safeReadDirectory(directory))
    .filter((name) => name.endsWith(".json") && isSafeRecordName(name));
  const selected = names.sort().slice(-maxWorkflowRecords);
  const records = await Promise.all(selected.map(async (name) =>
    readArtifactStatus(path.join(directory, name))));
  return summarizeStatuses(names.length, records);
}

async function readArtifactStatus(filePath: string): Promise<string> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return "unreadable";
    }
    const value = await readJsonFile<Record<string, unknown>>(filePath);
    return typeof value.status === "string" ? value.status : "unknown";
  } catch {
    return "unreadable";
  }
}

function summarizeStatuses(total: number, statuses: string[]): unknown {
  const counts: Record<string, number> = {};
  for (const status of statuses) {
    const safe = /^[a-z][a-z0-9_-]{0,31}$/u.test(status) ? status : "unknown";
    counts[safe] = (counts[safe] ?? 0) + 1;
  }
  return {
    records_total: total,
    records_scanned: statuses.length,
    truncated: total > statuses.length,
    statuses: Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right)))
  };
}

function createPlan(
  projectRoot: string,
  bundleId: string,
  statusValue: SupportBundlePlan["status"],
  outputDirectory: string,
  now: Date,
  entries: Array<Pick<SupportEntry, "path" | "category" | "content">>,
  incidentId?: string
): SupportBundlePlan {
  const files = entries.map((entry) => ({
    path: entry.path,
    category: entry.category,
    source: "sanitized_summary" as const,
    estimated_size_bytes: entry.content.length
  }));
  return {
    schema_version: "0.1",
    artifact_kind: "support_bundle_plan",
    bundle_id: bundleId,
    status: statusValue,
    created_at: now.toISOString(),
    output_directory: toProjectOrExternalPath(projectRoot, outputDirectory),
    archive_name: `kairon-support-${bundleId}.zip`,
    ...(incidentId === undefined ? {} : { incident_id: incidentId }),
    files,
    exclusions,
    estimated_payload_size_bytes: files.reduce(
      (total, entry) => total + entry.estimated_size_bytes,
      0
    )
  };
}

function createManifest(
  bundleId: string,
  now: Date,
  entries: SupportEntry[],
  redaction: SupportRedactionSummary,
  incidentId?: string
): SupportBundleManifest {
  return {
    schema_version: "0.1",
    artifact_kind: "support_bundle",
    bundle_id: bundleId,
    ...(incidentId === undefined ? {} : { incident_id: incidentId }),
    created_at: now.toISOString(),
    generator: { name: "kairon", version: KAIRON_VERSION },
    local_only: true,
    upload_performed: false,
    redaction: {
      ...redaction,
      secret_scan_status: "passed",
      secret_finding_count: 0
    },
    files: entries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      size_bytes: entry.content.length,
      sha256: sha256(entry.content)
    })).sort((left, right) => left.path.localeCompare(right.path))
  };
}

function buildSummary(
  now: Date,
  entries: Array<Pick<SupportEntry, "path" | "category" | "content">>
): string {
  return [
    "# Kairon Support Bundle",
    "",
    `Created: ${now.toISOString()}`,
    `Kairon: ${KAIRON_VERSION}`,
    "Local only: true",
    "Upload performed: false",
    "",
    "## Included Sanitized Summaries",
    "",
    ...entries.map((entry) =>
      `- ${entry.category}: ${entry.path} (${entry.content.length} bytes)`),
    "",
    "## Excluded By Policy",
    "",
    ...exclusions.map((entry) => `- ${entry.kind}: ${entry.reason}`),
    ""
  ].join("\n");
}

async function writeStagingEntries(
  stagingRoot: string,
  entries: SupportEntry[]
): Promise<void> {
  await mkdir(stagingRoot, { recursive: false });
  for (const entry of entries) {
    const destination = resolveInside(stagingRoot, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content, { flag: "wx" });
  }
}

async function readStagingEntries(
  stagingRoot: string,
  expected: SupportEntry[]
): Promise<SupportEntry[]> {
  return Promise.all(expected.map(async (entry) => {
    const source = resolveInside(stagingRoot, ...entry.path.split("/"));
    const [info, content] = await Promise.all([lstat(source), readFile(source)]);
    if (!info.isFile() || info.isSymbolicLink() || sha256(content) !== sha256(entry.content)) {
      throw new Error(`Support staging entry changed before archive creation: ${entry.path}.`);
    }
    return { path: entry.path, category: entry.category, content };
  }));
}

function createZip(entries: SupportEntry[]): Buffer {
  if (entries.length === 0 || entries.length > maxZipEntries) {
    throw new Error("Support ZIP entry count is outside the allowed range.");
  }
  const zipEntries = entries.map((entry) => {
    assertSafeZipPath(entry.path);
    if (entry.content.length > maxEntryBytes) {
      throw new Error(`Support entry exceeds 1 MiB: ${entry.path}.`);
    }
    return { path: entry.path, content: entry.content, crc32: crc32(entry.content) };
  });
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of zipEntries) {
    const name = Buffer.from(entry.path, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x20, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.content.length;
  }

  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zipEntries.length, 8);
  end.writeUInt16LE(zipEntries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  const archive = Buffer.concat([localBytes, centralBytes, end]);
  if (archive.length > maxArchiveBytes) {
    throw new Error("Support ZIP exceeds the 10 MiB limit.");
  }
  return archive;
}

function parseZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22 || buffer.length > maxArchiveBytes) {
    throw new Error("Support ZIP size is invalid.");
  }
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount === 0 || entryCount > maxZipEntries ||
      centralOffset + centralSize !== endOffset) {
    throw new Error("Support ZIP central directory is invalid.");
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Support ZIP central entry is malformed.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > endOffset || (flags & 0x0001) !== 0 || method !== 0 ||
        compressedSize !== uncompressedSize || uncompressedSize > maxEntryBytes) {
      throw new Error("Support ZIP entry uses a forbidden encoding or size.");
    }
    const entryPath = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assertSafeZipPath(entryPath);
    if (seen.has(entryPath) || isUnixSymlink(externalAttributes)) {
      throw new Error(`Support ZIP contains a duplicate or link entry: ${entryPath}.`);
    }
    seen.add(entryPath);
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Support ZIP local entry is malformed: ${entryPath}.`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localChecksum = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength
    ).toString("utf8");
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (localName !== entryPath ||
        localFlags !== flags ||
        localMethod !== method ||
        localChecksum !== checksum ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize ||
        contentEnd > centralOffset) {
      throw new Error(`Support ZIP local entry does not match central metadata: ${entryPath}.`);
    }
    const content = Buffer.from(buffer.subarray(contentStart, contentEnd));
    if (crc32(content) !== checksum) {
      throw new Error(`Support ZIP CRC mismatch: ${entryPath}.`);
    }
    entries.push({ path: entryPath, content, crc32: checksum });
    cursor = next;
  }
  if (cursor !== endOffset) {
    throw new Error("Support ZIP central directory has trailing data.");
  }
  return entries;
}

function verifySupportBundleBytes(
  bytes: Buffer,
  bundlePath: string
): SupportBundleVerification {
  const checks: SupportBundleVerification["checks"] = [];
  let entries: ZipEntry[] = [];
  let manifest: SupportBundleManifest | undefined;
  let scan: SupportSecretScan = {
    status: "failed",
    scanned_entries: 0,
    finding_count: 0,
    findings: []
  };

  try {
    entries = parseZip(bytes);
    checks.push({ id: "archive", status: "pass", details: "ZIP structure and CRC values are valid" });
    const paths = entries.map((entry) => entry.path);
    const hasIncidentEntry = paths.includes("diagnostics/incident.json");
    const allowed = paths.every((entryPath) =>
      entryPath === "manifest.json" || entryPath === "summary.md" ||
      entryPath === "hashes.sha256" ||
      entryPath === "diagnostics/incident.json" ||
      requiredDiagnosticPaths.includes(
        entryPath as typeof requiredDiagnosticPaths[number]
      ));
    const required = ["manifest.json", "summary.md", "hashes.sha256", ...requiredDiagnosticPaths]
      .every((requiredPath) => paths.includes(requiredPath));
    if (
      !allowed ||
      !required ||
      paths.length !== requiredDiagnosticPaths.length + 3 + (hasIncidentEntry ? 1 : 0)
    ) {
      throw new Error("Support ZIP file allowlist is invalid.");
    }
    checks.push({ id: "paths", status: "pass", details: "all required allowlisted files are present" });

    const manifestEntry = requireZipEntry(entries, "manifest.json");
    manifest = JSON.parse(manifestEntry.content.toString("utf8")) as SupportBundleManifest;
    if (!isSupportManifest(manifest)) {
      throw new Error("Support manifest schema is invalid.");
    }
    if ((manifest.incident_id !== undefined) !== hasIncidentEntry) {
      throw new Error("Support incident scope does not match the bundle payload.");
    }
    const payloadEntries = entries.filter((entry) =>
      entry.path !== "manifest.json" && entry.path !== "hashes.sha256");
    const manifestPaths = manifest.files.map((entry) => entry.path);
    if (new Set(manifestPaths).size !== manifestPaths.length ||
        manifestPaths.length !== payloadEntries.length ||
        !payloadEntries.every((entry) => {
          const expected = manifest?.files.find((candidate) => candidate.path === entry.path);
          return expected !== undefined && expected.size_bytes === entry.content.length &&
            expected.sha256 === sha256(entry.content) &&
            expected.category === expectedCategory(entry.path);
        })) {
      throw new Error("Support manifest does not match bundle payload hashes.");
    }
    checks.push({ id: "manifest", status: "pass", details: "manifest schema, size, and SHA-256 bindings are valid" });

    const expectedHashes = createHashesFile(manifest).toString("utf8");
    if (requireZipEntry(entries, "hashes.sha256").content.toString("utf8") !== expectedHashes) {
      throw new Error("Support hashes file does not match the manifest.");
    }
    checks.push({ id: "hashes", status: "pass", details: "hashes.sha256 matches manifest order and values" });

    scan = scanSupportEntries(entries);
    if (scan.status !== "passed") {
      throw new Error("Support ZIP contains secret-like content.");
    }
    checks.push({ id: "secret_scan", status: "pass", details: "post-archive entry scan found no secret patterns" });
  } catch (error) {
    const missingCheck = checks.length === 0 ? "archive"
      : checks.length === 1 ? "paths"
        : checks.length === 2 ? "manifest"
          : checks.length === 3 ? "hashes" : "secret_scan";
    checks.push({
      id: missingCheck,
      status: "error",
      details: sanitizeSupportText(error instanceof Error ? error.message : String(error))
    });
  }

  return {
    ok: checks.every((check) => check.status === "pass") && checks.length === 5,
    bundle_id: manifest?.bundle_id,
    archive_path: path.resolve(bundlePath),
    archive_sha256: sha256(bytes),
    size_bytes: bytes.length,
    files: entries.length,
    secret_scan: scan,
    checks
  };
}

function isSupportManifest(value: unknown): value is SupportBundleManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const manifest = value as Partial<SupportBundleManifest>;
  return manifest.schema_version === "0.1" &&
    manifest.artifact_kind === "support_bundle" &&
    typeof manifest.bundle_id === "string" && bundleIdPattern.test(manifest.bundle_id) &&
    (manifest.incident_id === undefined ||
      (typeof manifest.incident_id === "string" &&
        /^INC-\d{4}$/u.test(manifest.incident_id))) &&
    typeof manifest.created_at === "string" && !Number.isNaN(Date.parse(manifest.created_at)) &&
    manifest.generator?.name === "kairon" && typeof manifest.generator.version === "string" &&
    manifest.local_only === true && manifest.upload_performed === false &&
    manifest.redaction?.policy_version === "0.1" &&
    isNonNegativeInteger(manifest.redaction.redacted_fields) &&
    isNonNegativeInteger(manifest.redaction.redacted_values) &&
    isNonNegativeInteger(manifest.redaction.omitted_fields) &&
    isNonNegativeInteger(manifest.redaction.truncated_values) &&
    manifest.redaction.secret_scan_status === "passed" &&
    manifest.redaction.secret_finding_count === 0 &&
    Array.isArray(manifest.files) && manifest.files.every((entry) =>
      typeof entry.path === "string" && isSafeZipPath(entry.path) &&
      typeof entry.category === "string" && Number.isInteger(entry.size_bytes) &&
      entry.size_bytes >= 0 && /^[a-f0-9]{64}$/u.test(entry.sha256));
}

function createHashesFile(manifest: SupportBundleManifest): Buffer {
  return Buffer.from(
    `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
    "utf8"
  );
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeRedaction(summaries: SupportRedactionSummary[]): SupportRedactionSummary {
  return summaries.reduce<SupportRedactionSummary>((total, summary) => ({
    policy_version: "0.1",
    redacted_fields: total.redacted_fields + summary.redacted_fields,
    redacted_values: total.redacted_values + summary.redacted_values,
    omitted_fields: total.omitted_fields + summary.omitted_fields,
    truncated_values: total.truncated_values + summary.truncated_values
  }), {
    policy_version: "0.1",
    redacted_fields: 0,
    redacted_values: 0,
    omitted_fields: 0,
    truncated_values: 0
  });
}

function resolveOutputDirectory(projectRoot: string, value: string | undefined): string {
  return value === undefined
    ? resolveInside(projectRoot, ".kairon", "support", "bundles")
    : path.resolve(value);
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await assertNoLinkedSegments(directory);
  try {
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("Support output must be a real directory, not a link.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(directory, { recursive: true });
    await assertNoLinkedSegments(directory);
  }
}

async function assertNoLinkedSegments(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Support path must not contain symlink or junction segments.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function assertMissing(filePath: string): Promise<void> {
  try {
    await access(filePath);
    throw new Error(`Support bundle already exists: ${path.basename(filePath)}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function safeReadDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isSafeRecordName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function toProjectOrExternalPath(projectRoot: string, value: string): string {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(value));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosixPath(relative)
    : `<external-output>/${path.basename(path.resolve(value))}`;
}

function assertSecretScanPassed(scan: SupportSecretScan, phase: string): void {
  if (scan.status !== "passed") {
    const patterns = [...new Set(scan.findings.map((finding) => finding.pattern))].join(",");
    throw new Error(`Support bundle blocked by ${phase} secret scan: ${patterns}.`);
  }
}

function assertSafeZipPath(value: string): void {
  if (!isSafeZipPath(value)) {
    throw new Error("Support ZIP contains an unsafe entry path.");
  }
}

function isSafeZipPath(value: string): boolean {
  if (value.length === 0 || value.length > 200 || value.includes("\\") ||
      value.startsWith("/") || value.endsWith("/") || value.includes("\0")) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    path.posix.normalize(value) === value;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        return offset;
      }
    }
  }
  throw new Error("Support ZIP end record is missing.");
}

function isUnixSymlink(externalAttributes: number): boolean {
  return ((externalAttributes >>> 16) & 0xf000) === 0xa000;
}

function requireZipEntry(entries: ZipEntry[], entryPath: string): ZipEntry {
  const entry = entries.find((candidate) => candidate.path === entryPath);
  if (entry === undefined) {
    throw new Error(`Support ZIP is missing ${entryPath}.`);
  }
  return entry;
}

function expectedCategory(entryPath: string): SupportCategory | "summary" | undefined {
  if (entryPath === "summary.md") {
    return "summary";
  }
  if (entryPath === "diagnostics/incident.json") {
    return "incident";
  }
  const match = /^diagnostics\/(system|runtime|queue|provider|workflow|notification|integrity)\.json$/u
    .exec(entryPath);
  return match?.[1] as SupportCategory | undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
