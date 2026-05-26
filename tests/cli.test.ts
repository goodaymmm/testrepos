import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProgram, isCliEntrypoint } from "../src/cli/main.js";

describe("createProgram", () => {
  it("registers the documented top-level commands", () => {
    const commandNames = createProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual([
      "agent",
      "config",
      "docking",
      "doctor",
      "init",
      "leave",
      "maintenance",
      "migrate",
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
});
