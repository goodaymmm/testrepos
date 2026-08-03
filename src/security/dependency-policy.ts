import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type DependencyPolicyStatus = "PASS" | "UNPASSED" | "SETUP_REQUIRED";

export type DependencyPolicyFinding = {
  severity: "medium" | "high" | "critical";
  code: string;
  subject?: string;
  details: string;
};

export type DependencyPolicyResult = {
  status: DependencyPolicyStatus;
  package_lock_sha256: string;
  production_packages: number;
  direct_dependencies: string[];
  licenses: string[];
  external_audit: {
    status: "PASS" | "UNPASSED" | "SETUP_REQUIRED";
    captured_at?: string;
    high: number;
    critical: number;
  };
  findings: DependencyPolicyFinding[];
};

export const allowedProductionDependencies = [
  "commander",
  "discord.js",
  "node-pty",
  "zod"
] as const;

export const allowedProductionLicenses = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT"
] as const;

type LockPackage = {
  dev?: unknown;
  integrity?: unknown;
  resolved?: unknown;
  license?: unknown;
};

type PackageLock = {
  lockfileVersion?: unknown;
  packages?: unknown;
};

type PackageManifest = {
  dependencies?: unknown;
};

export async function inspectDependencyPolicy(
  projectRoot: string,
  options: { npmAuditPath?: string } = {}
): Promise<DependencyPolicyResult> {
  const packagePath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  const [packageBytes, lockBytes] = await Promise.all([
    readFile(packagePath),
    readFile(lockPath)
  ]);
  const manifest = parseRecord(packageBytes, "package.json") as PackageManifest;
  const lock = parseRecord(lockBytes, "package-lock.json") as PackageLock;
  const findings: DependencyPolicyFinding[] = [];
  const directDependencies = Object.keys(
    asRecord(manifest.dependencies)
  ).sort();
  const expectedDependencies = [...allowedProductionDependencies].sort();
  if (JSON.stringify(directDependencies) !== JSON.stringify(expectedDependencies)) {
    findings.push({
      severity: "high",
      code: "production_dependency_allowlist_mismatch",
      details: "Direct production dependencies differ from the reviewed allowlist."
    });
  }

  if (lock.lockfileVersion !== 3) {
    findings.push({
      severity: "high",
      code: "unsupported_lockfile_version",
      details: "package-lock.json must use lockfileVersion 3."
    });
  }

  const packageEntries = Object.entries(asRecord(lock.packages));
  const rootLockDependencies = asRecord(
    asRecord(asRecord(lock.packages)[""]).dependencies
  );
  if (
    JSON.stringify(sortedStringRecord(rootLockDependencies)) !==
    JSON.stringify(sortedStringRecord(asRecord(manifest.dependencies)))
  ) {
    findings.push({
      severity: "high",
      code: "lock_manifest_dependency_mismatch",
      details: "package.json and the root package-lock dependency set differ."
    });
  }
  const productionEntries = packageEntries.filter(
    ([name, candidate]) =>
      name !== "" && asRecord(candidate).dev !== true
  );
  const licenses = new Set<string>();
  for (const [packagePathName, candidate] of productionEntries) {
    const entry = asRecord(candidate) as LockPackage;
    const subject = packagePathName.replace(/^node_modules\//u, "");
    if (
      typeof entry.integrity !== "string" ||
      !entry.integrity.startsWith("sha512-")
    ) {
      findings.push({
        severity: "high",
        code: "lock_integrity_missing",
        subject,
        details: "Production package does not have a sha512 lockfile integrity."
      });
    }
    if (
      typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith("https://registry.npmjs.org/")
    ) {
      findings.push({
        severity: "high",
        code: "unapproved_dependency_source",
        subject,
        details: "Production package is not pinned to the approved npm registry."
      });
    }
    if (typeof entry.license !== "string") {
      findings.push({
        severity: "high",
        code: "dependency_license_missing",
        subject,
        details: "Production package license metadata is missing."
      });
    } else {
      licenses.add(entry.license);
      if (
        !allowedProductionLicenses.includes(
          entry.license as (typeof allowedProductionLicenses)[number]
        )
      ) {
        findings.push({
          severity: "high",
          code: "dependency_license_not_allowed",
          subject,
          details: "Production package license is outside the reviewed policy."
        });
      }
    }
  }

  const externalAudit = await inspectNpmAudit(options.npmAuditPath);
  findings.push(...externalAudit.findings);
  const offlineFailed = findings.some(
    (finding) =>
      finding.severity === "high" || finding.severity === "critical"
  ) && externalAudit.findings.length === 0;
  const status: DependencyPolicyStatus = offlineFailed
    ? "UNPASSED"
    : externalAudit.status;

  return {
    status,
    package_lock_sha256: createHash("sha256").update(lockBytes).digest("hex"),
    production_packages: productionEntries.length,
    direct_dependencies: directDependencies,
    licenses: [...licenses].sort(),
    external_audit: {
      status: externalAudit.status,
      ...(externalAudit.capturedAt === undefined
        ? {}
        : { captured_at: externalAudit.capturedAt }),
      high: externalAudit.high,
      critical: externalAudit.critical
    },
    findings
  };
}

async function inspectNpmAudit(npmAuditPath: string | undefined): Promise<{
  status: DependencyPolicyStatus;
  capturedAt?: string;
  high: number;
  critical: number;
  findings: DependencyPolicyFinding[];
}> {
  if (npmAuditPath === undefined) {
    return {
      status: "SETUP_REQUIRED",
      high: 0,
      critical: 0,
      findings: []
    };
  }

  try {
    const absolute = path.resolve(npmAuditPath);
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    const audit = parseRecord(bytes, "npm audit evidence");
    const vulnerabilities = asRecord(asRecord(audit.metadata).vulnerabilities);
    const high = nonNegativeInteger(vulnerabilities.high);
    const critical = nonNegativeInteger(vulnerabilities.critical);
    if (high === undefined || critical === undefined) {
      return {
        status: "SETUP_REQUIRED",
        capturedAt: info.mtime.toISOString(),
        high: 0,
        critical: 0,
        findings: []
      };
    }
    const findings: DependencyPolicyFinding[] = [
      ...(high > 0
        ? [{
            severity: "high" as const,
            code: "npm_audit_high",
            details: `npm audit reports ${high} high severity vulnerabilities.`
          }]
        : []),
      ...(critical > 0
        ? [{
            severity: "critical" as const,
            code: "npm_audit_critical",
            details: `npm audit reports ${critical} critical vulnerabilities.`
          }]
        : [])
    ];
    return {
      status: findings.length === 0 ? "PASS" : "UNPASSED",
      capturedAt: info.mtime.toISOString(),
      high,
      critical,
      findings
    };
  } catch {
    return {
      status: "SETUP_REQUIRED",
      high: 0,
      critical: 0,
      findings: []
    };
  }
}

function parseRecord(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The caller receives a stable, secret-safe parse error.
  }
  throw new Error(`${label} is not a JSON object.`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function sortedStringRecord(
  value: Record<string, unknown>
): Array<[string, string]> {
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
}
