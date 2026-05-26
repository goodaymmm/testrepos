import { spawn } from "node:child_process";
import path from "node:path";

export type CliInvocation = {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
    const child = spawn(processInvocation.command, processInvocation.args, {
      cwd: invocation.cwd,
      env: processInvocation.env,
      shell: processInvocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${String(error)}\n`,
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut
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
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut
      });
    });

    if (invocation.stdin !== undefined) {
      child.stdin.write(invocation.stdin);
    }
    child.stdin.end();
  });

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
