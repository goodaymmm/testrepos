import { describe, expect, it } from "vitest";
import { buildProcessInvocation } from "../src/agents/command-runner.js";

describe("buildProcessInvocation", () => {
  it("runs commands directly on non-Windows platforms", () => {
    const invocation = buildProcessInvocation(
      {
        command: "codex",
        args: ["exec", "-"],
        cwd: ".",
        env: { PATH: "test-path" }
      },
      "linux"
    );

    expect(invocation).toEqual({
      command: "codex",
      args: ["exec", "-"],
      env: { PATH: "test-path" },
      shell: false
    });
  });

  it("uses the shell for Windows command shims", () => {
    const invocation = buildProcessInvocation(
      {
        command: "codex",
        args: ["exec", "-"],
        cwd: ".",
        env: { PATH: "test-path" }
      },
      "win32"
    );

    expect(invocation).toEqual({
      command: "codex",
      args: ["exec", "-"],
      env: { PATH: "test-path" },
      shell: true
    });
  });

  it("keeps Windows exe commands direct so multiline prompt args are preserved", () => {
    const invocation = buildProcessInvocation(
      {
        command: "agy",
        args: ["--print", "line 1\nline 2"],
        cwd: ".",
        env: { PATH: "test-path" }
      },
      "win32"
    );

    expect(invocation.shell).toBe(false);
  });
});
