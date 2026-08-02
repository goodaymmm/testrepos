import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { loadConfigFile } from "../src/core/config/load-config.js";
import {
  acquireLockFile,
  releaseLockFile
} from "../src/core/fs/lock-file.js";
import { listIncidents } from "../src/incidents/store.js";
import { BackupCatalog } from "../src/state/backup-catalog.js";
import type {
  DisasterRecoveryRehearsalResult,
  DisasterRecoveryVerifyResult
} from "../src/state/disaster-recovery.js";
import {
  getScheduledDrVerificationStatus,
  installScheduledDrVerification,
  readLatestScheduledDrVerification,
  readScheduledDrProfile,
  runScheduledDrVerification,
  scheduledDrPaths,
  uninstallScheduledDrVerification,
  verifyScheduledDrTask
} from "../src/state/dr-scheduled-verification.js";
import {
  defaultWatchdogPolicy,
  evaluateWatchdogRules,
  type WatchdogRuleInput
} from "../src/runtime/watchdog-rules.js";
import { runWatchdogCheck } from "../src/runtime/watchdog.js";
import { createTempProject } from "./test-utils.js";

describe("scheduled off-device backup verification", () => {
  it("registers, verifies, and removes only the exact secret-free managed task", async () => {
    const root = await createInitializedProject();
    const catalogPath = path.join(await createTempProject(), "catalog.json");
    const invocations: Parameters<CommandRunner>[0][] = [];
    const registeredRunner = runner(
      "task.exists=true\ntask.name=Kairon DR Verify test\ntask.managed=true\ntask.state=Ready",
      invocations
    );

    const installed = await installScheduledDrVerification(root, {
      platform: "win32",
      taskName: "Kairon DR Verify test",
      catalogPath,
      intervalHours: 12,
      rehearsalIntervalDays: 14,
      timeoutMs: 120_000,
      minimumGenerations: 3,
      kaironCommand: "C:\\Tools\\kairon.cmd",
      commandRunner: registeredRunner,
      helperPath: "C:\\Tools\\kairon-dr-verify-task.ps1",
      powerShellCommand: "powershell.exe",
      now: () => new Date("2026-07-29T00:00:00.000Z")
    });

    expect(installed).toContain("task_status=registered");
    expect(await readScheduledDrProfile(root)).toMatchObject({
      enabled: true,
      interval_hours: 12,
      rehearsal_interval_days: 14,
      timeout_ms: 120_000,
      minimum_generations: 3
    });
    expect(invocations[0]?.args).toEqual(expect.arrayContaining([
      "-Action",
      "Register",
      "-CatalogPath",
      catalogPath,
      "-MinimumGenerations",
      "3"
    ]));
    const serializedInvocation = JSON.stringify(invocations[0]);
    expect(serializedInvocation).not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|KAIRON_DISCORD|github_pat_|ghp_/u
    );

    await verifyScheduledDrTask(root, {
      platform: "win32",
      commandRunner: registeredRunner,
      helperPath: "C:\\Tools\\kairon-dr-verify-task.ps1",
      powerShellCommand: "powershell.exe"
    });
    await uninstallScheduledDrVerification(root, {
      platform: "win32",
      commandRunner: runner(
        "task.exists=false\ntask.name=Kairon DR Verify test\ntask.managed=false",
        invocations
      ),
      helperPath: "C:\\Tools\\kairon-dr-verify-task.ps1",
      powerShellCommand: "powershell.exe",
      now: () => new Date("2026-07-29T00:01:00.000Z")
    });
    expect(invocations.map((invocation) =>
      invocation.args[invocation.args.indexOf("-Action") + 1]
    )).toEqual(["Register", "Verify", "Unregister"]);
    expect(await readScheduledDrProfile(root)).toMatchObject({ enabled: false });

    const foreignRoot = await createInitializedProject();
    const foreign = await installScheduledDrVerification(foreignRoot, {
      platform: "win32",
      catalogPath: path.join(await createTempProject(), "catalog.json"),
      commandRunner: runner(
        "task.exists=true\ntask.managed=false\ntask.state=Ready",
        [],
        1
      )
    });
    expect(foreign).toContain("task_status=foreign");
    expect(await readScheduledDrProfile(foreignRoot)).toBeNull();
  });

  it("rehearses the latest verified generation when due without restoring or cleaning up", async () => {
    const fixture = await createScheduledFixture({
      minimumGenerations: 2,
      entryCount: 2,
      rehearsedAt: undefined
    });
    const statePath = path.join(fixture.root, ".kairon", "state", "protected.json");
    await writeFile(statePath, "{\"schema_version\":\"0.1\",\"value\":\"unchanged\"}\n");
    const before = await readFile(statePath, "utf8");
    const rehearse = vi.fn(async () => rehearsalResult(fixture.latest, fixture.now));
    const verify = vi.fn(async () => verificationResult(fixture.latest, fixture.now));

    const result = await runScheduledDrVerification(fixture.root, {
      catalogPath: fixture.catalogPath,
      rehearsalIntervalDays: 30,
      timeoutMs: 120_000,
      minimumGenerations: 2,
      now: () => fixture.now,
      rehearseBackup: rehearse,
      verifyBackup: verify
    });

    expect(result).toMatchObject({
      status: "PASS",
      classification: "verified",
      backup_id: fixture.latest.backup_id,
      rehearsal: { required: true, status: "passed" },
      automatic_restore: false,
      cleanup_performed: false
    });
    expect(result.operator_restore_command).toContain(
      `--confirm "${fixture.latest.backup_id}"`
    );
    expect(rehearse).toHaveBeenCalledOnce();
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(statePath, "utf8")).toBe(before);
    await expect(
      Promise.all(fixture.packagePaths.map((packagePath) => readFile(
        path.join(packagePath, "sentinel.txt"),
        "utf8"
      )))
    ).resolves.toEqual(["keep", "keep"]);
    expect((await getScheduledDrVerificationStatus(fixture.root, {
      now: () => fixture.now
    })).stale).toBe(false);
  });

  it("uses verification between rehearsal intervals and reports generation shortfall without deletion", async () => {
    const now = new Date("2026-07-29T03:00:00.000Z");
    const fixture = await createScheduledFixture({
      minimumGenerations: 2,
      entryCount: 1,
      rehearsedAt: "2026-07-28T03:00:00.000Z",
      now
    });
    const verify = vi.fn(async () => verificationResult(fixture.latest, now));
    const rehearse = vi.fn(async () => rehearsalResult(fixture.latest, now));

    const result = await runScheduledDrVerification(fixture.root, {
      catalogPath: fixture.catalogPath,
      rehearsalIntervalDays: 30,
      timeoutMs: 120_000,
      minimumGenerations: 2,
      now: () => now,
      rehearseBackup: rehearse,
      verifyBackup: verify
    });

    expect(result).toMatchObject({
      status: "FAIL",
      classification: "generation_shortfall",
      verification: { status: "verified" },
      rehearsal: { required: false, status: "not_due" },
      cleanup_performed: false
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(rehearse).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(fixture.packagePaths[0], "sentinel.txt"), "utf8")
    ).resolves.toBe("keep");
  });

  it("distinguishes an unavailable destination from corrupt catalog and backup data", async () => {
    const unavailable = await createScheduledFixture({
      minimumGenerations: 1,
      entryCount: 1,
      createDestination: false
    });
    await expect(
      runScheduledDrVerification(unavailable.root, {
        catalogPath: unavailable.catalogPath,
        rehearsalIntervalDays: 30,
        timeoutMs: 120_000,
        minimumGenerations: 1,
        now: () => unavailable.now
      })
    ).resolves.toMatchObject({
      status: "SETUP_REQUIRED",
      classification: "destination_unavailable"
    });

    const corruptCatalog = await createScheduledFixture({
      minimumGenerations: 1,
      entryCount: 1
    });
    await writeFile(corruptCatalog.catalogPath, "{}\n", "utf8");
    await expect(
      runScheduledDrVerification(corruptCatalog.root, {
        catalogPath: corruptCatalog.catalogPath,
        rehearsalIntervalDays: 30,
        timeoutMs: 120_000,
        minimumGenerations: 1,
        now: () => corruptCatalog.now
      })
    ).resolves.toMatchObject({
      status: "FAIL",
      classification: "catalog_corrupt"
    });

    const corruptBackup = await createScheduledFixture({
      minimumGenerations: 1,
      entryCount: 1
    });
    await expect(
      runScheduledDrVerification(corruptBackup.root, {
        catalogPath: corruptBackup.catalogPath,
        rehearsalIntervalDays: 30,
        timeoutMs: 120_000,
        minimumGenerations: 1,
        now: () => corruptBackup.now,
        probeDestination: async () => "backup_corrupt"
      })
    ).resolves.toMatchObject({
      status: "FAIL",
      classification: "backup_corrupt"
    });
  });

  it("returns busy for overlap, bounds execution time, and rejects a tampered result", async () => {
    const fixture = await createScheduledFixture({
      minimumGenerations: 1,
      entryCount: 1,
      rehearsedAt: "2026-07-28T03:00:00.000Z",
      timeoutMs: 1_000
    });
    const lock = await acquireLockFile(
      scheduledDrPaths(fixture.root).lock,
      "scheduled-dr-test",
      30_000
    );
    try {
      await expect(
        runScheduledDrVerification(fixture.root, {
          catalogPath: fixture.catalogPath,
          rehearsalIntervalDays: 30,
          timeoutMs: 1_000,
          minimumGenerations: 1,
          now: () => fixture.now
        })
      ).resolves.toMatchObject({
        status: "BUSY",
        classification: "busy",
        automatic_restore: false
      });
    } finally {
      await releaseLockFile(lock);
    }

    const timedOut = await runScheduledDrVerification(fixture.root, {
      catalogPath: fixture.catalogPath,
      rehearsalIntervalDays: 30,
      timeoutMs: 1_000,
      minimumGenerations: 1,
      now: () => fixture.now,
      verifyBackup: () => new Promise<never>(() => undefined)
    });
    expect(timedOut).toMatchObject({
      status: "FAIL",
      classification: "verification_failed",
      reason: "scheduled_dr_verification_timeout",
      automatic_restore: false,
      cleanup_performed: false
    });

    const latestPath = scheduledDrPaths(fixture.root).latest;
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as Record<
      string,
      unknown
    >;
    latest.classification = "verified";
    await writeFile(latestPath, `${JSON.stringify(latest)}\n`, "utf8");
    await expect(
      readLatestScheduledDrVerification(fixture.root)
    ).rejects.toThrow("Scheduled DR artifact is invalid");
  });

  it("raises distinct watchdog findings and synchronizes a failed verification incident", async () => {
    const input = baseWatchdogInput("2026-07-29T04:00:00.000Z");
    input.dr_backup = {
      status: "FAIL",
      classification: "backup_corrupt",
      checked_at: input.now,
      stale: false
    };
    expect(
      evaluateWatchdogRules(input, defaultWatchdogPolicy).map(
        (finding) => finding.rule
      )
    ).toEqual(["dr_verification_failed"]);

    const stale = baseWatchdogInput("2026-07-29T04:00:00.000Z");
    stale.dr_backup = {
      status: "SETUP_REQUIRED",
      classification: "destination_unavailable",
      checked_at: null,
      stale: true
    };
    expect(
      evaluateWatchdogRules(stale, defaultWatchdogPolicy).map(
        (finding) => finding.rule
      )
    ).toEqual(["dr_verification_stale"]);

    const root = await createInitializedProject();
    const checked = await runWatchdogCheck(root, {
      input,
      now: new Date(input.now)
    });
    expect(checked.alerts).toEqual([
      expect.objectContaining({
        rule: "dr_verification_failed",
        resource: "backup:off-device",
        severity: "high"
      })
    ]);
    expect(await listIncidents(root)).toEqual([
      expect.objectContaining({
        status: "open",
        resources: [
          expect.objectContaining({
            kind: "watchdog_alert",
            id: checked.alerts[0]?.alert_id
          })
        ]
      })
    ]);
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function runner(
  stdout: string,
  invocations: Parameters<CommandRunner>[0][],
  exitCode = 0
): CommandRunner {
  return async (invocation) => {
    invocations.push(invocation);
    return {
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      pid: 1,
      exitCode,
      signal: null,
      stdout,
      stderr: "",
      startedAt: "2026-07-29T00:00:00.000Z",
      finishedAt: "2026-07-29T00:00:01.000Z",
      timedOut: false
    } satisfies CommandRunResult;
  };
}

async function createScheduledFixture(options: {
  minimumGenerations: number;
  entryCount: number;
  rehearsedAt?: string;
  createDestination?: boolean;
  timeoutMs?: number;
  now?: Date;
}): Promise<{
  root: string;
  catalogPath: string;
  packagePaths: string[];
  latest: Awaited<ReturnType<BackupCatalog["list"]>>[number];
  now: Date;
}> {
  const root = await createInitializedProject();
  const project = await loadConfigFile<{ project_id: string }>(root, "project.json");
  const destination = path.join(await createTempProject(), "off-device");
  const catalogPath = path.join(await createTempProject(), "catalog.json");
  const now = options.now ?? new Date("2026-07-29T02:00:00.000Z");
  const packagePaths: string[] = [];
  const catalog = new BackupCatalog({ catalogPath, now: () => now });

  if (options.createDestination !== false) {
    await mkdir(destination, { recursive: true });
  }
  for (let index = 0; index < options.entryCount; index += 1) {
    const backupId = `BKP-202607290${index}00000000-fixture${index}`;
    const packagePath = path.join(destination, backupId);
    packagePaths.push(packagePath);
    if (options.createDestination !== false) {
      await mkdir(packagePath, { recursive: true });
      await writeFile(path.join(packagePath, "sentinel.txt"), "keep", "utf8");
    }
    await catalog.upsert({
      backup_id: backupId,
      project_id: project.project_id,
      destination_root: destination,
      package_path: packagePath,
      content_sha256: `sha256:${String(index).padStart(64, "0")}`,
      bytes: 100 + index,
      copied_at: new Date(now.getTime() - index * 60_000).toISOString(),
      verification_interval_days: 30,
      verification_status: "verified",
      verified_at: new Date(now.getTime() - 60_000).toISOString(),
      rehearsed_at: options.rehearsedAt,
      rehearsal_status:
        options.rehearsedAt === undefined ? undefined : "passed"
    });
  }
  await installScheduledDrVerification(root, {
    platform: "win32",
    catalogPath,
    intervalHours: 24,
    rehearsalIntervalDays: 30,
    timeoutMs: options.timeoutMs ?? 120_000,
    minimumGenerations: options.minimumGenerations,
    commandRunner: runner(
      "task.exists=true\ntask.managed=true\ntask.state=Ready",
      []
    ),
    now: () => now
  });
  const entries = await catalog.list(project.project_id);
  return {
    root,
    catalogPath,
    packagePaths,
    latest: entries[0],
    now
  };
}

function verificationResult(
  entry: Awaited<ReturnType<BackupCatalog["list"]>>[number],
  now: Date
): DisasterRecoveryVerifyResult {
  return {
    schema_version: "0.1",
    status: "verified",
    backup_id: entry.backup_id,
    project_id: entry.project_id,
    package_path: entry.package_path,
    content_sha256: entry.content_sha256,
    verified_at: now.toISOString(),
    verification_due_at: new Date(
      now.getTime() + entry.verification_interval_days * 86_400_000
    ).toISOString()
  };
}

function rehearsalResult(
  entry: Awaited<ReturnType<BackupCatalog["list"]>>[number],
  now: Date
): DisasterRecoveryRehearsalResult {
  return {
    schema_version: "0.1",
    status: "passed",
    backup_id: entry.backup_id,
    project_id: entry.project_id,
    package_path: entry.package_path,
    rehearsed_at: now.toISOString(),
    cleaned_up: true,
    integrity: {
      schema_version: "0.1",
      status: "ok",
      checked_at: now.toISOString(),
      summary: {
        files_checked: 1,
        json_files: 1,
        jsonl_files: 0,
        errors: 0,
        warnings: 0
      },
      issues: []
    },
    config_validation: {
      ok: true,
      errors: 0,
      warnings: 0
    },
    workflow_replay: {
      status: "ready",
      canonical_records: 1,
      issues: 0
    }
  };
}

function baseWatchdogInput(now: string): WatchdogRuleInput {
  return {
    project_id: "scheduled-dr-fixture",
    now,
    runtime: {
      locked: false,
      fatal_error_count: 0
    },
    daemon_start_times: [],
    queue: { ready: 0 },
    failed_notification_times: [],
    providers: [],
    task_scheduler: { status: "registered" }
  };
}
