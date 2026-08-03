import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createAntigravityPtySessionRunner,
  resolvePtyCommandForSpawn,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawner
} from "../src/agents/pty-session-runner.js";
import type { InteractiveSessionJob } from "../src/agents/interactive-session-runner.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("createAntigravityPtySessionRunner", () => {
  it("returns completed once the agent outbox is written", async () => {
    const root = await createTempProject();
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0001", "outbox.json");
    const pty = new FakePty();
    let spawnedArgs: string[] = [];
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: fakeSpawner(pty, (_command, args) => {
        spawnedArgs = args;
      }),
      pollIntervalMs: 5,
      closeGraceMs: 5,
      platform: "linux"
    });

    const resultPromise = runner(job(root, outboxPath));
    await waitForPtyReady();
    pty.emitData("agy ready\n");
    await writeJsonFileAtomic(outboxPath, {
      schema_version: "0.1",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      agent: "gemini",
      persona: "smoke",
      status: "completed"
    });
    const result = await resultPromise;

    expect(spawnedArgs).toEqual([
      "--add-dir",
      path.dirname(outboxPath),
      "--prompt-interactive",
      expect.stringContaining("KAIRON_JOB_START RUN-0001")
    ]);
    expect(result).toMatchObject({
      command: "agy",
      args: spawnedArgs,
      pid: 4321,
      exitCode: 0,
      timedOut: false,
      stdout: "agy ready\n"
    });
    expect(pty.writes.join("")).toContain("exit");
    expect(pty.killed).toBe(true);
  });

  it("times out and kills the PTY when no outbox or process exit arrives", async () => {
    const root = await createTempProject();
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0002", "outbox.json");
    const pty = new FakePty();
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: fakeSpawner(pty),
      pollIntervalMs: 5,
      platform: "linux"
    });

    const result = await runner(job(root, outboxPath, { runId: "RUN-0002", timeoutMs: 20 }));

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: true
    });
    expect(pty.killed).toBe(true);
  });

  it("completes when Antigravity prints a valid stdout fallback and stays interactive", async () => {
    const root = await createTempProject();
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0006", "outbox.json");
    const pty = new FakePty();
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: fakeSpawner(pty),
      pollIntervalMs: 5,
      closeGraceMs: 5,
      platform: "linux"
    });

    const resultPromise = runner(job(root, outboxPath, { runId: "RUN-0006" }));
    await waitForPtyReady();
    pty.emitData([
      "KAIRON_OUTBOX_JSON_START\n",
      "prompt contract is not JSON\n",
      "KAIRON_OUTBOX_JSON_END\n",
      "\u001b[32mKAIRON_OUTBOX_JSON_START\u001b[0m\n",
      JSON.stringify({
        schema_version: "0.1",
        run_id: "RUN-0006",
        task_id: "TASK-0001",
        status: "completed",
        events: []
      }),
      "\nKAIRON_OUTBOX_JSON_END\n",
      "agy remains at its interactive prompt"
    ].join(""));
    const result = await resultPromise;

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false
    });
    expect(result.stdout).toContain("agy remains at its interactive prompt");
    expect(pty.writes.join("")).toContain("exit");
    expect(pty.killed).toBe(true);
  });

  it("returns the process exit code when the PTY exits before writing an outbox", async () => {
    const root = await createTempProject();
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0003", "outbox.json");
    const pty = new FakePty();
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: fakeSpawner(pty),
      pollIntervalMs: 5,
      closeGraceMs: 5,
      platform: "linux"
    });

    const resultPromise = runner(job(root, outboxPath, { runId: "RUN-0003" }));
    await waitForPtyReady();
    pty.emitExit({ exitCode: 7 });
    const result = await resultPromise;

    expect(result).toMatchObject({
      exitCode: 7,
      timedOut: false
    });
    expect(pty.killed).toBe(false);
  });

  it("resolves agy.exe from PATH before spawning node-pty on Windows", async () => {
    const root = await createTempProject();
    const executable = path.join(root, "agy.exe");
    await writeFile(executable, "", "utf8");
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0004", "outbox.json");
    const pty = new FakePty();
    let spawnedCommand = "";
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: fakeSpawner(pty, (command) => {
        spawnedCommand = command;
      }),
      pollIntervalMs: 5,
      closeGraceMs: 5,
      platform: "win32",
      env: {
        PATH: root,
        PATHEXT: ".exe;.cmd"
      }
    });

    const resultPromise = runner(job(root, outboxPath, { runId: "RUN-0004" }));
    await waitForPtyReady();
    await writeJsonFileAtomic(outboxPath, {
      schema_version: "0.1",
      run_id: "RUN-0004",
      task_id: "TASK-0001",
      agent: "gemini",
      persona: "smoke",
      status: "completed"
    });
    const result = await resultPromise;

    expect(spawnedCommand).toBe(executable);
    expect(result.command).toBe("agy");
    expect(result.exitCode).toBe(0);
  });

  it("returns setup-required without leaking File not found when the PTY command cannot be resolved", async () => {
    const root = await createTempProject();
    const outboxPath = path.join(root, ".kairon", "runs", "RUN-0005", "outbox.json");
    const runner = createAntigravityPtySessionRunner({
      ptySpawner: () => {
        throw new Error("should not spawn unresolved commands");
      },
      platform: "win32",
      env: {
        PATH: root,
        PATHEXT: ".exe"
      }
    });

    const result = await runner(job(root, outboxPath, { runId: "RUN-0005" }));

    expect(result.command).toBe("agy");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pty_command_unresolved");
    expect(result.stderr).not.toContain("pty_spawn_failed");
    expect(result.stderr).not.toContain("File not found");
  });
});

describe("resolvePtyCommandForSpawn", () => {
  it("keeps non-Windows commands unresolved for PATH-based spawning", async () => {
    await expect(resolvePtyCommandForSpawn("agy", {}, "linux")).resolves.toEqual({
      command: "agy",
      resolved: true,
      candidates: ["agy"]
    });
  });
});

class FakePty implements PtyProcess {
  readonly pid = 4321;
  readonly writes: string[] = [];
  killed = false;
  private dataCallback: ((data: string) => void) | undefined;
  private exitCallback: ((event: PtyExitEvent) => void) | undefined;

  onData(callback: (data: string) => void): unknown {
    this.dataCallback = callback;
    return undefined;
  }

  onExit(callback: (event: PtyExitEvent) => void): unknown {
    this.exitCallback = callback;
    return undefined;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    this.dataCallback?.(data);
  }

  emitExit(event: PtyExitEvent): void {
    this.exitCallback?.(event);
  }
}

async function waitForPtyReady(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeSpawner(
  pty: PtyProcess,
  onSpawn?: (command: string, args: string[]) => void
): PtySpawner {
  return (command, args) => {
    onSpawn?.(command, args);
    return pty;
  };
}

function job(
  root: string,
  outboxPath: string,
  overrides: Partial<Pick<InteractiveSessionJob, "runId" | "timeoutMs">> = {}
): InteractiveSessionJob {
  const runId = overrides.runId ?? "RUN-0001";
  return {
    agent: "gemini",
    command: "agy",
    cwd: root,
    prompt: `KAIRON_JOB_START ${runId}\nWrite the outbox.`,
    timeoutMs: overrides.timeoutMs,
    runId,
    taskId: "TASK-0001",
    persona: "smoke",
    outboxPath,
    expectedOutboxPath: ".kairon/runs/RUN-0001/outbox.json",
    contextPath: ".kairon/runs/RUN-0001/context.md",
    session: {
      schema_version: "0.1",
      session_id: "SESSION-2026-05-31-gemini",
      date: "2026-05-31",
      agent: "gemini",
      adapter: "antigravity_cli",
      command: "agy",
      command_available: true,
      mode: "persistent_terminal_session",
      status: "ready",
      native: {
        resume_id: null,
        thread_id: null,
        resume_supported: false
      },
      active_run_id: null,
      last_run_id: null,
      context_manifest: ".kairon/sessions/2026-05-31/gemini/context_manifest.json",
      scratch: ".kairon/sessions/2026-05-31/gemini/scratch.md",
      created_at: "2026-05-31T00:00:00.000Z",
      updated_at: "2026-05-31T00:00:00.000Z"
    }
  };
}
