import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runDoctor } from "../src/diagnostics/doctor.js";
import { attachIncidentResource } from "../src/incidents/store.js";
import {
  certifyStableSoak,
  evaluateStableSoak,
  inspectLatestStableSoak,
  markStableSoakWindow,
  startStableSoak
} from "../src/runtime/stable-soak.js";
import { createTempProject } from "./test-utils.js";

const startedAt = new Date("2026-07-01T00:00:00.000Z");
const completedAt = new Date("2026-07-08T00:00:00.000Z");
const releaseVerificationId = "STV-20260701000000-aaaaaaaaaaaa";

describe("Stable soak certification", () => {
  it("keeps seven-day clock-injected evidence SETUP_REQUIRED", async () => {
    const fixture = await createFixture();
    await appendContinuousDaemonEvidence(fixture.root, startedAt, completedAt);
    await appendHealthyMetrics(fixture.root, startedAt, 7);

    const first = await evaluateStableSoak(
      fixture.root,
      fixture.soakId,
      { now: () => completedAt }
    );
    const certificate = await certifyStableSoak(
      fixture.root,
      fixture.soakId,
      { now: () => completedAt }
    );

    expect(first).toMatchObject({
      status: "SETUP_REQUIRED",
      evidence_mode: "simulated",
      duration_satisfied: true,
      coverage_ratio: 1,
      release_drift: false,
      reasons: ["simulated_clock_cannot_certify"]
    });
    expect(first.daily_rollups).toHaveLength(7);
    expect(certificate.certificate).toMatchObject({
      status: "SETUP_REQUIRED",
      soak_id: fixture.soakId,
      evaluation: {
        soak_id: first.soak_id,
        daily_rollups: first.daily_rollups
      }
    });
    expect(JSON.stringify(certificate)).not.toContain(process.env.USERNAME);
    expect(JSON.stringify(certificate)).not.toContain(fixture.root);

    const dailyNames = await readdir(
      path.join(fixture.root, ".kairon", "runtime", "soak", fixture.soakId, "daily")
    );
    expect(dailyNames).toHaveLength(7);
  }, 30_000);

  it("reports the remaining duration and exposes the active soak in doctor inspection", async () => {
    const fixture = await createFixture();
    const afterOneDay = new Date("2026-07-02T00:00:00.000Z");
    await appendContinuousDaemonEvidence(fixture.root, startedAt, afterOneDay);
    await appendHealthyMetrics(fixture.root, startedAt, 1);

    const evaluation = await evaluateStableSoak(
      fixture.root,
      fixture.soakId,
      { now: () => afterOneDay }
    );
    const inspection = await inspectLatestStableSoak(
      fixture.root,
      afterOneDay
    );
    const doctor = await runDoctor({
      projectRoot: fixture.root,
      commandAvailability: async () => true,
      env: {},
      now: () => afterOneDay
    });

    expect(evaluation.status).toBe("SETUP_REQUIRED");
    expect(evaluation.reasons).toEqual(expect.arrayContaining([
      "minimum_duration_not_reached",
      "simulated_clock_cannot_certify"
    ]));
    expect(evaluation.next_action).toContain("clock injection");
    expect(inspection).toMatchObject({
      status: "active",
      soak_id: fixture.soakId,
      elapsed_hours: 24,
      minimum_hours: 168
    });
    expect(doctor.checks).toContainEqual(expect.objectContaining({
      id: "daemon.stable_soak",
      status: "warning",
      details: expect.arrayContaining([
        `soak_id=${fixture.soakId}`,
        "elapsed_hours=24",
        "minimum_hours=168"
      ])
    }));
  });

  it("classifies declared maintenance but does not trust an unverified reboot marker", async () => {
    const maintenance = await createFixture();
    await appendContinuousDaemonEvidence(
      maintenance.root,
      startedAt,
      completedAt,
      new Set([
        "2026-07-03T10:00:00.000Z",
        "2026-07-03T11:00:00.000Z",
        "2026-07-03T12:00:00.000Z"
      ])
    );
    await appendHealthyMetrics(maintenance.root, startedAt, 7);
    await markStableSoakWindow(maintenance.root, maintenance.soakId, {
      kind: "maintenance",
      from: "2026-07-03T09:00:00.000Z",
      until: "2026-07-03T13:00:00.000Z",
      reason: "scheduled database maintenance",
      now: () => new Date("2026-07-03T08:00:00.000Z")
    });

    const maintenanceResult = await evaluateStableSoak(
      maintenance.root,
      maintenance.soakId,
      { now: () => completedAt }
    );
    expect(maintenanceResult.daemon.unexplained_gaps).toBe(0);
    expect(maintenanceResult.reasons).not.toContain("unexplained_runtime_gap");
    await expect(
      markStableSoakWindow(maintenance.root, maintenance.soakId, {
        kind: "maintenance",
        from: "2026-07-04T09:00:00.000Z",
        until: "2026-07-04T10:00:00.000Z",
        reason: "retroactive maintenance marker",
        now: () => new Date("2026-07-04T11:00:00.000Z")
      })
    ).rejects.toThrow("before its window starts");

    const reboot = await createFixture();
    await appendContinuousDaemonEvidence(
      reboot.root,
      startedAt,
      completedAt,
      new Set([
        "2026-07-03T10:00:00.000Z",
        "2026-07-03T11:00:00.000Z",
        "2026-07-03T12:00:00.000Z"
      ])
    );
    await appendHealthyMetrics(reboot.root, startedAt, 7);
    await markStableSoakWindow(reboot.root, reboot.soakId, {
      kind: "planned_reboot",
      from: "2026-07-03T09:00:00.000Z",
      until: "2026-07-03T13:00:00.000Z",
      reason: "planned operating system reboot",
      now: () => new Date("2026-07-03T08:00:00.000Z")
    });

    const rebootResult = await evaluateStableSoak(
      reboot.root,
      reboot.soakId,
      { now: () => completedAt }
    );
    expect(rebootResult.status).toBe("FAIL");
    expect(rebootResult.daemon.unexplained_gaps).toBeGreaterThan(0);
    expect(rebootResult.reasons).toContain("unexplained_runtime_gap");
  }, 20_000);

  it("fails when the release-bound verification artifact drifts", async () => {
    const fixture = await createFixture();
    const artifactPath = path.join(fixture.root, fixture.releasePath);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    artifact.state_digest = "sha256:drift";
    await writeJsonFileAtomic(artifactPath, artifact);

    const evaluation = await evaluateStableSoak(
      fixture.root,
      fixture.soakId,
      { now: () => new Date("2026-07-01T01:00:00.000Z") }
    );

    expect(evaluation.status).toBe("FAIL");
    expect(evaluation.release_drift).toBe(true);
    expect(evaluation.reasons).toContain("release_binding_drift");
    expect(evaluation.reasons).toContain("slo_evidence_incomplete");
  });

  it("fails when a critical incident overlaps the certification window", async () => {
    const fixture = await createFixture();
    await attachIncidentResource(fixture.root, {
      fingerprint: "stable-soak-critical",
      severity: "critical",
      title: "Stable soak critical incident",
      summary: "runtime integrity failed",
      resource: {
        kind: "recovery_target",
        id: "REC-STABLE-SOAK",
        status: "open"
      },
      now: new Date("2026-07-01T00:30:00.000Z")
    });

    const evaluation = await evaluateStableSoak(
      fixture.root,
      fixture.soakId,
      { now: () => new Date("2026-07-01T01:00:00.000Z") }
    );

    expect(evaluation.status).toBe("FAIL");
    expect(evaluation.incidents.critical).toBe(1);
    expect(evaluation.reasons).toContain("critical_incident_detected");
  });
});

async function createFixture(): Promise<{
  root: string;
  soakId: string;
  releasePath: string;
}> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const releasePath = path.join(
    ".kairon",
    "release",
    "stable-verifications",
    `${releaseVerificationId}.json`
  );
  await writeJsonFileAtomic(path.join(root, releasePath), {
    schema_version: "0.1",
    artifact_kind: "stable_release_verification",
    verification_id: releaseVerificationId,
    status: "PASS",
    integrity_status: "PASS",
    currentness_status: "PASS",
    repository: "example/kairon",
    base_branch: "main",
    version: "0.3.0",
    tag: "v0.3.0",
    release_id: 199,
    release_name: "Kairon 0.3.0",
    target_commit_sha: "a".repeat(40),
    tag_commit_sha: "a".repeat(40),
    draft: false,
    prerelease: false,
    assets: [],
    manifest: {
      status: "verified",
      package_version: "0.3.0",
      source_commit: "a".repeat(40),
      sha256: "b".repeat(64),
      verification_context: "consumer",
      failed_checks: []
    },
    channel_selection: {
      channel: "stable",
      selected_release_id: 199,
      selected_version: "0.3.0",
      matches_requested_release: true
    },
    credential_provider: "env",
    checks: [],
    reasons: [],
    remediation: [],
    state_digest: `sha256:${"c".repeat(64)}`,
    checked_at: startedAt.toISOString(),
    expires_at: "2026-07-02T00:00:00.000Z",
    execution_performed: false
  });
  const started = await startStableSoak(root, {
    releaseVerification: releasePath,
    minimumHours: 168,
    expectedIntervalMs: 3_600_000,
    maxHeartbeatGapMs: 7_200_000,
    maxRestartGapMs: 3_600_000,
    now: () => startedAt
  });
  return {
    root,
    soakId: started.manifest.soak_id,
    releasePath
  };
}

async function appendContinuousDaemonEvidence(
  root: string,
  from: Date,
  until: Date,
  skipped: Set<string> = new Set()
): Promise<void> {
  const events = new Map<string, Record<string, unknown>[]>();
  addDatedRecord(events, {
    event: "started",
    started_at: from.toISOString(),
    host_boot_at: "2026-06-30T00:00:00.000Z",
    created_at: from.toISOString()
  });
  for (
    let cursor = from.getTime() + 3_600_000;
    cursor <= until.getTime();
    cursor += 3_600_000
  ) {
    const createdAt = new Date(cursor).toISOString();
    if (!skipped.has(createdAt)) {
      addDatedRecord(events, {
        event: "tick",
        action: "idle",
        created_at: createdAt
      });
    }
  }
  for (const [date, records] of events) {
    await writeJsonLines(
      path.join(
      root,
      ".kairon",
      "runtime",
      "daemon",
        `${date}.jsonl`
      ),
      records.map((event) => ({
        schema_version: "0.1",
        ...event
      }))
    );
  }
}

function addDatedRecord(
  target: Map<string, Record<string, unknown>[]>,
  record: Record<string, unknown>
): void {
  const date = String(record.created_at).slice(0, 10);
  const records = target.get(date) ?? [];
  records.push(record);
  target.set(date, records);
}

async function writeJsonLines(
  filePath: string,
  records: Record<string, unknown>[]
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8"
  );
}

async function appendHealthyMetrics(
  root: string,
  from: Date,
  days: number
): Promise<void> {
  for (let day = 0; day < days; day += 1) {
    const records: Record<string, unknown>[] = [];
    for (let sample = 1; sample <= 5; sample += 1) {
      const recordedAt = new Date(
        from.getTime() + day * 86_400_000 + sample * 3_600_000
      ).toISOString();
      records.push(
        metricSample("runtime_tick_duration_ms", 10, "milliseconds", recordedAt),
        metricSample("queue_ready_age_ms", 100, "milliseconds", recordedAt),
        metricSample("run_latency_ms", 100, "milliseconds", recordedAt),
        metricSample("notification_result", 1, "ratio", recordedAt),
        metricSample("remote_readiness", 1, "ratio", recordedAt)
      );
    }
    const date = new Date(from.getTime() + day * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await writeJsonLines(
      path.join(root, ".kairon", "metrics", "raw", `${date}.jsonl`),
      records
    );
  }
}

function metricSample(
  metric: string,
  value: number,
  unit: string,
  recordedAt: string
): Record<string, unknown> {
  return {
    schema_version: "0.1",
    artifact_kind: "runtime_metric_sample",
    metric,
    value,
    unit,
    labels: {},
    recorded_at: recordedAt
  };
}
