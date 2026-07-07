import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { daemonReportCommand } from "../src/cli/commands/daemon.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { appendJsonLine } from "../src/core/fs/jsonl-file.js";
import {
  createDaemonEvidenceReport,
  formatDaemonEvidenceReport,
  parseSinceDate
} from "../src/runtime/daemon-report.js";
import { createTempProject } from "./test-utils.js";

describe("daemon evidence report", () => {
  it("summarizes normal daemon ticks and writes a markdown evidence pack", async () => {
    const root = await createInitializedProject();
    await appendDaemonEvents(root, "2026-06-13", [
      {
        event: "started",
        pid: 1234,
        started_at: "2026-06-13T00:00:00.000Z",
        created_at: "2026-06-13T00:00:00.000Z"
      },
      {
        event: "tick",
        tick_count: 1,
        idle_count: 1,
        action: "idle",
        created_at: "2026-06-13T00:00:05.000Z"
      },
      {
        event: "tick",
        tick_count: 2,
        idle_count: 0,
        action: "processed-item",
        created_at: "2026-06-13T00:00:10.000Z"
      },
      {
        event: "stopped",
        ticks: 2,
        idle_ticks: 0,
        stop_reason: "max_ticks",
        created_at: "2026-06-13T00:00:11.000Z"
      }
    ]);

    const report = await createDaemonEvidenceReport(root, {
      since: "24h",
      now: () => new Date("2026-06-14T00:00:00.000Z")
    });

    expect(report.summary).toMatchObject({
      status: "stopped",
      started: 1,
      ticks: 2,
      idle_ticks: 1,
      processed_ticks: 1,
      fatal_errors: 0,
      latest_stop_reason: "max_ticks",
      last_action: "processed-item",
      heartbeat_gaps: 0,
      stale_lock_suspected: false
    });
    expect(report.logs.paths).toEqual([".kairon/runtime/daemon/2026-06-13.jsonl"]);
    expect(formatDaemonEvidenceReport(report)).toContain(
      "# Kairon Daemon Evidence Report"
    );

    const output = await daemonReportCommand(root, {
      since: "24h",
      output: ".kairon/reports/daemon/2026-06-14.md"
    });
    expect(output).toContain("Kairon daemon evidence report written.");
    expect(output).toContain("report=.kairon/reports/daemon/2026-06-14.md");
    await expect(
      readFile(path.join(root, ".kairon", "reports", "daemon", "2026-06-14.md"), "utf8")
    ).resolves.toContain("processed_ticks");
  });

  it("reports failures, heartbeat gaps, stale suspicion, and redacts secrets", async () => {
    const root = await createInitializedProject();
    await appendDaemonEvents(root, "2026-06-13", [
      {
        event: "started",
        created_at: "2026-06-13T00:00:00.000Z"
      },
      {
        event: "tick",
        tick_count: 1,
        idle_count: 0,
        action: "processed-item",
        created_at: "2026-06-13T00:00:05.000Z"
      },
      {
        event: "fatal_error",
        error: {
          code: "discord_token",
          message: "Discord token=SHOULD_NOT_LEAK failed",
          at: "2026-06-13T00:05:05.000Z"
        },
        created_at: "2026-06-13T00:05:05.000Z"
      }
    ]);

    const report = await createDaemonEvidenceReport(root, {
      since: "1d",
      now: () => new Date("2026-06-13T00:10:00.000Z"),
      heartbeatGapMs: 60_000
    });
    const serialized = JSON.stringify(report);

    expect(report.summary).toMatchObject({
      status: "fatal_error",
      fatal_errors: 1,
      heartbeat_gaps: 1,
      max_heartbeat_gap_ms: 300_000,
      stale_lock_suspected: true
    });
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "fatal_error",
          message: "Discord token=[redacted] failed"
        })
      ])
    );
    expect(formatDaemonEvidenceReport(report)).toContain("Heartbeat Gaps");
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
  });

  it("handles empty daemon logs and supports json output", async () => {
    const root = await createInitializedProject();

    const report = await createDaemonEvidenceReport(root, {
      since: "24h",
      now: () => new Date("2026-06-14T00:00:00.000Z")
    });
    expect(report.summary.status).toBe("no_events");
    expect(report.logs.event_count).toBe(0);
    expect(formatDaemonEvidenceReport(report)).toContain(
      "No daemon log files were found"
    );

    const json = await daemonReportCommand(root, {
      since: "24h",
      format: "json"
    });
    expect(JSON.parse(json)).toMatchObject({
      schema_version: "0.1",
      summary: {
        status: "no_events"
      }
    });
  });

  it("parses relative and absolute since values", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");

    expect(parseSinceDate("7d", now).toISOString()).toBe(
      "2026-06-07T00:00:00.000Z"
    );
    expect(parseSinceDate("2026-06-01T12:00:00.000Z", now).toISOString()).toBe(
      "2026-06-01T12:00:00.000Z"
    );
    expect(() => parseSinceDate("soon", now)).toThrow("Invalid daemon report since");
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
