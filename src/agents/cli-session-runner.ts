import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAgentCliInvocation } from "./cli-invocation.js";
import {
  spawnCommandRunner,
  type CliInvocation,
  type CommandRunner,
  type CommandRunResult
} from "./command-runner.js";
import {
  classificationForSetupRequired,
  classifyCliRunResult,
  type CliRunClassification,
  type CliRunClassificationStatus
} from "./cli-classification.js";
import type { InteractiveSessionRunner } from "./interactive-session-runner.js";
import { ContextBuilder, type ContextBundle } from "./context-builder.js";
import {
  buildDailyBootstrapPrompt,
  buildJobPrompt
} from "./prompt-envelope.js";
import { getAgentAdapter } from "./adapters/index.js";
import {
  FileSessionHost,
  type CommandAvailabilityChecker,
  type SessionMetadata
} from "./session-host.js";
import type { AgentId } from "./types.js";
import {
  beginProviderRun,
  finishProviderRun
} from "./provider-policy.js";
import { extractOutboxFromStdout } from "./stdout-outbox.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  ReviewLoopManager,
  type ReviewLoopState
} from "../review/review-loop-manager.js";
import type { ChangedFile } from "../git/diff-snapshot.js";

export type CliSessionRunStatus = CliRunClassificationStatus;

export type BootstrapAgentSessionRequest = {
  agent: AgentId;
  date: string;
  timeoutMs?: number;
};

export type RunAgentJobRequest = {
  agent: AgentId;
  date: string;
  runId: string;
  taskId: string;
  persona: string;
  timeoutMs?: number;
  capabilities?: string[];
  extraSources?: string[];
  modelClass?: string;
  codeProducing?: boolean;
  commitRequested?: boolean;
  changedFiles?: Array<Pick<ChangedFile, "path" | "status">>;
  tags?: string[];
  unattended?: boolean;
};

export type CliSessionRunRecord = {
  schema_version: string;
  kind: "daily_bootstrap" | "job";
  status: CliSessionRunStatus;
  agent: AgentId;
  date: string;
  session_id: string;
  terminal_id: string;
  run_id?: string;
  task_id?: string;
  persona?: string;
  command: string;
  args: string[];
  command_available: boolean;
  pid: number | null;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  classification?: CliRunClassification;
  failure_reason?: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
  prompt_path: string;
  stdout_log: string;
  stderr_log: string;
  outbox_path?: string;
  context_path: string;
  runner_metadata_path: string;
  review_loop?: Pick<
    ReviewLoopState,
    "loop_id" | "status" | "reviewers" | "integration"
  >;
  created_at: string;
  finished_at: string;
};

type TerminalState = {
  schema_version: string;
  terminal_id: string;
  agent: AgentId;
  session_path: string;
  pid: number | null;
  cwd: string;
  stdin_open: boolean;
  stdout_log: string;
  stderr_log: string;
  status:
    | "ready"
    | "running"
    | "failed"
    | "setup_required"
    | "permission_required"
    | "rate_limited"
    | "usage_limited"
    | "timeout"
    | "no_output";
  updated_at: string;
};

type PathSet = {
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  runnerMetadataPath: string;
  outboxPath?: string;
};

export class CliSessionRunner {
  private readonly sessionHost: FileSessionHost;
  private readonly contextBuilder: ContextBuilder;
  private readonly commandRunner: CommandRunner;
  private readonly interactiveSessionRunner?: InteractiveSessionRunner;
  private readonly now: () => Date;

  constructor(
    private readonly projectRoot: string,
    options: {
      commandAvailability?: CommandAvailabilityChecker;
      commandRunner?: CommandRunner;
      interactiveSessionRunner?: InteractiveSessionRunner;
      now?: () => Date;
    } = {}
  ) {
    this.sessionHost = new FileSessionHost(projectRoot, {
      commandAvailability: options.commandAvailability,
      now: options.now
    });
    this.now = options.now ?? (() => new Date());
    this.contextBuilder = new ContextBuilder(projectRoot);
    this.commandRunner = options.commandRunner ?? spawnCommandRunner;
    this.interactiveSessionRunner = options.interactiveSessionRunner;
  }

  async bootstrapAgentSession(
    request: BootstrapAgentSessionRequest
  ): Promise<CliSessionRunRecord> {
    const session = await this.sessionHost.openSession(request.agent, request.date);
    const bundle = await this.contextBuilder.buildDailyBootstrap({
      agent: request.agent,
      date: request.date
    });
    const sessionDir = resolveInside(
      getKaironPaths(this.projectRoot).sessionsDir,
      request.date,
      request.agent
    );
    const paths: PathSet = {
      promptPath: resolveInside(sessionDir, "bootstrap.stdin.md"),
      stdoutPath: resolveInside(sessionDir, "bootstrap.stdout.log"),
      stderrPath: resolveInside(sessionDir, "bootstrap.stderr.log"),
      runnerMetadataPath: resolveInside(sessionDir, "bootstrap-run.json")
    };
    const prompt = buildDailyBootstrapPrompt({
      agent: request.agent,
      date: request.date,
      contextPath: bundle.context_path
    });

    await writeText(paths.promptPath, prompt);

    if (!session.command_available) {
      const classification = classificationForSetupRequired({
        agent: request.agent,
        reason: "cli_command_missing",
        command: session.command
      });
      const record = await this.writeSetupRequiredRecord({
        kind: "daily_bootstrap",
        session,
        bundle,
        paths,
        stderr: `Kairon setup required: ${session.command} is not available.\n`,
        classification
      });
      await this.recordSessionRun({ session, bundle, paths, record });
      return record;
    }

    if (!getAgentAdapter(request.agent).supports.nonInteractive) {
      const classification = classificationForSetupRequired({
        agent: request.agent,
        reason: "cli_pty_required",
        command: session.command
      });
      const record = await this.writeSetupRequiredRecord({
        kind: "daily_bootstrap",
        session,
        bundle,
        paths,
        stderr: `Kairon setup required: ${session.command} requires an interactive terminal or PTY adapter.\n`,
        classification
      });
      await this.recordSessionRun({ session, bundle, paths, record });
      return record;
    }

    const invocation = buildAgentCliInvocation({
      agent: request.agent,
      command: session.command,
      cwd: this.projectRoot,
      prompt,
      timeoutMs: request.timeoutMs
    });
    const result = await this.commandRunner(invocation);
    const classification = classifyCliRunResult(request.agent, result);

    await writeRunLogs(paths, result);
    await this.writeTerminalState(
      session,
      result,
      terminalStatusFromRunStatus(classification.status)
    );

    const record = this.createRecord({
      kind: "daily_bootstrap",
      session,
      bundle,
      paths,
      result,
      invocation,
      classification,
      status: classification.status
    });
    await writeJsonFileAtomic(paths.runnerMetadataPath, record);
    await this.recordSessionRun({ session, bundle, paths, record });
    return record;
  }

  async runAgentJob(
    request: RunAgentJobRequest
  ): Promise<CliSessionRunRecord> {
    const session =
      (await this.sessionHost.attachSession(request.agent, request.date)) ??
      (await this.sessionHost.openSession(request.agent, request.date));
    const bundle = await this.contextBuilder.buildRunContext({
      runId: request.runId,
      taskId: request.taskId,
      agent: request.agent,
      persona: request.persona,
      date: request.date,
      extraSources: request.extraSources
    });
    const runDir = resolveInside(getKaironPaths(this.projectRoot).runsDir, request.runId);
    const outboxPath = resolveInside(runDir, "outbox.json");
    const paths: PathSet = {
      promptPath: resolveInside(runDir, "stdin.md"),
      stdoutPath: resolveInside(runDir, "stdout.log"),
      stderrPath: resolveInside(runDir, "stderr.log"),
      runnerMetadataPath: resolveInside(runDir, "runner.json"),
      outboxPath
    };
    const prompt = buildJobPrompt({
      agent: request.agent,
      runId: request.runId,
      taskId: request.taskId,
      persona: request.persona,
      contextPath: bundle.context_path,
      expectedOutboxPath: toProjectPath(this.projectRoot, outboxPath),
      contextContent: await readContextContent(this.projectRoot, bundle.context_path),
      capabilities: request.capabilities
    });

    await writeText(paths.promptPath, prompt);
    await this.sessionHost.sendJob(session.session_id, {
      runId: request.runId,
      taskId: request.taskId,
      persona: request.persona,
      contextPath: bundle.context_path,
      expectedOutboxPath: toProjectPath(this.projectRoot, outboxPath)
    });
    await beginProviderRun(this.projectRoot, {
      agent: request.agent,
      date: request.date,
      runId: request.runId,
      unattended: request.unattended !== false,
      now: this.now()
    });
    await this.sessionHost.markRunStarted(request.agent, request.date, {
      kind: "job",
      run_id: request.runId,
      task_id: request.taskId,
      persona: request.persona,
      context_path: bundle.context_path,
      outbox_path: toProjectPath(this.projectRoot, outboxPath),
      prompt_path: toProjectPath(this.projectRoot, paths.promptPath),
      stdout_log: toProjectPath(this.projectRoot, paths.stdoutPath),
      stderr_log: toProjectPath(this.projectRoot, paths.stderrPath),
      runner_metadata_path: toProjectPath(this.projectRoot, paths.runnerMetadataPath),
      status: "running",
      started_at: this.now().toISOString()
    });

    let record: CliSessionRunRecord | undefined;

    try {
      if (!session.command_available) {
        const classification = classificationForSetupRequired({
          agent: request.agent,
          reason: "cli_command_missing",
          command: session.command
        });
        await this.writeClassifiedOutbox({
          request,
          outboxPath,
          classification
        });
        record = await this.writeSetupRequiredRecord({
          kind: "job",
          session,
          bundle,
          paths,
          stderr: `Kairon setup required: ${session.command} is not available.\n`,
          request,
          classification
        });
        return record;
      }

      if (!getAgentAdapter(request.agent).supports.nonInteractive) {
        if (this.interactiveSessionRunner !== undefined) {
          const result = await this.interactiveSessionRunner({
            agent: request.agent,
            command: session.command,
            cwd: this.projectRoot,
            prompt,
            timeoutMs: request.timeoutMs,
            runId: request.runId,
            taskId: request.taskId,
            persona: request.persona,
            outboxPath,
            expectedOutboxPath: toProjectPath(this.projectRoot, outboxPath),
            contextPath: bundle.context_path,
            session
          });
          const classification = classifyAgentJobResult(
            request.agent,
            result,
            request.runId
          );
          if (shouldWriteClassifiedOutbox(classification.status)) {
            await this.writeClassifiedOutbox({
              request,
              outboxPath,
              classification,
              result
            });
            await writeRunLogs(paths, result);
            await this.writeTerminalState(
              session,
              result,
              terminalStatusFromRunStatus(classification.status)
            );
            record = this.createRecord({
              kind: "job",
              session,
              bundle,
              paths,
              result,
              request,
              classification,
              status: classification.status
            });
            await writeJsonFileAtomic(paths.runnerMetadataPath, record);
            return record;
          }

          const outboxStatus = await this.ensureOutbox(
            request,
            outboxPath,
            result,
            classification
          );
          const status =
            outboxStatus.source === "generated_failure"
              ? (outboxStatus.runStatus ?? "failed")
              : (outboxStatus.runStatus ?? classification.status);
          const reviewLoop = await this.maybeStartReviewLoop(request);

          await writeRunLogs(paths, result);
          await this.writeTerminalState(session, result, terminalStatusFromRunStatus(status));
          record = this.createRecord({
            kind: "job",
            session,
            bundle,
            paths,
            result,
            request,
            reviewLoop,
            classification: outboxStatus.classification ?? classification,
            status
          });
          await writeJsonFileAtomic(paths.runnerMetadataPath, record);
          return record;
        }

        const classification = classificationForSetupRequired({
          agent: request.agent,
          reason: "cli_pty_required",
          command: session.command
        });
        await this.writeClassifiedOutbox({
          request,
          outboxPath,
          classification
        });
        record = await this.writeSetupRequiredRecord({
          kind: "job",
          session,
          bundle,
          paths,
          stderr: `Kairon setup required: ${session.command} requires an interactive terminal or PTY adapter.\n`,
          request,
          classification
        });
        return record;
      }

      const invocation = buildAgentCliInvocation({
        agent: request.agent,
        command: session.command,
        cwd: this.projectRoot,
        prompt,
        timeoutMs: request.timeoutMs
      });
      const result = await this.commandRunner(invocation);
      const classification = classifyAgentJobResult(
        request.agent,
        result,
        request.runId
      );
      if (shouldWriteClassifiedOutbox(classification.status)) {
        await this.writeClassifiedOutbox({
          request,
          outboxPath,
          classification,
          result
        });
        await writeRunLogs(paths, result);
        await this.writeTerminalState(
          session,
          result,
          terminalStatusFromRunStatus(classification.status)
        );
        record = this.createRecord({
          kind: "job",
          session,
          bundle,
          paths,
          result,
          invocation,
          request,
          classification,
          status: classification.status
        });
        await writeJsonFileAtomic(paths.runnerMetadataPath, record);
        return record;
      }

      const outboxStatus = await this.ensureOutbox(
        request,
        outboxPath,
        result,
        classification
      );
      const status =
        outboxStatus.source === "generated_failure"
          ? (outboxStatus.runStatus ?? "failed")
          : (outboxStatus.runStatus ?? classification.status);
      const reviewLoop = await this.maybeStartReviewLoop(request);

      await writeRunLogs(paths, result);
      await this.writeTerminalState(session, result, terminalStatusFromRunStatus(status));
      record = this.createRecord({
        kind: "job",
        session,
        bundle,
        paths,
        result,
        invocation,
        request,
        reviewLoop,
        classification: outboxStatus.classification ?? classification,
        status
      });
      await writeJsonFileAtomic(paths.runnerMetadataPath, record);
      return record;
    } finally {
      try {
        await this.sessionHost.markRunFinished(request.agent, request.date, {
          kind: "job",
          run_id: request.runId,
          task_id: request.taskId,
          persona: request.persona,
          context_path: bundle.context_path,
          outbox_path: toProjectPath(this.projectRoot, outboxPath),
          prompt_path: toProjectPath(this.projectRoot, paths.promptPath),
          stdout_log: toProjectPath(this.projectRoot, paths.stdoutPath),
          stderr_log: toProjectPath(this.projectRoot, paths.stderrPath),
          runner_metadata_path: toProjectPath(this.projectRoot, paths.runnerMetadataPath),
          status: record?.status ?? "failed",
          failure_reason: record?.failure_reason,
          setup_action: record?.setup_action,
          resume_hint: record?.resume_hint,
          retry_after: record?.retry_after,
          matched_pattern: record?.matched_pattern,
          started_at: record?.created_at,
          finished_at: record?.finished_at ?? this.now().toISOString()
        });
      } finally {
        await finishProviderRun(this.projectRoot, {
          agent: request.agent,
          date: request.date,
          runId: request.runId,
          status: record?.status ?? "failed",
          reason: record?.failure_reason,
          retryAfter: record?.retry_after,
          now: this.now()
        });
      }
    }
  }

  private async recordSessionRun(input: {
    session: SessionMetadata;
    bundle: ContextBundle;
    paths: PathSet;
    record: CliSessionRunRecord;
  }): Promise<void> {
    await this.sessionHost.recordSessionContext(input.session.agent, input.session.date, {
      kind: input.record.kind,
      run_id: input.record.run_id,
      task_id: input.record.task_id,
      persona: input.record.persona,
      context_path: input.bundle.context_path,
      outbox_path: input.record.outbox_path,
      prompt_path: input.record.prompt_path,
      stdout_log: input.record.stdout_log,
      stderr_log: input.record.stderr_log,
      runner_metadata_path: toProjectPath(
        this.projectRoot,
        input.paths.runnerMetadataPath
      ),
      status: input.record.status,
      failure_reason: input.record.failure_reason,
      setup_action: input.record.setup_action,
      resume_hint: input.record.resume_hint,
      retry_after: input.record.retry_after,
      matched_pattern: input.record.matched_pattern,
      started_at: input.record.created_at,
      finished_at: input.record.finished_at
    });
  }

  private async writeSetupRequiredRecord(input: {
    kind: CliSessionRunRecord["kind"];
    session: SessionMetadata;
    bundle: ContextBundle;
    paths: PathSet;
    stderr: string;
    classification: CliRunClassification;
    request?: RunAgentJobRequest;
  }): Promise<CliSessionRunRecord> {
    await writeText(input.paths.stdoutPath, "");
    await writeText(input.paths.stderrPath, input.stderr);
    await this.writeTerminalState(
      input.session,
      null,
      terminalStatusFromRunStatus(input.classification.status)
    );
    const record = this.createRecord({
      kind: input.kind,
      session: input.session,
      bundle: input.bundle,
      paths: input.paths,
      request: input.request,
      classification: input.classification,
      status: input.classification.status
    });
    await writeJsonFileAtomic(input.paths.runnerMetadataPath, record);
    return record;
  }

  private async ensureOutbox(
    request: RunAgentJobRequest,
    outboxPath: string,
    result: CommandRunResult,
    classification: CliRunClassification
  ): Promise<{
    source: "agent_outbox" | "stdout_outbox" | "generated_failure";
    runStatus?: CliSessionRunStatus;
    classification?: CliRunClassification;
  }> {
    try {
      await access(outboxPath);
      const outbox = await readJsonFile<unknown>(outboxPath);
      return {
        source: "agent_outbox",
        runStatus: runStatusFromOutbox(outbox)
      };
    } catch {
      const stdoutOutbox = extractOutboxFromStdout(result.stdout);
      if (stdoutOutbox !== undefined) {
        const outbox = withOutboxDefaults(stdoutOutbox, request);
        await writeJsonFileAtomic(outboxPath, outbox);
        return {
          source: "stdout_outbox",
          runStatus: runStatusFromOutbox(outbox)
        };
      }

      const generatedClassification = generatedFailureClassification(
        result,
        classification
      );
      await this.writeFailureOutbox({
        request,
        outboxPath,
        classification: generatedClassification,
        result
      });
      return {
        source: "generated_failure",
        runStatus: generatedClassification.status,
        classification: generatedClassification
      };
    }
  }

  private async writeFailureOutbox(input: {
    request: RunAgentJobRequest;
    outboxPath: string;
    classification: CliRunClassification;
    result?: CommandRunResult;
  }): Promise<void> {
    await writeJsonFileAtomic(input.outboxPath, {
      schema_version: "0.1",
      run_id: input.request.runId,
      task_id: input.request.taskId,
      agent: input.request.agent,
      persona: input.request.persona,
      status: input.classification.status,
      events: [
        {
          type: "message.created",
          payload: {
            message_type: messageTypeForClassification(input.classification.status),
            classification_status: input.classification.status,
            reason: input.classification.reason,
            message: input.classification.message,
            setup_action: input.classification.setup_action,
            resume_hint: input.classification.resume_hint,
            retry_after: input.classification.retry_after,
            matched_pattern: input.classification.matched_pattern,
            exit_code: input.result?.exitCode ?? null,
            timed_out: input.result?.timedOut ?? false,
            stdout_excerpt: truncate(input.result?.stdout ?? ""),
            stderr_excerpt: truncate(input.result?.stderr ?? "")
          }
        }
      ]
    });
  }

  private async writeClassifiedOutbox(input: {
    request: RunAgentJobRequest;
    outboxPath: string;
    classification: CliRunClassification;
    result?: CommandRunResult;
  }): Promise<void> {
    await writeJsonFileAtomic(input.outboxPath, {
      schema_version: "0.1",
      run_id: input.request.runId,
      task_id: input.request.taskId,
      agent: input.request.agent,
      persona: input.request.persona,
      status: input.classification.status,
      events: [
        {
          type: "message.created",
          payload: {
            message_type: messageTypeForClassification(input.classification.status),
            classification_status: input.classification.status,
            reason: input.classification.reason,
            message: input.classification.message,
            setup_action: input.classification.setup_action,
            resume_hint: input.classification.resume_hint,
            retry_after: input.classification.retry_after,
            matched_pattern: input.classification.matched_pattern,
            exit_code: input.result?.exitCode ?? null,
            timed_out: input.result?.timedOut ?? false,
            stdout_excerpt: truncate(input.result?.stdout ?? ""),
            stderr_excerpt: truncate(input.result?.stderr ?? "")
          }
        }
      ]
    });
  }

  private async maybeStartReviewLoop(
    request: RunAgentJobRequest
  ): Promise<CliSessionRunRecord["review_loop"]> {
    const shouldStart =
      request.codeProducing === true ||
      request.commitRequested === true ||
      (request.changedFiles?.length ?? 0) > 0;

    if (!shouldStart) {
      return undefined;
    }

    const loop = await new ReviewLoopManager(this.projectRoot).start({
      taskId: request.taskId,
      runId: request.runId,
      implementer: request.agent,
      modelClass: request.modelClass,
      changedFiles: request.changedFiles,
      commitRequested: request.commitRequested,
      codeProducing: request.codeProducing,
      tags: request.tags
    });

    return {
      loop_id: loop.loop_id,
      status: loop.status,
      reviewers: loop.reviewers,
      integration: loop.integration
    };
  }

  private async writeTerminalState(
    session: SessionMetadata,
    result: CommandRunResult | null,
    status: TerminalState["status"]
  ): Promise<void> {
    const terminalPath = terminalStatePath(this.projectRoot, session);
    const terminalId = terminalIdFor(session.agent, session.date);
    const logBase = resolveInside(
      getKaironPaths(this.projectRoot).runtimeDir,
      "terminals",
      terminalId
    );
    const state: TerminalState = {
      schema_version: "0.1",
      terminal_id: terminalId,
      agent: session.agent,
      session_path: sessionPathFor(this.projectRoot, session),
      pid: result?.pid ?? null,
      cwd: ".",
      stdin_open: status === "ready",
      stdout_log: toProjectPath(this.projectRoot, `${logBase}.stdout.log`),
      stderr_log: toProjectPath(this.projectRoot, `${logBase}.stderr.log`),
      status,
      updated_at: new Date().toISOString()
    };

    await writeJsonFileAtomic(terminalPath, state);
    if (result !== null) {
      await writeText(`${logBase}.stdout.log`, result.stdout);
      await writeText(`${logBase}.stderr.log`, result.stderr);
    }
  }

  private createRecord(input: {
    kind: CliSessionRunRecord["kind"];
    session: SessionMetadata;
    bundle: ContextBundle;
    paths: PathSet;
    status: CliSessionRunStatus;
    request?: RunAgentJobRequest;
    result?: CommandRunResult;
    invocation?: CliInvocation;
    classification?: CliRunClassification;
    reviewLoop?: CliSessionRunRecord["review_loop"];
  }): CliSessionRunRecord {
    const now = new Date().toISOString();
    return {
      schema_version: "0.1",
      kind: input.kind,
      status: input.status,
      agent: input.session.agent,
      date: input.session.date,
      session_id: input.session.session_id,
      terminal_id: terminalIdFor(input.session.agent, input.session.date),
      run_id: input.request?.runId,
      task_id: input.request?.taskId,
      persona: input.request?.persona,
      command: input.invocation?.command ?? input.result?.command ?? input.session.command,
      args: input.invocation?.args ?? input.result?.args ?? [],
      command_available: input.session.command_available,
      pid: input.result?.pid ?? null,
      exit_code: input.result?.exitCode ?? null,
      signal: input.result?.signal ?? null,
      timed_out: input.result?.timedOut ?? false,
      classification: input.classification,
      failure_reason: input.classification?.reason,
      setup_action: input.classification?.setup_action,
      resume_hint: input.classification?.resume_hint,
      retry_after: input.classification?.retry_after,
      matched_pattern: input.classification?.matched_pattern,
      prompt_path: toProjectPath(this.projectRoot, input.paths.promptPath),
      stdout_log: toProjectPath(this.projectRoot, input.paths.stdoutPath),
      stderr_log: toProjectPath(this.projectRoot, input.paths.stderrPath),
      outbox_path:
        input.paths.outboxPath === undefined
          ? undefined
          : toProjectPath(this.projectRoot, input.paths.outboxPath),
      context_path: input.bundle.context_path,
      runner_metadata_path: toProjectPath(
        this.projectRoot,
        input.paths.runnerMetadataPath
      ),
      review_loop: input.reviewLoop,
      created_at: input.result?.startedAt ?? now,
      finished_at: input.result?.finishedAt ?? now
    };
  }
}

function terminalStatusFromRunStatus(
  status: CliSessionRunStatus
): TerminalState["status"] {
  if (status === "completed") {
    return "ready";
  }

  if (
    status === "setup_required" ||
    status === "permission_required" ||
    status === "rate_limited" ||
    status === "usage_limited" ||
    status === "timeout" ||
    status === "no_output"
  ) {
    return status;
  }

  return "failed";
}

function shouldWriteClassifiedOutbox(status: CliSessionRunStatus): boolean {
  return status !== "completed" && status !== "failed";
}

function classifyAgentJobResult(
  agent: AgentId,
  result: CommandRunResult,
  runId: string
): CliRunClassification {
  const stdoutOutbox =
    agent === "gemini" ? extractOutboxFromStdout(result.stdout) : undefined;
  if (
    stdoutOutbox !== null &&
    typeof stdoutOutbox === "object" &&
    !Array.isArray(stdoutOutbox) &&
    (stdoutOutbox as Record<string, unknown>).run_id === runId &&
    runStatusFromOutbox(stdoutOutbox) === "completed"
  ) {
    return {
      status: "completed",
      reason: "stdout_outbox_completed",
      message: "Agent CLI returned a valid completed stdout outbox."
    };
  }

  return classifyCliRunResult(agent, result);
}

function generatedFailureClassification(
  result: CommandRunResult,
  classification: CliRunClassification
): CliRunClassification {
  if (classification.status !== "completed") {
    return classification;
  }

  const hasOutput = `${result.stdout}\n${result.stderr}`.trim().length > 0;
  if (!hasOutput) {
    return {
      status: "no_output",
      reason: "cli_no_output",
      message: "Agent CLI completed without stdout, stderr, or a valid outbox."
    };
  }

  return {
    status: "failed",
    reason: "outbox_missing",
    message: "Agent process completed without writing the required outbox."
  };
}

function messageTypeForClassification(status: CliSessionRunStatus): string {
  if (status === "setup_required") {
    return "agent.run.setup_required";
  }

  if (status === "permission_required") {
    return "agent.run.permission_required";
  }

  if (status === "rate_limited") {
    return "agent.run.rate_limited";
  }

  if (status === "usage_limited") {
    return "agent.run.usage_limited";
  }

  if (status === "timeout") {
    return "agent.run.timeout";
  }

  if (status === "no_output") {
    return "agent.run.no_output";
  }

  return "agent.run.failure";
}

async function writeRunLogs(
  paths: Pick<PathSet, "stdoutPath" | "stderrPath">,
  result: CommandRunResult
): Promise<void> {
  await writeText(paths.stdoutPath, result.stdout);
  await writeText(paths.stderrPath, result.stderr);
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function truncate(value: string, max = 2_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

async function readContextContent(
  projectRoot: string,
  contextPath: string
): Promise<string> {
  return readFile(resolveInside(projectRoot, contextPath), "utf8");
}

function withOutboxDefaults(
  outbox: unknown,
  request: RunAgentJobRequest
): Record<string, unknown> {
  const value =
    outbox !== null && typeof outbox === "object" && !Array.isArray(outbox)
      ? (outbox as Record<string, unknown>)
      : {};

  return {
    schema_version: "0.1",
    run_id: request.runId,
    task_id: request.taskId,
    agent: request.agent,
    persona: request.persona,
    ...value
  };
}

function runStatusFromOutbox(
  outbox: unknown
): CliSessionRunStatus | undefined {
  if (outbox === null || typeof outbox !== "object" || Array.isArray(outbox)) {
    return undefined;
  }

  const status = (outbox as { status?: unknown }).status;
  if (status === undefined) {
    return undefined;
  }

  if (
    status === "completed" ||
    status === "failed" ||
    status === "setup_required" ||
    status === "permission_required" ||
    status === "rate_limited" ||
    status === "usage_limited" ||
    status === "timeout" ||
    status === "no_output"
  ) {
    return status;
  }

  return "failed";
}

function terminalIdFor(agent: AgentId, date: string): string {
  return `TERM-${agent}-${date.replaceAll("-", "")}`;
}

function terminalStatePath(projectRoot: string, session: SessionMetadata): string {
  return resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "terminals",
    `${terminalIdFor(session.agent, session.date)}.json`
  );
}

function sessionPathFor(projectRoot: string, session: SessionMetadata): string {
  return toProjectPath(
    projectRoot,
    resolveInside(
      getKaironPaths(projectRoot).sessionsDir,
      session.date,
      session.agent,
      "session.json"
    )
  );
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
