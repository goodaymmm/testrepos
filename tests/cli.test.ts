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
      "docking",
      "doctor",
      "init",
      "leave",
      "maintenance",
      "migrate",
      "rag",
      "recovery",
      "review",
      "start",
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

    expect(test?.description()).toContain("operation test results");
    expect(summarize?.description()).toContain("without editing docs");
    expect(summarize?.options.map((option) => option.long)).toContain("--result-root");
    expect(summarize?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--test-list", "--suggest", "--json", "--patch-preview"])
    );
  });

  it("registers RAG index commands and query filters", () => {
    const rag = createProgram().commands.find((command) => command.name() === "rag");

    expect(rag?.commands.map((command) => command.name()).sort()).toEqual([
      "query",
      "refresh",
      "status"
    ]);
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
        "--severity"
      ])
    );
  });
});
