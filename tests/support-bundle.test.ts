import {
  access,
  mkdir,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  createSupportBundle,
  planSupportBundle,
  supportPlanPath,
  verifySupportBundle,
  type SupportBundleDependencies
} from "../src/diagnostics/support-bundle.js";
import { scanSupportEntries } from "../src/diagnostics/support-redaction.js";
import type { RuntimeStatus } from "../src/runtime/status.js";
import { createTempProject } from "./test-utils.js";

describe("sanitized support bundle", () => {
  it("creates and verifies an allowlisted local-only support ZIP", async () => {
    const root = await createProject();
    const result = await createSupportBundle(root, {}, dependencies());

    expect(result.archive_path).toMatch(/kairon-support-SUP-0001\.zip$/u);
    expect(result.manifest).toMatchObject({
      bundle_id: "SUP-0001",
      local_only: true,
      upload_performed: false,
      redaction: { secret_scan_status: "passed", secret_finding_count: 0 }
    });
    expect(result.manifest?.files.map((entry) => entry.path)).toEqual([
      "diagnostics/integrity.json",
      "diagnostics/notification.json",
      "diagnostics/provider.json",
      "diagnostics/queue.json",
      "diagnostics/runtime.json",
      "diagnostics/system.json",
      "diagnostics/workflow.json",
      "summary.md"
    ]);
    await expect(access(supportPlanPath(root, "SUP-0001"))).resolves.toBeUndefined();

    const verified = await verifySupportBundle(result.archive_path!);
    expect(verified).toMatchObject({
      ok: true,
      bundle_id: "SUP-0001",
      files: 10,
      secret_scan: { status: "passed", finding_count: 0 }
    });
    expect(verified.checks).toHaveLength(5);
  });

  it("keeps dry-run free of filesystem mutations while listing exclusions", async () => {
    const root = await createProject();
    const result = await planSupportBundle(root, {}, dependencies());

    expect(result.plan).toMatchObject({
      bundle_id: "SUP-DRY-RUN",
      status: "dry_run",
      archive_name: "kairon-support-SUP-DRY-RUN.zip"
    });
    expect(result.plan.files).toHaveLength(8);
    expect(result.plan.exclusions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["project_source", "protected_paths", "agent_output", "raw_logs"])
    );
    await expect(access(path.join(root, ".kairon", "support"))).rejects.toThrow();
  });

  it("redacts credentials, user paths, raw fields, and URL query secrets", async () => {
    const root = await createProject();
    const secret = `${"github"}_pat_${"1234567890abcdefghijklmnop"}`;
    const fixture = dependencies({
      doctorDetails: [
        `Authorization: Bearer ${secret}`,
        `path=${path.join(root, "private", "record.json")}`,
        `url=https://example.test/check?token=${secret}`
      ]
    });
    const result = await createSupportBundle(root, {}, fixture);
    const archive = (await readFile(result.archive_path!)).toString("utf8");

    expect(archive).not.toContain(secret);
    expect(archive).not.toContain(path.resolve(root));
    expect(archive).toContain("[redacted]");
    expect(result.manifest?.redaction.redacted_values).toBeGreaterThan(0);
    expect((await verifySupportBundle(result.archive_path!)).ok).toBe(true);
  });

  it("never copies huge raw agent logs or protected project files", async () => {
    const root = await createProject();
    const rawSecret = `${"github"}_pat_${"rawlog1234567890abcdefghijklmnop"}`;
    const runDir = path.join(root, ".kairon", "runs", "RUN-9000");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "stdout.log"), `${rawSecret}\n${"x".repeat(2_000_000)}`);
    await writeFile(path.join(root, ".env"), `TOKEN=${rawSecret}\n`);

    const result = await createSupportBundle(root, {}, dependencies());
    const archive = await readFile(result.archive_path!);
    expect(archive.length).toBeLessThan(200_000);
    expect(archive.toString("utf8")).not.toContain(rawSecret);
    expect((await verifySupportBundle(result.archive_path!)).ok).toBe(true);
  });

  it("detects payload tampering through CRC and manifest verification", async () => {
    const root = await createProject();
    const result = await createSupportBundle(root, {}, dependencies());
    const archive = await readFile(result.archive_path!);
    const marker = Buffer.from('"category": "system"', "utf8");
    const offset = archive.indexOf(marker);
    expect(offset).toBeGreaterThan(0);
    archive[offset + marker.length - 1] = "X".charCodeAt(0);
    const tampered = path.join(root, "tampered.zip");
    await writeFile(tampered, archive);

    const verification = await verifySupportBundle(tampered);
    expect(verification.ok).toBe(false);
    expect(verification.checks.some((check) => check.status === "error")).toBe(true);
  });

  it("rejects ZIP traversal paths before reading payload data", async () => {
    const root = await createProject();
    const result = await createSupportBundle(root, {}, dependencies());
    const archive = await readFile(result.archive_path!);
    replaceAllSameLength(archive, "summary.md", "../evil.md");
    const unsafe = path.join(root, "unsafe.zip");
    await writeFile(unsafe, archive);

    const verification = await verifySupportBundle(unsafe);
    expect(verification.ok).toBe(false);
    expect(verification.checks[0]).toMatchObject({ id: "archive", status: "error" });
  });

  it("detects representative secret fixture patterns without echoing values", () => {
    const credential = `${"Bearer"} abcdefghijklmnopqrstuvwxyz`;
    const scan = scanSupportEntries([{ path: "fixture.json", content:
      JSON.stringify({ authorization: credential }) }]);
    expect(scan).toMatchObject({ status: "failed", finding_count: 1 });
    expect(scan.findings).toEqual([{ entry: "fixture.json", pattern: "bearer_token" }]);
    expect(JSON.stringify(scan)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects a symlink or junction output directory", async () => {
    const root = await createProject();
    const actual = path.join(root, "actual-output");
    const linked = path.join(root, "linked-output");
    await mkdir(actual);
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(createSupportBundle(
      root,
      { outputDirectory: path.join(linked, "nested") },
      dependencies()
    ))
      .rejects.toThrow(/symlink|junction|not a link/iu);
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function dependencies(options: { doctorDetails?: string[] } = {}): SupportBundleDependencies {
  return {
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    doctor: async () => ({
      ok: true,
      summary: { pass: 2, warning: 0, error: 0 },
      checks: [
        {
          id: "git.repository",
          title: "Git repository",
          status: "pass",
          details: options.doctorDetails ?? ["repository=ready"]
        },
        {
          id: "discord.config",
          title: "Discord notification config",
          status: "pass",
          details: ["enabled=false", "live_status=setup_required"]
        }
      ]
    }),
    runtimeStatus: async () => runtimeStatus(),
    providerHealth: async () => [],
    ragIntegrity: async () => ({
      schema_version: "0.1",
      artifact_kind: "rag_integrity",
      status: "SETUP_REQUIRED",
      index_path: ".kairon/rag/index.json",
      source_count: 0,
      chunk_count: 0,
      issue_count: 0,
      issues: [],
      checked_at: "2026-07-23T00:00:00.000Z"
    })
  };
}

function runtimeStatus(): RuntimeStatus {
  return {
    schedule: {
      mode: "standby_work",
      baseMode: "standby_work",
      activeWorkClosed: false,
      timezone: "UTC"
    },
    runtimeLock: { locked: false },
    queue: { ready: 1, claimed: 0, failed: 0 },
    approvals: { pending: 0 },
    followUps: { pending: 0, snoozed: 0 },
    recovery: {
      targets: 0,
      stale_locks: 0,
      expired_claims: 0,
      run_issues: 0,
      gateway_issues: 0,
      git_transaction_issues: 0,
      resolved_targets: 0
    },
    artifacts: { last_tick: ".kairon/runtime/last-tick.json" }
  } as RuntimeStatus;
}

function replaceAllSameLength(buffer: Buffer, before: string, after: string): void {
  const source = Buffer.from(before, "utf8");
  const target = Buffer.from(after, "utf8");
  expect(target.length).toBe(source.length);
  let offset = 0;
  while ((offset = buffer.indexOf(source, offset)) !== -1) {
    target.copy(buffer, offset);
    offset += target.length;
  }
}
