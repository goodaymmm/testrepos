import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProgram, isCliEntrypoint } from "../src/cli/main.js";
import { resolveAllowInteractiveAgents } from "../src/cli/commands/task.js";

describe("createProgram", () => {
  it("registers the documented top-level commands", () => {
    const commandNames = createProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual([
      "agent",
      "approval",
      "board",
      "cleanup",
      "config",
      "daemon",
      "deploy",
      "discord",
      "docking",
      "doctor",
      "git",
      "init",
      "leave",
      "maintenance",
      "merge",
      "migrate",
      "rag",
      "recovery",
      "release",
      "review",
      "start",
      "state",
      "status",
      "stop",
      "task",
      "test"
    ]);
  });

  it("detects npm link entrypoints through their real path", () => {
    const realEntrypoint = path.resolve("repo", "dist", "cli", "main.js");
    const linkedEntrypoint = path.resolve(
      "global",
      "node_modules",
      "kairon",
      "dist",
      "cli",
      "main.js"
    );
    const realpath = (filePath: string) =>
      filePath === linkedEntrypoint ? realEntrypoint : filePath;

    expect(
      isCliEntrypoint(
        pathToFileURL(realEntrypoint).href,
        linkedEntrypoint,
        realpath
      )
    ).toBe(true);
  });

  it("maps Commander --no-interactive-agents to task run dispatch options", () => {
    expect(
      resolveAllowInteractiveAgents({ interactiveAgents: false })
    ).toBe(false);
    expect(
      resolveAllowInteractiveAgents({ noInteractiveAgents: true })
    ).toBe(false);
    expect(resolveAllowInteractiveAgents({})).toBeUndefined();
  });

  it("registers maintenance RAG build option", () => {
    const maintenance = createProgram().commands.find(
      (command) => command.name() === "maintenance"
    );
    const run = maintenance?.commands.find((command) => command.name() === "run");

    expect(run?.options.map((option) => option.long)).toContain("--build-rag");
    expect(maintenance?.description()).toContain("operator artifacts");
    expect(run?.description()).toContain("daily report");
    expect(run?.description()).toContain("cleanup proposal");
    expect(run?.description()).toContain("recovery artifact");
  });

  it("documents status and recovery operational scope", () => {
    const program = createProgram();
    const status = program.commands.find((command) => command.name() === "status");
    const recovery = program.commands.find((command) => command.name() === "recovery");

    expect(status?.description()).toContain("artifact status");
    expect(recovery?.description()).toContain("Inspect and resolve");
  });

  it("registers daemon evidence report command", () => {
    const daemon = createProgram().commands.find(
      (command) => command.name() === "daemon"
    );
    const report = daemon?.commands.find((command) => command.name() === "report");

    expect(daemon?.description()).toContain("daemon evidence");
    expect(report?.description()).toContain("long-run evidence report");
    expect(report?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--since",
        "--format",
        "--output",
        "--heartbeat-gap-ms"
      ])
    );
  });

  it("registers state integrity and snapshot commands", () => {
    const state = createProgram().commands.find(
      (command) => command.name() === "state"
    );
    const check = state?.commands.find((command) => command.name() === "check");
    const snapshot = state?.commands.find(
      (command) => command.name() === "snapshot"
    );

    expect(state?.description()).toContain("file-based state integrity");
    expect(state?.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "snapshot"
    ]);
    expect(check?.options.map((option) => option.long)).toContain("--format");
    expect(snapshot?.description()).toContain("Restore is intentionally not implemented");
    expect(snapshot?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--dry-run", "--format"])
    );
  });

  it("registers board export and serve commands", () => {
    const board = createProgram().commands.find((command) => command.name() === "board");

    expect(board?.commands.map((command) => command.name()).sort()).toEqual([
      "export",
      "serve"
    ]);
    expect(
      board?.commands
        .find((command) => command.name() === "serve")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--host", "--port", "--recent", "--max-seconds"]));
  });

  it("registers agent session commands", () => {
    const agent = createProgram().commands.find(
      (command) => command.name() === "agent"
    );
    const session = agent?.commands.find((command) => command.name() === "session");

    expect(agent?.commands.map((command) => command.name()).sort()).toEqual([
      "session",
      "smoke"
    ]);
    expect(session?.commands.map((command) => command.name()).sort()).toEqual([
      "list",
      "reset",
      "show"
    ]);
    expect(
      session?.commands
        .find((command) => command.name() === "reset")
        ?.options.map((option) => option.long)
    ).toContain("--date");
  });

  it("registers cleanup proposal commands", () => {
    const cleanup = createProgram().commands.find(
      (command) => command.name() === "cleanup"
    );

    expect(cleanup?.commands.map((command) => command.name()).sort()).toEqual([
      "apply",
      "archive",
      "list",
      "show"
    ]);
    expect(
      cleanup?.commands
        .find((command) => command.name() === "apply")
        ?.options.map((option) => option.long)
    ).toContain("--dry-run");
  });

  it("registers runtime recovery target commands", () => {
    const recovery = createProgram().commands.find(
      (command) => command.name() === "recovery"
    );

    expect(recovery?.commands.map((command) => command.name()).sort()).toEqual([
      "acknowledge",
      "list",
      "resolve",
      "run",
      "show"
    ]);
    expect(
      recovery?.commands
        .find((command) => command.name() === "resolve")
        ?.options.map((option) => option.long)
    ).toContain("--reason");
  });

  it("registers operation test summary command", () => {
    const test = createProgram().commands.find((command) => command.name() === "test");
    const summarize = test?.commands.find((command) => command.name() === "summarize");
    const commands = test?.commands.find((command) => command.name() === "commands");

    expect(test?.description()).toContain("operation test results");
    expect(test?.commands.map((command) => command.name()).sort()).toEqual([
      "commands",
      "summarize"
    ]);
    expect(commands?.description()).toContain("Generate PowerShell commands");
    expect(commands?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--profile", "--range", "--format"])
    );
    expect(summarize?.description()).toContain("without editing docs");
    expect(summarize?.options.map((option) => option.long)).toContain("--result-root");
    expect(summarize?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--test-list", "--suggest", "--json", "--patch-preview"])
    );
  });

  it("registers RAG index commands and query filters", () => {
    const rag = createProgram().commands.find((command) => command.name() === "rag");

    expect(rag?.commands.map((command) => command.name()).sort()).toEqual([
      "compact",
      "query",
      "refresh",
      "status"
    ]);
    expect(
      rag?.commands
        .find((command) => command.name() === "refresh")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--compact", "--max-artifact-age-days"]));
    expect(
      rag?.commands
        .find((command) => command.name() === "compact")
        ?.options.map((option) => option.long)
    ).toContain("--max-artifact-age-days");
    expect(
      rag?.commands
        .find((command) => command.name() === "query")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--type",
        "--collection",
        "--limit",
        "--task-id",
        "--run-id",
        "--approval-id",
        "--review-id",
        "--review-loop-id",
        "--date",
        "--severity",
        "--explain"
      ])
    );
  });

  it("registers release helper commands", () => {
    const release = createProgram().commands.find(
      (command) => command.name() === "release"
    );

    expect(release?.commands.map((command) => command.name()).sort()).toEqual([
      "bump",
      "check",
      "notes"
    ]);
    expect(
      release?.commands
        .find((command) => command.name() === "notes")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--since", "--dry-run", "--write"]));
    expect(
      release?.commands
        .find((command) => command.name() === "bump")
        ?.options.map((option) => option.long)
    ).toEqual(expect.arrayContaining(["--type", "--version", "--dry-run", "--write"]));
  });

  it("registers merge and deploy dry-run approval commands", () => {
    const program = createProgram();
    const merge = program.commands.find((command) => command.name() === "merge");
    const deploy = program.commands.find((command) => command.name() === "deploy");

    expect(merge?.commands.map((command) => command.name())).toEqual(["dry-run"]);
    expect(deploy?.commands.map((command) => command.name())).toEqual(["dry-run"]);
    expect(
      merge?.commands
        .find((command) => command.name() === "dry-run")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--source",
        "--target",
        "--commit-range",
        "--check",
        "--rollback-hint",
        "--reason"
      ])
    );
    expect(
      deploy?.commands
        .find((command) => command.name() === "dry-run")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--target",
        "--environment",
        "--commit-range",
        "--check",
        "--rollback-hint",
        "--reason"
      ])
    );
  });

  it("registers git PR candidate commands", () => {
    const git = createProgram().commands.find((command) => command.name() === "git");
    const pr = git?.commands.find((command) => command.name() === "pr");

    expect(git?.description()).toContain("git artifacts");
    expect(pr?.commands.map((command) => command.name()).sort()).toEqual([
      "create",
      "list",
      "show"
    ]);
    expect(
      pr?.commands
        .find((command) => command.name() === "create")
        ?.options.map((option) => option.long)
    ).toEqual(
      expect.arrayContaining([
        "--dry-run",
        "--execute",
        "--approval-id",
        "--repository",
        "--draft",
        "--token-env"
      ])
    );
  });

  it("registers Discord HTTP interactions server command", () => {
    const discord = createProgram().commands.find(
      (command) => command.name() === "discord"
    );
    const http = discord?.commands.find((command) => command.name() === "http");
    const start = http?.commands.find((command) => command.name() === "start");

    expect(discord?.description()).toContain("Discord integration");
    expect(http?.description()).toContain("HTTP Interactions");
    expect(start?.description()).toContain("loopback-only");
    expect(start?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--host", "--port", "--max-seconds"])
    );
  });
});
