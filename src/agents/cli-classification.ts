import type { CommandRunResult } from "./command-runner.js";
import type { AgentId } from "./types.js";

export type CliRunClassificationStatus =
  | "completed"
  | "failed"
  | "setup_required"
  | "permission_required"
  | "rate_limited"
  | "usage_limited"
  | "timeout"
  | "no_output";

export type CliRunClassification = {
  status: CliRunClassificationStatus;
  reason: string;
  message: string;
  setup_action?: string;
  resume_hint?: string;
  retry_after?: string;
  matched_pattern?: string;
};

type PatternMatch = {
  pattern: string;
  matched: boolean;
};

export function classifyCliRunResult(
  agent: AgentId,
  result: CommandRunResult
): CliRunClassification {
  const output = `${result.stdout}\n${result.stderr}`;
  const normalized = removeAllowedRateLimitEvents(output).toLowerCase();

  if (result.timedOut) {
    return {
      status: "timeout",
      reason: "cli_timeout",
      message: "Agent CLI timed out before writing a valid outbox."
    };
  }

  const ptyUnavailable = firstMatch(normalized, [
    "pty_spawn_failed",
    "pty spawn failed"
  ]);
  if (ptyUnavailable !== undefined) {
    return {
      status: "setup_required",
      reason: "cli_pty_unavailable",
      message:
        "Agent CLI requires a PTY adapter, but the PTY process could not be started.",
      setup_action:
        "Install or repair the PTY runner dependencies, then retry the Kairon command.",
      matched_pattern: ptyUnavailable.pattern
    };
  }

  const ptyCommandMissing = firstMatch(normalized, ["pty_command_unresolved"]);
  if (ptyCommandMissing !== undefined) {
    return {
      status: "setup_required",
      reason: "cli_pty_command_unresolved",
      message:
        "Agent CLI requires a PTY adapter, but the configured command could not be resolved to an executable.",
      setup_action: setupActionFor(agent, "command"),
      matched_pattern: ptyCommandMissing.pattern
    };
  }

  const rateLimit = firstMatch(normalized, [
    '"error":"rate_limit"',
    '"error": "rate_limit"',
    "rate_limit",
    "rate limit",
    "too many requests",
    "http 429",
    "status 429",
    "code 429"
  ]);
  if (rateLimit !== undefined) {
    return {
      status: "rate_limited",
      reason: "cli_rate_limited",
      message:
        "Agent CLI is rate limited. Do not retry automatically; retry after the provider reset window.",
      resume_hint:
        "Defer this agent until the provider reset window or retry_after has passed.",
      retry_after: extractRetryAfter(output),
      matched_pattern: rateLimit.pattern
    };
  }

  const usageLimit = firstMatch(normalized, [
    "usage limit",
    "usage limit reached",
    "you've hit your limit",
    "quota exceeded",
    "quota exhausted",
    "monthly limit",
    "weekly limit",
    "daily limit",
    "usage cap",
    "spending limit",
    "billing limit",
    "credit balance"
  ]);
  if (usageLimit !== undefined) {
    return {
      status: "usage_limited",
      reason: "cli_usage_limited",
      message:
        "Agent CLI usage is limited by provider quota or billing. Do not retry automatically.",
      setup_action:
        "Check provider usage, billing, or subscription limits, then retry after capacity is restored.",
      resume_hint:
        "Pause this agent for automated dispatch until quota or billing capacity is restored.",
      matched_pattern: usageLimit.pattern
    };
  }

  const permission = firstMatch(normalized, [
    "permission prompt",
    "requires approval",
    "approval required",
    "tool permission",
    "allow this command",
    "confirm this command",
    "permission denied by user",
    "workspace trust",
    "trust this workspace"
  ]);
  if (permission !== undefined) {
    return {
      status: "permission_required",
      reason: "cli_permission_required",
      message:
        "Agent CLI is waiting for a permission or trust prompt. Kairon will not auto-approve it.",
      setup_action:
        "Complete the CLI permission prompt in an interactive trusted session, then retry.",
      resume_hint:
        "Retry only after the provider UI permission prompt has been handled by a human.",
      matched_pattern: permission.pattern
    };
  }

  const invalidConfiguration = firstMatch(normalized, [
    "error loading config.toml",
    "model_reasoning_effort",
    "failed to parse config.toml"
  ]);
  if (invalidConfiguration !== undefined) {
    return {
      status: "setup_required",
      reason: "cli_configuration_invalid",
      message: "Agent CLI configuration is invalid.",
      setup_action:
        agent === "codex"
          ? "Fix the reported Codex config.toml setting, then retry the Kairon command."
          : "Fix the reported agent CLI configuration, then retry the Kairon command.",
      resume_hint: "Retry after the CLI starts successfully with the corrected configuration.",
      matched_pattern: invalidConfiguration.pattern
    };
  }

  const termsAcceptance =
    agent === "claude"
      ? firstMatch(normalized, [
          "review the updated terms",
          "consumer terms and privacy policy will take effect",
          "terms acceptance required"
        ])
      : undefined;
  if (termsAcceptance !== undefined) {
    return {
      status: "setup_required",
      reason: "cli_terms_acceptance_required",
      message: "Claude Code requires an interactive terms review before automation can continue.",
      setup_action:
        "Run claude interactively, review the displayed terms, and complete the required confirmation.",
      resume_hint: "Retry after Claude Code exits the terms review flow normally.",
      matched_pattern: termsAcceptance.pattern
    };
  }

  const login = firstMatch(normalized, [
    "login required",
    "not logged in",
    "please log in",
    "authentication required",
    "auth required",
    "unauthorized",
    "not authenticated",
    "no api key",
    "api key required",
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "oauth"
  ]);
  if (login !== undefined) {
    return {
      status: "setup_required",
      reason: "cli_login_required",
      message: "Agent CLI authentication is not configured.",
      setup_action: setupActionFor(agent, "login"),
      resume_hint: "Retry after CLI authentication has been completed.",
      matched_pattern: login.pattern
    };
  }

  if (result.exitCode === 0) {
    return {
      status: "completed",
      reason: "cli_completed",
      message: "Agent CLI process completed."
    };
  }

  if (output.trim().length === 0) {
    return {
      status: "no_output",
      reason: "cli_no_output",
      message: "Agent CLI exited without stdout, stderr, or a valid outbox."
    };
  }

  return {
    status: "failed",
    reason: "cli_failed",
    message: "Agent CLI failed before writing a valid outbox."
  };
}

export function classificationForSetupRequired(input: {
  agent: AgentId;
  reason: "cli_command_missing" | "cli_pty_required";
  command: string;
}): CliRunClassification {
  if (input.reason === "cli_command_missing") {
    return {
      status: "setup_required",
      reason: input.reason,
      message: `${input.command} is not available.`,
      setup_action: setupActionFor(input.agent, "command"),
      resume_hint: "Retry after the configured CLI command is available on PATH."
    };
  }

  return {
    status: "setup_required",
    reason: input.reason,
    message: `${input.command} requires an interactive terminal or PTY adapter for Kairon automation.`,
    setup_action:
      "Configure an interactive session runner or PTY adapter for this CLI, then retry.",
    resume_hint:
      "Retry after an interactive session runner or PTY adapter is configured."
  };
}

function firstMatch(value: string, patterns: string[]): PatternMatch | undefined {
  for (const pattern of patterns) {
    if (value.includes(pattern)) {
      return { pattern, matched: true };
    }
  }

  return undefined;
}

function removeAllowedRateLimitEvents(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !isAllowedRateLimitEvent(line))
    .join("\n");
}

function isAllowedRateLimitEvent(line: string): boolean {
  try {
    const event = JSON.parse(line.trim()) as {
      type?: unknown;
      rate_limit_info?: {
        status?: unknown;
      };
    };

    return (
      event.type === "rate_limit_event" &&
      event.rate_limit_info?.status === "allowed"
    );
  } catch {
    return false;
  }
}

function extractRetryAfter(output: string): string | undefined {
  const retryAfter =
    /retry[_ -]?after["']?\s*[:=]\s*["']?([^"',\s}]+)/i.exec(output)?.[1] ??
    /retry after\s+([^\r\n.]+)/i.exec(output)?.[1];

  return retryAfter?.trim();
}

function setupActionFor(agent: AgentId, kind: "login" | "command"): string {
  if (kind === "command") {
    if (agent === "gemini") {
      return "Install Antigravity CLI and ensure agy is available on PATH.";
    }

    return `Install ${agent} CLI and ensure it is available on PATH.`;
  }

  if (agent === "codex") {
    return "Run codex login, then retry the Kairon command.";
  }

  if (agent === "claude") {
    return "Run Claude Code authentication setup, then retry the Kairon command.";
  }

  return "Complete Antigravity authentication, then retry the Kairon command.";
}
