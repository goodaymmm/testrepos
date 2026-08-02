import { access } from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import type { CommandRunResult } from "./command-runner.js";
import type {
  InteractiveSessionJob,
  InteractiveSessionRunner
} from "./interactive-session-runner.js";
import { hasMatchingStdoutOutbox } from "./stdout-outbox.js";

export type PtyExitEvent = {
  exitCode: number;
  signal?: number;
};

export type PtyProcess = {
  pid: number;
  onData(callback: (data: string) => void): unknown;
  onExit(callback: (event: PtyExitEvent) => void): unknown;
  write(data: string): void;
  kill(): void;
};

export type PtySpawner = (
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
) => PtyProcess | Promise<PtyProcess>;

export type PtySessionRunnerOptions = {
  ptySpawner?: PtySpawner;
  pollIntervalMs?: number;
  closeGraceMs?: number;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
};

export function createAntigravityPtySessionRunner(
  options: PtySessionRunnerOptions = {}
): InteractiveSessionRunner {
  return (job) => runPtySession(job, options);
}

async function runPtySession(
  job: InteractiveSessionJob,
  options: PtySessionRunnerOptions
): Promise<CommandRunResult> {
  const startedAt = isoNow(options);
  const args = antigravityArgs(job);
  const spawn = options.ptySpawner ?? defaultPtySpawner;
  const env = options.env ?? process.env;
  const commandResolution = await resolvePtyCommandForSpawn(
    job.command,
    env,
    options.platform ?? process.platform
  );
  const timeoutMs = job.timeoutMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const closeGraceMs = options.closeGraceMs ?? 1_500;
  let pty: PtyProcess | undefined;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exited = false;
  let outboxDetected = false;
  let closeTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  if (!commandResolution.resolved) {
    return {
      command: job.command,
      args,
      cwd: job.cwd,
      pid: null,
      exitCode: 1,
      signal: null,
      stdout,
      stderr: [
        "KAIRON_SETUP_REQUIRED pty_command_unresolved:",
        `command=${job.command}`,
        `searched=${commandResolution.candidates.join(";")}`
      ].join(" ") + "\n",
      startedAt,
      finishedAt: isoNow(options),
      timedOut: false
    };
  }

  try {
    pty = await spawn(commandResolution.command, args, {
      name: "xterm-256color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      cwd: job.cwd,
      env
    });
  } catch (error) {
    return {
      command: job.command,
      args,
      cwd: job.cwd,
      pid: null,
      exitCode: 1,
      signal: null,
      stdout,
      stderr: `KAIRON_SETUP_REQUIRED pty_spawn_failed: ${String(error)}\n`,
      startedAt,
      finishedAt: isoNow(options),
      timedOut: false
    };
  }

  return new Promise<CommandRunResult>((resolve) => {
    let settled = false;
    const finish = (input: { exitCode: number | null; timedOut?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer);
      }
      if (!exited) {
        try {
          pty?.kill();
        } catch {
          // The process may already be gone.
        }
      }
      resolve({
        command: job.command,
        args,
        cwd: job.cwd,
        pid: pty?.pid ?? null,
        exitCode: input.exitCode,
        signal: null,
        stdout,
        stderr,
        startedAt,
        finishedAt: isoNow(options),
        timedOut: input.timedOut ?? false
      });
    };

    pty.onData((data) => {
      stdout += data;
      if (outboxDetected || !hasMatchingStdoutOutbox(stdout, job.runId)) {
        return;
      }

      outboxDetected = true;
      requestGracefulExit(pty);
      closeTimer = setTimeout(() => finish({ exitCode: 0 }), closeGraceMs);
    });
    pty.onExit((event) => {
      exited = true;
      finish({ exitCode: outboxDetected ? 0 : event.exitCode });
    });

    pollTimer = setInterval(() => {
      void hasReadyOutbox(job.outboxPath, job.runId).then((ready) => {
        if (!ready || outboxDetected) {
          return;
        }
        outboxDetected = true;
        requestGracefulExit(pty);
        closeTimer = setTimeout(() => finish({ exitCode: 0 }), closeGraceMs);
      });
    }, pollIntervalMs);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      finish({ exitCode: 1, timedOut });
    }, timeoutMs);
  });
}

export async function resolvePtyCommandForSpawn(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<{ command: string; resolved: boolean; candidates: string[] }> {
  if (platform !== "win32") {
    return { command, resolved: true, candidates: [command] };
  }

  if (hasPathSeparator(command) || path.isAbsolute(command)) {
    const exists = await canAccess(command);
    return { command, resolved: exists, candidates: [command] };
  }

  const pathValue = getEnvValue(env, "PATH") ?? "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
  const extensions = commandHasExtension(command)
    ? [""]
    : (getEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension.length > 0);
  const candidates = pathEntries.flatMap((entry) =>
    extensions.map((extension) => path.join(entry, `${command}${extension}`))
  );

  for (const candidate of candidates) {
    if (await canAccess(candidate)) {
      return { command: candidate, resolved: true, candidates };
    }
  }

  return { command, resolved: false, candidates };
}

async function defaultPtySpawner(
  command: string,
  args: string[],
  options: Parameters<PtySpawner>[2]
): Promise<PtyProcess> {
  const { spawn } = await import("node-pty");
  return spawn(command, args, options);
}

function antigravityArgs(job: InteractiveSessionJob): string[] {
  return [
    "--add-dir",
    path.dirname(job.outboxPath),
    "--prompt-interactive",
    job.prompt
  ];
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) {
    return exact;
  }

  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match === undefined ? undefined : env[match];
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function commandHasExtension(command: string): boolean {
  return path.extname(command).length > 0;
}

async function canAccess(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasReadyOutbox(outboxPath: string, runId: string): Promise<boolean> {
  try {
    const outbox = await readJsonFile<{ run_id?: unknown }>(outboxPath);
    return outbox.run_id === undefined || outbox.run_id === runId;
  } catch {
    return false;
  }
}

function requestGracefulExit(pty: PtyProcess | undefined): void {
  if (pty === undefined) {
    return;
  }

  try {
    pty.write("\x03");
    pty.write("exit\r");
  } catch {
    // Forced cleanup happens after the grace window.
  }
}

function isoNow(options: Pick<PtySessionRunnerOptions, "now">): string {
  return (options.now?.() ?? new Date()).toISOString();
}
