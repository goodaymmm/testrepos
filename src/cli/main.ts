#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { agentCliIdHint } from "../agents/display.js";
import { KAIRON_VERSION } from "../index.js";
import {
  compactAgentSessionCommand,
  listAgentSessionsCommand,
  resumeAgentCommand,
  resetAgentSessionCommand,
  rotateAgentSessionCommand,
  runAgentSmokeCommand,
  showAgentHealthCommand,
  showAgentSessionBudgetCommand,
  suspendAgentCommand,
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
  evaluateCapabilityCommand,
  explainCapabilityCommand
} from "./commands/capability.js";
import {
  exportBoard,
  formatBoardServeResult,
  issueBoardAccessCommand,
  revokeBoardAccessCommand,
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
  getDiscordHttpStatusCommand,
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
  deployStatusCommand,
  mergeExecuteCommand,
  mergeDryRunCommand
} from "./commands/deploy.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  createGitPrCommand,
  listGitPrCandidatesCommand,
  showGitPrCandidateCommand
} from "./commands/git-pr.js";
import { mergeGitPrCommand } from "../git/pr-merge.js";
import { initializeProject } from "./commands/init.js";
import {
  acknowledgeIncidentCommand,
  bundleIncidentCommand,
  listIncidentsCommand,
  recoverIncidentCommand,
  resolveIncidentCommand,
  showIncidentCommand
} from "./commands/incident.js";
import { closeActiveWork } from "./commands/leave.js";
import { runMaintenance } from "./commands/maintenance.js";
import { runMigrations } from "./commands/migrate.js";
import {
  buildRagVectorCommand,
  compactRagIndexCommand,
  evaluateRagCommand,
  queryRagIndexCommand,
  rebuildRagIndexCommand,
  refreshRagIndexCommand,
  statusRagProviderCommand,
  statsRagIndexCommand,
  statusRagIndexCommand,
  verifyRagIndexCommand
} from "./commands/rag.js";
import {
  readinessCheckCommand,
  readinessManifestCommand,
  readinessReportCommand
} from "./commands/readiness.js";
import {
  doctorProjectsCommand,
  listProjectsCommand,
  registerProjectCommand,
  showProjectCommand,
  unregisterProjectCommand
} from "./commands/projects.js";
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
  releaseGitHubPlanCommand,
  releaseGitHubPublishCommand,
  releaseGitHubVerifyCommand,
  releaseManifestCommand,
  releaseNotesCommand,
  releasePackCommand,
  releaseVerifyCommand,
  validateRelease
} from "./commands/release.js";
import { runReviewLoopCommand } from "./commands/review.js";
import { startRuntime } from "./commands/start.js";
import {
  stateBackupCreateCommand,
  stateBackupRehearseCommand,
  stateBackupRestoreCommand,
  stateBackupVerifyCommand,
  stateCheckCommand,
  stateEventsCompactCommand,
  stateEventsVerifyCommand,
  stateSnapshotCommand,
  stateSnapshotRestoreCommand
} from "./commands/state.js";
import { getStatusText } from "./commands/status.js";
import { stopRuntime } from "./commands/stop.js";
import {
  supportBundleCommand,
  supportVerifyCommand
} from "./commands/support.js";
import {
  collectOption,
  createTaskCommand,
  runTaskCommand
} from "./commands/task.js";
import {
  updateApplyCommand,
  updateChannelSetCommand,
  updateChannelShowCommand,
  updateCheckCommand,
  updateDownloadCommand,
  updateRollbackCommand
} from "./commands/update.js";
import {
  generateOperationTestCommandsCommand,
  generateOperationTestDocsCommand
} from "./commands/test-commands.js";
import { summarizeOperationTestsCommand } from "./commands/test-summary.js";
import {
  workflowCancelCommand,
  workflowCheckpointRebuildCommand,
  workflowCheckpointStatusCommand,
  workflowCheckpointVerifyCommand,
  workflowCompensateCommand,
  workflowConfigProposeCommand,
  workflowConfigShowCommand,
  workflowListCommand,
  workflowPauseCommand,
  workflowRecoverCommand,
  workflowResumeCommand,
  workflowRetryCommand,
  workflowRunCommand,
  workflowShowCommand,
  workflowValidateCommand
} from "./commands/workflow.js";
import {
  watchdogCheckCommand,
  watchdogListCommand,
  watchdogResolveCommand,
  watchdogShowCommand
} from "./commands/watchdog.js";

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

  const projects = program
    .command("projects")
    .description("Register and inspect multiple Kairon projects read-only.");

  projects
    .command("register")
    .description("Register a Kairon project in the user-local registry.")
    .argument("<root>", "Kairon project root.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (root: string, options: { format?: string }) => {
      console.log(await registerProjectCommand(root, options));
    });

  projects
    .command("unregister")
    .description("Remove a project from the user-local registry.")
    .argument("<projectId>", "Registered project id.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (projectId: string, options: { format?: string }) => {
      console.log(await unregisterProjectCommand(projectId, options));
    });

  projects
    .command("list")
    .description("List registered Kairon projects.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { format?: string }) => {
      console.log(await listProjectsCommand(options));
    });

  projects
    .command("show")
    .description("Show one registered Kairon project.")
    .argument("<projectId>", "Registered project id.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (projectId: string, options: { format?: string }) => {
      console.log(await showProjectCommand(projectId, options));
    });

  projects
    .command("doctor")
    .description("Diagnose registered projects without mutating project state.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { format?: string }) => {
      console.log(await doctorProjectsCommand(options));
    });

  const capability = program
    .command("capability")
    .description("Evaluate effective Agent and connector capabilities.");

  capability
    .command("evaluate")
    .description("Evaluate the effective capability decision for a task.")
    .requiredOption("--task <taskId>", "Task id, for example TASK-0001.")
    .option("--agent <agent>", "Evaluate a specific agent.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options) => {
      console.log(await evaluateCapabilityCommand(process.cwd(), options));
    });

  capability
    .command("explain")
    .description("Explain requested, supported, allowed, and approved capabilities.")
    .requiredOption("--task <taskId>", "Task id, for example TASK-0001.")
    .option("--agent <agent>", "Explain a specific agent.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options) => {
      console.log(await explainCapabilityCommand(process.cwd(), options));
    });

  const support = program
    .command("support")
    .description("Create and verify local sanitized incident support bundles.");

  support
    .command("bundle")
    .description("Plan or create one local-only sanitized support ZIP.")
    .option("--dry-run", "Show the allowlist, exclusions, and estimated size without writing files.")
    .option("--output <directory>", "Output directory for the finalized ZIP.")
    .action(async (options: { dryRun?: boolean; output?: string }) => {
      console.log(await supportBundleCommand(process.cwd(), options));
    });

  support
    .command("verify")
    .description("Verify support ZIP paths, hashes, manifest, and secret scan.")
    .argument("<bundle>", "Path to a kairon-support-SUP-*.zip file.")
    .action(async (bundlePath: string) => {
      console.log(await supportVerifyCommand(bundlePath));
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

  agent
    .command("health")
    .description("Show provider policy health for configured agents.")
    .option("--agent <agent>", `Agent id: ${agentCliIdHint()}.`)
    .action(async (options: { agent?: string }) => {
      console.log(await showAgentHealthCommand(process.cwd(), options));
    });

  agent
    .command("suspend")
    .description("Suspend one provider from dispatch with an audited reason.")
    .requiredOption("--agent <agent>", `Agent id: ${agentCliIdHint()}.`)
    .requiredOption("--reason <reason>", "Audited suspension reason.")
    .action(async (options: { agent?: string; reason?: string }) => {
      console.log(await suspendAgentCommand(process.cwd(), options));
    });

  agent
    .command("resume")
    .description("Resume one provider after an operator verifies recovery.")
    .requiredOption("--agent <agent>", `Agent id: ${agentCliIdHint()}.`)
    .requiredOption("--reason <reason>", "Audited resume reason.")
    .action(async (options: { agent?: string; reason?: string }) => {
      console.log(await resumeAgentCommand(process.cwd(), options));
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

  agentSession
    .command("budget")
    .description("Show observed and estimated context budget for one session.")
    .argument("<agent>", `Agent id: ${agentCliIdHint()}.`)
    .option("--date <date>", "Session date in YYYY-MM-DD form. Defaults to today.")
    .action(async (agentId: string, options: { date?: string }) => {
      console.log(
        await showAgentSessionBudgetCommand(process.cwd(), agentId, options)
      );
    });

  agentSession
    .command("compact")
    .description("Plan or confirm a bounded session context compaction.")
    .argument("<agent>", `Agent id: ${agentCliIdHint()}.`)
    .option("--date <date>", "Session date in YYYY-MM-DD form. Defaults to today.")
    .option("--dry-run", "Create a compaction plan without compacting the session.")
    .option("--confirm <planId>", "Execute only when this value matches the plan id.")
    .action(
      async (
        agentId: string,
        options: { date?: string; dryRun?: boolean; confirm?: string }
      ) => {
        console.log(
          await compactAgentSessionCommand(process.cwd(), agentId, options)
        );
      }
    );

  agentSession
    .command("rotate")
    .description("Rotate one idle session with a sanitized handoff.")
    .argument("<agent>", `Agent id: ${agentCliIdHint()}.`)
    .option("--date <date>", "Session date in YYYY-MM-DD form. Defaults to today.")
    .requiredOption("--reason <text>", "Audited operator reason for rotation.")
    .action(
      async (
        agentId: string,
        options: { date?: string; reason?: string }
      ) => {
        console.log(
          await rotateAgentSessionCommand(process.cwd(), agentId, options)
        );
      }
    );

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

  const incident = program
    .command("incident")
    .description("Inspect incidents and run guarded assisted recovery.");

  incident
    .command("list")
    .description("List incident artifacts.")
    .option("--status <status>", "all, open, acknowledged, recovering, or resolved.", "all")
    .action(async (options: { status?: string }) => {
      console.log(await listIncidentsCommand(process.cwd(), options));
    });

  incident
    .command("show")
    .description("Show one incident and its append-only timeline.")
    .argument("<incident-id>", "Incident id, for example INC-0001.")
    .action(async (incidentId: string) => {
      console.log(await showIncidentCommand(process.cwd(), incidentId));
    });

  incident
    .command("acknowledge")
    .description("Record operator acknowledgement without resolving health conditions.")
    .argument("<incident-id>", "Incident id, for example INC-0001.")
    .requiredOption("--reason <reason>", "Audited acknowledgement reason.")
    .action(async (incidentId: string, options: { reason?: string }) => {
      console.log(await acknowledgeIncidentCommand(process.cwd(), incidentId, options));
    });

  incident
    .command("bundle")
    .description("Plan or create an incident-scoped sanitized support bundle.")
    .argument("<incident-id>", "Incident id, for example INC-0001.")
    .option("--dry-run", "Show the incident-scoped bundle plan without creating a ZIP.")
    .option("--output <directory>", "Output directory for the finalized ZIP.")
    .action(
      async (
        incidentId: string,
        options: { dryRun?: boolean; output?: string }
      ) => {
        console.log(await bundleIncidentCommand(process.cwd(), incidentId, options));
      }
    );

  incident
    .command("recover")
    .description("Plan or execute approval-gated assisted recovery.")
    .argument("<incident-id>", "Incident id, for example INC-0001.")
    .option("--dry-run", "Create a recovery plan and approval request.")
    .option("--approval-id <approval-id>", "Approved incident recovery approval id.")
    .option("--confirm <plan-id>", "Exact recovery plan id confirmation.")
    .action(
      async (
        incidentId: string,
        options: {
          dryRun?: boolean;
          approvalId?: string;
          confirm?: string;
        }
      ) => {
        console.log(await recoverIncidentCommand(process.cwd(), incidentId, options));
      }
    );

  incident
    .command("resolve")
    .description("Resolve an incident after all active conditions are cleared.")
    .argument("<incident-id>", "Incident id, for example INC-0001.")
    .requiredOption("--reason <reason>", "Audited resolution reason.")
    .action(async (incidentId: string, options: { reason?: string }) => {
      console.log(await resolveIncidentCommand(process.cwd(), incidentId, options));
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
    .option(
      "--profile <profile>",
      "Board profile: loopback or remote-readonly. Defaults to configured profile."
    )
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
      profile?: string;
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

  const boardAccess = board
    .command("access")
    .description("Issue and revoke short-lived remote Board access.");

  boardAccess
    .command("issue")
    .description("Issue a short-lived Board Bearer token. The raw token is shown once.")
    .option("--ttl-minutes <minutes>", "Token lifetime in minutes. Defaults to 15.")
    .action(async (options: { ttlMinutes?: string }) => {
      console.log(await issueBoardAccessCommand(process.cwd(), options));
    });

  boardAccess
    .command("revoke")
    .description("Revoke a previously issued Board access token.")
    .argument("<access-id>", "Board access id returned by board access issue.")
    .action(async (accessId: string) => {
      console.log(await revokeBoardAccessCommand(process.cwd(), accessId));
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
    .description("Serve and inspect Discord HTTP Interactions endpoints.");

  discordHttp
    .command("start")
    .description("Start a loopback-bound Discord HTTP Interactions endpoint.")
    .option(
      "--profile <profile>",
      "HTTP profile: loopback or reverse-proxy. Defaults to notifications config."
    )
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
      profile?: string;
      host?: string;
      port?: string;
      timestampToleranceSeconds?: string;
      replayTtlSeconds?: string;
      maxSeconds?: string;
    }) => {
      if (
        options.profile !== undefined &&
        options.profile !== "loopback" &&
        options.profile !== "reverse-proxy"
      ) {
        throw new Error(`Invalid Discord HTTP profile: ${options.profile}`);
      }
      const maxSeconds = parseOptionalPositiveInteger(options.maxSeconds, "--max-seconds");
      const server = await startDiscordHttpCommand(process.cwd(), {
        ...options,
        profile: options.profile
      });
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

  discordHttp
    .command("status")
    .description("Show the latest Discord HTTP Interactions status artifact.")
    .action(async () => {
      console.log(await getDiscordHttpStatusCommand(process.cwd()));
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

  const watchdog = program
    .command("watchdog")
    .description("Detect, inspect, and resolve deduplicated runtime alerts.");

  watchdog
    .command("check")
    .description("Evaluate runtime watchdog rules and persist alert transitions.")
    .action(async () => {
      console.log(await watchdogCheckCommand(process.cwd()));
    });

  watchdog
    .command("list")
    .description("List persisted watchdog alerts.")
    .option("--status <status>", "Filter by open, acknowledged, or resolved.")
    .action(async (options: { status?: string }) => {
      console.log(await watchdogListCommand(process.cwd(), options));
    });

  watchdog
    .command("show <alert-id>")
    .description("Show one sanitized watchdog alert.")
    .action(async (alertId: string) => {
      console.log(await watchdogShowCommand(process.cwd(), alertId));
    });

  watchdog
    .command("resolve <alert-id>")
    .description("Resolve one watchdog alert with an operator reason.")
    .requiredOption("--reason <text>", "Resolution reason.")
    .action(async (alertId: string, options: { reason: string }) => {
      console.log(await watchdogResolveCommand(process.cwd(), alertId, options.reason));
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

  const stateBackup = state
    .command("backup")
    .description("Create, verify, rehearse, and restore deterministic state backups.");

  stateBackup
    .command("create")
    .description("Plan or create a manifest-based backup of canonical Kairon state.")
    .option("--dry-run", "List included and excluded paths without writing a backup.")
    .option("--output <path>", "Parent directory for the backup package.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (options: { dryRun?: boolean; output?: string; format?: string }) => {
      console.log(await stateBackupCreateCommand(process.cwd(), options));
    });

  stateBackup
    .command("verify")
    .description("Verify a backup manifest, payload set, sizes, and checksums.")
    .argument("<backup-id>", "Backup id, for example BKP-20260715000000000-abcdef123456")
    .option("--source <path>", "Backup package path when the local registry is unavailable.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (backupId: string, options: { source?: string; format?: string }) => {
      console.log(await stateBackupVerifyCommand(process.cwd(), backupId, options));
    });

  stateBackup
    .command("rehearse")
    .description("Extract and validate a backup in an isolated temporary project.")
    .argument("<backup-id>", "Backup id, for example BKP-20260715000000000-abcdef123456")
    .option("--source <path>", "Backup package path when the local registry is unavailable.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (backupId: string, options: { source?: string; format?: string }) => {
      console.log(await stateBackupRehearseCommand(process.cwd(), backupId, options));
    });

  stateBackup
    .command("restore")
    .description("Restore a verified backup with an exact confirmation and rollback snapshot.")
    .argument("<backup-id>", "Backup id, for example BKP-20260715000000000-abcdef123456")
    .requiredOption("--confirm <backupId>", "Restore only when this value matches backup-id.")
    .option("--source <path>", "Backup package path when the local registry is unavailable.")
    .option("--format <format>", "Output format: text or json.", "text")
    .action(async (
      backupId: string,
      options: { confirm?: string; source?: string; format?: string }
    ) => {
      console.log(await stateBackupRestoreCommand(process.cwd(), backupId, options));
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

  gitPr
    .command("merge")
    .description("Dry-run or execute an approved GitHub PR merge from a PR candidate.")
    .argument("<candidate-id>", "PR candidate id, for example GTX-0001")
    .option("--dry-run", "Validate live GitHub merge conditions without merging. This is the default.")
    .option("--execute", "Merge after approval, follow-up, live checks, and exact confirmation.")
    .requiredOption("--follow-up-id <followUpId>", "Approved merge follow-up bound to this candidate.")
    .option("--confirm <candidateId>", "Execute only when this value exactly matches candidate-id.")
    .option("--repository <owner/repo>", "GitHub repository. Must match the PR creation artifact.")
    .option("--method <method>", "Merge method: merge, squash, or rebase.", "squash")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (candidateId: string, options) => {
      console.log(await mergeGitPrCommand(process.cwd(), candidateId, options));
    });

  const merge = program
    .command("merge")
    .description("Prepare merge approvals without executing a merge.");

  merge
    .command("dry-run")
    .description("Create a high-risk approval artifact for a planned merge.")
    .requiredOption("--source <branch>", "Source branch to merge later.")
    .requiredOption("--target <branch>", "Target branch for the planned merge.")
    .option("--candidate-id <candidateId>", "Git PR candidate id bound to this approval.")
    .option("--commit-range <range>", "Commit range reviewed for this dry-run.")
    .option("--check <check>", "Check summary as name:status[:detail]. Repeatable.", collectOption, [])
    .option("--rollback-hint <hint>", "Operator rollback hint recorded in the artifact.")
    .option("--reason <reason>", "Reason shown on the approval.")
    .action(async (options: {
      source?: string;
      target?: string;
      candidateId?: string;
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
    .description("Prepare, execute, and inspect guarded deploy provider operations.");

  deploy
    .command("dry-run")
    .description("Create a high-risk approval artifact for a planned deploy.")
    .requiredOption("--target <branch>", "Branch or release ref planned for deployment.")
    .option("--environment <name>", "Deployment environment.", "local-sandbox")
    .option("--provider <name>", "Allowed deploy provider.", "local-sandbox")
    .option("--commit-range <range>", "Commit range reviewed for this dry-run.")
    .option("--check <check>", "Check summary as name:status[:detail]. Repeatable.", collectOption, [])
    .option("--rollback-hint <hint>", "Operator rollback hint recorded in the artifact.")
    .option("--reason <reason>", "Reason shown on the approval.")
    .action(async (options: {
      target?: string;
      environment?: string;
      provider?: string;
      commitRange?: string;
      check?: string[];
      rollbackHint?: string;
      reason?: string;
    }) => {
      console.log(await deployDryRunCommand(process.cwd(), options));
    });

  deploy
    .command("execute")
    .description("Preflight or execute an approved deploy through an allowed provider.")
    .requiredOption("--dry-run-artifact <idOrPath>", "Dry-run artifact approval id or JSON path.")
    .option("--preflight", "Show execution guardrails without executing. This is the default.")
    .option("--execute", "Execute once after all deploy guardrails pass.")
    .option("--provider <name>", "Provider bound to the dry-run artifact.")
    .option("--expected-head-sha <sha>", "Expected current target branch head SHA.")
    .option("--actual-head-sha <sha>", "Observed target branch head SHA for deterministic checks.")
    .option("--required-check <name>", "Dry-run check name that must be passed. Repeatable.", collectOption, [])
    .option("--approval-id <approvalId>", "Approved dry-run approval id.")
    .option("--confirm <dryRunId>", "Exact dry-run id required for provider execution.")
    .action(async (options: {
      dryRunArtifact?: string;
      preflight?: boolean;
      execute?: boolean;
      provider?: string;
      expectedHeadSha?: string;
      actualHeadSha?: string;
      requiredCheck?: string[];
      approvalId?: string;
      confirm?: string;
    }) => {
      console.log(await deployExecuteCommand(process.cwd(), options));
    });

  deploy
    .command("status")
    .description("Reconcile and show a deploy provider execution.")
    .argument("<executionId>", "Deploy execution id, for example DEP-0001.")
    .action(async (executionId: string) => {
      console.log(await deployStatusCommand(process.cwd(), executionId));
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
    .description("Run and inspect persistent Kairon workflows.");

  const workflowConfig = workflow
    .command("config")
    .description("Inspect and propose production workflow runtime configuration.");

  workflowConfig
    .command("show")
    .description("Show configured and effective workflow runtime enablement.")
    .action(async () => {
      console.log(await workflowConfigShowCommand(process.cwd()));
    });

  workflowConfig
    .command("propose")
    .description("Create a runtime.json workflow config proposal.")
    .option("--enable", "Enable production workflow after proposal apply and restart.")
    .option("--disable", "Disable production workflow after proposal apply and restart.")
    .action(async (options: { enable?: boolean; disable?: boolean }) => {
      console.log(await workflowConfigProposeCommand(process.cwd(), options));
    });

  const workflowCheckpoint = workflow
    .command("checkpoint")
    .description("Inspect, verify, and rebuild the workflow checkpoint mirror.");

  workflowCheckpoint
    .command("status")
    .description("Show canonical file and optional SQLite checkpoint health.")
    .action(async () => {
      console.log(await workflowCheckpointStatusCommand(process.cwd()));
    });

  workflowCheckpoint
    .command("verify")
    .description("Compare canonical checkpoint files with the configured mirror.")
    .action(async () => {
      console.log(await workflowCheckpointVerifyCommand(process.cwd()));
    });

  workflowCheckpoint
    .command("rebuild")
    .description("Plan or execute an exact-confirm SQLite checkpoint rebuild.")
    .option("--dry-run", "Create a rebuild plan from canonical checkpoint files.")
    .option("--confirm <rebuildId>", "Execute the exact rebuild plan id.")
    .action(async (options: { dryRun?: boolean; confirm?: string }) => {
      console.log(
        await workflowCheckpointRebuildCommand(process.cwd(), options)
      );
    });

  workflow
    .command("validate")
    .description("Validate a declarative workflow definition without executing it.")
    .argument("<definitionFile>", "Workflow definition JSON file.")
    .action(async (definitionFile: string) => {
      console.log(await workflowValidateCommand(process.cwd(), definitionFile));
    });

  workflow
    .command("list")
    .description("List persistent workflows with progress and blockers.")
    .action(async () => {
      console.log(await workflowListCommand(process.cwd()));
    });

  workflow
    .command("run")
    .description("Run a production workflow or an experimental candidate.")
    .argument("[workflowId]", "Production workflow id, for example WF-0001.")
    .option("--candidate", "Run the production-candidate workflow adapter.")
    .option("--definition <file>", "Run a validated declarative workflow definition.")
    .option("--dry-run", "Write only experimental candidate artifacts. This is the default.")
    .option("--connect-queue", "Enqueue an approved candidate task behind the workflow feature flag.")
    .option("--workflow-id <workflowId>", "Workflow id. Defaults to EXP-WF-CANDIDATE-<timestamp>.")
    .option("--task-id <taskId>", "Optional task id to read as a placeholder.")
    .option("--queue-item-id <queueItemId>", "Optional queue item id to read without claiming.")
    .option("--approval-id <approvalId>", "Optional approval id to read as a gate.")
    .option("--objective <objective>", "Candidate evaluation objective.")
    .option("--resource-lock <key>", "Exclusive workflow resource key. Repeatable.", collectOption, [])
    .option("--retry-max-attempts <count>", "Maximum task dispatch attempts.")
    .option("--retry-backoff-seconds <seconds>", "Retry policy backoff metadata.")
    .action(async (workflowId: string | undefined, options: {
      candidate?: boolean;
      dryRun?: boolean;
      connectQueue?: boolean;
      definition?: string;
      workflowId?: string;
      taskId?: string;
      queueItemId?: string;
      approvalId?: string;
      objective?: string;
      resourceLock?: string[];
      retryMaxAttempts?: string;
      retryBackoffSeconds?: string;
    }) => {
      console.log(
        await workflowRunCommand(process.cwd(), {
          ...options,
          workflowId: workflowId ?? options.workflowId
        })
      );
    });

  workflow
    .command("compensate")
    .description("Plan or execute approved workflow compensation.")
    .argument("<workflowId>", "Workflow id.")
    .option("--dry-run", "Create or inspect a compensation plan without dispatch.")
    .option("--approval-id <approvalId>", "Approved compensation decision.")
    .option("--confirm <planId>", "Exact compensation plan id confirmation.")
    .action(async (
      workflowId: string,
      options: {
        dryRun?: boolean;
        approvalId?: string;
        confirm?: string;
      }
    ) => {
      console.log(
        await workflowCompensateCommand(process.cwd(), workflowId, options)
      );
    });

  workflow
    .command("show")
    .description("Show the persistent state of a production or legacy workflow.")
    .argument("<workflowId>", "Workflow id.")
    .action(async (workflowId: string) => {
      console.log(await workflowShowCommand(process.cwd(), workflowId));
    });

  workflow
    .command("recover")
    .description("Reconcile workflow state with approval and queue artifacts.")
    .argument("<workflowId>", "Workflow id.")
    .option("--dry-run", "Preview recovery without writing or dispatching.")
    .action(async (workflowId: string, options: { dryRun?: boolean }) => {
      console.log(
        await workflowRecoverCommand(process.cwd(), workflowId, options)
      );
    });

  workflow
    .command("pause")
    .description("Pause new workflow node dispatch without killing a running process.")
    .argument("<workflowId>", "Workflow id.")
    .requiredOption("--reason <text>", "Reason recorded in the control event.")
    .action(async (workflowId: string, options: { reason: string }) => {
      console.log(
        await workflowPauseCommand(process.cwd(), workflowId, options.reason)
      );
    });

  workflow
    .command("resume")
    .description("Resume dispatch for a paused workflow.")
    .argument("<workflowId>", "Workflow id.")
    .action(async (workflowId: string) => {
      console.log(await workflowResumeCommand(process.cwd(), workflowId));
    });

  workflow
    .command("cancel")
    .description("Cooperatively cancel a workflow using an approved decision.")
    .argument("<workflowId>", "Workflow id.")
    .requiredOption("--reason <text>", "Reason recorded in the control event.")
    .option(
      "--approval-id <approvalId>",
      "Approved control decision; defaults to the workflow approval."
    )
    .action(async (
      workflowId: string,
      options: { reason: string; approvalId?: string }
    ) => {
      console.log(await workflowCancelCommand(process.cwd(), workflowId, options));
    });

  workflow
    .command("retry")
    .description("Retry one failed workflow node with a new idempotency key.")
    .argument("<workflowId>", "Workflow id.")
    .requiredOption("--node <nodeId>", "Failed workflow node id.")
    .option("--reason <text>", "Optional retry reason recorded in the event.")
    .action(async (
      workflowId: string,
      options: { node: string; reason?: string }
    ) => {
      console.log(await workflowRetryCommand(process.cwd(), workflowId, options));
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

  const readiness = program
    .command("readiness")
    .description("Create evidence manifests and evaluate Beta release readiness.");

  readiness
    .command("manifest")
    .description("Create a checksummed readiness evidence manifest.")
    .requiredOption(
      "--evidence <gate=path>",
      "Evidence mapping in GATE_ID=path form. Repeatable.",
      collectOption,
      []
    )
    .option("--output <path>", "Manifest output path.")
    .action(async (options: { evidence?: string[]; output?: string }) => {
      console.log(await readinessManifestCommand(process.cwd(), options));
    });

  readiness
    .command("check")
    .description("Evaluate required Beta gates without writing a report.")
    .option("--manifest <path>", "Readiness evidence manifest path.")
    .action(async (options: { manifest?: string }) => {
      const result = await readinessCheckCommand(process.cwd(), options);
      console.log(result.text);
      if (!result.ready) {
        process.exitCode = 1;
      }
    });

  readiness
    .command("report")
    .description("Evaluate Beta gates and write a JSON or Markdown report.")
    .option("--manifest <path>", "Readiness evidence manifest path.")
    .option("--format <format>", "Output format: json or markdown.", "markdown")
    .option("--output <path>", "Report output path.")
    .action(async (options: {
      manifest?: string;
      format?: string;
      output?: string;
    }) => {
      const result = await readinessReportCommand(process.cwd(), options);
      console.log(result.text);
      if (!result.ready) {
        process.exitCode = 1;
      }
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

  const update = program
    .command("update")
    .description("Check, download, apply, and roll back verified Kairon releases.");

  const updateChannel = update
    .command("channel")
    .description("Inspect or configure the manual update channel.");

  updateChannel
    .command("show")
    .description("Show the configured update channel without changing state.")
    .action(async () => {
      console.log(await updateChannelShowCommand(process.cwd()));
    });

  updateChannel
    .command("set")
    .description("Plan or write a stable, beta, or pinned update channel.")
    .argument("<channel>", "stable, beta, or pinned")
    .requiredOption("--repository <owner/repo>", "GitHub release repository.")
    .option("--base-branch <branch>", "Release source branch. Defaults to main.")
    .option("--version <version>", "Required version for the pinned channel.")
    .option("--dry-run", "Preview the channel change. This is the default.")
    .option("--write", "Write the channel config after exact confirmation.")
    .option("--confirm <value>", "Exact channel confirmation, such as beta or pinned@0.2.0.")
    .action(async (channel: string, options: {
      repository?: string;
      baseBranch?: string;
      version?: string;
      dryRun?: boolean;
      write?: boolean;
      confirm?: string;
    }) => {
      console.log(await updateChannelSetCommand(process.cwd(), channel, options));
    });

  update
    .command("check")
    .description("Inspect verified releases without changing the filesystem.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (options: { tokenEnv?: string }) => {
      console.log(await updateCheckCommand(
        process.cwd(),
        KAIRON_VERSION,
        options
      ));
    });

  update
    .command("download")
    .description("Download and verify one release into the user-local cache.")
    .argument("<version>", "Core semantic version to download.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (version: string, options: { tokenEnv?: string }) => {
      console.log(await updateDownloadCommand(process.cwd(), version, options));
    });

  update
    .command("apply")
    .description("Apply one verified download through the local beta PowerShell lifecycle.")
    .argument("<download-id>", "Verified update download id.")
    .requiredOption("--confirm <download-id>", "Exact download id confirmation.")
    .option("--dry-run", "Verify and preview without launching the update lifecycle.")
    .option("--timeout-ms <milliseconds>", "Update lifecycle timeout. Defaults to 900000.")
    .action(async (downloadId: string, options: {
      confirm?: string;
      dryRun?: boolean;
      timeoutMs?: string;
    }) => {
      console.log(await updateApplyCommand(process.cwd(), KAIRON_VERSION, downloadId, {
        confirm: options.confirm,
        dryRun: options.dryRun,
        timeoutMs: parseOptionalPositiveInteger(options.timeoutMs, "--timeout-ms")
      }));
    });

  update
    .command("rollback")
    .description("Roll back to a previously verified cached release.")
    .requiredOption("--to <version>", "Verified cached target version.")
    .requiredOption("--confirm <version>", "Exact target version confirmation.")
    .option("--dry-run", "Verify and preview without launching the update lifecycle.")
    .option("--timeout-ms <milliseconds>", "Rollback lifecycle timeout. Defaults to 900000.")
    .action(async (options: {
      to: string;
      confirm?: string;
      dryRun?: boolean;
      timeoutMs?: string;
    }) => {
      console.log(await updateRollbackCommand(process.cwd(), KAIRON_VERSION, options.to, {
        confirm: options.confirm,
        dryRun: options.dryRun,
        timeoutMs: parseOptionalPositiveInteger(options.timeoutMs, "--timeout-ms")
      }));
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
    .command("pack")
    .description("Build a checksummed private local beta tarball.")
    .option("--output <path>", "Output directory. Defaults to release-artifacts/<version>.")
    .action(async (options: { output?: string }) => {
      console.log(await releasePackCommand(process.cwd(), options));
    });

  release
    .command("verify")
    .description("Verify a local beta tarball and its checksum manifest.")
    .argument("<package>", "Path to the local beta .tgz package.")
    .option("--manifest <path>", "Checksum manifest path. Defaults to <package>.sha256.json.")
    .option("--release-manifest <path>", "Release manifest path for source and artifact binding verification.")
    .action(async (packageFile: string, options: {
      manifest?: string;
      releaseManifest?: string;
    }) => {
      const result = await releaseVerifyCommand(packageFile, options);
      console.log(result.text);
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  release
    .command("manifest")
    .description("Create a release manifest bound to clean source and a verified package.")
    .requiredOption("--package <path>", "Path to the verified local beta .tgz package.")
    .requiredOption("--manifest <path>", "Path to the package checksum manifest.")
    .option("--output <path>", "Output path. Defaults to release-manifest.json beside the package.")
    .action(async (options: {
      package?: string;
      manifest?: string;
      output?: string;
    }) => {
      console.log(await releaseManifestCommand(process.cwd(), options));
    });

  const releaseGitHub = release
    .command("github")
    .description("Plan, publish, and verify an approval-gated GitHub Release.");

  releaseGitHub
    .command("plan")
    .description("Create an approval-bound GitHub Release publication plan.")
    .requiredOption("--version <version>", "Release version, for example 0.2.0.")
    .requiredOption("--repository <owner/repo>", "Target GitHub repository.")
    .option("--base-branch <branch>", "Remote release source branch. Defaults to main.")
    .option("--artifact-dir <path>", "Local release artifact directory.")
    .option("--stable", "Plan a stable release. The default is prerelease.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (options: {
      version: string;
      repository: string;
      baseBranch?: string;
      artifactDir?: string;
      stable?: boolean;
      tokenEnv?: string;
    }) => {
      console.log(await releaseGitHubPlanCommand(process.cwd(), options));
    });

  releaseGitHub
    .command("publish")
    .description("Publish one approved GitHub Release plan.")
    .argument("<plan-id>", "GitHub Release plan id.")
    .requiredOption("--approval-id <id>", "Approval bound to the plan.")
    .requiredOption("--confirm <plan-id>", "Exact plan id confirmation.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (planId: string, options: {
      approvalId: string;
      confirm: string;
      tokenEnv?: string;
    }) => {
      console.log(await releaseGitHubPublishCommand(process.cwd(), planId, options));
    });

  releaseGitHub
    .command("verify")
    .description("Verify the remote tag, release state, and downloaded asset hashes.")
    .requiredOption("--version <version>", "Release version, for example 0.2.0.")
    .requiredOption("--repository <owner/repo>", "Target GitHub repository.")
    .option("--base-branch <branch>", "Remote release source branch. Defaults to main.")
    .option("--artifact-dir <path>", "Local release artifact directory.")
    .option("--stable", "Verify a stable release. The default is prerelease.")
    .option("--token-env <envName>", "Token environment variable. Defaults to GH_TOKEN then GITHUB_TOKEN.")
    .action(async (options: {
      version: string;
      repository: string;
      baseBranch?: string;
      artifactDir?: string;
      stable?: boolean;
      tokenEnv?: string;
    }) => {
      console.log(await releaseGitHubVerifyCommand(process.cwd(), options));
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

  const ragProvider = rag
    .command("provider")
    .description("Inspect local RAG embedding provider capabilities.");

  ragProvider
    .command("status")
    .description("Show local-only vector provider readiness.")
    .action(async () => {
      console.log(await statusRagProviderCommand(process.cwd()));
    });

  const ragVector = rag
    .command("vector")
    .description("Plan or execute a local vector index build.");

  ragVector
    .command("build")
    .description("Build the local vector index with explicit confirmation.")
    .option("--dry-run", "Plan the vector build without replacing the index.")
    .option("--execute", "Execute a previously planned vector build.")
    .option("--confirm <buildId>", "Exact build id from the dry-run plan.")
    .action(async (options: {
      dryRun?: boolean;
      execute?: boolean;
      confirm?: string;
    }) => {
      console.log(await buildRagVectorCommand(process.cwd(), options));
    });

  rag
    .command("verify")
    .description("Verify the RAG index manifest, references, and source freshness.")
    .action(async () => {
      console.log(await verifyRagIndexCommand(process.cwd()));
    });

  rag
    .command("stats")
    .description("Show RAG duplicate, context budget, rebuild, and retention statistics.")
    .option("--duplicates", "Include duplicate statistics (enabled by default).")
    .option("--context-budget", "Include context budget statistics (enabled by default).")
    .action(async () => {
      console.log(await statsRagIndexCommand(process.cwd()));
    });

  rag
    .command("rebuild")
    .description("Plan or execute a verified full RAG index rebuild.")
    .option("--dry-run", "Build and compare a candidate without replacing the index.")
    .option("--compare", "Compare configured query samples.")
    .option("--execute", "Execute a previously planned rebuild.")
    .option("--confirm <rebuildId>", "Exact rebuild id from the dry-run plan.")
    .action(async (options: {
      dryRun?: boolean;
      compare?: boolean;
      execute?: boolean;
      confirm?: string;
    }) => {
      console.log(await rebuildRagIndexCommand(process.cwd(), options));
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
    .option("--mode <mode>", "Retrieval mode: lexical, vector, or hybrid.")
    .option("--explain", "Show lexical scoring and source freshness details.")
    .action(async (query: string, options) => {
      console.log(await queryRagIndexCommand(process.cwd(), query, options));
    });

  rag
    .command("evaluate")
    .description("Evaluate representative RAG queries without golden answer text.")
    .option("--profile <profile>", "Evaluation profile name. Defaults to default.", "default")
    .action(async (options: { profile: string }) => {
      console.log(await evaluateRagCommand(process.cwd(), options.profile));
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
