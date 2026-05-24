import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/main.js";

describe("createProgram", () => {
  it("registers the documented top-level commands", () => {
    const commandNames = createProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(commandNames).toEqual([
      "doctor",
      "init",
      "leave",
      "maintenance",
      "start",
      "status",
      "stop",
      "task"
    ]);
  });
});
