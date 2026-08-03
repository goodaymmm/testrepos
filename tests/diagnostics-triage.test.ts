import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnosticsTriageCommand } from "../src/cli/commands/diagnostics.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { createProgram } from "../src/cli/main.js";
import {
  generateDiagnosticsTriage,
  writeDiagnosticsTriage,
  type DiagnosticsTriageDependencies
} from "../src/diagnostics/triage.js";
import type { DoctorResult } from "../src/diagnostics/doctor.js";
import type { CorrelationArtifact } from "../src/correlation/store.js";
import type { IncidentArtifact } from "../src/incidents/store.js";
import type { WatchdogAlert } from "../src/runtime/watchdog.js";
import { createTempProject } from "./test-utils.js";

const now = new Date("2026-07-29T00:00:00.000Z");

describe("diagnostics triage", () => {
  it("groups watchdog, incident, and update symptoms by correlation id", async () => {
    const root = await createProject();
    const report = await generateDiagnosticsTriage(
      root,
      dependencies({
        doctor: doctorResult(),
        watchdogAlerts: [watchdogAlert()],
        incidents: [incident()],
        correlations: [correlation()],
        fileArtifacts: {
          stableReadiness: {
            status: "PASS",
            stable_ready: true
          },
          updateTransactions: [{
            transaction_id: "UTX-0001",
            status: "recovery_required",
            incident_id: "INC-0001"
          }],
          supportPlans: [{
            bundle_id: "SUP-0001",
            status: "completed"
          }]
        }
      })
    );

    expect(report.status).toBe("ATTENTION_REQUIRED");
    const correlated = report.items.find(
      (item) => item.root_cause_key === "correlation:COR-000001"
    );
    expect(correlated).toMatchObject({
      severity: "critical",
      correlation: {
        correlation_ids: ["COR-000001"],
        incident_ids: ["INC-0001"],
        transaction_ids: ["UTX-0001"]
      }
    });
    expect(correlated?.related_finding_ids).toEqual([
      "incident:INC-0001",
      "update:UTX-0001",
      "watchdog:ALT-0001"
    ]);
    expect(correlated?.evidence_paths).toContain(
      ".kairon/support/plans/SUP-0001.json"
    );
    expect(correlated?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "read_only",
          command: "kairon incident show INC-0001"
        }),
        expect.objectContaining({
          kind: "approval_required",
          command: "kairon incident recover INC-0001 --dry-run"
        }),
        expect.objectContaining({
          kind: "read_only",
          command: "kairon support bundle --dry-run"
        })
      ])
    );
  });

  it("separates credentials, external actions, and read-only reruns without leaking secrets", async () => {
    const root = await createProject();
    const report = await generateDiagnosticsTriage(
      root,
      dependencies({
        doctor: doctorResult({
          id: "git.branch_protection",
          title: "GitHub branch protection",
          status: "warning",
          details: [
            "token=github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "status=setup_required"
          ],
          next_action:
            "Set GH_TOKEN=github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }),
        certifications: [{
          agent: "codex",
          status: "setup_required",
          certification: null,
          reason: "certification_setup_required",
          rerun_command: "kairon agent certify --agent codex"
        }],
        fileArtifacts: {
          stableReadiness: {
            status: "UNPASSED",
            stable_ready: false,
            blockers: [{ id: "external_remote" }]
          },
          updateTransactions: [],
          supportPlans: []
        }
      })
    );
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("github_pat_");
    expect(serialized).not.toContain("GH_TOKEN=");
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root_cause_category: "credentials",
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: "external_manual" })
          ])
        }),
        expect.objectContaining({
          root_cause_category: "release_readiness",
          actions: expect.arrayContaining([
            expect.objectContaining({
              kind: "read_only",
              command: "kairon readiness stable check --format json"
            })
          ])
        })
      ])
    );
    expect(report.redaction.secret_scan_status).toBe("passed");
  });

  it("marks a failed source as partial with a bounded fallback action", async () => {
    const root = await createProject();
    const deps = dependencies({});
    deps.watchdogAlerts = async () => {
      throw new Error(
        "raw stack C:\\Users\\operator\\.credentials\\token.txt"
      );
    };
    const report = await generateDiagnosticsTriage(root, deps);
    const watchdog = report.sources.find((source) => source.id === "watchdog");
    const serialized = JSON.stringify(report);

    expect(report.status).toBe("PARTIAL");
    expect(watchdog).toMatchObject({
      status: "unavailable",
      reason: "source_read_failed"
    });
    expect(serialized).not.toContain("C:\\Users\\operator");
    expect(serialized).not.toContain(".credentials");
    expect(serialized).not.toContain("token.txt");
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          related_finding_ids: ["watchdog:source_unavailable"],
          actions: [
            expect.objectContaining({
              kind: "read_only",
              command: "kairon doctor --format json"
            })
          ]
        })
      ])
    );
  });

  it("writes secret-scanned JSON and Markdown atomically without changing canonical state", async () => {
    const root = await createProject();
    const before = await directoryDigest(path.join(root, ".kairon"));
    const report = await generateDiagnosticsTriage(
      root,
      dependencies({
        doctor: doctorResult(),
        fileArtifacts: {
          stableReadiness: null,
          updateTransactions: [],
          supportPlans: []
        }
      })
    );
    const output = path.join(root, "reports", "triage-result.json");
    const written = await writeDiagnosticsTriage(report, output);
    const after = await directoryDigest(path.join(root, ".kairon"));
    const json = await readFile(written.json_path, "utf8");
    const markdown = await readFile(written.markdown_path, "utf8");

    expect(before).toBe(after);
    expect(JSON.parse(json)).toMatchObject({
      artifact_kind: "diagnostics_triage_report",
      read_only: true
    });
    expect(markdown).toContain("# Kairon Diagnostics Triage");
    expect(markdown).toContain("Secret scan: passed");
  });

  it("registers the CLI and preserves valid JSON output while writing companion files", async () => {
    const diagnostics = createProgram().commands.find(
      (command) => command.name() === "diagnostics"
    );
    const triage = diagnostics?.commands.find(
      (command) => command.name() === "triage"
    );
    expect(triage?.options.map((option) => option.long)).toEqual([
      "--format",
      "--output"
    ]);

    const root = await createProject();
    const output = await diagnosticsTriageCommand(
      root,
      { format: "json", output: path.join(root, "triage") },
      dependencies({})
    );
    expect(JSON.parse(output)).toMatchObject({
      artifact_kind: "diagnostics_triage_report"
    });
    await expect(readFile(path.join(root, "triage.json"), "utf8"))
      .resolves.toContain("diagnostics_triage_report");
    await expect(readFile(path.join(root, "triage.md"), "utf8"))
      .resolves.toContain("Kairon Diagnostics Triage");
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function dependencies(input: {
  doctor?: DoctorResult;
  watchdogAlerts?: WatchdogAlert[];
  incidents?: IncidentArtifact[];
  correlations?: CorrelationArtifact[];
  certifications?: Awaited<
    ReturnType<NonNullable<DiagnosticsTriageDependencies["agentCertifications"]>>
  >;
  fileArtifacts?: Awaited<
    ReturnType<NonNullable<DiagnosticsTriageDependencies["fileArtifacts"]>>
  >;
}): DiagnosticsTriageDependencies {
  return {
    now: () => now,
    projectId: async () => "triage-project",
    doctor: async () => input.doctor ?? doctorResult(),
    watchdogAlerts: async () => input.watchdogAlerts ?? [],
    incidents: async () => input.incidents ?? [],
    correlations: async () => input.correlations ?? [],
    correlationIntegrity: async () => ({
      total: input.correlations?.length ?? 0,
      healthy: input.correlations?.length ?? 0,
      missing_artifacts: 0,
      stale_messages: 0,
      orphan_follow_ups: 0,
      duplicate_members: 0,
      issues: []
    }),
    agentCertifications: async () => input.certifications ?? [],
    fileArtifacts: async () =>
      input.fileArtifacts ?? {
        stableReadiness: null,
        updateTransactions: [],
        supportPlans: []
      }
  };
}

function doctorResult(check?: DoctorResult["checks"][number]): DoctorResult {
  const checks = check === undefined ? [] : [check];
  return {
    ok: check?.status !== "error",
    checks,
    summary: {
      pass: 0,
      warning: checks.filter((candidate) => candidate.status === "warning").length,
      error: checks.filter((candidate) => candidate.status === "error").length
    }
  };
}

function watchdogAlert(): WatchdogAlert {
  return {
    schema_version: "0.1",
    alert_id: "ALT-0001",
    project_id: "triage-project",
    fingerprint: "runtime:fatal",
    rule: "fatal_runtime_error",
    resource: "runtime",
    severity: "critical",
    status: "open",
    title: "Fatal runtime error",
    summary: "The runtime recorded a fatal error.",
    evidence: { count: 1 },
    cooldown_seconds: 900,
    occurrence_count: 1,
    recurrence_count: 0,
    first_detected_at: now.toISOString(),
    last_detected_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

function incident(): IncidentArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "incident",
    incident_id: "INC-0001",
    fingerprint: "runtime:fatal",
    correlation_id: "COR-000001",
    status: "open",
    severity: "critical",
    title: "Runtime recovery required",
    summary: "Runtime recovery requires an operator decision.",
    resources: [
      {
        kind: "watchdog_alert",
        id: "ALT-0001",
        status: "open",
        artifact_path: ".kairon/runtime/watchdog/alerts/ALT-0001.json",
        attached_at: now.toISOString(),
        updated_at: now.toISOString()
      },
      {
        kind: "update_transaction",
        id: "UTX-0001",
        status: "recovery_required",
        artifact_path: ".kairon/update/transactions/UTX-0001.json",
        attached_at: now.toISOString(),
        updated_at: now.toISOString()
      }
    ],
    recurrence_count: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

function correlation(): CorrelationArtifact {
  return {
    schema_version: "0.1",
    artifact_kind: "correlation",
    correlation_id: "COR-000001",
    status: "open",
    members: [{
      kind: "incident",
      id: "INC-0001",
      status: "open",
      artifact_path: ".kairon/incidents/INC-0001/incident.json",
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }],
    timeline: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

async function directoryDigest(directory: string): Promise<string> {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(toPosix(path.relative(directory, file)));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const absolute = path.join(directory, entry);
    if ((await stat(absolute)).isDirectory()) {
      files.push(...await listFiles(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files.sort();
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
