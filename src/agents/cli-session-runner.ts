import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAgentCliInvocation } from "./cli-invocation.js";
import {
  spawnCommandRunner,
  type CliInvocation,
  type CommandRunner,
  type CommandRunResult
} from "./command-runner.js";
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
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  ReviewLoopManager,
  type ReviewLoopState
} from "../review/review-loop-manager.js";
import type { ChangedFile } from "../git/diff-snapshot.js";

export type CliSessionRunStatus = "completed" | "failed" | "setup_required";

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
  status: "ready" | "running" | "failed" | "setup_required";
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
      const record = await this.writeSetupRequiredRecord({
        kind: "daily_bootstrap",
        session,
        bundle,
        paths,
        stderr: `Kairon setup required: ${session.command} is not available.\n`
      });
      await this.recordSessionRun({ session, bundle, paths, record });
      return record;
    }

    if (!getAgentAdapter(request.agent).supports.nonInteractive) {
      const record = await this.writeSetupRequiredRecord({
        kind: "daily_bootstrap",
        session,
        bundle,
        paths,
        stderr: `Kairon setup required: ${session.command} requires an interactive terminal or PTY adapter.\n`
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

    await writeRunLogs(paths, result);
    await this.writeTerminalState(session, result, terminalStatusFromResult(result));

    const record = this.createRecord({
      kind: "daily_bootstrap",
      session,
      bundle,
      paths,
      result,
      invocation,
      status: statusFromResult(result)
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
    await this.sessionHost.markRunStarted(request.agent, request.date, {
      kind: "job",
      run_id: request.runId,
      task_id: request.taskId,
      persona: request.persona,
      context_path: bundle.context_path,
      outbox_path: toProjectPath(this.projectRoot, outboxPath),
      runner_metadata_path: toProjectPath(this.projectRoot, paths.runnerMetadataPath),
      status: "running",
      started_at: new Date().toISOString()
    });

    let record: CliSessionRunRecord | undefined;

    try {
      if (!session.command_available) {
        await this.writeFailureOutbox({
          request,
          outboxPath,
          reason: "cli_command_missing",
          message: `${session.command} is not available.`
        });
        record = await this.writeSetupRequiredRecord({
          kind: "job",
          session,
          bundle,
          paths,
          stderr: `Kairon setup required: ${session.command} is not available.\n`,
          request
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
          const setupRequired = classifyCliSetupRequired(result);
          if (setupRequired !== undefined) {
            await this.writeSetupRequiredOutbox({
              request,
              outboxPath,
              reason: setupRequired.reason,
              message: setupRequired.message,
              result
            });
            await writeRunLogs(paths, result);
            await this.writeTerminalState(session, result, "setup_required");
            record = this.createRecord({
              kind: "job",
              session,
              bundle,
              paths,
              result,
              request,
              status: "setup_required"
            });
            await writeJsonFileAtomic(paths.runnerMetadataPath, record);
            return record;
          }

          const outboxStatus = await this.ensureOutbox(request, outboxPath, result);
          const status =
            outboxStatus.source === "generated_failure"
              ? "failed"
              : (outboxStatus.runStatus ?? statusFromResult(result));
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
            status
          });
          await writeJsonFileAtomic(paths.runnerMetadataPath, record);
          return record;
        }

        await this.writeFailureOutbox({
          request,
          outboxPath,
          reason: "cli_pty_required",
          message: `${session.command} requires an interactive terminal or PTY adapter for Kairon automation.`
        });
        record = await this.writeSetupRequiredRecord({
          kind: "job",
          session,
          bundle,
          paths,
          stderr: `Kairon setup required: ${session.command} requires an interactive terminal or PTY adapter.\n`,
          request
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
      const setupRequired = classifyCliSetupRequired(result);
      if (setupRequired !== undefined) {
        await this.writeSetupRequiredOutbox({
          request,
          outboxPath,
          reason: setupRequired.reason,
          message: setupRequired.message,
          result
        });
        await writeRunLogs(paths, result);
        await this.writeTerminalState(session, result, "setup_required");
        record = this.createRecord({
          kind: "job",
          session,
          bundle,
          paths,
          result,
          invocation,
          request,
          status: "setup_required"
        });
        await writeJsonFileAtomic(paths.runnerMetadataPath, record);
        return record;
      }

      const outboxStatus = await this.ensureOutbox(request, outboxPath, result);
      const status =
        outboxStatus.source === "generated_failure"
          ? "failed"
          : (outboxStatus.runStatus ?? statusFromResult(result));
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
        status
      });
      await writeJsonFileAtomic(paths.runnerMetadataPath, record);
      return record;
    } finally {
      await this.sessionHost.markRunFinished(request.agent, request.date, {
        kind: "job",
        run_id: request.runId,
        task_id: request.taskId,
        persona: request.persona,
        context_path: bundle.context_path,
        outbox_path: toProjectPath(this.projectRoot, outboxPath),
        runner_metadata_path: toProjectPath(this.projectRoot, paths.runnerMetadataPath),
        status: record?.status ?? "failed",
        started_at: record?.created_at,
        finished_at: record?.finished_at ?? new Date().toISOString()
      });
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
      runner_metadata_path: toProjectPath(
        this.projectRoot,
        input.paths.runnerMetadataPath
      ),
      status: input.record.status,
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
    request?: RunAgentJobRequest;
  }): Promise<CliSessionRunRecord> {
    await writeText(input.paths.stdoutPath, "");
    await writeText(input.paths.stderrPath, input.stderr);
    await this.writeTerminalState(input.session, null, "setup_required");
    const record = this.createRecord({
      kind: input.kind,
      session: input.session,
      bundle: input.bundle,
      paths: input.paths,
      request: input.request,
      status: "setup_required"
    });
    await writeJsonFileAtomic(input.paths.runnerMetadataPath, record);
    return record;
  }

  private async ensureOutbox(
    request: RunAgentJobRequest,
    outboxPath: string,
    result: CommandRunResult
  ): Promise<{
    source: "agent_outbox" | "stdout_outbox" | "generated_failure";
    runStatus?: CliSessionRunStatus;
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

      await this.writeFailureOutbox({
        request,
        outboxPath,
        reason: result.exitCode === 0 ? "outbox_missing" : "cli_failed",
        message:
          result.exitCode === 0
            ? "Agent process completed without writing the required outbox."
            : "Agent process failed before writing a valid outbox.",
        result
      });
      return { source: "generated_failure" };
    }
  }

  private async writeFailureOutbox(input: {
    request: RunAgentJobRequest;
    outboxPath: string;
    reason: string;
    message: string;
    result?: CommandRunResult;
  }): Promise<void> {
    await writeJsonFileAtomic(input.outboxPath, {
      schema_version: "0.1",
      run_id: input.request.runId,
      task_id: input.request.taskId,
      agent: input.request.agent,
      persona: input.request.persona,
      status: "failed",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.failure",
            reason: input.reason,
            message: input.message,
            exit_code: input.result?.exitCode ?? null,
            timed_out: input.result?.timedOut ?? false,
            stdout_excerpt: truncate(input.result?.stdout ?? ""),
            stderr_excerpt: truncate(input.result?.stderr ?? "")
          }
        }
      ]
    });
  }

  private async writeSetupRequiredOutbox(input: {
    request: RunAgentJobRequest;
    outboxPath: string;
    reason: string;
    message: string;
    result: CommandRunResult;
  }): Promise<void> {
    await writeJsonFileAtomic(input.outboxPath, {
      schema_version: "0.1",
      run_id: input.request.runId,
      task_id: input.request.taskId,
      agent: input.request.agent,
      persona: input.request.persona,
      status: "setup_required",
      events: [
        {
          type: "message.created",
          payload: {
            message_type: "agent.run.setup_required",
            reason: input.reason,
            message: input.message,
            exit_code: input.result.exitCode,
            timed_out: input.result.timedOut,
            stdout_excerpt: truncate(input.result.stdout),
            stderr_excerpt: truncate(input.result.stderr)
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

function statusFromResult(
  result: CommandRunResult
): Extract<CliSessionRunStatus, "completed" | "failed"> {
  return result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
}

function terminalStatusFromResult(result: CommandRunResult): TerminalState["status"] {
  return statusFromResult(result) === "completed" ? "ready" : "failed";
}

function terminalStatusFromRunStatus(
  status: CliSessionRunStatus
): TerminalState["status"] {
  if (status === "completed") {
    return "ready";
  }

  return status === "setup_required" ? "setup_required" : "failed";
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

function extractOutboxFromStdout(stdout: string): unknown | undefined {
  for (const candidate of stdoutCandidates(stdout)) {
    const match = /KAIRON_OUTBOX_JSON_START\s*([\s\S]*?)\s*KAIRON_OUTBOX_JSON_END/.exec(
      candidate
    );
    if (match?.[1] === undefined) {
      continue;
    }

    try {
      return JSON.parse(match[1]) as unknown;
    } catch {
      continue;
    }
  }

  return undefined;
}

function stdoutCandidates(stdout: string): string[] {
  const candidates = [stdout];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }

    try {
      collectStrings(JSON.parse(line) as unknown, candidates);
    } catch {
      continue;
    }
  }

  return candidates;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
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

  if (status === "completed" || status === "setup_required") {
    return status;
  }

  return "failed";
}

function classifyCliSetupRequired(
  result: CommandRunResult
): { reason: string; message: string } | undefined {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    output.includes('"error":"rate_limit"') ||
    output.includes('"error": "rate_limit"') ||
    output.includes("rate_limit") ||
    output.includes("you've hit your limit")
  ) {
    return {
      reason: "cli_rate_limited",
      message: "Agent CLI is rate limited. Retry after the provider reset window."
    };
  }

  if (
    output.includes("pty_spawn_failed") ||
    output.includes("pty spawn failed")
  ) {
    return {
      reason: "cli_pty_unavailable",
      message: "Agent CLI requires a PTY adapter, but the PTY process could not be started."
    };
  }

  if (output.includes("pty_command_unresolved")) {
    return {
      reason: "cli_pty_command_unresolved",
      message: "Agent CLI requires a PTY adapter, but the configured command could not be resolved to an executable."
    };
  }

  return undefined;
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
