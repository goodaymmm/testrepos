#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { agentCliIdHint } from "../agents/display.js";
import { KAIRON_VERSION } from "../index.js";
import {
  listAgentSessionsCommand,
  resetAgentSessionCommand,
  runAgentSmokeCommand,
  showAgentSessionCommand
} from "./commands/agent.js";
import {
  decideApprovalCommand,
  listApprovalsCommand,
  seedApprovalCommand,
  showApprovalCommand
} from "./commands/approval.js";
import {
  exportBoard,
  formatBoardServeResult,
  serveBoard
} from "./commands/board.js";
import {
  applyCleanupCommand,
  archiveCleanupCommand,
  listCleanupCommand,
  showCleanupCommand
} from "./commands/cleanup.js";
import { applyConfig, proposeConfig } from "./commands/config.js";
import { analyzeDocking } from "./commands/docking.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { initializeProject } from "./commands/init.js";
import { closeActiveWork } from "./commands/leave.js";
import { runMaintenance } from "./commands/maintenance.js";
import { runMigrations } from "./commands/migrate.js";
import {
  compactRagIndexCommand,
  queryRagIndexCommand,
  refreshRagIndexCommand,
  statusRagIndexCommand
} from "./commands/rag.js";
import {
  acknowledgeRecoveryTarget,
  listRecoveryTargets,
  resolveRecoveryTarget,
  runRecovery,
  showRecoveryTarget
} from "./commands/recovery.js";
import {
  releaseBumpCommand,
  releaseCheckCommand,
  releaseNotesCommand
} from "./commands/release.js";
import { runReviewLoopCommand } from "./commands/review.js";
import { startRuntime } from "./commands/start.js";
import { getStatusText } from "./commands/status.js";
import { stopRuntime } from "./commands/stop.js";
import {
  collectOption,
  createTaskCommand,
  runTaskCommand
} from "./commands/task.js";
import { summarizeOperationTestsCommand } from "./commands/test-summary.js";

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

  const agentSession = agent
    .command("session")
    .description("Inspect and safely reset Kairon agent sessions.");

  agentSession
    .command("list")
    .description("List agent sessions for a date.")
    .option("--date <date>", "Session date in YYYY-MM-DD form. Defaults to today.")
    .action(async (options: { date?: string }) => {
      console.log(await listAgentSessionsCommand(process.cwd(), options));
    });

  agentSession
    .command("show")
    .description("Show one agent session.")
    .argument("<agent>", `Agent id: ${agentCliIdHint()}.`)
    .option("--date <date>", "Session date in YYYY-MM-DD form. Defaults to today.")
    .action(async (agentId: string, options: { date?: string }) => {
      console.log(await showAgentSessionCommand(process.cwd(), agentId, options));
    });

  agentSession
    .command("reset")
    .description("Archive one agent session so a fresh session can be created safely.")
    .argument("<agent>", `Agent id: ${agentCliIdHint()}.`)
    .requiredOption("--date <date>", "Session date in YYYY-MM-DD form.")
    .action(async (agentId: string, options: { date?: string }) => {
      console.log(await resetAgentSessionCommand(process.cwd(), agentId, options));
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

  board
    .command("serve")
    .description("Serve a read-only local Kairon board over loopback HTTP.")
    .option("--host <host>", "Loopback host. Defaults to 127.0.0.1.")
    .option("--port <port>", "Loopback port. Defaults to 8787.")
    .option("--recent <count>", "Number of recent items to include per section.")
    .option("--max-seconds <seconds>", "Stop the board server automatically after this many seconds.")
    .action(async (options: { host?: string; port?: string; recent?: string; maxSeconds?: string }) => {
      const server = await serveBoard(process.cwd(), options);
      const maxSeconds = parseOptionalPositiveInteger(options.maxSeconds, "--max-seconds");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        void server.stop();
      };

      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      console.log(formatBoardServeResult(server));
      try {
        if (maxSeconds !== undefined) {
          timer = setTimeout(stop, maxSeconds * 1000);
        }

        await server.waitUntilClosed();
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  const cleanup = program
    .command("cleanup")
    .description("Inspect and apply reviewed cleanup proposals.");

  cleanup
    .command("list")
    .description("List active cleanup proposals.")
    .action(async () => {
      console.log(await listCleanupCommand(process.cwd()));
    });

  cleanup
    .command("show")
    .description("Show cleanup proposal details.")
    .argument("<proposalId>", "Cleanup proposal date, for example 2026-06-01.")
    .action(async (proposalId: string) => {
      console.log(await showCleanupCommand(process.cwd(), proposalId));
    });

  cleanup
    .command("apply")
    .description("Move reviewed cleanup candidates to .kairon/tmp.")
    .argument("<proposalId>", "Cleanup proposal date, for example 2026-06-01.")
    .option("--dry-run", "Show planned moves without changing files.")
    .action(async (proposalId: string, options: { dryRun?: boolean }) => {
      console.log(await applyCleanupCommand(process.cwd(), proposalId, options));
    });

  cleanup
    .command("archive")
    .description("Archive a reviewed cleanup proposal.")
    .argument("<proposalId>", "Cleanup proposal date, for example 2026-06-01.")
    .action(async (proposalId: string) => {
      console.log(await archiveCleanupCommand(process.cwd(), proposalId));
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
    .description("Show runtime, queue, session, approval, and artifact status.")
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

  const operationTest = program
    .command("test")
    .description("Inspect operation test results.");

  operationTest
    .command("summarize")
    .description("Summarize operation test logs or result directories without editing docs.")
    .argument("[logFile]", "PowerShell transcript, pasted text, summary.md, or summary.json.")
    .option("--result-root <dir>", "Directory containing operation-test-results output.")
    .option("--test-list <path>", "Operation test list Markdown to compare against.")
    .option("--suggest", "Print non-destructive test list update candidates.")
    .option("--json", "Print JSON output.")
    .option("--patch-preview", "Print non-destructive Markdown row replacement previews.")
    .action(async (logFile: string | undefined, options: {
      resultRoot?: string;
      testList?: string;
      suggest?: boolean;
      json?: boolean;
      patchPreview?: boolean;
    }) => {
      console.log(
        await summarizeOperationTestsCommand(process.cwd(), logFile, options)
      );
    });

  const review = program
    .command("review")
    .description("Run and inspect Kairon review loops.");

  const recovery = program
    .command("recovery")
    .description("Inspect and resolve runtime recovery targets.");

  recovery
    .command("list")
    .description("List unresolved runtime recovery targets.")
    .action(async () => {
      console.log(await listRecoveryTargets(process.cwd()));
    });

  recovery
    .command("show")
    .description("Show one unresolved runtime recovery target.")
    .argument("<targetId>", "Recovery target id or fingerprint.")
    .action(async (targetId: string) => {
      console.log(await showRecoveryTarget(process.cwd(), targetId));
    });

  recovery
    .command("resolve")
    .description("Mark a runtime recovery target as resolved.")
    .argument("<targetId>", "Recovery target id or fingerprint.")
    .requiredOption("--reason <reason>", "Resolution reason.")
    .action(async (targetId: string, options: { reason?: string }) => {
      console.log(await resolveRecoveryTarget(process.cwd(), targetId, options));
    });

  recovery
    .command("acknowledge")
    .description("Acknowledge a runtime recovery target without applying automatic recovery.")
    .argument("<targetId>", "Recovery target id or fingerprint.")
    .requiredOption("--reason <reason>", "Acknowledgement reason.")
    .action(async (targetId: string, options: { reason?: string }) => {
      console.log(await acknowledgeRecoveryTarget(process.cwd(), targetId, options));
    });

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

  const release = program
    .command("release")
    .description("Prepare release checks, notes, and version bump plans.");

  release
    .command("check")
    .description("Show release readiness checks and recommended commands.")
    .action(async () => {
      console.log(await releaseCheckCommand(process.cwd()));
    });

  release
    .command("notes")
    .description("Draft release notes from commit summaries.")
    .requiredOption("--since <ref>", "Git ref used as the lower bound, for example v0.1.0.")
    .action(async (options: { since?: string }) => {
      console.log(await releaseNotesCommand(process.cwd(), options));
    });

  release
    .command("bump")
    .description("Plan or apply a synchronized package and CLI version bump.")
    .requiredOption("--type <type>", "major, minor, or patch.")
    .option("--dry-run", "Show planned changes without writing files. This is the default.")
    .option("--write", "Apply the version bump to package.json and src/index.ts.")
    .action(async (options: { type?: string; dryRun?: boolean; write?: boolean }) => {
      console.log(await releaseBumpCommand(process.cwd(), options));
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
    .description("Run maintenance workflows and write operator artifacts.");

  maintenance
    .command("run")
    .description("Create daily report, cleanup proposal, recovery artifact, next-day plan, and optional RAG index.")
    .option(
      "--build-rag",
      "Build the local RAG index even when rag.json disables automatic maintenance indexing."
    )
    .action(async (options: { buildRag?: boolean }) => {
      console.log(
        await runMaintenance(process.cwd(), { buildRag: options.buildRag })
      );
    });

  const rag = program
    .command("rag")
    .description("Build, inspect, and query the local RAG index.");

  rag
    .command("refresh")
    .description("Refresh the local RAG index.")
    .option("--since <iso-date>", "Only refresh sources updated at or after this timestamp.")
    .option("--type <type>", "Source type filter, comma- or whitespace-separated.")
    .option("--limit <count>", "Maximum candidate sources to refresh.")
    .option("--prune", "Remove missing, protected, or archived sources from the existing index.")
    .option("--compact", "Also remove stale run/session artifacts while refreshing.")
    .option("--max-artifact-age-days <days>", "Maximum age for run/session artifacts during compact.")
    .action(async (options: {
      since?: string;
      type?: string;
      limit?: string;
      prune?: boolean;
      compact?: boolean;
      maxArtifactAgeDays?: string;
    }) => {
      console.log(await refreshRagIndexCommand(process.cwd(), options));
    });

  rag
    .command("compact")
    .description("Compact the local RAG index without refreshing source content.")
    .option("--max-artifact-age-days <days>", "Maximum age for run/session artifacts during compact.")
    .action(async (options: { maxArtifactAgeDays?: string }) => {
      console.log(await compactRagIndexCommand(process.cwd(), options));
    });

  rag
    .command("status")
    .description("Show local RAG index status.")
    .action(async () => {
      console.log(await statusRagIndexCommand(process.cwd()));
    });

  rag
    .command("query")
    .description("Query the local RAG index.")
    .argument("<query>", "Search query.")
    .option("--type <type>", "Source type filter, comma- or whitespace-separated.")
    .option("--collection <collection>", "Collection filter, comma- or whitespace-separated.")
    .option("--limit <count>", "Maximum matches to return. Defaults to 5.")
    .option("--task-id <taskId>", "Task id filter.")
    .option("--run-id <runId>", "Run id filter.")
    .option("--approval-id <approvalId>", "Approval id filter.")
    .option("--review-id <reviewId>", "Review result id filter.")
    .option("--review-loop-id <reviewLoopId>", "Review loop id filter.")
    .option("--date <date>", "Date filter in YYYY-MM-DD form.")
    .option("--severity <severity>", "Severity filter.")
    .action(async (query: string, options) => {
      console.log(await queryRagIndexCommand(process.cwd(), query, options));
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

function parseOptionalPositiveInteger(
  value: string | undefined,
  optionName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`Invalid ${optionName}: ${value}`);
}
