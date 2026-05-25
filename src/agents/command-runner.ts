import { spawn } from "node:child_process";

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

export const spawnCommandRunner: CommandRunner = async (invocation) =>
  new Promise<CommandRunResult>((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env ?? process.env,
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
