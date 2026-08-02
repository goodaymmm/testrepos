import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../agents/command-runner.js";
import { commandRunnerSecurityPolicy } from "../agents/command-runner.js";
import { boardHttpSecurityLimits } from "../board/server.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  sanitizeSupportText,
  scanSupportEntries
} from "../diagnostics/support-redaction.js";
import {
  defaultDiscordReplayTtlSeconds,
  defaultDiscordTimestampToleranceSeconds
} from "../discord/http-interactions.js";
import { discordHttpSecurityLimits } from "../discord/http-server.js";
import { resolveCurrentCommit } from "../readiness/evidence-manifest.js";
import { checkStateIntegrity } from "../state/integrity-check.js";
import {
  inspectDependencyPolicy,
  type DependencyPolicyFinding,
  type DependencyPolicyResult
} from "./dependency-policy.js";
import {
  evaluateArchivePolicy,
  stableArchivePolicyLimits,
  validatePortableArchivePath
} from "./path-policy.js";

export type SecurityBaselineStatus =
  | "PASS"
  | "UNPASSED"
  | "SETUP_REQUIRED";

export type SecurityBaselineFinding = {
  severity: "medium" | "high" | "critical";
  category:
    | "dependency"
    | "archive"
    | "path"
    | "credential"
    | "http"
    | "process"
    | "artifact_integrity";
  code: string;
  subject?: string;
  details: string;
};

export type SecurityBaselineCheck = {
  id: string;
  category: SecurityBaselineFinding["category"];
  status: SecurityBaselineStatus;
  summary: string;
};

export type SecurityBaselineArtifact = {
  schema_version: "0.1";
  artifact_kind: "security_baseline_result";
  status: SecurityBaselineStatus;
  offline_status: "PASS" | "UNPASSED";
  source_commit: string;
  generated_at: string;
  checks: SecurityBaselineCheck[];
  findings: SecurityBaselineFinding[];
  dependency: {
    package_lock_sha256: string;
    production_packages: number;
    direct_dependencies: string[];
    licenses: string[];
    external_audit: {
      status: SecurityBaselineStatus;
      captured_at?: string;
      high: number;
      critical: number;
    };
  };
  artifact_scan: {
    scanned_entries: number;
    finding_count: number;
  };
  state_integrity: {
    files_checked: number;
    errors: number;
    warnings: number;
  };
  summary: {
    pass: number;
    unpassed: number;
    setup_required: number;
    high: number;
    critical: number;
    secret_exposures: number;
    total: number;
  };
};

export type SecurityBaselineOptions = {
  npmAuditPath?: string;
  artifactPaths?: string[];
  output?: string;
  sourceCommit?: string;
  now?: () => Date;
  commandRunner?: CommandRunner;
};

export type SecurityBaselineRunResult = {
  artifact: SecurityBaselineArtifact;
  output_path: string;
};

const maxScannedArtifactBytes = 2 * 1024 * 1024;
const maxScannedArtifacts = 256;
const maxNpmAuditAgeMs = 24 * 60 * 60 * 1_000;
const maxNpmAuditFutureSkewMs = 5 * 60 * 1_000;
const defaultOutput = ".kairon/security/security-baseline.json";
const artifactRoots = [
  "release-artifacts",
  ".kairon/metrics",
  ".kairon/performance",
  ".kairon/backups",
  ".kairon/recovery"
] as const;

export async function runSecurityBaseline(
  projectRoot: string,
  options: SecurityBaselineOptions = {}
): Promise<SecurityBaselineRunResult> {
  const now = options.now ?? (() => new Date());
  const generatedAt = now();
  const [dependency, stateIntegrity, sourceCommit, artifactCollection] =
    await Promise.all([
      inspectDependencyPolicySafely(projectRoot, {
        npmAuditPath: options.npmAuditPath
      }),
      checkStateIntegrity(projectRoot, { now: () => generatedAt }),
      options.sourceCommit === undefined
        ? resolveCurrentCommit(projectRoot, options.commandRunner)
        : Promise.resolve(validateSourceCommit(options.sourceCommit)),
      collectSecurityArtifactEntries(
        projectRoot,
        options.artifactPaths ?? []
      )
    ]);
  dependency.external_audit.status = normalizeNpmAuditEvidenceStatus(
    dependency.external_audit,
    generatedAt
  );

  const findings: SecurityBaselineFinding[] = [
    ...dependency.findings.map(dependencyFinding),
    ...artifactCollection.findings
  ];
  const checks: SecurityBaselineCheck[] = [];
  checks.push(check(
    "dependency_policy",
    "dependency",
    dependency.findings.some(
      (finding) =>
        finding.code !== "npm_audit_high" &&
        finding.code !== "npm_audit_critical"
    )
      ? "UNPASSED"
      : "PASS",
    `${dependency.production_packages} production packages match the reviewed source, integrity, and license policy.`
  ));
  checks.push(check(
    "dependency_advisories",
    "dependency",
    dependency.external_audit.status,
    dependency.external_audit.status === "SETUP_REQUIRED"
      ? "Timestamped npm audit JSON evidence is required."
      : `npm audit high=${dependency.external_audit.high} critical=${dependency.external_audit.critical}.`
  ));

  const pathPolicy = evaluatePathPolicySelfTest();
  findings.push(...pathPolicy.findings);
  checks.push(pathPolicy.check);

  const archivePolicy = evaluateArchivePolicySelfTest();
  findings.push(...archivePolicy.findings);
  checks.push(archivePolicy.check);

  const credentialPolicy = evaluateCredentialPolicySelfTest();
  findings.push(...credentialPolicy.findings);
  checks.push(credentialPolicy.check);

  const httpPolicy = evaluateHttpPolicy();
  findings.push(...httpPolicy.findings);
  checks.push(httpPolicy.check);

  const processPolicy = evaluateProcessPolicy();
  findings.push(...processPolicy.findings);
  checks.push(processPolicy.check);

  const artifactSecretScan = scanSupportEntries(artifactCollection.entries);
  for (const finding of artifactSecretScan.findings) {
    findings.push({
      severity: "critical",
      category: "credential",
      code: "artifact_secret_exposure",
      subject: finding.entry,
      details: `Generated artifact matched secret pattern ${finding.pattern}.`
    });
  }
  checks.push(check(
    "generated_artifact_secret_scan",
    "credential",
    artifactSecretScan.finding_count === 0 ? "PASS" : "UNPASSED",
    `Scanned ${artifactSecretScan.scanned_entries} generated artifacts; findings=${artifactSecretScan.finding_count}.`
  ));

  const stateStatus =
    stateIntegrity.summary.errors === 0 ? "PASS" : "UNPASSED";
  if (stateStatus === "UNPASSED") {
    findings.push({
      severity: "high",
      category: "artifact_integrity",
      code: "state_integrity_error",
      details: `Canonical state integrity reports ${stateIntegrity.summary.errors} errors.`
    });
  }
  checks.push(check(
    "canonical_state_integrity",
    "artifact_integrity",
    stateStatus,
    `files=${stateIntegrity.summary.files_checked} errors=${stateIntegrity.summary.errors} warnings=${stateIntegrity.summary.warnings}.`
  ));

  for (const finding of artifactCollection.findings) {
    if (finding.code === "artifact_scan_limit") {
      checks.push(check(
        "artifact_scan_bounds",
        "artifact_integrity",
        "UNPASSED",
        "Generated artifact scan exceeded its bounded input policy."
      ));
      break;
    }
  }
  if (!checks.some((entry) => entry.id === "artifact_scan_bounds")) {
    checks.push(check(
      "artifact_scan_bounds",
      "artifact_integrity",
      "PASS",
      `Artifact scan stayed within ${maxScannedArtifacts} files and ${maxScannedArtifactBytes} bytes per file.`
    ));
  }

  const offlineBlockingFinding = findings.some(
    (finding) =>
      (finding.severity === "high" || finding.severity === "critical") &&
      finding.code !== "npm_audit_high" &&
      finding.code !== "npm_audit_critical"
  );
  const blockingFinding = findings.some(
    (finding) =>
      finding.severity === "high" || finding.severity === "critical"
  );
  const offlineStatus =
    offlineBlockingFinding ||
    checks.some(
      (entry) =>
        entry.id !== "dependency_advisories" && entry.status === "UNPASSED"
    )
    ? "UNPASSED"
    : "PASS";
  const status: SecurityBaselineStatus =
    offlineStatus === "UNPASSED" ||
    blockingFinding ||
    checks.some((entry) => entry.status === "UNPASSED")
      ? "UNPASSED"
      : checks.some((entry) => entry.status === "SETUP_REQUIRED")
        ? "SETUP_REQUIRED"
        : "PASS";
  const artifact: SecurityBaselineArtifact = {
    schema_version: "0.1",
    artifact_kind: "security_baseline_result",
    status,
    offline_status: offlineStatus,
    source_commit: sourceCommit,
    generated_at: generatedAt.toISOString(),
    checks,
    findings: findings.sort(compareFindings),
    dependency: {
      package_lock_sha256: dependency.package_lock_sha256,
      production_packages: dependency.production_packages,
      direct_dependencies: dependency.direct_dependencies,
      licenses: dependency.licenses,
      external_audit: dependency.external_audit
    },
    artifact_scan: {
      scanned_entries: artifactSecretScan.scanned_entries,
      finding_count: artifactSecretScan.finding_count
    },
    state_integrity: {
      files_checked: stateIntegrity.summary.files_checked,
      errors: stateIntegrity.summary.errors,
      warnings: stateIntegrity.summary.warnings
    },
    summary: summarize(checks, findings)
  };

  const selfScan = scanSupportEntries([
    {
      path: "security-baseline.json",
      content: JSON.stringify(artifact)
    }
  ]);
  if (selfScan.status === "failed") {
    artifact.status = "UNPASSED";
    artifact.offline_status = "UNPASSED";
    artifact.findings.push({
      severity: "critical",
      category: "credential",
      code: "security_report_secret_exposure",
      details: "The generated security report matched the secret scan policy."
    });
    artifact.summary = summarize(artifact.checks, artifact.findings);
  }

  const output = resolveInside(projectRoot, options.output ?? defaultOutput);
  await writeJsonFileAtomic(output, artifact);
  return {
    artifact,
    output_path: toPosixPath(path.relative(projectRoot, output))
  };
}

export function formatSecurityBaselineReport(
  artifact: SecurityBaselineArtifact
): string {
  return [
    "# Kairon Stable Security Baseline",
    "",
    `- status: **${artifact.status}**`,
    `- offline status: **${artifact.offline_status}**`,
    `- source commit: \`${artifact.source_commit}\``,
    `- generated at: \`${artifact.generated_at}\``,
    `- high findings: \`${artifact.summary.high}\``,
    `- critical findings: \`${artifact.summary.critical}\``,
    `- secret exposures: \`${artifact.summary.secret_exposures}\``,
    "",
    "| Check | Category | Status | Summary |",
    "| --- | --- | --- | --- |",
    ...artifact.checks.map(
      (entry) =>
        `| ${entry.id} | ${entry.category} | ${entry.status} | ${escapeMarkdown(entry.summary)} |`
    ),
    "",
    "## Findings",
    "",
    ...(artifact.findings.length === 0
      ? ["- none"]
      : artifact.findings.map(
          (finding) =>
            `- **${finding.severity.toUpperCase()}** \`${finding.code}\` (${finding.category})${
              finding.subject === undefined
                ? ""
                : ` subject=\`${escapeMarkdown(finding.subject)}\``
            }: ${escapeMarkdown(finding.details)}`
        )),
    ""
  ].join("\n");
}

function evaluatePathPolicySelfTest(): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  const attacks = [
    "../escape.json",
    "C:/Windows/system32.txt",
    "//server/share/file.txt",
    "package/CON.txt",
    "package/trailing.",
    "package/trailing ",
    "package/a/../../escape"
  ];
  const rejected = attacks.every(
    (value) =>
      validatePortableArchivePath(value, { requiredRoot: "package" }).length > 0
  );
  return policyResult(
    "portable_path_policy",
    "path",
    rejected,
    "Traversal, absolute/UNC, reserved device, and trailing dot/space paths are rejected.",
    "portable_path_policy_incomplete"
  );
}

function evaluateArchivePolicySelfTest(): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  const valid = evaluateArchivePolicy({
    archive_bytes: 1_024,
    expanded_bytes: 2_048,
    required_root: "package",
    entries: [
      { path: "package/file.txt", size_bytes: 10, type: "file" }
    ]
  }).ok;
  const bombRejected = !evaluateArchivePolicy({
    archive_bytes: 1,
    expanded_bytes: stableArchivePolicyLimits.max_expanded_bytes,
    required_root: "package",
    entries: [
      { path: "package/file.txt", size_bytes: 10, type: "file" }
    ]
  }).ok;
  const collisionRejected = !evaluateArchivePolicy({
    archive_bytes: 1_024,
    expanded_bytes: 2_048,
    required_root: "package",
    entries: [
      { path: "package/File.txt", size_bytes: 10, type: "file" },
      { path: "package/file.txt", size_bytes: 10, type: "file" }
    ]
  }).ok;
  return policyResult(
    "bounded_archive_policy",
    "archive",
    valid && bombRejected && collisionRejected,
    "Archive size, expansion ratio, entry count/size, path length, and case collisions are bounded.",
    "bounded_archive_policy_incomplete"
  );
}

function evaluateCredentialPolicySelfTest(): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  const sanitized = sanitizeSupportText(
    "Authorization: Bearer github_pat_123456789012345678901234567890"
  );
  const scan = scanSupportEntries([
    { path: "credential-self-test", content: sanitized }
  ]);
  return policyResult(
    "credential_redaction_policy",
    "credential",
    sanitized.includes("[redacted]") && scan.status === "passed",
    "Credential-bearing diagnostic text is redacted before artifact persistence.",
    "credential_redaction_policy_incomplete"
  );
}

function evaluateHttpPolicy(): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  const valid =
    discordHttpSecurityLimits.max_body_bytes <= 1024 * 1024 &&
    discordHttpSecurityLimits.max_header_bytes <= 16 * 1024 &&
    discordHttpSecurityLimits.max_header_count <= 64 &&
    discordHttpSecurityLimits.request_timeout_ms <= 10_000 &&
    defaultDiscordTimestampToleranceSeconds <= 300 &&
    defaultDiscordReplayTtlSeconds <= 300 &&
    boardHttpSecurityLimits.max_header_bytes <= 16 * 1024 &&
    boardHttpSecurityLimits.max_header_count <= 64 &&
    JSON.stringify(boardHttpSecurityLimits.allowed_methods) ===
      JSON.stringify(["GET", "HEAD"]);
  return policyResult(
    "http_boundary_policy",
    "http",
    valid,
    "Discord and Board keep bounded headers/body, loopback proxy validation, signature freshness, replay protection, and read-only methods.",
    "http_boundary_policy_incomplete"
  );
}

function evaluateProcessPolicy(): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  const valid =
    commandRunnerSecurityPolicy.default_max_output_bytes <= 4 * 1024 * 1024 &&
    commandRunnerSecurityPolicy.windows_shell_shims.length === 3;
  return policyResult(
    "child_process_policy",
    "process",
    valid,
    "Child process capture is bounded and shell use is restricted to reviewed Windows shims.",
    "child_process_policy_incomplete"
  );
}

function policyResult(
  id: string,
  category: SecurityBaselineFinding["category"],
  passed: boolean,
  summary: string,
  failureCode: string
): {
  check: SecurityBaselineCheck;
  findings: SecurityBaselineFinding[];
} {
  return {
    check: check(id, category, passed ? "PASS" : "UNPASSED", summary),
    findings: passed
      ? []
      : [{
          severity: "high",
          category,
          code: failureCode,
          details: summary
        }]
  };
}

async function collectSecurityArtifactEntries(
  projectRoot: string,
  explicitPaths: readonly string[]
): Promise<{
  entries: Array<{ path: string; content: Buffer }>;
  findings: SecurityBaselineFinding[];
}> {
  const candidates = new Set<string>();
  for (const root of artifactRoots) {
    await walkArtifacts(path.join(projectRoot, root), candidates);
  }
  for (const explicitPath of explicitPaths) {
    candidates.add(path.resolve(projectRoot, explicitPath));
  }

  const entries: Array<{ path: string; content: Buffer }> = [];
  const findings: SecurityBaselineFinding[] = [];
  const selected = [...candidates].sort();
  if (selected.length > maxScannedArtifacts) {
    findings.push({
      severity: "high",
      category: "artifact_integrity",
      code: "artifact_scan_limit",
      details: `Generated artifact candidate count exceeds ${maxScannedArtifacts}.`
    });
  }

  for (const candidate of selected.slice(0, maxScannedArtifacts)) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        findings.push({
          severity: "high",
          category: "path",
          code: "artifact_symlink_rejected",
          subject: safeArtifactLabel(projectRoot, candidate),
          details: "Generated artifact scan does not follow symbolic links or junctions."
        });
        continue;
      }
      if (!info.isFile() || info.size > maxScannedArtifactBytes) {
        if (info.isFile() && info.size > maxScannedArtifactBytes) {
          findings.push({
            severity: "high",
            category: "artifact_integrity",
            code: "artifact_scan_limit",
            subject: safeArtifactLabel(projectRoot, candidate),
            details: `Generated artifact exceeds ${maxScannedArtifactBytes} bytes.`
          });
        }
        continue;
      }
      entries.push({
        path: safeArtifactLabel(projectRoot, candidate),
        content: await readFile(candidate)
      });
    } catch {
      findings.push({
        severity: "high",
        category: "artifact_integrity",
        code: "artifact_unreadable",
        subject: safeArtifactLabel(projectRoot, candidate),
        details: "Generated artifact could not be read for security scanning."
      });
    }
  }
  return { entries, findings };
}

async function walkArtifacts(
  root: string,
  candidates: Set<string>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkArtifacts(target, candidates);
    } else if (
      entry.isFile() &&
      /\.(?:json|jsonl|md)$/iu.test(entry.name)
    ) {
      candidates.add(target);
    } else if (entry.isSymbolicLink()) {
      candidates.add(target);
    }
    if (candidates.size > maxScannedArtifacts) {
      return;
    }
  }
}

function safeArtifactLabel(projectRoot: string, candidate: string): string {
  const relative = path.relative(projectRoot, candidate);
  return relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
    ? toPosixPath(relative)
    : `<external>/${path.basename(candidate)}`;
}

function dependencyFinding(
  finding: DependencyPolicyFinding
): SecurityBaselineFinding {
  return {
    severity: finding.severity,
    category: "dependency",
    code: finding.code,
    ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    details: finding.details
  };
}

async function inspectDependencyPolicySafely(
  projectRoot: string,
  options: { npmAuditPath?: string }
): Promise<DependencyPolicyResult> {
  try {
    return await inspectDependencyPolicy(projectRoot, {
      npmAuditPath:
        options.npmAuditPath === undefined
          ? undefined
          : path.resolve(projectRoot, options.npmAuditPath)
    });
  } catch {
    return {
      status: "UNPASSED",
      package_lock_sha256: "unavailable",
      production_packages: 0,
      direct_dependencies: [],
      licenses: [],
      external_audit: {
        status: "SETUP_REQUIRED",
        high: 0,
        critical: 0
      },
      findings: [{
        severity: "high",
        code: "dependency_metadata_unreadable",
        details:
          "package.json or package-lock.json is missing, unreadable, or not a JSON object."
      }]
    };
  }
}

function normalizeNpmAuditEvidenceStatus(
  externalAudit: DependencyPolicyResult["external_audit"],
  generatedAt: Date
): DependencyPolicyResult["external_audit"]["status"] {
  if (externalAudit.status !== "PASS") {
    return externalAudit.status;
  }
  if (externalAudit.captured_at === undefined) {
    return "SETUP_REQUIRED";
  }
  const capturedAt = Date.parse(externalAudit.captured_at);
  const ageMs = generatedAt.getTime() - capturedAt;
  return Number.isFinite(capturedAt) &&
    ageMs >= -maxNpmAuditFutureSkewMs &&
    ageMs <= maxNpmAuditAgeMs
    ? "PASS"
    : "SETUP_REQUIRED";
}

function check(
  id: string,
  category: SecurityBaselineCheck["category"],
  status: SecurityBaselineStatus,
  summary: string
): SecurityBaselineCheck {
  return { id, category, status, summary };
}

function summarize(
  checks: readonly SecurityBaselineCheck[],
  findings: readonly SecurityBaselineFinding[]
): SecurityBaselineArtifact["summary"] {
  return {
    pass: checks.filter((entry) => entry.status === "PASS").length,
    unpassed: checks.filter((entry) => entry.status === "UNPASSED").length,
    setup_required: checks.filter(
      (entry) => entry.status === "SETUP_REQUIRED"
    ).length,
    high: findings.filter((finding) => finding.severity === "high").length,
    critical: findings.filter(
      (finding) => finding.severity === "critical"
    ).length,
    secret_exposures: findings.filter(
      (finding) =>
        finding.code === "artifact_secret_exposure" ||
        finding.code === "security_report_secret_exposure"
    ).length,
    total: checks.length
  };
}

function compareFindings(
  left: SecurityBaselineFinding,
  right: SecurityBaselineFinding
): number {
  const severity = { critical: 0, high: 1, medium: 2 };
  return (
    severity[left.severity] - severity[right.severity] ||
    left.category.localeCompare(right.category) ||
    left.code.localeCompare(right.code) ||
    (left.subject ?? "").localeCompare(right.subject ?? "")
  );
}

function validateSourceCommit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error("Security baseline source commit must be a 40-character SHA.");
  }
  return normalized;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
