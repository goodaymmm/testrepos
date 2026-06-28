import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { appendJsonLine } from "../src/core/fs/jsonl-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import {
  acquireRuntimeLock,
  refreshRuntimeHeartbeat
} from "../src/runtime/runtime-lock.js";
import { formatRuntimeStatus, getRuntimeStatus } from "../src/runtime/status.js";
import { createTempProject } from "./test-utils.js";

describe("runtime status", () => {
  it("reports schedule, runtime lock, queue, and approvals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await acquireRuntimeLock(root, {
      mode: "daemon",
      now: new Date("2026-05-26T00:00:00.000Z")
    });
    await refreshRuntimeHeartbeat(root, {
      now: new Date("2026-05-26T00:00:10.000Z"),
      tickCount: 7,
      idleCount: 2,
      lastAction: "idle",
      nextTickAt: "2026-05-26T00:00:15.000Z",
      lastError: {
        code: "daemon_error",
        message: "token=SHOULD_NOT_LEAK failed",
        at: "2026-05-26T00:00:09.000Z"
      }
    });
    await new WorkQueue(root).enqueue({ type: "agent.run" });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
      schema_version: "0.1",
      id: "APR-0001",
      status: "pending"
    });
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "runtime", "discord", "gateway.json"),
      {
        schema_version: "0.1",
        status: "setup_required",
        commands_registered: false,
        error_code: "discord_missing_access_approval_channel",
        operation: "resolve_approval_channel",
        http_status: 403,
        next_action: "Verify token=SHOULD_NOT_LEAK and channel permissions."
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "runtime", "last-tick.json"),
      {
        schema_version: "0.1",
        sessions: {
          schema_version: "0.1",
          date: "2026-05-26",
          initialized: 3,
          ready: 1,
          idle: 1,
          busy: 0,
          setup_required: 1,
          permission_required: 0,
          rate_limited: 0,
          usage_limited: 1,
          closed: 0,
          agents: [],
          updated_at: "2026-05-26T00:00:00.000Z"
        }
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "reports", "daily", "2026-05-26.json"),
      {
        schema_version: "0.1",
        date: "2026-05-26"
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "cleanup", "proposals", "2026-05-26.json"),
      {
        schema_version: "0.1",
        date: "2026-05-26"
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "recovery", "REC-20260526000000000.json"),
      {
        schema_version: "0.1",
        recovery_id: "REC-20260526000000000"
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "reports", "next-day", "2026-05-26.json"),
      {
        schema_version: "0.1",
        date: "2026-05-26"
      }
    );
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "board", "projection.json"),
      {
        schema_version: "0.1"
      }
    );
    await appendJsonLine(
      path.join(root, ".kairon", "runtime", "daemon", "2026-05-26.jsonl"),
      {
        schema_version: "0.1",
        event: "started",
        pid: 1234,
        started_at: "2026-05-26T00:00:00.000Z",
        created_at: "2026-05-26T00:00:00.000Z"
      }
    );
    await appendJsonLine(
      path.join(root, ".kairon", "runtime", "daemon", "2026-05-26.jsonl"),
      {
        schema_version: "0.1",
        event: "tick",
        tick_count: 1,
        idle_count: 0,
        action: "processed-item",
        created_at: "2026-05-26T00:00:01.000Z"
      }
    );

    const status = await getRuntimeStatus(root);
    expect(status.runtimeLock.locked).toBe(true);
    expect(status.runtimeLock.mode).toBe("daemon");
    expect(status.runtimeLock.heartbeat_at).toBe("2026-05-26T00:00:10.000Z");
    expect(status.queue.ready).toBe(1);
    expect(status.approvals.pending).toBe(1);
    expect(formatRuntimeStatus(status)).toContain("queue.ready=1");
    expect(formatRuntimeStatus(status)).toContain("runtime.mode=daemon");
    expect(formatRuntimeStatus(status)).toContain("runtime.tickCount=7");
    expect(formatRuntimeStatus(status)).toContain("runtime.idleCount=2");
    expect(formatRuntimeStatus(status)).toContain("runtime.lastAction=idle");
    expect(formatRuntimeStatus(status)).toContain(
      "runtime.nextTickAt=2026-05-26T00:00:15.000Z"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "runtime.lastErrorCode=daemon_error"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "runtime.lastErrorMessage=token=[redacted] failed"
    );
    expect(formatRuntimeStatus(status)).toContain("recovery.targets=1");
    expect(formatRuntimeStatus(status)).toContain("recovery.staleLocks=1");
    expect(formatRuntimeStatus(status)).toContain("recovery.resolvedTargets=0");
    expect(formatRuntimeStatus(status)).toContain("sessions.initialized=3");
    expect(formatRuntimeStatus(status)).toContain("sessions.setupRequired=1");
    expect(formatRuntimeStatus(status)).toContain("sessions.usageLimited=1");
    expect(formatRuntimeStatus(status)).toContain("daemon.health.status=stale_lock");
    expect(formatRuntimeStatus(status)).toContain(
      "daemon.health.latestLog=.kairon/runtime/daemon/2026-05-26.jsonl"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "daemon.health.latestEventAt=2026-05-26T00:00:10.000Z"
    );
    expect(formatRuntimeStatus(status)).toContain("daemon.health.ticks=7");
    expect(formatRuntimeStatus(status)).toContain("daemon.health.idleTicks=2");
    expect(formatRuntimeStatus(status)).toContain("daemon.health.processedTicks=1");
    expect(formatRuntimeStatus(status)).toContain("daemon.health.fatalErrors=0");
    expect(formatRuntimeStatus(status)).toContain("daemon.health.lastAction=idle");
    expect(formatRuntimeStatus(status)).toContain(
      "daemon.health.staleLockSuspected=true"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "daemon.health.lastErrorMessage=token=[redacted] failed"
    );
    expect(formatRuntimeStatus(status)).toContain("discord.gateway.status=setup_required");
    expect(formatRuntimeStatus(status)).toContain(
      "discord.gateway.errorCode=discord_missing_access_approval_channel"
    );
    expect(formatRuntimeStatus(status)).toContain("discord.gateway.httpStatus=403");
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.lastTick=.kairon/runtime/last-tick.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestDailyReport=.kairon/reports/daily/2026-05-26.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestCleanupProposal=.kairon/cleanup/proposals/2026-05-26.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestRecoveryArtifact=.kairon/recovery/REC-20260526000000000.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestNextDayPlan=.kairon/reports/next-day/2026-05-26.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.boardProjection=.kairon/board/projection.json"
    );
    expect(formatRuntimeStatus(status)).toContain(
      "artifacts.latestDaemonLog=.kairon/runtime/daemon/2026-05-26.jsonl"
    );
    expect(formatRuntimeStatus(status)).not.toContain("SHOULD_NOT_LEAK");
  });
});
