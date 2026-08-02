import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  createProjectRolloutPlan,
  showProjectRolloutPlan,
  type ProjectRolloutPlan
} from "../src/projects/rollout-plan.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import {
  ProjectSupervisor,
  type ProjectHealth
} from "../src/projects/supervisor.js";
import type { StableReleaseVerificationResult } from "../src/release/stable-verification.js";
import { createTempProject } from "./test-utils.js";

describe("multi-project rollout plan", () => {
  it("keeps primary blocked until the canary reaches the verified target with passing health", async () => {
    const sourceRoot = await createTempProject();
    const registry = await createRegistry("canary-app", "primary-app");
    await registry.setRolloutGroup("canary-app", "canary");
    await registry.setRolloutGroup("primary-app", "primary");
    const entries = await registry.list();
    const roots = new Map(entries.map((entry) => [entry.project_id, entry.root]));
    const before = await Promise.all(
      entries.map((entry) => treeDigest(entry.root))
    );
    const verification = stableVerification("0.4.0");
    const initialSupervisor = supervisor(registry, {
      "canary-app": health("canary-app", roots.get("canary-app")!, "0.3.0"),
      "primary-app": health("primary-app", roots.get("primary-app")!, "0.3.0")
    });

    const initial = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: initialSupervisor,
      stableVerification: verification,
      now: () => new Date("2026-07-29T10:00:00.000Z")
    });

    expect(initial.plan).toMatchObject({
      status: "ready",
      canary_gate: { status: "pending" },
      summary: { ready: 1, blocked: 1 }
    });
    expect(project(initial.plan, "canary-app")).toMatchObject({
      rollout_group: "canary",
      status: "ready",
      manual_commands: {
        download: "kairon update download 0.4.0",
        apply_template:
          "kairon update apply <download-id> --confirm <download-id>"
      }
    });
    expect(project(initial.plan, "primary-app")).toMatchObject({
      rollout_group: "primary",
      status: "blocked",
      blockers: ["canary_not_completed"],
      manual_commands: null
    });
    expect(await Promise.all(entries.map((entry) => treeDigest(entry.root))))
      .toEqual(before);
    expect(await readFile(initial.plan_path, "utf8")).not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|DISCORD_BOT_TOKEN|approval detail|task body/iu
    );

    const current = await showProjectRolloutPlan(initial.plan.plan_id, {
      registry,
      supervisor: initialSupervisor,
      stableVerification: verification,
      now: () => new Date("2026-07-29T10:30:00.000Z")
    });
    expect(current.drift.status).toBe("current");
    expect(current.commands_available).toBe(true);
    expect(initial.plan.expires_at).toBe(verification.expires_at);

    const expired = await showProjectRolloutPlan(initial.plan.plan_id, {
      registry,
      supervisor: initialSupervisor,
      stableVerification: verification,
      now: () => new Date("2026-07-30T08:00:00.001Z")
    });
    expect(expired).toMatchObject({
      drift: {
        status: "stale",
        reasons: ["rollout_plan_expired"]
      },
      commands_available: false
    });

    const promotedSupervisor = supervisor(registry, {
      "canary-app": health("canary-app", roots.get("canary-app")!, "0.4.0"),
      "primary-app": health("primary-app", roots.get("primary-app")!, "0.3.0")
    });
    const stale = await showProjectRolloutPlan(initial.plan.plan_id, {
      registry,
      supervisor: promotedSupervisor,
      stableVerification: verification,
      now: () => new Date("2026-07-29T11:00:00.000Z")
    });
    expect(stale).toMatchObject({
      drift: {
        status: "stale",
        reasons: ["rollout_input_drift"]
      },
      commands_available: false
    });

    const next = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: promotedSupervisor,
      stableVerification: verification,
      now: () => new Date("2026-07-29T11:00:00.000Z")
    });
    expect(next.plan.canary_gate.status).toBe("satisfied");
    expect(project(next.plan, "canary-app").status).toBe("completed");
    expect(project(next.plan, "primary-app")).toMatchObject({
      status: "ready",
      blockers: [],
      manual_commands: {
        download: "kairon update download 0.4.0"
      }
    });
  });

  it("blocks active runtime, state errors, version ahead, and unavailable roots", async () => {
    const sourceRoot = await createTempProject();
    const registry = await createRegistry("canary-app", "primary-app");
    await registry.setRolloutGroup("canary-app", "canary");
    await registry.setRolloutGroup("primary-app", "primary");
    const entries = await registry.list();
    const roots = new Map(entries.map((entry) => [entry.project_id, entry.root]));
    const canary = health(
      "canary-app",
      roots.get("canary-app")!,
      "0.5.0"
    );
    canary.runtime = {
      locked: true,
      stale: false,
      queue: { ready: 0, claimed: 0, failed: 0 },
      pending_approvals: 0,
      watchdog_open: 0
    };
    canary.state_integrity.errors = 2;
    const missing = health(
      "primary-app",
      roots.get("primary-app")!,
      "0.3.0"
    );
    missing.status = "error";
    missing.issues = ["root_missing"];
    const result = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: supervisor(registry, {
        "canary-app": canary,
        "primary-app": missing
      }),
      stableVerification: stableVerification("0.4.0"),
      now: () => new Date("2026-07-29T12:00:00.000Z")
    });

    expect(project(result.plan, "canary-app").blockers).toEqual(
      expect.arrayContaining([
        "installed_version_ahead",
        "runtime_active",
        "state_integrity_error"
      ])
    );
    expect(project(result.plan, "primary-app").blockers).toEqual(
      expect.arrayContaining([
        "canary_not_completed",
        "project_health_error",
        "project_root_unavailable"
      ])
    );
    expect(result.plan.projects.every((entry) => entry.manual_commands === null))
      .toBe(true);
    expect(result.plan.execution_performed).toBe(false);
    expect(result.plan.automatic_update).toBe(false);
  });

  it("fails closed when the Stable verification is missing or mismatched", async () => {
    const sourceRoot = await createTempProject();
    const registry = await createRegistry("canary-app");
    await registry.setRolloutGroup("canary-app", "canary");
    const entry = (await registry.list())[0]!;
    const projectSupervisor = supervisor(registry, {
      "canary-app": health("canary-app", entry.root, "0.3.0")
    });

    const missing = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: projectSupervisor,
      stableVerification: null,
      now: () => new Date("2026-07-29T13:00:00.000Z")
    });
    expect(missing.plan.global_blockers).toContain(
      "stable_verification_missing"
    );

    const mismatched = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: projectSupervisor,
      stableVerification: stableVerification("0.3.0"),
      now: () => new Date("2026-07-29T13:01:00.000Z")
    });
    expect(mismatched.plan.global_blockers).toContain(
      "stable_verification_version_mismatch"
    );
    expect(mismatched.plan.summary.ready).toBe(0);
  });

  it("rejects a tampered stored plan", async () => {
    const sourceRoot = await createTempProject();
    const registry = await createRegistry("canary-app");
    await registry.setRolloutGroup("canary-app", "canary");
    const entry = (await registry.list())[0]!;
    const result = await createProjectRolloutPlan({
      projectRoot: sourceRoot,
      targetVersion: "0.4.0",
      registry,
      supervisor: supervisor(registry, {
        "canary-app": health("canary-app", entry.root, "0.3.0")
      }),
      stableVerification: stableVerification("0.4.0"),
      now: () => new Date("2026-07-29T14:00:00.000Z")
    });
    const stored = await readJsonFile<ProjectRolloutPlan>(result.plan_path);
    await writeJsonFileAtomic(result.plan_path, {
      ...stored,
      target_version: "9.9.9"
    });

    await expect(
      showProjectRolloutPlan(result.plan.plan_id, {
        registry,
        stableVerification: stableVerification("0.4.0")
      })
    ).rejects.toThrow("Rollout plan digest mismatch");
  });
});

async function createRegistry(...projectIds: string[]): Promise<ProjectRegistry> {
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

function supervisor(
  registry: ProjectRegistry,
  projects: Record<string, ProjectHealth>
): ProjectSupervisor {
  return new ProjectSupervisor({
    registry,
    persistObservations: false,
    now: () => new Date("2026-07-29T09:00:00.000Z"),
    projectInspector: async (entry) => {
      const result = projects[entry.project_id];
      if (result === undefined) {
        throw new Error(`Missing project fixture: ${entry.project_id}`);
      }
      return structuredClone(result);
    }
  });
}

function health(
  projectId: string,
  root: string,
  installedVersion: string
): ProjectHealth {
  return {
    project_id: projectId,
    root,
    status: "pass",
    issues: [],
    registered_version: "0.3.0",
    observed_version: installedVersion,
    config: {
      valid: true,
      schema_version: "0.1",
      warnings: 0,
      errors: 0
    },
    state_integrity: {
      errors: 0,
      warnings: 0
    },
    runtime: {
      locked: false,
      stale: false,
      queue: { ready: 0, claimed: 0, failed: 0 },
      pending_approvals: 0,
      watchdog_open: 0
    },
    endpoints: [],
    provider_limits: {},
    last_seen_at: "2026-07-29T08:00:00.000Z"
  };
}

function stableVerification(
  version: string
): StableReleaseVerificationResult {
  return {
    schema_version: "0.1",
    artifact_kind: "stable_release_verification",
    verification_id: `STV-20260729080000-${"a".repeat(12)}`,
    status: "PASS",
    integrity_status: "PASS",
    currentness_status: "PASS",
    repository: "goodaymmm/Kairon",
    base_branch: "main",
    version,
    tag: `v${version}`,
    release_id: 500,
    release_name: `Kairon ${version}`,
    target_commit_sha: "a".repeat(40),
    tag_commit_sha: "a".repeat(40),
    draft: false,
    prerelease: false,
    assets: [],
    manifest: {
      status: "verified",
      package_version: version,
      source_commit: "a".repeat(40),
      sha256: "b".repeat(64),
      verification_context: "consumer",
      failed_checks: []
    },
    channel_selection: {
      channel: "stable",
      selected_release_id: 500,
      selected_version: version,
      matches_requested_release: true
    },
    credential_provider: "env",
    checks: [],
    reasons: [],
    remediation: [],
    state_digest: `sha256:${"c".repeat(64)}`,
    checked_at: "2026-07-29T08:00:00.000Z",
    expires_at: "2026-07-30T08:00:00.000Z",
    execution_performed: false
  };
}

function project(
  plan: ProjectRolloutPlan,
  projectId: string
): ProjectRolloutPlan["projects"][number] {
  const result = plan.projects.find((entry) => entry.project_id === projectId);
  if (result === undefined) {
    throw new Error(`Missing project plan: ${projectId}`);
  }
  return result;
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(candidate)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files.sort();
}
