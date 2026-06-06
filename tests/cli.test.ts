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
      "config",
      "docking",
      "doctor",
      "init",
      "leave",
      "maintenance",
      "migrate",
      "recovery",
      "review",
      "start",
      "status",
      "stop",
      "task"
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
    ).toEqual(expect.arrayContaining(["--host", "--port", "--recent"]));
  });
});
