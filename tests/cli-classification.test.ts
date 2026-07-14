import { describe, expect, it } from "vitest";
import { classifyCliRunResult } from "../src/agents/cli-classification.js";
import type { CommandRunResult } from "../src/agents/command-runner.js";

describe("classifyCliRunResult", () => {
  it("classifies an invalid Codex config as setup_required", () => {
    const result = classifyCliRunResult(
      "codex",
      commandResult(
        "Error loading config.toml: unknown variant `ultra` in `model_reasoning_effort`."
      )
    );

    expect(result).toMatchObject({
      status: "setup_required",
      reason: "cli_configuration_invalid",
      matched_pattern: "error loading config.toml"
    });
    expect(result.setup_action).toContain("config.toml");
  });

  it("classifies the Claude terms review gate as setup_required", () => {
    const result = classifyCliRunResult(
      "claude",
      commandResult(
        "An update to our Consumer Terms and Privacy Policy will take effect soon. Run `claude` to review the updated terms."
      )
    );

    expect(result).toMatchObject({
      status: "setup_required",
      reason: "cli_terms_acceptance_required",
      matched_pattern: "review the updated terms"
    });
    expect(result.setup_action).toContain("Run claude interactively");
  });
});

function commandResult(stderr: string): CommandRunResult {
  return {
    command: "agent-cli",
    args: [],
    cwd: ".",
    pid: 1,
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr,
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    timedOut: false
  };
}
