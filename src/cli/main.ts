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
  listApprovalFollowUpsCommand,
  listApprovalsCommand,
  runApprovalFollowUpCommand,
  seedApprovalCommand,
  showApprovalFollowUpCommand,
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
  planCleanupRetentionCommand,
  showCleanupCommand
} from "./commands/cleanup.js";
import { applyConfig, proposeConfig } from "./commands/config.js";
import { analyzeDocking } from "./commands/docking.js";
import {
  formatDiscordHttpServerResult,
  startDiscordHttpCommand
} from "./commands/discord.js";
import {
  daemonCertifyCommand,
  daemonReportCommand,
  daemonTaskCommand
} from "./commands/daemon.js";
import {
  deployExecuteCommand,
  deployDryRunCommand,
  mergeExecuteCommand,
  mergeDryRunCommand
} from "./commands/deploy.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  createGitPrCommand,
  listGitPrCandidatesCommand,
  showGitPrCandidateCommand
} from "./commands/git-pr.js";
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
  formatReleaseValidation,
  releaseBumpCommand,
  releaseCheckCommand,
  releaseNotesCommand,
  validateRelease
} from "./commands/release.js";
import { runReviewLoopCommand } from "./commands/review.js";
import { startRuntime } from "./commands/start.js";
import {
  stateCheckCommand,
  stateEventsCompactCommand,
  stateEventsVerifyCommand,
  stateSnapshotCommand,
  stateSnapshotRestoreCommand
} from "./commands/state.js";
import { getStatusText } from "./commands/status.js";
import { stopRuntime } from "./commands/stop.js";
import {
  collectOption,
  createTaskCommand,
  runTaskCommand
} from "./commands/task.js";
import {
  generateOperationTestCommandsCommand,
  generateOperationTestDocsCommand
} from "./commands/test-commands.js";
import { summarizeOperationTestsCommand } from "./commands/test-summary.js";
import { workflowRunCommand } from "./commands/workflow.js";

export type StateSnapshotRestoreCliOptions = {
  dryRun?: boolean;
  confirm?: string;
  format?: string;
};

export function resolveStateSnapshotRestoreCliOptions(
  restoreOptions: StateSnapshotRestoreCliOptions,
  snapshotOptions: Pick<StateSnapshotRestoreCliOptions, "dryRun" | "format">
): StateSnapshotRestoreCliOptions {
  return {
    dryRun: restoreOptions.dryRun ?? snapshotOptions.dryRun,
    confirm: restoreOptions.confirm,
    format: restoreOptions.format ?? snapshotOptions.format
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("kairon")
    .description("Local AI-human symbiosis runtime for project orchestration.")
    .version(KAIRON_VERSION)
    .enablePositionalOptions();

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
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { format?: string }) => {
      console.log(await runDoctorCommand(process.cwd(), options));
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

  const approvalFollowUp = approval
    .command("follow-up")
    .description("Inspect and explicitly run approval follow-up artifacts.");

  approvalFollowUp
    .command("list")
    .description("List approval follow-up artifacts.")
    .option("--status <status>", "Optional follow-up status filter.")
    .action(async (options: { status?: string }) => {
      console.log(await listApprovalFollowUpsCommand(process.cwd(), options));
    });

  approvalFollowUp
    .command("show")
    .description("Show one sanitized approval follow-up artifact.")
    .argument("<follow-up-id>", "Follow-up id, for example FUP-APR-0001-approve-git-resume_push")
    .action(async (followUpId: string) => {
      console.log(await showApprovalFollowUpCommand(process.cwd(), followUpId));
    });

  approvalFollowUp
    .command("run")
    .description("Dry-run or explicitly execute one approval follow-up.")
    .argument("<follow-up-id>", "Follow-up id to run")
    .option("--dry-run", "Show the executor, readiness, and next action without writing state.")
    .option("--confirm <followUpId>", "Execute only when this value matches follow-up-id.")
    .action(
      async (
        followUpId: string,
        options: { dryRun?: boolean; confirm?: string }
      ) => {
        console.log(
          await runApprovalFollowUpCommand(process.cwd(), followUpId, options)
        );
      }
    );

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
    .option(
      "--require-token",
      "Require a generated short-lived read-only Bearer token."
    )
    .option(
      "--access-token-ttl-seconds <seconds>",
      "Require a Bearer token with this lifetime. Defaults to 900 seconds."
    )
    .option("--max-seconds <seconds>", "Stop the board server automatically after this many seconds.")
    .action(async (options: {
      host?: string;
      port?: string;
      recent?: string;
      requireToken?: boolean;
      accessTokenTtlSeconds?: string;
      maxSeconds?: string;
    }) => {
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

  const cleanupRetention = cleanup
    .command("retention")
    .description("Plan retention moves for local runtime artifacts.");

  cleanupRetention
    .command("plan")
    .description("Inspect retention limits without deleting artifacts.")
    .option("--dry-run", "Show candidates without writing a proposal. This is the default.")
    .option("--write-proposal", "Write the retention proposal for operator review.")
    .action(async (options: { dryRun?: boolean; writeProposal?: boolean }) => {
      console.log(await planCleanupRetentionCommand(process.cwd(), options));
    });

  const discord = program
    .command("discord")
    .description("Run Discord integration helpers.");

  const discordHttp = discord
    .command("http")
    .description("Serve Discord HTTP Interactions over local loopback.");

  discordHttp
    .command("start")
    .description("Start a loopback-only Discord HTTP Interactions endpoint.")
    .option("--host <host>", "Loopback host. Defaults to 127.0.0.1.")
    .option("--port <port>", "Loopback port. Defaults to 18777.")
    .option(
      "--timestamp-tolerance-seconds <seconds>",
      "Maximum Discord signature timestamp drift. Defaults to 300 seconds."
    )
    .option(
      "--replay-ttl-seconds <seconds>",
      "Reject duplicate signed requests during this window. Defaults to 300 seconds."
    )
    .option("--max-seconds <seconds>", "Stop the HTTP server automatically after this many seconds.")
    .action(async (options: {
      host?: string;
      port?: string;
      timestampToleranceSeconds?: string;
      replayTtlSeconds?: string;
      maxSeconds?: string;
    }) => {
      const maxSeconds = parseOptionalPositiveInteger(options.maxSeconds, "--max-seconds");
      const server = await startDiscordHttpCommand(process.cwd(), options);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        void server.stop();
      };

      console.log(formatDiscordHttpServerResult(server));
      if (server.status !== "ready") {
        return;
      }

      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
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

  const daemon = program
    .command("daemon")
    .description("Inspect Kairon daemon evidence and long-run operation reports.");

  daemon
    .command("report")
    .description("Generate a daemon long-run evidence report.")
    .option("--since <duration>", "Lookback window such as 24h, 7d, or an ISO timestamp.", "24h")
    .option("--format <format>", "Report format: markdown or json.", "markdown")
    .option("--output <path>", "Write the report to a file instead of stdout.")
    .option("--heartbeat-gap-ms <ms>", "Heartbeat gap threshold in milliseconds.")
    .action(async (options: {
      since?: string;
      format?: string;
      output?: string;
      heartbeatGapMs?: string;
    }) => {
      console.log(await daemonReportCommand(process.cwd(), options));
    });

  daemon
    .command("certify")
    .description("Certify daemon soak evidence against explicit long-run thresholds.")
    .option("--since <duration>", "Certification window such as 24h or an ISO timestamp.", "24h")
    .option("--format <format>", "Certification format: markdown or json.", "markdown")
    .option("--output <path>", "Write the certification artifact to a file instead of stdout.")
    .option("--expected-interval-ms <ms>", "Expected daemon tick interval in milliseconds.", "60000")
    .option("--max-heartbeat-gap-ms <ms>", "Maximum heartbeat gap in milliseconds.")
    .option("--max-restart-gap-ms <ms>", "Maximum allowed scheduled restart or reboot gap.")
    .option("--max-fatal-errors <count>", "Maximum allowed fatal error count.", "0")
    .option("--minimum-ticks <count>", "Minimum tick count; defaults to 90% of the expected count.")
    .action(async (options: {
      since?: string;
      format?: string;
      output?: string;
      expectedIntervalMs?: string;
      maxHeartbeatGapMs?: string;
      maxRestartGapMs?: string;
      maxFatalErrors?: string;
      minimumTicks?: string;
    }) => {
      console.log(await daemonCertifyCommand(process.cwd(), options));
    });

  const daemonTask = daemon
    .command("task")
    .description("Manage the Windows Task Scheduler daemon registration.");

  daemonTask
    .command("status")
    .description("Show the Windows daemon task status; a missing task is successful.")
    .option("--task-name <name>", "Task Scheduler task name.", "Kairon Runtime")
    .option("--project-root <path>", "Target Kairon project root.")
    .action(async (options: { taskName?: string; projectRoot?: string }) => {
      console.log(await daemonTaskCommand(process.cwd(), "status", options));
    });

  daemonTask
    .command("install")
    .description("Install the Windows daemon task or preview it with --dry-run.")
    .option("--task-name <name>", "Task Scheduler task name.", "Kairon Runtime")
    .option("--project-root <path>", "Target Kairon project root.")
    .option("--kairon-command <command>", "Kairon executable name or path.", "kairon")
    .option("--interval-ms <ms>", "Daemon tick interval in milliseconds.", "60000")
    .option("--log-root <path>", "Daemon log directory.")
    .option("--at-startup", "Use an OS startup trigger instead of a logon trigger.")
    .option("--dry-run", "Show the registration plan without changing Task Scheduler.")
    .action(async (options: {
      taskName?: string;
      projectRoot?: string;
      kaironCommand?: string;
      intervalMs?: string;
      logRoot?: string;
      atStartup?: boolean;
      dryRun?: boolean;
    }) => {
      console.log(await daemonTaskCommand(process.cwd(), "install", options));
    });

  daemonTask
    .command("uninstall")
    .description("Uninstall the Windows daemon task or preview it with --dry-run.")
    .option("--task-name <name>", "Task Scheduler task name.", "Kairon Runtime")
    .option("--project-root <path>", "Target Kairon project root.")
    .option("--dry-run", "Show the removal plan without changing Task Scheduler.")
    .action(async (options: {
      taskName?: string;
      projectRoot?: string;
      dryRun?: boolean;
    }) => {
      console.log(await daemonTaskCommand(process.cwd(), "uninstall", options));
    });

  daemonTask
    .command("restart")
    .description("Stop Kairon and restart the registered Windows daemon task.")
    .option("--task-name <name>", "Task Scheduler task name.", "Kairon Runtime")
    .option("--project-root <path>", "Target Kairon project root.")
    .option("--kairon-command <command>", "Kairon executable name or path.", "kairon")
    .action(async (options: {
      taskName?: string;
      projectRoot?: string;
      kaironCommand?: string;
    }) => {
      console.log(await daemonTaskCommand(process.cwd(), "restart", options));
    });

  const state = program
    .command("state")
    .description("Inspect Kairon file-based state integrity and snapshot targets.");

  state
    .command("check")
    .description("Check .kairon file-based state integrity.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { format?: string }) => {
      console.log(await stateCheckCommand(process.cwd(), options));
    });

  const stateSnapshot = state
    .command("snapshot")
    .description("Create state snapshots and safely plan or execute restores.")
    .option("--dry-run", "List snapshot targets without writing a snapshot.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { dryRun?: boolean; format?: string }) => {
      console.log(await stateSnapshotCommand(process.cwd(), options));
    });

  stateSnapshot
    .command("restore")
    .description("Plan or restore one state snapshot with explicit confirmation.")
    .argument("<snapshot-id>", "Snapshot id, for example SNP-20260712000000000")
    .option("--dry-run", "Show add, update, and delete candidates without writing state.")
    .option("--confirm <snapshotId>", "Restore only when this value matches snapshot-id.")
    .option("--format <format>", "Output format: text or json.")
    .action(
      async (
        snapshotId: string,
        options: StateSnapshotRestoreCliOptions
      ) => {
        console.log(
          await stateSnapshotRestoreCommand(
            process.cwd(),
            snapshotId,
            resolveStateSnapshotRestoreCliOptions(options, stateSnapshot.opts())
          )
        );
      }
    );

  const stateEvents = state
    .command("events")
    .description("Plan, execute, and verify event log checkpoints and archives.");

  stateEvents
    .command("compact")
    .description("Plan or execute compaction for closed daily event segments.")
    .option("--dry-run", "Show the checkpoint and archive plan without changing state.")
    .option("--confirm <checkpointId>", "Compact only when this value matches the planned checkpoint id.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { dryRun?: boolean; confirm?: string; format?: string }) => {
      console.log(await stateEventsCompactCommand(process.cwd(), options));
    });

  stateEvents
    .command("verify")
    .description("Verify one event checkpoint, archive, and source snapshot.")
    .argument("<checkpoint-id>", "Event checkpoint id, for example ECP-EVT-000001-abcdef123456")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (checkpointId: string, options: { format?: string }) => {
      console.log(await stateEventsVerifyCommand(process.cwd(), checkpointId, options));
    });

  const git = program
    .command("git")
    .description("Inspect and act on Kairon git artifacts.");

  const gitPr = git
    .command("pr")
    .description("Inspect and create pull requests from git transaction PR candidates.");

  gitPr
    .command("list")
    .description("List git transaction PR candidates.")
    .action(async () => {
      console.log(await listGitPrCandidatesCommand(process.cwd()));
    });

  gitPr
    .command("show")
    .description("Show one git transaction PR candidate.")
    .argument("<candidate-id>", "PR candidate id, for example GTX-0001")
    .action(async (candidateId: string) => {
      console.log(await showGitPrCandidateCommand(process.cwd(), candidateId));
    });

  gitPr
    .command("create")
    .description("Dry-run or execute PR creation from a git transaction PR candidate.")
    .argument("<candidate-id>", "PR candidate id, for example GTX-0001")
    .option("--dry-run", "Show the planned PR payload without calling GitHub. This is the default.")
    .option("--execute", "Create the GitHub PR after confirmation, approval, ref, and token checks.")
    .option("--approval-id <approvalId>", "Approved Kairon approval id used with --execute.")
    .option("--follow-up-id <followUpId>", "Ready approval follow-up that authorizes this candidate.")
    .option("--confirm <candidateId>", "Execute only when this value exactly matches candidate-id.")
    .option("--repository <owner/repo>", "GitHub repository. Defaults to the candidate remote.")
    .option("--draft", "Create the GitHub PR as a draft when --execute is used.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (candidateId: string, options) => {
      console.log(await createGitPrCommand(process.cwd(), candidateId, options));
    });

  const merge = program
    .command("merge")
    .description("Prepare merge approvals without executing a merge.");

  merge
    .command("dry-run")
    .description("Create a high-risk approval artifact for a planned merge.")
    .requiredOption("--source <branch>", "Source branch to merge later.")
    .requiredOption("--target <branch>", "Target branch for the planned merge.")
    .option("--commit-range <range>", "Commit range reviewed for this dry-run.")
    .option("--check <check>", "Check summary as name:status[:detail]. Repeatable.", collectOption, [])
    .option("--rollback-hint <hint>", "Operator rollback hint recorded in the artifact.")
    .option("--reason <reason>", "Reason shown on the approval.")
    .action(async (options: {
      source?: string;
      target?: string;
      commitRange?: string;
      check?: string[];
      rollbackHint?: string;
      reason?: string;
    }) => {
      console.log(await mergeDryRunCommand(process.cwd(), options));
    });

  merge
    .command("execute")
    .description("Run merge execution preflight. Actual merge execution is intentionally disabled.")
    .requiredOption("--dry-run-artifact <idOrPath>", "Dry-run artifact approval id or JSON path.")
    .option("--preflight", "Show execution guardrails without executing. This is the default.")
    .option("--execute", "Request execution after preflight. Execution is still explicitly disabled.")
    .option("--expected-head-sha <sha>", "Expected current target branch head SHA.")
    .option("--actual-head-sha <sha>", "Observed target branch head SHA for deterministic checks.")
    .option("--required-check <name>", "Dry-run check name that must be passed. Repeatable.", collectOption, [])
    .option("--approval-id <approvalId>", "Approved dry-run approval id.")
    .option("--confirm <phrase>", "Local confirmation phrase for later execution modes.")
    .action(async (options: {
      dryRunArtifact?: string;
      preflight?: boolean;
      execute?: boolean;
      expectedHeadSha?: string;
      actualHeadSha?: string;
      requiredCheck?: string[];
      approvalId?: string;
      confirm?: string;
    }) => {
      console.log(await mergeExecuteCommand(process.cwd(), options));
    });

  const deploy = program
    .command("deploy")
    .description("Prepare deploy approvals without executing a deploy.");

  deploy
    .command("dry-run")
    .description("Create a high-risk approval artifact for a planned deploy.")
    .requiredOption("--target <branch>", "Branch or release ref planned for deployment.")
    .option("--environment <name>", "Deployment environment.")
    .option("--commit-range <range>", "Commit range reviewed for this dry-run.")
    .option("--check <check>", "Check summary as name:status[:detail]. Repeatable.", collectOption, [])
    .option("--rollback-hint <hint>", "Operator rollback hint recorded in the artifact.")
    .option("--reason <reason>", "Reason shown on the approval.")
    .action(async (options: {
      target?: string;
      environment?: string;
      commitRange?: string;
      check?: string[];
      rollbackHint?: string;
      reason?: string;
    }) => {
      console.log(await deployDryRunCommand(process.cwd(), options));
    });

  deploy
    .command("execute")
    .description("Run deploy execution preflight. Actual deployment is intentionally disabled.")
    .requiredOption("--dry-run-artifact <idOrPath>", "Dry-run artifact approval id or JSON path.")
    .option("--preflight", "Show execution guardrails without executing. This is the default.")
    .option("--execute", "Request execution after preflight. Execution is still explicitly disabled.")
    .option("--expected-head-sha <sha>", "Expected current target branch head SHA.")
    .option("--actual-head-sha <sha>", "Observed target branch head SHA for deterministic checks.")
    .option("--required-check <name>", "Dry-run check name that must be passed. Repeatable.", collectOption, [])
    .option("--approval-id <approvalId>", "Approved dry-run approval id.")
    .option("--confirm <phrase>", "Local confirmation phrase for later execution modes.")
    .action(async (options: {
      dryRunArtifact?: string;
      preflight?: boolean;
      execute?: boolean;
      expectedHeadSha?: string;
      actualHeadSha?: string;
      requiredCheck?: string[];
      approvalId?: string;
      confirm?: string;
    }) => {
      console.log(await deployExecuteCommand(process.cwd(), options));
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

  const workflow = program
    .command("workflow")
    .description("Evaluate experimental workflow runtime candidates.");

  workflow
    .command("run")
    .description("Run a feature-flagged workflow candidate dry-run or queue connection.")
    .option("--candidate", "Run the production-candidate workflow adapter.")
    .option("--dry-run", "Write only experimental candidate artifacts. This is the default.")
    .option("--connect-queue", "Enqueue an approved candidate task behind the workflow feature flag.")
    .option("--workflow-id <workflowId>", "Workflow id. Defaults to EXP-WF-CANDIDATE-<timestamp>.")
    .option("--task-id <taskId>", "Optional task id to read as a placeholder.")
    .option("--queue-item-id <queueItemId>", "Optional queue item id to read without claiming.")
    .option("--approval-id <approvalId>", "Optional approval id to read as a gate.")
    .option("--objective <objective>", "Candidate evaluation objective.")
    .action(async (options: {
      candidate?: boolean;
      dryRun?: boolean;
      connectQueue?: boolean;
      workflowId?: string;
      taskId?: string;
      queueItemId?: string;
      approvalId?: string;
      objective?: string;
    }) => {
      console.log(await workflowRunCommand(process.cwd(), options));
    });

  const operationTest = program
    .command("test")
    .description("Inspect operation test results.");

  operationTest
    .command("commands")
    .description("Generate PowerShell commands for operation test profiles.")
    .option("--profile <id>", "Operation test command profile id. Repeatable.", collectOption, [])
    .option("--range <range>", "Task range filter, for example T116-T120.")
    .option("--format <format>", "Output format: powershell or json. Defaults to powershell.")
    .action(async (options: {
      profile?: string[];
      range?: string;
      format?: string;
    }) => {
      console.log(generateOperationTestCommandsCommand(options));
    });

  operationTest
    .command("docs")
    .description("Generate operation test list and command documents.")
    .requiredOption("--range <range>", "Task range, for example T130-T143.")
    .option("--output-dir <dir>", "Output directory. Defaults to docs.")
    .option("--name-prefix <prefix>", "Output file prefix. Defaults to the normalized range.")
    .option("--overwrite", "Replace existing generated documents.")
    .option("--dry-run", "Show planned output paths without writing files.")
    .action(async (options: {
      range?: string;
      outputDir?: string;
      namePrefix?: string;
      overwrite?: boolean;
      dryRun?: boolean;
    }) => {
      console.log(await generateOperationTestDocsCommand(process.cwd(), options));
    });

  operationTest
    .command("summarize")
    .description("Summarize operation test logs and optionally apply PASS updates.")
    .argument("[logFile]", "PowerShell transcript, pasted text, summary.md, or summary.json.")
    .option("--result-root <dir>", "Directory containing operation-test-results output.")
    .option("--test-list <path>", "Operation test list Markdown to compare against.")
    .option("--suggest", "Print non-destructive test list update candidates.")
    .option("--json", "Print JSON output.")
    .option("--patch-preview", "Print non-destructive Markdown row replacement previews.")
    .option("--apply-pass", "Apply only PASS update candidates to the test list with a backup.")
    .action(async (logFile: string | undefined, options: {
      resultRoot?: string;
      testList?: string;
      suggest?: boolean;
      json?: boolean;
      patchPreview?: boolean;
      applyPass?: boolean;
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
    .command("validate")
    .description("Validate synchronized versions and required release documentation.")
    .action(async () => {
      const result = await validateRelease(process.cwd());
      console.log(formatReleaseValidation(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  release
    .command("notes")
    .description("Draft or append release notes from commit summaries.")
    .requiredOption("--since <ref>", "Git ref used as the lower bound, for example v0.1.0.")
    .option("--dry-run", "Show the append preview without writing files. This is the default.")
    .option("--write", "Append the generated notes under the Unreleased marker.")
    .action(async (options: { since?: string; dryRun?: boolean; write?: boolean }) => {
      console.log(await releaseNotesCommand(process.cwd(), options));
    });

  release
    .command("bump")
    .description("Plan or apply a synchronized package and CLI version bump.")
    .option("--type <type>", "major, minor, or patch.")
    .option("--version <version>", "Explicit next semantic version, for example 0.2.0.")
    .option("--dry-run", "Show planned changes without writing files. This is the default.")
    .option("--write", "Apply the version bump to package.json and src/index.ts.")
    .action(async (options: {
      type?: string;
      version?: string;
      dryRun?: boolean;
      write?: boolean;
    }) => {
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
    .option("--explain", "Show lexical scoring and source freshness details.")
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
