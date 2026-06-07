import { describe, expect, it } from "vitest";
import {
  buildProcessInvocation,
  type CommandRunResult
} from "../src/agents/command-runner.js";
import { classifyCliRunResult } from "../src/agents/cli-classification.js";

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

  it("classifies CLI authentication, rate limit, permission, timeout, and no-output results", () => {
    expect(
      classifyCliRunResult(
        "codex",
        commandResult({ stderr: "Error: login required. Please log in." })
      )
    ).toMatchObject({
      status: "setup_required",
      reason: "cli_login_required",
      setup_action: expect.stringContaining("codex login")
    });

    expect(
      classifyCliRunResult(
        "claude",
        commandResult({
          stdout: '{"error":"rate_limit","retry_after":"45s"}'
        })
      )
    ).toMatchObject({
      status: "rate_limited",
      reason: "cli_rate_limited",
      retry_after: "45s"
    });

    expect(
      classifyCliRunResult(
        "claude",
        commandResult({
          stdout: "Usage limit reached for the current billing period."
        })
      )
    ).toMatchObject({
      status: "usage_limited",
      reason: "cli_usage_limited",
      resume_hint: expect.stringContaining("Pause this agent")
    });

    expect(
      classifyCliRunResult(
        "gemini",
        commandResult({ stderr: "Approval required: allow this command?" })
      )
    ).toMatchObject({
      status: "permission_required",
      reason: "cli_permission_required",
      resume_hint: expect.stringContaining("permission prompt")
    });

    expect(
      classifyCliRunResult("codex", commandResult({ timedOut: true }))
    ).toMatchObject({
      status: "timeout",
      reason: "cli_timeout"
    });

    expect(classifyCliRunResult("claude", commandResult())).toMatchObject({
      status: "no_output",
      reason: "cli_no_output"
    });
  });
});

function commandResult(
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: "codex",
    args: [],
    cwd: ".",
    pid: 1234,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-05-25T00:00:00.000Z",
    finishedAt: "2026-05-25T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}
