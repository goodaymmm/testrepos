#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { KAIRON_VERSION } from "../index.js";
import { initializeProject } from "./commands/init.js";
import { closeActiveWork } from "./commands/leave.js";
import { runMaintenance } from "./commands/maintenance.js";
import { runMigrations } from "./commands/migrate.js";
import { startRuntime } from "./commands/start.js";
import { getStatusText } from "./commands/status.js";
import { stopRuntime } from "./commands/stop.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("kairon")
    .description("Local AI-human symbiosis runtime for project orchestration.")
    .version(KAIRON_VERSION);

  program
    .command("init")
    .description("Create .kairon configuration and state directories.")
    .action(async () => {
      const result = await initializeProject({ projectRoot: process.cwd() });
      console.log(
        `Initialized Kairon with ${result.createdDirectories.length} directories and ${result.writtenFiles.length} files.`
      );

      if (result.gitignoreSuggestionNeeded) {
        console.log("Add `.kairon/` to .gitignore before committing.");
      }
    });

  program
    .command("migrate")
    .description("Migrate existing .kairon configuration to the current schema.")
    .option("--dry-run", "Show planned migrations without writing files")
    .action(async (options: { dryRun?: boolean }) => {
      console.log(await runMigrations(process.cwd(), { dryRun: options.dryRun }));
    });

  program
    .command("doctor")
    .description("Check whether Kairon can run in this project.")
    .action(() => {
      console.log("kairon doctor is not implemented yet.");
    });

  program
    .command("start")
    .description("Start the Kairon runtime.")
    .action(async () => {
      console.log(await startRuntime(process.cwd()));
    });

  program
    .command("stop")
    .description("Stop the Kairon runtime.")
    .action(async () => {
      console.log(await stopRuntime(process.cwd()));
    });

  program
    .command("status")
    .description("Show runtime, queue, session, and approval status.")
    .action(async () => {
      console.log(await getStatusText(process.cwd()));
    });

  const task = program.command("task").description("Manage Kairon tasks.");

  task
    .command("create")
    .description("Create a task.")
    .option("--title <title>", "Task title")
    .option("--persona <persona>", "Requested persona")
    .action(() => {
      console.log("kairon task create is not implemented yet.");
    });

  task
    .command("run")
    .description("Queue a task run.")
    .argument("<taskId>", "Task id, for example TASK-0001")
    .action(() => {
      console.log("kairon task run is not implemented yet.");
    });

  program
    .command("leave")
    .description("Close today's Active Work and switch to standby behavior.")
    .action(async () => {
      console.log(await closeActiveWork(process.cwd()));
    });

  const maintenance = program
    .command("maintenance")
    .description("Run maintenance workflows.");

  maintenance
    .command("run")
    .description("Run daily maintenance manually.")
    .action(async () => {
      console.log(await runMaintenance(process.cwd()));
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

export type RealpathResolver = (filePath: string) => string;

export function isCliEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined,
  realpath: RealpathResolver = realpathSync.native
): boolean {
  if (argvPath === undefined) {
    return false;
  }

  try {
    return samePath(
      realpath(fileURLToPath(importMetaUrl)),
      realpath(path.resolve(argvPath))
    );
  } catch {
    return importMetaUrl === pathToFileURL(path.resolve(argvPath)).href;
  }
}

const isEntrypoint = isCliEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  await main();
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
}
