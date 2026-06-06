#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { agentCliIdHint } from "../agents/display.js";
import { KAIRON_VERSION } from "../index.js";
import { runAgentSmokeCommand } from "./commands/agent.js";
import {
  decideApprovalCommand,
  listApprovalsCommand,
  seedApprovalCommand,
  showApprovalCommand
} from "./commands/approval.js";
import { exportBoard } from "./commands/board.js";
import { applyConfig, proposeConfig } from "./commands/config.js";
import { analyzeDocking } from "./commands/docking.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { initializeProject } from "./commands/init.js";
import { closeActiveWork } from "./commands/leave.js";
import { runMaintenance } from "./commands/maintenance.js";
import { runMigrations } from "./commands/migrate.js";
import { runRecovery } from "./commands/recovery.js";
import { runReviewLoopCommand } from "./commands/review.js";
import { startRuntime } from "./commands/start.js";
import { getStatusText } from "./commands/status.js";
import { stopRuntime } from "./commands/stop.js";
import {
  collectOption,
  createTaskCommand,
  runTaskCommand
} from "./commands/task.js";

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
    .action(async () => {
      console.log(await runDoctorCommand(process.cwd()));
    });

  const agent = program
    .command("agent")
    .description("Run and inspect Kairon AI agents.");

  agent
    .command("smoke")
    .description("Run a minimal official CLI smoke check for one agent.")
    .requiredOption("--agent <agent>", `Agent id: ${agentCliIdHint()}.`)
    .option("--timeout-ms <ms>", "CLI execution timeout in milliseconds.")
    .action(async (options: { agent?: string; timeoutMs?: string }) => {
      console.log(await runAgentSmokeCommand(process.cwd(), options));
    });

  const config = program
    .command("config")
    .description("Manage Kairon configuration proposals.");

  config
    .command("propose")
    .description("Analyze this project and save a config proposal.")
    .action(async () => {
      console.log(await proposeConfig(process.cwd()));
    });

  config
    .command("apply")
    .description("Apply a saved config proposal.")
    .argument("<proposal-id>", "Proposal id from kairon config propose.")
    .option("--dry-run", "Show planned changes without writing config.")
    .action(async (proposalId: string, options: { dryRun?: boolean }) => {
      console.log(await applyConfig(process.cwd(), proposalId, options));
    });

  const approval = program
    .command("approval")
    .description("Inspect and decide Kairon approvals.");

  approval
    .command("list")
    .description("List approvals.")
    .option("--status <status>", "Approval status filter. Defaults to pending; use all for every status.")
    .action(async (options: { status?: string }) => {
      console.log(await listApprovalsCommand(process.cwd(), options));
    });

  approval
    .command("show")
    .description("Show a sanitized approval detail.")
    .argument("<approvalId>", "Approval id, for example APR-0001")
    .action(async (approvalId: string) => {
      console.log(await showApprovalCommand(process.cwd(), approvalId));
    });

  approval
    .command("decide")
    .description("Apply an approval decision.")
    .argument("<approvalId>", "Approval id, for example APR-0001")
    .requiredOption("--action <action>", "approve, reject, request_changes, or snooze.")
    .option("--reason <reason>", "Decision reason.")
    .option("--until <iso-date>", "Snooze until this ISO timestamp. Defaults to one hour.")
    .action(async (approvalId: string, options) => {
      console.log(await decideApprovalCommand(process.cwd(), approvalId, options));
    });

  approval
    .command("seed")
    .description("Create a manual approval for operation tests.")
    .argument("<approvalId>", "Approval id, for example APR-MANUAL-0001")
    .option("--type <type>", "Approval type. Defaults to manual_test.")
    .option("--title <title>", "Approval title.")
    .option("--actions <actions>", "Comma- or whitespace-separated actions. Defaults to all approval actions.")
    .option("--task-id <taskId>", "Optional task id to attach to the event.")
    .option("--run-id <runId>", "Optional run id to attach to the event.")
    .option("--redaction-fixture", "Include omitted/redacted fields for display tests.")
    .action(async (approvalId: string, options) => {
      console.log(await seedApprovalCommand(process.cwd(), approvalId, options));
    });

  const board = program
    .command("board")
    .description("Export read-only Kairon board projections.");

  board
    .command("export")
    .description("Export a sanitized board projection JSON file.")
    .option("--output <path>", "Projection output path. Defaults to .kairon/board/projection.json.")
    .option("--recent <count>", "Number of recent items to include per section.")
    .action(async (options: { output?: string; recent?: string }) => {
      console.log(await exportBoard(process.cwd(), options));
    });

  program
    .command("start")
    .description("Start the Kairon runtime.")
    .option("--daemon", "Run continuously until stopped.")
    .option("--interval-ms <ms>", "Daemon tick interval in milliseconds.")
    .option("--max-ticks <count>", "Stop daemon after this many ticks.")
    .option("--max-idle-ticks <count>", "Stop daemon after this many consecutive idle ticks.")
    .action(async (options: {
      daemon?: boolean;
      intervalMs?: string;
      maxTicks?: string;
      maxIdleTicks?: string;
    }) => {
      console.log(
        await startRuntime(process.cwd(), {
          daemon: options.daemon,
          intervalMs: parseOptionalNumber(options.intervalMs),
          maxTicks: parseOptionalNumber(options.maxTicks),
          maxIdleTicks: parseOptionalNumber(options.maxIdleTicks)
        })
      );
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
    .requiredOption("--title <title>", "Task title.")
    .requiredOption("--persona <persona>", "Requested persona.")
    .option("--description <description>", "Task description.")
    .option("--capability <capability>", "Capability hint. Repeatable.", collectOption, [])
    .option("--tag <tag>", "Task tag. Repeatable.", collectOption, [])
    .option("--approval-required", "Mark the task as requiring approval.")
    .option("--code-producing", "Mark the task as code-producing.")
    .option("--commit-requested", "Mark the task as expecting a commit.")
    .option("--priority <priority>", "Queue priority. Higher runs first.")
    .option("--schedule-mode <mode>", "active_work, standby_work, or maintenance.")
    .action(async (options) => {
      console.log(await createTaskCommand(process.cwd(), options));
    });

  task
    .command("run")
    .description("Queue a task run.")
    .argument("<taskId>", "Task id, for example TASK-0001")
    .option("--timeout-ms <ms>", "CLI execution timeout in milliseconds.")
    .option("--worker-id <id>", "Worker id recorded on the queue claim.")
    .option("--no-interactive-agents", "Do not dispatch to interactive-only agents such as Antigravity.")
    .action(async (taskId: string, options) => {
      console.log(await runTaskCommand(process.cwd(), taskId, options));
    });

  const review = program
    .command("review")
    .description("Run and inspect Kairon review loops.");

  const recovery = program
    .command("recovery")
    .description("Run runtime recovery workflows.");

  recovery
    .command("run")
    .description("Scan stale runtime state and recover safe work.")
    .option("--claim-timeout-ms <ms>", "Fallback age for claimed queue items without claim expiry.")
    .option("--runner-stale-ms <ms>", "Age threshold for stale running runner metadata.")
    .option("--heartbeat-stale-ms <ms>", "Age threshold for stale daemon heartbeat.")
    .action(async (options: {
      claimTimeoutMs?: string;
      runnerStaleMs?: string;
      heartbeatStaleMs?: string;
    }) => {
      console.log(await runRecovery(process.cwd(), options));
    });

  review
    .command("run")
    .description("Execute reviewer agents for a review loop.")
    .argument("<loopId>", "Review loop id, for example REV-0001")
    .option("--timeout-ms <ms>", "CLI execution timeout in milliseconds.")
    .action(async (loopId: string, options: { timeoutMs?: string }) => {
      console.log(await runReviewLoopCommand(process.cwd(), loopId, options));
    });

  const docking = program
    .command("docking")
    .description("Analyze and manage Kairon project docking.");

  docking
    .command("analyze")
    .description("Analyze this project and print a project config proposal.")
    .action(async () => {
      process.stdout.write(await analyzeDocking(process.cwd()));
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
    .option(
      "--build-rag",
      "Build the local RAG index even when rag.json disables automatic maintenance indexing."
    )
    .action(async (options: { buildRag?: boolean }) => {
      console.log(
        await runMaintenance(process.cwd(), { buildRag: options.buildRag })
      );
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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
