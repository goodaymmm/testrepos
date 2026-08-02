import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { appendJsonLine } from "../src/core/fs/jsonl-file.js";
import {
  createDaemonSoakCertification,
  formatDaemonSoakCertification
} from "../src/runtime/daemon-certification.js";
import { createTempProject } from "./test-utils.js";

describe("daemon soak certification", () => {
  it("passes a complete 24-hour window with an allowed scheduled restart", async () => {
    const root = await createInitializedProject();
    const events: Record<string, unknown>[] = [
      started("2026-07-14T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
    ];
    for (let hour = 1; hour <= 11; hour += 1) {
      events.push(tick(atHour(hour)));
    }
    events.push({
      event: "stopped",
      stop_reason: "stop_requested",
      created_at: "2026-07-14T11:30:00.000Z"
    });
    events.push(started("2026-07-14T11:35:00.000Z", "2026-07-01T00:00:00.000Z"));
    for (let hour = 12; hour <= 24; hour += 1) {
      events.push(tick(atHour(hour)));
    }
    await appendDaemonEvents(root, "2026-07-14", events);

    const certification = await createDaemonSoakCertification(root, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 3_600_000,
      maxHeartbeatGapMs: 3_900_000,
      maxRestartGapMs: 600_000,
      minimumTicks: 20
    });

    expect(certification).toMatchObject({
      status: "PASS",
      window: { complete: true },
      metrics: {
        ticks: 24,
        fatal_errors: 0,
        heartbeat_gap_violations: 0,
        allowed_restarts: 1,
        unexpected_restarts: 0
      }
    });
    expect(certification.restarts).toContainEqual(
      expect.objectContaining({
        kind: "scheduled_restart",
        status: "allowed",
        stop_reason: "stop_requested"
      })
    );
    expect(certification.source.logs).toEqual([
      {
        path: ".kairon/runtime/daemon/2026-07-14.jsonl",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    ]);
    expect(formatDaemonSoakCertification(certification)).toContain(
      "# Kairon Daemon Soak Certification"
    );
  });

  it("returns SETUP_REQUIRED when no daemon evidence exists", async () => {
    const root = await createInitializedProject();

    const certification = await createDaemonSoakCertification(root, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z")
    });

    expect(certification.status).toBe("SETUP_REQUIRED");
    expect(certification.source.logs).toEqual([]);
    expect(certification.checks).toContainEqual(
      expect.objectContaining({
        id: "evidence_available",
        status: "SETUP_REQUIRED"
      })
    );
  });

  it("returns INCOMPLETE when the selected window is not covered", async () => {
    const root = await createInitializedProject();
    await appendDaemonEvents(root, "2026-07-14", [
      started("2026-07-14T22:00:00.000Z", "2026-07-01T00:00:00.000Z"),
      tick("2026-07-14T23:00:00.000Z"),
      tick("2026-07-15T00:00:00.000Z")
    ]);

    const certification = await createDaemonSoakCertification(root, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 3_600_000,
      maxHeartbeatGapMs: 3_900_000
    });

    expect(certification.status).toBe("INCOMPLETE");
    expect(certification.window).toMatchObject({
      complete: false,
      leading_gap_ms: 79_200_000,
      trailing_gap_ms: 0
    });
    expect(certification.checks).toContainEqual(
      expect.objectContaining({ id: "minimum_ticks", status: "INCOMPLETE" })
    );
  });

  it("returns UNPASSED for fatal errors and heartbeat gaps", async () => {
    const root = await createInitializedProject();
    await appendDaemonEvents(root, "2026-07-14", [
      started("2026-07-14T00:00:00.000Z", "2026-07-01T00:00:00.000Z"),
      tick("2026-07-14T01:00:00.000Z"),
      {
        event: "fatal_error",
        error: {
          message: "token=SHOULD_NOT_LEAK"
        },
        created_at: "2026-07-14T23:59:00.000Z"
      },
      tick("2026-07-15T00:00:00.000Z")
    ]);

    const certification = await createDaemonSoakCertification(root, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 3_600_000,
      maxHeartbeatGapMs: 7_200_000,
      minimumTicks: 2
    });

    expect(certification.status).toBe("UNPASSED");
    expect(certification.metrics).toMatchObject({
      fatal_errors: 1,
      heartbeat_gap_violations: 1
    });
    expect(JSON.stringify(certification)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("returns UNPASSED when the latest running evidence is stale", async () => {
    const root = await createInitializedProject();
    const events: Record<string, unknown>[] = [
      started("2026-07-14T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
    ];
    for (let hour = 1; hour <= 20; hour += 1) {
      events.push(tick(atHour(hour)));
    }
    await appendDaemonEvents(root, "2026-07-14", events);

    const certification = await createDaemonSoakCertification(root, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 3_600_000,
      maxHeartbeatGapMs: 7_200_000,
      minimumTicks: 1
    });

    expect(certification.status).toBe("UNPASSED");
    expect(certification.metrics.stale_lock_suspected).toBe(true);
    expect(certification.checks).toContainEqual(
      expect.objectContaining({ id: "stale_lock", status: "UNPASSED" })
    );
  });

  it("allows a short host reboot but rejects an unverified same-boot restart", async () => {
    const passingRoot = await createInitializedProject();
    await appendDaemonEvents(passingRoot, "2026-07-13", [
      started("2026-07-13T23:00:00.000Z", "2026-07-01T00:00:00.000Z")
    ]);
    await appendDaemonEvents(passingRoot, "2026-07-14", [
      tick("2026-07-14T00:00:00.000Z"),
      tick("2026-07-14T11:59:00.000Z"),
      started("2026-07-14T12:00:00.000Z", "2026-07-14T11:58:00.000Z"),
      tick("2026-07-15T00:00:00.000Z")
    ]);

    const passing = await createDaemonSoakCertification(passingRoot, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 43_200_000,
      maxHeartbeatGapMs: 43_200_000,
      maxRestartGapMs: 300_000,
      minimumTicks: 2
    });
    expect(passing.status).toBe("PASS");
    expect(passing.restarts).toContainEqual(
      expect.objectContaining({ kind: "host_reboot", status: "allowed" })
    );
    expect(passing.source.logs.map((source) => source.path)).toEqual([
      ".kairon/runtime/daemon/2026-07-13.jsonl",
      ".kairon/runtime/daemon/2026-07-14.jsonl"
    ]);

    const failingRoot = await createInitializedProject();
    await appendDaemonEvents(failingRoot, "2026-07-14", [
      started("2026-07-14T00:00:00.000Z", "2026-07-01T00:00:00.000Z"),
      tick("2026-07-14T11:59:00.000Z"),
      started("2026-07-14T12:00:00.000Z", "2026-07-01T00:00:00.000Z"),
      tick("2026-07-15T00:00:00.000Z")
    ]);

    const failing = await createDaemonSoakCertification(failingRoot, {
      since: "24h",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      expectedIntervalMs: 43_200_000,
      maxHeartbeatGapMs: 43_200_000,
      maxRestartGapMs: 300_000,
      minimumTicks: 2
    });
    expect(failing.status).toBe("UNPASSED");
    expect(failing.metrics.unexpected_restarts).toBe(1);
  });

  it("rejects future certification windows", async () => {
    const root = await createInitializedProject();
    await expect(
      createDaemonSoakCertification(root, {
        since: "2026-07-16T00:00:00.000Z",
        now: () => new Date("2026-07-15T00:00:00.000Z")
      })
    ).rejects.toThrow("window must start before");
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

async function appendDaemonEvents(
  root: string,
  date: string,
  events: Record<string, unknown>[]
): Promise<void> {
  for (const event of events) {
    await appendJsonLine(
      path.join(root, ".kairon", "runtime", "daemon", `${date}.jsonl`),
      {
        schema_version: "0.1",
        ...event
      }
    );
  }
}

function started(createdAt: string, hostBootAt: string): Record<string, unknown> {
  return {
    event: "started",
    started_at: createdAt,
    host_boot_at: hostBootAt,
    created_at: createdAt
  };
}

function tick(createdAt: string): Record<string, unknown> {
  return {
    event: "tick",
    action: "idle",
    created_at: createdAt
  };
}

function atHour(hour: number): string {
  return new Date(Date.UTC(2026, 6, 14, hour)).toISOString();
}
