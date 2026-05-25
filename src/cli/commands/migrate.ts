import {
  formatMigrationResult,
  migrateConfigs
} from "../../core/config/migrate-config.js";

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
