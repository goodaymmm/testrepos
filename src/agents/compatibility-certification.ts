import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { getAgentAdapter } from "./adapters/index.js";
import {
  spawnCommandRunner,
  type CommandRunResult,
  type CommandRunner
} from "./command-runner.js";
import { classifyCliRunResult } from "./cli-classification.js";
import type { InteractiveSessionRunner } from "./interactive-session-runner.js";
import { createAntigravityPtySessionRunner } from "./pty-session-runner.js";
import {
  runAgentSmoke,
  type AgentSmokeResult
} from "./smoke-runner.js";
import {
  isCommandAvailable,
  type CommandAvailabilityChecker
} from "./session-host.js";
import { agentIds, type AgentId } from "./types.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  getKaironPaths,
  resolveInside,
  toPosixPath
} from "../core/fs/paths.js";

const schemaVersion = "0.1";
const defaultTimeoutMs = 120_000;
const defaultVersionTimeoutMs = 10_000;
const defaultFreshnessMs = 7 * 24 * 60 * 60 * 1_000;
const maxVersionOutputBytes = 64 * 1_024;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const versionPattern = /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/u;

export type AgentCertificationStatus = "PASS" | "SETUP_REQUIRED" | "FAIL";
export type AgentCertificationCheckStatus =
  | "PASS"
  | "WARNING"
  | "SETUP_REQUIRED"
  | "FAIL";

export type AgentCertificationCheck = {
  id:
    | "command_availability"
    | "version_parse"
    | "version_change"
    | "login_readiness"
    | "prompt_delivery"
    | "stdio_capture"
    | "outbox_contract"
    | "classification_contract"
    | "same_day_session"
    | "pty_round_trip"
    | "secret_free_result";
  status: AgentCertificationCheckStatus;
  reason: string;
};

export type AgentCompatibilityCertification = {
  schema_version: "0.1";
  kind: "agent_cli_compatibility_certification";
  certification_id: string;
  agent: AgentId;
  adapter: string;
  command: string;
  runner_mode: string;
  status: AgentCertificationStatus;
  version: string | null;
  version_output_sha256: string | null;
  previous_success_version: string | null;
  version_changed: boolean;
  smoke_status: AgentSmokeResult["status"] | null;
  run_id: string | null;
  task_id: string | null;
  checks: AgentCertificationCheck[];
  source_commit: string;
  executed_at: string;
  expires_at: string;
  rerun_command: string;
  artifact_path: string;
  artifact_sha256: string;
};

export type AgentCertificationSummary = {
  schema_version: "0.1";
  kind: "agent_cli_compatibility_certification_summary";
  status: AgentCertificationStatus;
  certifications: AgentCompatibilityCertification[];
  executed_at: string;
};

export type AgentCertificationInspection = {
  agent: AgentId;
  status: "current" | "warning" | "setup_required" | "failed" | "missing" | "corrupt";
  certification: AgentCompatibilityCertification | null;
  reason: string;
  rerun_command: string;
};

type AgentsConfig = {
  agents: Record<string, { adapter?: string; command?: string }>;
};

type RunnerArtifact = {
  status?: unknown;
  run_id?: unknown;
  task_id?: unknown;
  stdout_log?: unknown;
  stderr_log?: unknown;
};

type OutboxArtifact = {
  run_id?: unknown;
  task_id?: unknown;
  agent?: unknown;
  persona?: unknown;
  status?: unknown;
};

type SessionArtifact = {
  agent?: unknown;
  date?: unknown;
  last_run_id?: unknown;
  last_status?: unknown;
};

export type AgentCertificationOptions = {
  timeoutMs?: number;
  freshnessMs?: number;
  now?: () => Date;
  sourceCommit?: string;
  commandAvailability?: CommandAvailabilityChecker;
  commandRunner?: CommandRunner;
  interactiveSessionRunner?: InteractiveSessionRunner;
};

export async function certifyAgentCompatibility(
  projectRoot: string,
  agent: AgentId,
  options: AgentCertificationOptions = {}
): Promise<AgentCompatibilityCertification> {
  const now = options.now?.() ?? new Date();
  const timeoutMs = positiveInteger(options.timeoutMs ?? defaultTimeoutMs, "timeout");
  const freshnessMs = positiveInteger(
    options.freshnessMs ?? defaultFreshnessMs,
    "freshness"
  );
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const commandAvailability = options.commandAvailability ?? isCommandAvailable;
  const config = await loadConfigFile<AgentsConfig>(projectRoot, "agents.json");
  const adapter = getAgentAdapter(agent);
  const configured = config.agents[agent] ?? {};
  const command = configured.command ?? adapter.command;
  const adapterName = configured.adapter ?? adapter.adapter;
  const sourceCommit = await resolveSourceCommit(
    projectRoot,
    options.sourceCommit,
    commandRunner
  );
  const previous = await readLatestCertification(projectRoot, agent, {
    allowMissing: true
  });
  const certificationId = certificationIdFor(agent, now);
  const artifactAbsolutePath = certificationHistoryPath(
    projectRoot,
    agent,
    certificationId
  );
  const artifactPath = toProjectPath(projectRoot, artifactAbsolutePath);
  const checks: AgentCertificationCheck[] = [];
  const available = await commandAvailability(command);

  checks.push({
    id: "command_availability",
    status: available ? "PASS" : "SETUP_REQUIRED",
    reason: available ? "official_cli_command_available" : "official_cli_command_missing"
  });

  let version: string | null = null;
  let versionOutputSha256: string | null = null;
  let smoke: AgentSmokeResult | null = null;

  if (available) {
    const versionResult = await commandRunner({
      command,
      args: versionArgs(agent),
      cwd: projectRoot,
      timeoutMs: defaultVersionTimeoutMs,
      maxOutputBytes: maxVersionOutputBytes
    });
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
    version = parseCliVersion(versionOutput);
    versionOutputSha256 = sha256(versionOutput);
    checks.push(versionCheck(agent, versionResult, version));

    smoke = await runAgentSmoke(
      projectRoot,
      {
        agent,
        timeoutMs
      },
      {
        commandAvailability,
        commandRunner,
        interactiveSessionRunner:
          options.interactiveSessionRunner ??
          (agent === "gemini"
            ? createAntigravityPtySessionRunner()
            : undefined),
        now: options.now
      }
    );
    checks.push(...await inspectSmokeContract(projectRoot, agent, smoke));
  } else {
    checks.push(
      setupCheck("version_parse", "version_not_checked_command_missing"),
      setupCheck("version_change", "version_not_checked_command_missing"),
      setupCheck("login_readiness", "login_not_checked_command_missing"),
      setupCheck("prompt_delivery", "prompt_not_checked_command_missing"),
      setupCheck("stdio_capture", "stdio_not_checked_command_missing"),
      setupCheck("outbox_contract", "outbox_not_checked_command_missing"),
      setupCheck("classification_contract", "classification_not_checked_command_missing"),
      setupCheck("same_day_session", "session_not_checked_command_missing"),
      setupCheck("pty_round_trip", "pty_not_checked_command_missing")
    );
  }

  const previousSuccessVersion =
    previous?.status === "PASS" ? previous.version : null;
  const versionChanged =
    version !== null &&
    previousSuccessVersion !== null &&
    version !== previousSuccessVersion;
  replaceCheck(checks, {
    id: "version_change",
    status: versionChanged ? "WARNING" : "PASS",
    reason: versionChanged
      ? "cli_version_changed_targeted_smoke_completed"
      : previousSuccessVersion === null
        ? "cli_version_baseline_recorded"
        : "cli_version_unchanged"
  });
  checks.push({
    id: "secret_free_result",
    status: "PASS",
    reason: "allowlisted_summary_only"
  });

  const status = aggregateStatus(checks);
  const unsigned: Omit<AgentCompatibilityCertification, "artifact_sha256"> = {
    schema_version: schemaVersion,
    kind: "agent_cli_compatibility_certification",
    certification_id: certificationId,
    agent,
    adapter: adapterName,
    command,
    runner_mode: adapter.defaultMode,
    status,
    version,
    version_output_sha256: versionOutputSha256,
    previous_success_version: previousSuccessVersion,
    version_changed: versionChanged,
    smoke_status: smoke?.status ?? null,
    run_id: smoke?.run_id ?? null,
    task_id: smoke?.task_id ?? null,
    checks,
    source_commit: sourceCommit,
    executed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + freshnessMs).toISOString(),
    rerun_command: `kairon agent certify --agent ${agent}`,
    artifact_path: artifactPath
  };
  assertSecretFreeCertification(unsigned);
  const certification: AgentCompatibilityCertification = {
    ...unsigned,
    artifact_sha256: certificationDigest(unsigned)
  };

  await writeJsonFileAtomic(artifactAbsolutePath, certification);
  await writeJsonFileAtomic(certificationLatestPath(projectRoot, agent), certification);
  return certification;
}

export async function certifyAllAgentCompatibility(
  projectRoot: string,
  options: AgentCertificationOptions = {}
): Promise<AgentCertificationSummary> {
  const certifications: AgentCompatibilityCertification[] = [];
  for (const agent of agentIds) {
    certifications.push(await certifyAgentCompatibility(projectRoot, agent, options));
  }
  const now = options.now?.() ?? new Date();
  const summary: AgentCertificationSummary = {
    schema_version: schemaVersion,
    kind: "agent_cli_compatibility_certification_summary",
    status: aggregateCertificationStatuses(certifications),
    certifications,
    executed_at: now.toISOString()
  };
  await writeJsonFileAtomic(certificationSummaryPath(projectRoot), summary);
  return summary;
}

export async function readLatestCertification(
  projectRoot: string,
  agent: AgentId,
  options: { allowMissing?: boolean } = {}
): Promise<AgentCompatibilityCertification | null> {
  const filePath = certificationLatestPath(projectRoot, agent);
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    if (!isCertification(parsed)) {
      throw new Error(`Agent certification is invalid: ${toProjectPath(projectRoot, filePath)}`);
    }
    const expectedArtifactPath = toProjectPath(
      projectRoot,
      certificationHistoryPath(projectRoot, agent, parsed.certification_id)
    );
    if (parsed.agent !== agent || parsed.artifact_path !== expectedArtifactPath) {
      throw new Error(`Agent certification binding mismatch: ${toProjectPath(projectRoot, filePath)}`);
    }
    const { artifact_sha256: digest, ...unsigned } = parsed;
    if (certificationDigest(unsigned) !== digest) {
      throw new Error(`Agent certification digest mismatch: ${toProjectPath(projectRoot, filePath)}`);
    }
    return parsed;
  } catch (error) {
    if (options.allowMissing === true && isMissingReadError(error)) {
      return null;
    }
    throw error;
  }
}

export async function inspectAgentCertifications(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<AgentCertificationInspection[]> {
  const now = options.now ?? new Date();
  const inspections: AgentCertificationInspection[] = [];
  for (const agent of agentIds) {
    const rerunCommand = `kairon agent certify --agent ${agent}`;
    try {
      const certification = await readLatestCertification(projectRoot, agent, {
        allowMissing: true
      });
      if (certification === null) {
        inspections.push({
          agent,
          status: "missing",
          certification: null,
          reason: "certification_missing",
          rerun_command: rerunCommand
        });
        continue;
      }
      if (certification.status === "FAIL") {
        inspections.push({
          agent,
          status: "failed",
          certification,
          reason: "certification_failed",
          rerun_command: rerunCommand
        });
        continue;
      }
      if (certification.status === "SETUP_REQUIRED") {
        inspections.push({
          agent,
          status: "setup_required",
          certification,
          reason: "certification_setup_required",
          rerun_command: rerunCommand
        });
        continue;
      }
      if (Date.parse(certification.expires_at) <= now.getTime()) {
        inspections.push({
          agent,
          status: "warning",
          certification,
          reason: "certification_expired",
          rerun_command: rerunCommand
        });
        continue;
      }
      if (certification.version_changed) {
        inspections.push({
          agent,
          status: "warning",
          certification,
          reason: "cli_version_changed",
          rerun_command: rerunCommand
        });
        continue;
      }
      inspections.push({
        agent,
        status: "current",
        certification,
        reason: "certification_current",
        rerun_command: rerunCommand
      });
    } catch {
      inspections.push({
        agent,
        status: "corrupt",
        certification: null,
        reason: "certification_corrupt",
        rerun_command: rerunCommand
      });
    }
  }
  return inspections;
}

export function formatAgentCertification(
  certification: AgentCompatibilityCertification
): string {
  return [
    "Kairon agent compatibility certification.",
    `agent=${certification.agent}`,
    `status=${certification.status}`,
    `version=${certification.version ?? ""}`,
    `version_changed=${certification.version_changed}`,
    `command=${certification.command}`,
    `runner_mode=${certification.runner_mode}`,
    `smoke_status=${certification.smoke_status ?? ""}`,
    `checks_pass=${certification.checks.filter((check) => check.status === "PASS").length}`,
    `checks_warning=${certification.checks.filter((check) => check.status === "WARNING").length}`,
    `checks_setup_required=${certification.checks.filter((check) => check.status === "SETUP_REQUIRED").length}`,
    `checks_fail=${certification.checks.filter((check) => check.status === "FAIL").length}`,
    `executed_at=${certification.executed_at}`,
    `expires_at=${certification.expires_at}`,
    `source_commit=${certification.source_commit}`,
    `artifact=${certification.artifact_path}`,
    `rerun=${certification.rerun_command}`,
    ...certification.checks.map(
      (check) => `check.${check.id}=${check.status}:${check.reason}`
    )
  ].join("\n");
}

export function formatAgentCertificationSummary(
  summary: AgentCertificationSummary
): string {
  return [
    "Kairon agent compatibility certifications.",
    `status=${summary.status}`,
    `agents=${summary.certifications.length}`,
    ...summary.certifications.flatMap((certification) =>
      formatAgentCertification(certification).split("\n").slice(1)
        .map((line) => `${certification.agent}.${line}`)
    )
  ].join("\n");
}

export function formatAgentCertificationInspections(
  inspections: AgentCertificationInspection[]
): string {
  return [
    "Kairon agent compatibility certification status.",
    `agents=${inspections.length}`,
    ...inspections.flatMap((inspection) => [
      `agent=${inspection.agent} status=${inspection.status} reason=${inspection.reason}`,
      ...(inspection.certification === null
        ? []
        : [
            `agent=${inspection.agent} version=${inspection.certification.version ?? ""} certification_status=${inspection.certification.status} executed_at=${inspection.certification.executed_at} expires_at=${inspection.certification.expires_at} artifact=${inspection.certification.artifact_path}`
          ]),
      `agent=${inspection.agent} rerun=${inspection.rerun_command}`
    ])
  ].join("\n");
}

async function inspectSmokeContract(
  projectRoot: string,
  agent: AgentId,
  smoke: AgentSmokeResult
): Promise<AgentCertificationCheck[]> {
  const outcomeStatus = checkStatusForSmoke(smoke.status);
  const runner = await readOptionalJson<RunnerArtifact>(
    resolveInside(projectRoot, smoke.runner_metadata_path)
  );
  const outbox = await readOptionalJson<OutboxArtifact>(
    resolveInside(projectRoot, smoke.outbox_path)
  );
  const date = smoke.date;
  const session = await readOptionalJson<SessionArtifact>(
    resolveInside(getKaironPaths(projectRoot).sessionsDir, date, agent, "session.json")
  );
  const stdioPresent =
    await exists(resolveInside(projectRoot, smoke.stdout_log)) &&
    await exists(resolveInside(projectRoot, smoke.stderr_log));
  const runnerMatches =
    runner?.run_id === smoke.run_id &&
    runner?.task_id === smoke.task_id &&
    runner?.status === smoke.status;
  const outboxMatches =
    outbox?.run_id === smoke.run_id &&
    outbox?.task_id === smoke.task_id &&
    outbox?.agent === agent &&
    outbox?.persona === "smoke" &&
    outbox?.status === smoke.status;
  const sessionMatches =
    session?.agent === agent &&
    session?.date === smoke.date &&
    session?.last_run_id === smoke.run_id &&
    session?.last_status === smoke.status;
  const promptRoundTrip = smoke.status === "completed";

  return [
    {
      id: "login_readiness",
      status: outcomeStatus,
      reason: smokeReason(smoke.status, "login")
    },
    {
      id: "prompt_delivery",
      status: promptRoundTrip ? "PASS" : outcomeStatus,
      reason: promptRoundTrip ? "minimal_prompt_completed" : smokeReason(smoke.status, "prompt")
    },
    {
      id: "stdio_capture",
      status: stdioPresent ? "PASS" : "FAIL",
      reason: stdioPresent ? "stdout_stderr_artifacts_present" : "stdio_artifact_missing"
    },
    {
      id: "outbox_contract",
      status: outboxMatches ? "PASS" : "FAIL",
      reason: outboxMatches ? "outbox_contract_matches" : "outbox_contract_mismatch"
    },
    {
      id: "classification_contract",
      status: runnerMatches ? "PASS" : "FAIL",
      reason: runnerMatches ? "runner_classification_matches" : "runner_classification_mismatch"
    },
    {
      id: "same_day_session",
      status: sessionMatches ? "PASS" : "FAIL",
      reason: sessionMatches ? "same_day_session_matches" : "same_day_session_mismatch"
    },
    {
      id: "pty_round_trip",
      status:
        agent !== "gemini"
          ? "PASS"
          : promptRoundTrip && smoke.command === "agy"
            ? "PASS"
            : outcomeStatus,
      reason:
        agent !== "gemini"
          ? "pty_not_required"
          : promptRoundTrip && smoke.command === "agy"
            ? "antigravity_pty_round_trip_completed"
            : smokeReason(smoke.status, "pty")
    }
  ];
}

function versionCheck(
  agent: AgentId,
  result: CommandRunResult,
  version: string | null
): AgentCertificationCheck {
  if (result.timedOut) {
    return {
      id: "version_parse",
      status: "FAIL",
      reason: "version_command_timeout"
    };
  }
  if (result.exitCode !== 0) {
    const classification = classifyCliRunResult(agent, result);
    if (
      classification.status === "setup_required" ||
      classification.status === "permission_required" ||
      classification.status === "rate_limited" ||
      classification.status === "usage_limited"
    ) {
      return {
        id: "version_parse",
        status: "SETUP_REQUIRED",
        reason: `version_${classification.reason}`
      };
    }
    return {
      id: "version_parse",
      status: "FAIL",
      reason: "version_command_failed"
    };
  }
  return {
    id: "version_parse",
    status: version === null ? "FAIL" : "PASS",
    reason: version === null ? "version_unparseable" : "version_normalized"
  };
}

function parseCliVersion(output: string): string | null {
  return versionPattern.exec(` ${output} `)?.[1] ?? null;
}

function versionArgs(_agent: AgentId): string[] {
  return ["--version"];
}

function checkStatusForSmoke(
  status: AgentSmokeResult["status"]
): AgentCertificationCheckStatus {
  if (status === "completed") {
    return "PASS";
  }
  if (
    status === "setup_required" ||
    status === "permission_required" ||
    status === "rate_limited" ||
    status === "usage_limited"
  ) {
    return "SETUP_REQUIRED";
  }
  return "FAIL";
}

function smokeReason(
  status: AgentSmokeResult["status"],
  scope: "login" | "prompt" | "pty"
): string {
  return `${scope}_${status}`;
}

function setupCheck(
  id: AgentCertificationCheck["id"],
  reason: string
): AgentCertificationCheck {
  return { id, status: "SETUP_REQUIRED", reason };
}

function replaceCheck(
  checks: AgentCertificationCheck[],
  replacement: AgentCertificationCheck
): void {
  const index = checks.findIndex((check) => check.id === replacement.id);
  if (index === -1) {
    checks.push(replacement);
    return;
  }
  checks[index] = replacement;
}

function aggregateStatus(
  checks: AgentCertificationCheck[]
): AgentCertificationStatus {
  if (checks.some((check) => check.status === "FAIL")) {
    return "FAIL";
  }
  if (checks.some((check) => check.status === "SETUP_REQUIRED")) {
    return "SETUP_REQUIRED";
  }
  return "PASS";
}

function aggregateCertificationStatuses(
  certifications: AgentCompatibilityCertification[]
): AgentCertificationStatus {
  if (certifications.some((certification) => certification.status === "FAIL")) {
    return "FAIL";
  }
  if (
    certifications.some(
      (certification) => certification.status === "SETUP_REQUIRED"
    )
  ) {
    return "SETUP_REQUIRED";
  }
  return "PASS";
}

async function resolveSourceCommit(
  projectRoot: string,
  sourceCommit: string | undefined,
  commandRunner: CommandRunner
): Promise<string> {
  if (sourceCommit !== undefined) {
    return normalizeSourceCommit(sourceCommit);
  }
  const result = await commandRunner({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: projectRoot,
    timeoutMs: defaultVersionTimeoutMs,
    maxOutputBytes: 1_024
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error("Unable to bind agent certification to the current Git commit.");
  }
  return normalizeSourceCommit(result.stdout.trim());
}

function normalizeSourceCommit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!sourceCommitPattern.test(normalized)) {
    throw new Error("Agent certification source commit must be a 40-character Git SHA.");
  }
  return normalized;
}

function certificationIdFor(agent: AgentId, now: Date): string {
  return `CERT-${now.toISOString().replace(/[-:.TZ]/gu, "")}-${agent}-${randomBytes(4).toString("hex")}`;
}

function certificationRoot(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).stateDir, "agent-certifications");
}

function certificationAgentRoot(projectRoot: string, agent: AgentId): string {
  return resolveInside(certificationRoot(projectRoot), agent);
}

function certificationHistoryPath(
  projectRoot: string,
  agent: AgentId,
  certificationId: string
): string {
  return resolveInside(
    certificationAgentRoot(projectRoot, agent),
    "history",
    `${certificationId}.json`
  );
}

function certificationLatestPath(projectRoot: string, agent: AgentId): string {
  return resolveInside(certificationAgentRoot(projectRoot, agent), "latest.json");
}

function certificationSummaryPath(projectRoot: string): string {
  return resolveInside(certificationRoot(projectRoot), "latest-summary.json");
}

function certificationDigest(
  unsigned: Omit<AgentCompatibilityCertification, "artifact_sha256">
): string {
  return sha256(JSON.stringify(unsigned));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSecretFreeCertification(value: unknown): void {
  const unsafeKeys = new Set([
    "token",
    "credential",
    "cookie",
    "authorization",
    "prompt",
    "stdout",
    "stderr",
    "api_key",
    "secret"
  ]);
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry === null || typeof entry !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (unsafeKeys.has(key.toLowerCase())) {
        throw new Error(`Unsafe agent certification field: ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

function isCertification(value: unknown): value is AgentCompatibilityCertification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === schemaVersion &&
    record.kind === "agent_cli_compatibility_certification" &&
    typeof record.certification_id === "string" &&
    agentIds.includes(record.agent as AgentId) &&
    typeof record.adapter === "string" &&
    typeof record.command === "string" &&
    typeof record.runner_mode === "string" &&
    ["PASS", "SETUP_REQUIRED", "FAIL"].includes(String(record.status)) &&
    (record.version === null || typeof record.version === "string") &&
    (record.version_output_sha256 === null ||
      isSha256(record.version_output_sha256)) &&
    (record.previous_success_version === null ||
      typeof record.previous_success_version === "string") &&
    typeof record.version_changed === "boolean" &&
    Array.isArray(record.checks) &&
    record.checks.every(isCertificationCheck) &&
    typeof record.source_commit === "string" &&
    sourceCommitPattern.test(record.source_commit) &&
    isIsoDate(record.executed_at) &&
    isIsoDate(record.expires_at) &&
    typeof record.rerun_command === "string" &&
    typeof record.artifact_path === "string" &&
    isSha256(record.artifact_sha256)
  );
}

function isCertificationCheck(value: unknown): value is AgentCertificationCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    [
      "command_availability",
      "version_parse",
      "version_change",
      "login_readiness",
      "prompt_delivery",
      "stdio_capture",
      "outbox_contract",
      "classification_contract",
      "same_day_session",
      "pty_round_trip",
      "secret_free_result"
    ].includes(String(record.id)) &&
    ["PASS", "WARNING", "SETUP_REQUIRED", "FAIL"].includes(
      String(record.status)
    ) &&
    typeof record.reason === "string"
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingReadError(error: unknown): boolean {
  return String(error).includes("ENOENT");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent certification ${name} must be a positive safe integer.`);
  }
  return value;
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
