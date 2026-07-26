import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  configFileNames,
  validateAllConfigs
} from "../src/core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  applySchemaMigrationPlan,
  createSchemaMigrationPlan,
  schemaMigrationMarkerPath,
  schemaMigrationPlanPath
} from "../src/migration/migration-plan.js";
import {
  configSchemaRegistry,
  currentConfigSchemaVersion,
  inspectConfigSchemaVersion,
  stateSchemaRegistry
} from "../src/migration/schema-registry.js";
import {
  acquireRuntimeLock,
  releaseRuntimeLock
} from "../src/runtime/runtime-lock.js";
import { checkStateIntegrity } from "../src/state/integrity-check.js";
import { createTempProject } from "./test-utils.js";

describe("schema evolution contract", () => {
  it("inventories config and state schema policy separately", () => {
    expect(configSchemaRegistry).toHaveLength(8);
    expect(
      configSchemaRegistry.every(
        (entry) =>
          entry.domain === "config" &&
          entry.current_version === "0.3.0" &&
          entry.minimum_readable_version === "0.1" &&
          entry.minimum_writable_version === "0.2.0" &&
          entry.rewrite_policy === "migration"
      )
    ).toBe(true);
    expect(
      stateSchemaRegistry.some(
        (entry) =>
          entry.key === "event_record" &&
          entry.append_only &&
          entry.rewrite_policy === "reader_compatibility"
      )
    ).toBe(true);
    expect(
      stateSchemaRegistry.some(
        (entry) =>
          entry.key === "audit_record" &&
          entry.append_only &&
          entry.rewrite_policy === "reader_compatibility"
      )
    ).toBe(true);
  });

  it("plans and applies a 0.2.0 fixture after backup and is idempotent", async () => {
    const root = await createLegacyProject("0.2.0");
    const now = new Date("2026-07-26T07:15:00.000Z");
    const planned = await createSchemaMigrationPlan(root, {
      now: () => now
    });

    expect(planned.status).toBe("plan_created");
    expect(planned.plan).toMatchObject({
      target_config_schema_version: "0.3.0",
      runtime_must_be_stopped: true,
      backup_required: true
    });
    expect(planned.plan?.steps).toHaveLength(8);
    expect(
      planned.plan?.steps.every(
        (step) =>
          step.from_schema_version === "0.2.0" &&
          step.to_schema_version === "0.3.0" &&
          step.input_sha256.length === 64 &&
          step.output_sha256.length === 64 &&
          !step.reversible
      )
    ).toBe(true);
    await expect(
      access(schemaMigrationPlanPath(root, planned.plan!.plan_id))
    ).resolves.toBeUndefined();

    const applied = await applySchemaMigrationPlan(
      root,
      {
        planId: planned.plan!.plan_id,
        confirm: planned.plan!.plan_id
      },
      {
        now: () => now,
        doctor: async () => healthyDoctor()
      }
    );

    expect(applied).toMatchObject({
      status: "applied",
      execution_performed: true,
      result: {
        status: "applied",
        post_checks: {
          config_validation_ok: true,
          state_integrity_errors: 0,
          doctor_required_checks_ok: true
        }
      }
    });
    expect(applied.result?.backup_id).toMatch(/^BKP-/u);
    await expect(
      access(path.join(root, applied.result!.backup_manifest_path!))
    ).resolves.toBeUndefined();
    for (const fileName of configFileNames) {
      const config = await readJsonFile<Record<string, unknown>>(
        configPath(root, fileName)
      );
      expect(config.schema_version).toBe(currentConfigSchemaVersion);
    }

    const repeated = await applySchemaMigrationPlan(
      root,
      {
        planId: planned.plan!.plan_id,
        confirm: planned.plan!.plan_id
      },
      { doctor: async () => healthyDoctor() }
    );
    expect(repeated).toMatchObject({
      status: "already_applied",
      execution_performed: false
    });
  });

  it("blocks unknown newer and corrupt config without creating a plan", async () => {
    const newerRoot = await createLegacyProject("0.2.0");
    const project = await readJsonFile<Record<string, unknown>>(
      configPath(newerRoot, "project.json")
    );
    project.schema_version = "9.0.0";
    await writeJsonFileAtomic(configPath(newerRoot, "project.json"), project);

    expect(inspectConfigSchemaVersion("project.json", "9.0.0")).toBe(
      "unsupported_newer"
    );
    await expect(createSchemaMigrationPlan(newerRoot)).resolves.toMatchObject({
      status: "blocked",
      reason: "unsupported_newer:project.json",
      execution_performed: false
    });
    const validation = await validateAllConfigs(newerRoot);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("newer than supported");

    const corruptRoot = await createLegacyProject("0.2.0");
    await writeFile(configPath(corruptRoot, "agents.json"), "{broken", "utf8");
    await expect(createSchemaMigrationPlan(corruptRoot)).resolves.toMatchObject({
      status: "blocked",
      reason: "config_unreadable:agents.json"
    });
  });

  it("blocks runtime activity, backup failure, and plan input drift before writes", async () => {
    const runtimeRoot = await createLegacyProject("0.2.0");
    const runtimePlan = await createSchemaMigrationPlan(runtimeRoot);
    await acquireRuntimeLock(runtimeRoot);
    try {
      await expect(
        applySchemaMigrationPlan(runtimeRoot, {
          planId: runtimePlan.plan!.plan_id,
          confirm: runtimePlan.plan!.plan_id
        })
      ).resolves.toMatchObject({
        status: "blocked",
        reason: "runtime_must_be_stopped",
        execution_performed: false
      });
    } finally {
      await releaseRuntimeLock(runtimeRoot);
    }

    const backupRoot = await createLegacyProject("0.2.0");
    const backupPlan = await createSchemaMigrationPlan(backupRoot);
    await expect(
      applySchemaMigrationPlan(
        backupRoot,
        {
          planId: backupPlan.plan!.plan_id,
          confirm: backupPlan.plan!.plan_id
        },
        {
          createBackup: async () => {
            throw new Error("backup unavailable");
          }
        }
      )
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "pre_migration_backup_failed",
      execution_performed: false
    });
    expect(
      (
        await readJsonFile<Record<string, unknown>>(
          configPath(backupRoot, "project.json")
        )
      ).schema_version
    ).toBe("0.2.0");

    const driftRoot = await createLegacyProject("0.2.0");
    const driftPlan = await createSchemaMigrationPlan(driftRoot);
    const schedule = await readJsonFile<Record<string, unknown>>(
      configPath(driftRoot, "schedule.json")
    );
    schedule.timezone = "UTC";
    await writeJsonFileAtomic(configPath(driftRoot, "schedule.json"), schedule);
    await expect(
      applySchemaMigrationPlan(driftRoot, {
        planId: driftPlan.plan!.plan_id,
        confirm: driftPlan.plan!.plan_id
      })
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "migration_input_digest_drift:schedule.json",
      execution_performed: false
    });
  });

  it("leaves an explicit restore marker when a post-check fails", async () => {
    const root = await createLegacyProject("0.2.0");
    const planned = await createSchemaMigrationPlan(root, {
      now: () => new Date("2026-07-26T08:00:00.000Z")
    });
    const applied = await applySchemaMigrationPlan(
      root,
      {
        planId: planned.plan!.plan_id,
        confirm: planned.plan!.plan_id
      },
      {
        now: () => new Date("2026-07-26T08:01:00.000Z"),
        validateConfigs: async () => ({
          ok: false,
          errors: ["forced post-check failure"],
          warnings: []
        }),
        doctor: async () => healthyDoctor()
      }
    );

    expect(applied).toMatchObject({
      status: "failed",
      reason: "post_migration_config_validation_failed",
      execution_performed: true
    });
    const marker = await readJsonFile<Record<string, unknown>>(
      schemaMigrationMarkerPath(root)
    );
    expect(marker).toMatchObject({
      status: "failed",
      plan_id: planned.plan!.plan_id,
      backup_id: applied.result!.backup_id
    });
    expect(String(marker.restore_command)).toContain(
      `kairon state backup restore ${applied.result!.backup_id}`
    );
  });

  it("rejects an unknown newer canonical state record", async () => {
    const root = await createLegacyProject("0.3.0");
    const taskPath = path.join(
      root,
      ".kairon",
      "tasks",
      "TASK-NEWER",
      "task.json"
    );
    await writeJsonFileAtomic(taskPath, {
      schema_version: "9.0.0",
      id: "TASK-NEWER"
    });

    const integrity = await checkStateIntegrity(root);
    expect(integrity.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "unsupported_schema_version",
          path: ".kairon/tasks/TASK-NEWER/task.json"
        })
      ])
    );
  });
});

async function createLegacyProject(schemaVersion: string): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  for (const fileName of configFileNames) {
    const filePath = configPath(root, fileName);
    const config = await readJsonFile<Record<string, unknown>>(filePath);
    config.schema_version = schemaVersion;
    await writeJsonFileAtomic(filePath, config);
  }
  return root;
}

function configPath(root: string, fileName: string): string {
  return path.join(root, ".kairon", "config", fileName);
}

function healthyDoctor() {
  return {
    ok: true,
    checks: [
      {
        id: "config.validation",
        title: "Config validation",
        status: "pass" as const,
        details: ["all config files are valid"]
      },
      {
        id: "workflow.config",
        title: "Workflow runtime config",
        status: "pass" as const,
        details: ["schema_version=0.3.0"]
      }
    ],
    summary: { pass: 2, warning: 0, error: 0 }
  };
}
