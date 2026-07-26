import {
  formatMigrationResult,
  migrateConfigs
} from "../../core/config/migrate-config.js";
import {
  applySchemaMigrationPlan,
  createSchemaMigrationPlan,
  formatMigrationApplyCommandResult,
  formatMigrationPlanCommandResult
} from "../../migration/migration-plan.js";

export type MigrateCommandOptions = {
  dryRun?: boolean;
};

export async function runMigrations(
  projectRoot: string,
  options: MigrateCommandOptions = {}
): Promise<string> {
  const result = await migrateConfigs({
    projectRoot,
    dryRun: options.dryRun
  });

  return formatMigrationResult(result);
}

export async function planSchemaMigrationCommand(
  projectRoot: string
): Promise<string> {
  const result = await createSchemaMigrationPlan(projectRoot);
  return formatMigrationPlanCommandResult(projectRoot, result);
}

export async function applySchemaMigrationCommand(
  projectRoot: string,
  planId: string,
  options: { confirm?: string }
): Promise<string> {
  const result = await applySchemaMigrationPlan(projectRoot, {
    planId,
    confirm: options.confirm
  });
  return formatMigrationApplyCommandResult(result);
}
