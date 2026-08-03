import { spawn } from "node:child_process";
import path from "node:path";

export type CliInvocation = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type CommandRunResult = {
  command: string;
  args: string[];
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type CommandRunner = (
  invocation: CliInvocation
) => Promise<CommandRunResult>;

export type ProcessInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
};

export const commandRunnerSecurityPolicy = {
  default_max_output_bytes: 4 * 1024 * 1024,
  windows_shell_shims: ["codex", ".cmd", ".bat"]
} as const;

export function buildProcessInvocation(
  invocation: CliInvocation,
  platform: NodeJS.Platform = process.platform
): ProcessInvocation {
  const env = invocation.env ?? process.env;

  return {
    command: invocation.command,
    args: invocation.args,
    env,
    shell: shouldUseWindowsShellShim(invocation.command, platform)
  };
}

export const spawnCommandRunner: CommandRunner = async (invocation) =>
  new Promise<CommandRunResult>((resolve) => {
    const startedAt = new Date().toISOString();
    const processInvocation = buildProcessInvocation(invocation);
    const maxOutputBytes =
      invocation.maxOutputBytes ??
      commandRunnerSecurityPolicy.default_max_output_bytes;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("Command output limit must be a positive safe integer.");
    }
    const child = spawn(processInvocation.command, processInvocation.args, {
      cwd: invocation.cwd,
      env: processInvocation.env,
      shell: processInvocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = new BoundedOutputCapture(maxOutputBytes);
    const stderr = new BoundedOutputCapture(maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timeout =
      invocation.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        pid: child.pid ?? null,
        exitCode: 1,
        signal: null,
        stdout: stdout.text(),
        stderr: `${stderr.text()}${String(error)}\n`,
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut,
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {})
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        pid: child.pid ?? null,
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut,
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {})
      });
    });

    if (invocation.stdin !== undefined) {
      child.stdin.write(invocation.stdin);
    }
    child.stdin.end();
  });

class BoundedOutputCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const value = Buffer.from(chunk);
    this.#chunks.push(value);
    this.#bytes += value.length;
    while (this.#bytes > this.maxBytes && this.#chunks.length > 0) {
      const overflow = this.#bytes - this.maxBytes;
      const first = this.#chunks[0]!;
      if (first.length <= overflow) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(overflow);
        this.#bytes -= overflow;
      }
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

function shouldUseWindowsShellShim(
  command: string,
  platform: NodeJS.Platform
): boolean {
  if (platform !== "win32") {
    return false;
  }

  const executableName = path.basename(command).toLowerCase();
  return (
    executableName === "codex" ||
    executableName.endsWith(".cmd") ||
    executableName.endsWith(".bat")
  );
}
