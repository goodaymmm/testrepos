import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { securityCheckCommand } from "../src/cli/commands/security.js";
import { scanSupportEntries } from "../src/diagnostics/support-redaction.js";
import {
  formatSecurityBaselineReport,
  runSecurityBaseline
} from "../src/security/baseline.js";
import { inspectDependencyPolicy } from "../src/security/dependency-policy.js";
import {
  evaluateArchivePolicy,
  stableArchivePolicyLimits,
  validatePortableArchivePath
} from "../src/security/path-policy.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);
const fixedNow = new Date("2026-07-27T00:00:00.000Z");

describe("Stable security baseline", () => {
  it("passes reviewed dependencies, bounded policies, state integrity, and clean audit evidence", async () => {
    const root = await createSecurityProject();
    const auditPath = await writeAudit(root, { high: 0, critical: 0 });
    const result = await runSecurityBaseline(root, {
      sourceCommit,
      npmAuditPath: auditPath,
      now: () => fixedNow
    });

    expect(result.artifact).toMatchObject({
      artifact_kind: "security_baseline_result",
      status: "PASS",
      offline_status: "PASS",
      source_commit: sourceCommit,
      dependency: {
        external_audit: {
          status: "PASS",
          high: 0,
          critical: 0
        }
      },
      summary: {
        unpassed: 0,
        setup_required: 0,
        high: 0,
        critical: 0,
        secret_exposures: 0
      }
    });
    expect(result.artifact.checks.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "dependency_policy",
        "bounded_archive_policy",
        "portable_path_policy",
        "credential_redaction_policy",
        "http_boundary_policy",
        "child_process_policy",
        "generated_artifact_secret_scan",
        "canonical_state_integrity"
      ])
    );
    expect(result.output_path).toBe(
      ".kairon/security/security-baseline.json"
    );
    expect(scanSupportEntries([
      {
        path: "security-baseline.json",
        content: await readFile(path.join(root, result.output_path))
      }
    ]).status).toBe("passed");
  });

  it("keeps offline checks passed but requires fresh external npm audit evidence", async () => {
    const root = await createSecurityProject();
    const result = await runSecurityBaseline(root, {
      sourceCommit,
      now: () => fixedNow
    });

    expect(result.artifact.status).toBe("SETUP_REQUIRED");
    expect(result.artifact.offline_status).toBe("PASS");
    expect(result.artifact.dependency.external_audit.status).toBe(
      "SETUP_REQUIRED"
    );
  });

  it("requires a new npm audit when the external evidence is stale", async () => {
    const root = await createSecurityProject();
    const auditPath = await writeAudit(root, { high: 0, critical: 0 });
    const stale = new Date(fixedNow.getTime() - 25 * 60 * 60 * 1_000);
    await utimes(auditPath, stale, stale);

    const result = await runSecurityBaseline(root, {
      sourceCommit,
      npmAuditPath: auditPath,
      now: () => fixedNow
    });

    expect(result.artifact.status).toBe("SETUP_REQUIRED");
    expect(result.artifact.offline_status).toBe("PASS");
    expect(result.artifact.dependency.external_audit.status).toBe(
      "SETUP_REQUIRED"
    );
  });

  it("blocks a tampered production lock entry", async () => {
    const root = await createSecurityProject();
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    delete lock.packages["node_modules/commander"]!.integrity;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    const auditPath = await writeAudit(root, { high: 0, critical: 0 });

    const result = await runSecurityBaseline(root, {
      sourceCommit,
      npmAuditPath: auditPath,
      now: () => fixedNow
    });
    expect(result.artifact.status).toBe("UNPASSED");
    expect(result.artifact.findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        code: "lock_integrity_missing",
        subject: "commander"
      })
    );
  });

  it("writes an UNPASSED artifact when dependency metadata is malformed", async () => {
    const root = await createSecurityProject();
    await writeFile(path.join(root, "package-lock.json"), "{broken", "utf8");

    const result = await runSecurityBaseline(root, {
      sourceCommit,
      now: () => fixedNow
    });

    expect(result.artifact.status).toBe("UNPASSED");
    expect(result.artifact.offline_status).toBe("UNPASSED");
    expect(result.artifact.dependency.package_lock_sha256).toBe("unavailable");
    expect(result.artifact.findings).toContainEqual(
      expect.objectContaining({
        severity: "high",
        code: "dependency_metadata_unreadable"
      })
    );
  });

  it("finds generated artifact secrets without copying the credential into evidence", async () => {
    const root = await createSecurityProject();
    const artifactDirectory = path.join(root, ".kairon", "performance");
    await mkdir(artifactDirectory, { recursive: true });
    const secret = `github_pat_${"A".repeat(40)}`;
    await writeFile(
      path.join(artifactDirectory, "leak.json"),
      JSON.stringify({ value: secret }),
      "utf8"
    );
    const auditPath = await writeAudit(root, { high: 0, critical: 0 });
    const result = await runSecurityBaseline(root, {
      sourceCommit,
      npmAuditPath: auditPath,
      now: () => fixedNow
    });

    expect(result.artifact.status).toBe("UNPASSED");
    expect(result.artifact.summary.secret_exposures).toBe(1);
    expect(JSON.stringify(result.artifact)).not.toContain(secret);
    expect(result.artifact.findings).toContainEqual(
      expect.objectContaining({
        severity: "critical",
        code: "artifact_secret_exposure",
        subject: ".kairon/performance/leak.json"
      })
    );
  });

  it("rejects traversal, UNC, Windows device names, archive bombs, and case collisions", () => {
    for (const candidate of [
      "../escape",
      "C:/Windows/file",
      "//server/share/file",
      "package/CON.txt",
      "package/file.",
      "package/file "
    ]) {
      expect(
        validatePortableArchivePath(candidate, { requiredRoot: "package" })
      ).not.toEqual([]);
    }
    expect(
      validatePortableArchivePath("package/dist/cli/main.js", {
        requiredRoot: "package"
      })
    ).toEqual([]);

    expect(
      evaluateArchivePolicy({
        archive_bytes: 1,
        expanded_bytes: stableArchivePolicyLimits.max_expanded_bytes,
        required_root: "package",
        entries: [
          { path: "package/file", size_bytes: 1, type: "file" }
        ]
      }).violations
    ).toContain("compression_ratio");
    expect(
      evaluateArchivePolicy({
        archive_bytes: 1_024,
        expanded_bytes: 2_048,
        required_root: "package",
        entries: [
          { path: "package/File", size_bytes: 1, type: "file" },
          { path: "package/file", size_bytes: 1, type: "file" }
        ]
      }).violations
    ).toContain("case_collision");
  });

  it("reports high and critical npm advisories as blockers", async () => {
    const root = await createSecurityProject();
    const auditPath = await writeAudit(root, { high: 2, critical: 1 });
    const dependency = await inspectDependencyPolicy(root, {
      npmAuditPath: auditPath
    });

    expect(dependency.status).toBe("UNPASSED");
    expect(dependency.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "npm_audit_high" }),
        expect.objectContaining({ code: "npm_audit_critical" })
      ])
    );
  });

  it("registers secret-safe check/report CLI behavior", async () => {
    const root = await createSecurityProject();
    const auditPath = await writeAudit(root, { high: 0, critical: 0 });
    const checkResult = await securityCheckCommand(root, {
      npmAudit: auditPath,
      sourceCommit
    });
    const artifact = JSON.parse(
      await readFile(
        path.join(root, ".kairon", "security", "security-baseline.json"),
        "utf8"
      )
    );

    expect(checkResult.passed).toBe(true);
    expect(checkResult.text).toContain("status=PASS");
    const report = formatSecurityBaselineReport(artifact);
    expect(report).toContain("# Kairon Stable Security Baseline");
    expect(report).toContain("secret exposures: `0`");
    expect(scanSupportEntries([
      { path: "security-baseline.md", content: report }
    ]).status).toBe("passed");
  });
});

async function createSecurityProject(): Promise<string> {
  const root = await createTempProject();
  await Promise.all([
    copyRepositoryFile("package.json", root),
    copyRepositoryFile("package-lock.json", root)
  ]);
  return root;
}

async function copyRepositoryFile(
  name: string,
  targetRoot: string
): Promise<void> {
  await writeFile(
    path.join(targetRoot, name),
    await readFile(path.resolve(name))
  );
}

async function writeAudit(
  root: string,
  vulnerabilities: { high: number; critical: number }
): Promise<string> {
  const output = path.join(root, "npm-audit.json");
  await writeFile(
    output,
    `${JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: vulnerabilities.high,
          critical: vulnerabilities.critical,
          total: vulnerabilities.high + vulnerabilities.critical
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await utimes(output, fixedNow, fixedNow);
  return output;
}
