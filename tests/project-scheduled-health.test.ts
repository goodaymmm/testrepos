import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { acquireLockFile, releaseLockFile } from "../src/core/fs/lock-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import {
  getScheduledHealthPaths,
  scanScheduledProjectHealth,
  type ScheduledHealthSnapshot
} from "../src/projects/scheduled-health.js";
import {
  createScheduledHealthTaskPlan,
  runScheduledHealthTaskAction
} from "../src/projects/scheduled-health-task.js";
import {
  ProjectSupervisor,
  type ProjectHealth
} from "../src/projects/supervisor.js";
import { createTempProject } from "./test-utils.js";

describe("scheduled multi-project health", () => {
  it("isolates a timed out project while preserving ordered results", async () => {
    const registry = await createRegistryWithProjects("slow", "healthy");
    const inspector = async (
      entry: Awaited<ReturnType<ProjectRegistry["list"]>>[number]
    ): Promise<ProjectHealth> => {
      if (entry.project_id === "slow") {
        return new Promise<ProjectHealth>(() => undefined);
      }
      return health(entry.project_id, entry.root, "pass", []);
    };

    const report = await new ProjectSupervisor({
      registry,
      persistObservations: false,
      projectTimeoutMs: 20,
      concurrency: 2,
      projectInspector: inspector
    }).inspect();

    expect(report.projects.map((project) => project.project_id)).toEqual([
      "healthy",
      "slow"
    ]);
    expect(
      report.projects.find((project) => project.project_id === "slow")
    ).toMatchObject({
      status: "error",
      issues: ["project_inspection_timeout"]
    });
    expect(
      report.projects.find((project) => project.project_id === "healthy")
        ?.status
    ).toBe("pass");
  });

  it("writes root-free snapshots, diffs, rollups, policy decisions, and retention", async () => {
    const registry = await createRegistryWithProjects("alpha");
    const registryPath = registry.registryPath;
    const entries = await registry.list();
    const projectRoot = entries[0]!.root;
    const paths = getScheduledHealthPaths(registryPath);
    await mkdir(paths.snapshotsDir, { recursive: true });
    const oldSnapshotPath = path.join(paths.snapshotsDir, "old.json");
    await writeJsonFileAtomic(oldSnapshotPath, {
      schema_version: "0.1",
      snapshot_id: "old",
      generated_at: "2025-01-01T00:00:00.000Z",
      status: "completed",
      ok: true,
      summary: { pass: 1, warning: 0, error: 0 },
      projects: [],
      conflicts: [],
      provider_pressure: [],
      diff: { added: [], removed: [], changed: [] }
    });

    const warningSupervisor = new ProjectSupervisor({
      registry,
      persistObservations: false,
      projectInspector: async () => ({
        ...health("alpha", projectRoot, "warning", ["runtime_lock_stale"]),
        provider_limits: { codex: 10 },
        endpoints: [
          {
            kind: "board",
            status: "ready",
            external_url: "https://board.example.test/"
          }
        ]
      })
    });
    const first = await scanScheduledProjectHealth({
      registryPath,
      supervisor: warningSupervisor,
      now: () => new Date("2026-07-26T01:00:00.000Z"),
      profile: {
        retention_days: 1,
        provider_pressure_threshold: 8
      },
      alertPolicyEvaluator: async () => ({
        decision: "defer",
        reason: "quiet_hours",
        route_id: "watchdog-discord"
      })
    });
    expect(first.status).toBe("completed");
    if (first.status === "busy") {
      throw new Error("Unexpected busy scan.");
    }
    expect(first.snapshot.projects[0]).toMatchObject({
      project_id: "alpha",
      status: "warning",
      alert_policy: {
        decision: "defer",
        reason: "quiet_hours"
      }
    });
    expect(first.snapshot.provider_pressure[0]?.status).toBe("pressure");
    expect(await readFile(first.snapshot_path, "utf8")).not.toContain(
      projectRoot
    );
    await expect(readFile(oldSnapshotPath, "utf8")).rejects.toThrow();

    const errorSupervisor = new ProjectSupervisor({
      registry,
      persistObservations: false,
      projectInspector: async () =>
        health("alpha", projectRoot, "error", ["root_missing"])
    });
    const second = await scanScheduledProjectHealth({
      registryPath,
      supervisor: errorSupervisor,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      alertPolicyEvaluator: async () => ({
        decision: "send",
        reason: "none",
        route_id: "watchdog-discord"
      })
    });
    expect(second.status).toBe("completed");
    if (second.status === "busy") {
      throw new Error("Unexpected busy scan.");
    }
    expect(second.snapshot.diff.changed).toEqual([
      expect.objectContaining({
        project_id: "alpha",
        before: "warning",
        after: "error"
      })
    ]);
    const daily = await readJsonFile<{ scans: number }>(
      path.join(paths.dailyDir, "2026-07-26.json")
    );
    const weekly = await readJsonFile<{ scans: number }>(
      path.join(paths.weeklyDir, "2026-W30.json")
    );
    expect(daily.scans).toBe(2);
    expect(weekly.scans).toBe(2);
  });

  it("records corrupt registry failure and reports lock contention without mutation", async () => {
    const registryRoot = await createTempProject();
    const registryPath = path.join(registryRoot, "projects.json");
    await writeFile(registryPath, "{broken", "utf8");

    const failed = await scanScheduledProjectHealth({
      registryPath,
      now: () => new Date("2026-07-26T03:00:00.000Z")
    });
    expect(failed.status).toBe("failed");
    if (failed.status !== "busy") {
      expect(failed.snapshot.failure_reason).toBe(
        "ProjectRegistryCorruptError"
      );
    }

    const paths = getScheduledHealthPaths(registryPath);
    const lock = await acquireLockFile(paths.lockPath, "test-owner", 60_000);
    try {
      const busy = await scanScheduledProjectHealth({ registryPath });
      expect(busy).toMatchObject({
        status: "busy",
        reason: "scan_lock_held"
      });
    } finally {
      await releaseLockFile(lock);
    }
  });
});

describe("scheduled multi-project health task", () => {
  it("requires exact plan confirmation and delegates idempotent task actions", async () => {
    const userRoot = await createTempProject();
    const registryPath = path.join(userRoot, "projects.json");
    const now = () => new Date("2026-07-26T04:00:00.000Z");
    const { plan } = await createScheduledHealthTaskPlan({
      registryPath,
      userDataRoot: userRoot,
      now,
      intervalMinutes: 30
    });
    const invocations: CliInvocation[] = [];
    const commandRunner = async (
      invocation: CliInvocation
    ): Promise<CommandRunResult> => {
      invocations.push(invocation);
      return commandResult(invocation, {
        stdout:
          invocation.args.includes("Unregister")
            ? "task.exists=false\n"
            : "task.exists=true\ntask.state=Ready\n"
      });
    };

    await expect(
      runScheduledHealthTaskAction("register", {
        registryPath,
        userDataRoot: userRoot,
        platform: "win32",
        planId: plan.plan_id,
        confirm: "wrong",
        commandRunner
      })
    ).rejects.toThrow("Confirmation mismatch");
    expect(invocations).toHaveLength(0);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = await runScheduledHealthTaskAction("register", {
        registryPath,
        userDataRoot: userRoot,
        platform: "win32",
        planId: plan.plan_id,
        confirm: plan.plan_id,
        helperPath: "C:\\Kairon\\kairon-supervisor-health-task.ps1",
        commandRunner,
        now
      });
      expect(output).toContain("task_status=registered");
    }
    const unregister = await runScheduledHealthTaskAction("unregister", {
      registryPath,
      userDataRoot: userRoot,
      platform: "win32",
      planId: plan.plan_id,
      confirm: plan.plan_id,
      commandRunner,
      now
    });
    expect(unregister).toContain("task_status=missing");
    expect(invocations).toHaveLength(3);
    expect(invocations[0]?.args).toEqual(
      expect.arrayContaining([
        "Register",
        "-IntervalMinutes",
        "30",
        "-RegistryPath",
        registryPath
      ])
    );
    expect(JSON.stringify(invocations)).not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|DISCORD_BOT_TOKEN/u
    );
  });

  it("returns setup_required outside Windows", async () => {
    const output = await runScheduledHealthTaskAction("verify", {
      registryPath: "/tmp/projects.json",
      platform: "linux"
    });
    expect(output).toContain("status=setup_required");
    expect(output).toContain("windows_task_scheduler_required");
  });
});

async function createRegistryWithProjects(
  ...projectIds: string[]
): Promise<ProjectRegistry> {
  const registryPath = path.join(await createTempProject(), "projects.json");
  const registry = new ProjectRegistry({ registryPath });
  for (const projectId of projectIds) {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const configPath = path.join(root, ".kairon", "config", "project.json");
    const config = await readJsonFile<Record<string, unknown>>(configPath);
    await writeJsonFileAtomic(configPath, {
      ...config,
      project_id: projectId,
      root
    });
    await registry.register(root);
  }
  return registry;
}

function health(
  projectId: string,
  root: string,
  status: ProjectHealth["status"],
  issues: string[]
): ProjectHealth {
  return {
    project_id: projectId,
    root,
    status,
    issues,
    registered_version: "0.3.0",
    observed_version: "0.3.0",
    config: {
      valid: status !== "error",
      warnings: status === "warning" ? 1 : 0,
      errors: status === "error" ? 1 : 0
    },
    state_integrity: {
      errors: status === "error" ? 1 : 0,
      warnings: status === "warning" ? 1 : 0
    },
    endpoints: [],
    provider_limits: {},
    last_seen_at: "2026-07-26T00:00:00.000Z"
  };
}

function commandResult(
  invocation: CliInvocation,
  overrides: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:01.000Z",
    timedOut: false,
    ...overrides
  };
}
