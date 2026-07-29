import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  certifyAgentCompatibility,
  certifyAllAgentCompatibility,
  inspectAgentCertifications,
  readLatestCertification
} from "../src/agents/compatibility-certification.js";
import type {
  CliInvocation,
  CommandRunResult,
  CommandRunner
} from "../src/agents/command-runner.js";
import type {
  InteractiveSessionJob,
  InteractiveSessionRunner
} from "../src/agents/interactive-session-runner.js";
import type { AgentId } from "../src/agents/types.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runDoctor } from "../src/diagnostics/doctor.js";
import { createTempProject } from "./test-utils.js";

const sourceCommit = "a".repeat(40);

describe("Agent CLI compatibility certification", () => {
  it("certifies Codex, Claude, and Antigravity with secret-free artifacts", async () => {
    const root = await createInitializedProject();
    const commandRunner = successfulCommandRunner(root, {
      codex: "codex-cli 0.85.0",
      claude: "2.1.3 (Claude Code)",
      gemini: "agy version 1.4.2"
    });
    const summary = await certifyAllAgentCompatibility(root, {
      sourceCommit,
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      commandAvailability: async () => true,
      commandRunner,
      interactiveSessionRunner: successfulInteractiveRunner()
    });

    expect(summary.status).toBe("PASS");
    expect(summary.certifications).toHaveLength(3);
    expect(summary.certifications.map((entry) => [
      entry.agent,
      entry.command,
      entry.version,
      entry.status
    ])).toEqual([
      ["codex", "codex", "0.85.0", "PASS"],
      ["claude", "claude", "2.1.3", "PASS"],
      ["gemini", "agy", "1.4.2", "PASS"]
    ]);
    expect(
      summary.certifications.find((entry) => entry.agent === "gemini")?.checks
    ).toContainEqual({
      id: "pty_round_trip",
      status: "PASS",
      reason: "antigravity_pty_round_trip_completed"
    });

    for (const certification of summary.certifications) {
      const serialized = await readFile(
        path.join(root, certification.artifact_path),
        "utf8"
      );
      expect(serialized).not.toContain("TOP_SECRET");
      expect(serialized).not.toContain("KAIRON_JOB_START");
      await expect(
        readLatestCertification(root, certification.agent)
      ).resolves.toMatchObject({
        certification_id: certification.certification_id,
        source_commit: sourceCommit
      });
    }
    const doctor = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {},
      now: () => new Date("2026-07-29T01:00:00.000Z")
    });
    expect(
      doctor.checks.find((check) => check.id === "agent.compatibility")?.status
    ).toBe("pass");
  });

  it("warns on a changed version after the required smoke succeeds", async () => {
    const root = await createInitializedProject();
    await certifyAgentCompatibility(root, "codex", {
      sourceCommit,
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      commandAvailability: async () => true,
      commandRunner: successfulCommandRunner(root, { codex: "codex-cli 0.85.0" })
    });

    const changed = await certifyAgentCompatibility(root, "codex", {
      sourceCommit,
      now: () => new Date("2026-07-30T00:00:00.000Z"),
      commandAvailability: async () => true,
      commandRunner: successfulCommandRunner(root, { codex: "codex-cli 0.86.0" })
    });

    expect(changed).toMatchObject({
      status: "PASS",
      version: "0.86.0",
      previous_success_version: "0.85.0",
      version_changed: true
    });
    expect(changed.checks).toContainEqual({
      id: "version_change",
      status: "WARNING",
      reason: "cli_version_changed_targeted_smoke_completed"
    });
    await expect(
      inspectAgentCertifications(root, {
        now: new Date("2026-07-30T01:00:00.000Z")
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        agent: "codex",
        status: "warning",
        reason: "cli_version_changed"
      })
    );
    const doctor = await runDoctor({
      projectRoot: root,
      commandAvailability: async () => true,
      env: {},
      now: () => new Date("2026-07-30T01:00:00.000Z")
    });
    const compatibility = doctor.checks.find(
      (check) => check.id === "agent.compatibility"
    );
    expect(compatibility?.status).toBe("warning");
    expect(
      compatibility?.details.some((detail) =>
        detail.includes("reason=cli_version_changed")
      )
    ).toBe(true);
  });

  it("classifies a missing official CLI as setup required without running it", async () => {
    const root = await createInitializedProject();
    const invocations: CliInvocation[] = [];
    const certification = await certifyAgentCompatibility(root, "gemini", {
      sourceCommit,
      commandAvailability: async () => false,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation);
      }
    });

    expect(invocations).toEqual([]);
    expect(certification).toMatchObject({
      agent: "gemini",
      command: "agy",
      status: "SETUP_REQUIRED",
      version: null,
      smoke_status: null
    });
    expect(certification.checks).toContainEqual({
      id: "command_availability",
      status: "SETUP_REQUIRED",
      reason: "official_cli_command_missing"
    });
  });

  it("keeps a version-command login gate as setup required", async () => {
    const root = await createInitializedProject();
    const certification = await certifyAgentCompatibility(root, "claude", {
      sourceCommit,
      commandAvailability: async () => true,
      commandRunner: async (invocation) =>
        commandResult(invocation, {
          exitCode: 1,
          stderr: "Authentication required. Please log in."
        })
    });

    expect(certification.status).toBe("SETUP_REQUIRED");
    expect(certification.checks).toContainEqual({
      id: "version_parse",
      status: "SETUP_REQUIRED",
      reason: "version_cli_login_required"
    });
  });

  it("fails a version or outbox contract regression and rejects artifact tampering", async () => {
    const root = await createInitializedProject();
    const certification = await certifyAgentCompatibility(root, "codex", {
      sourceCommit,
      commandAvailability: async () => true,
      commandRunner: async (invocation) => {
        if (invocation.args.includes("--version")) {
          return commandResult(invocation, { stdout: "unexpected version output" });
        }
        return commandResult(invocation);
      }
    });

    expect(certification.status).toBe("FAIL");
    expect(certification.checks).toContainEqual({
      id: "version_parse",
      status: "FAIL",
      reason: "version_unparseable"
    });
    expect(certification.smoke_status).toBe("no_output");

    const latestPath = path.join(
      root,
      ".kairon",
      "state",
      "agent-certifications",
      "codex",
      "latest.json"
    );
    const tampered = JSON.parse(await readFile(latestPath, "utf8")) as {
      version: string | null;
    };
    tampered.version = "999.0.0";
    await writeJsonFileAtomic(latestPath, tampered);
    await expect(readLatestCertification(root, "codex")).rejects.toThrow(
      "digest mismatch"
    );
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function successfulCommandRunner(
  root: string,
  versions: Partial<Record<AgentId, string>>
): CommandRunner {
  return async (invocation) => {
    if (invocation.args.includes("--version")) {
      const agent = agentForCommand(invocation.command);
      return commandResult(invocation, {
        stdout: `${versions[agent] ?? "agent-cli 1.0.0"}\n`
      });
    }

    const prompt = invocation.stdin ?? invocation.args.join("\n");
    await writeSmokeOutbox(root, prompt, agentForCommand(invocation.command));
    return commandResult(invocation, {
      stdout: "TOP_SECRET provider output was captured outside certification\n"
    });
  };
}

function successfulInteractiveRunner(): InteractiveSessionRunner {
  return async (job) => {
    await writeInteractiveOutbox(job);
    return commandResult(
      {
        command: job.command,
        args: ["--prompt-interactive"],
        cwd: job.cwd,
        timeoutMs: job.timeoutMs
      },
      { stdout: "TOP_SECRET interactive output\n" }
    );
  };
}

async function writeSmokeOutbox(
  root: string,
  prompt: string,
  agent: AgentId
): Promise<void> {
  const runId = /KAIRON_JOB_START (RUN-\d+)/u.exec(prompt)?.[1];
  const taskId = /Task: (TASK-\d+)/u.exec(prompt)?.[1];
  const outboxPath = /Expected outbox: (.+)/u.exec(prompt)?.[1];
  if (runId === undefined || taskId === undefined || outboxPath === undefined) {
    throw new Error("Smoke prompt contract was not provided.");
  }
  await writeJsonFileAtomic(path.join(root, outboxPath), {
    schema_version: "0.1",
    run_id: runId,
    task_id: taskId,
    agent,
    persona: "smoke",
    status: "completed",
    events: []
  });
}

async function writeInteractiveOutbox(job: InteractiveSessionJob): Promise<void> {
  await writeJsonFileAtomic(job.outboxPath, {
    schema_version: "0.1",
    run_id: job.runId,
    task_id: job.taskId,
    agent: job.agent,
    persona: job.persona,
    status: "completed",
    events: []
  });
}

function agentForCommand(command: string): AgentId {
  if (command === "codex") {
    return "codex";
  }
  if (command === "claude") {
    return "claude";
  }
  if (command === "agy") {
    return "gemini";
  }
  throw new Error(`Unexpected command: ${command}`);
}

function commandResult(
  invocation: CliInvocation,
  overrides: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 100,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:00:01.000Z",
    timedOut: false,
    ...overrides
  };
}
