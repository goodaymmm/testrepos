#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { KAIRON_VERSION } from "../index.js";
import { initializeProject } from "./commands/init.js";
import { closeActiveWork } from "./commands/leave.js";
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
    .action(() => {
      console.log("kairon maintenance run is not implemented yet.");
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  await main();
}
