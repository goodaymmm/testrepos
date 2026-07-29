import { describe, expect, it } from "vitest";
import { generateOperationTestCommandsCommand } from "../src/cli/commands/test-commands.js";
import {
  formatOperationTestCommandProfiles,
  resolveOperationTestCommandProfiles
} from "../src/operation-test/command-profiles.js";

describe("operation test command profiles", () => {
  it("generates PowerShell for a profile using a temporary .mjs script", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["t116-alias"]
    });

    expect(output).toContain("# Kairon operation test commands");
    expect(output).toContain("# Profile: t116-alias");
    expect(output).toContain("$T116_ALIAS_SCRIPT = Join-Path $RESULT_ROOT \"t116-alias-fixture.mjs\"");
    expect(output).toContain("'@ | Set-Content -LiteralPath $T116_ALIAS_SCRIPT -Encoding UTF8");
    expect(output).toContain("node $T116_ALIAS_SCRIPT $RESULT_ROOT");
    expect(output).toContain("kairon test summarize $T116_ALIAS_LOG `");
    expect(output).not.toContain("${step.variable}");
    expect(output).toContain("aliases.total=2");
    expect(output).not.toContain("node -e");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
  });

  it("filters profiles by task range", () => {
    const resolution = resolveOperationTestCommandProfiles({
      range: "T116-T117"
    });

    expect(resolution.selected_tasks).toEqual(["T116", "T117"]);
    expect(resolution.profiles.map((profile) => profile.id)).toEqual([
      "t116-alias",
      "t117-command-profiles-unit"
    ]);
  });

  it("prints JSON for selected profiles without secret values", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["branch-protection-public-sandbox"],
      format: "json"
    });
    const parsed = JSON.parse(output) as {
      profiles: Array<{ id: string; required_env: string[] }>;
    };

    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({
      id: "branch-protection-public-sandbox",
      required_env: ["GH_TOKEN or GITHUB_TOKEN"]
    });
    expect(output).toContain("KAIRON_GITHUB_EXPECTED_STATUS_CHECKS");
    expect(output).not.toContain("Bearer ");
  });

  it("rejects unknown profiles for PowerShell output", () => {
    const resolution = resolveOperationTestCommandProfiles({
      profiles: ["missing-profile"]
    });

    expect(() => formatOperationTestCommandProfiles(resolution)).toThrow(
      "Unknown operation test command profile: missing-profile"
    );
  });

  it("generates the Stable acceptance bundle profile without credential values", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["stable-acceptance"]
    });

    expect(output).toContain("# Profile: stable-acceptance");
    expect(output).toContain("--template");
    expect(output).toContain("\"stable-acceptance\"");
    expect(output).toContain("--result-root");
    expect(output).toContain("KAIRON_STABLE_PREVIOUS_RESULT_ROOT");
    expect(output).toContain("source_commit is bound to Git HEAD");
    expect(output).not.toContain("Bearer ");
    expect(output).not.toContain("github_pat_");
  });

  it("generates the T195 Stable canary profile without source checkout or token values", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["stable-canary"]
    });

    expect(output).toContain("# Profile: stable-canary");
    expect(output).toContain("Tasks: T195");
    expect(output).toContain("kairon-stable-canary.ps1");
    expect(output).toContain("KAIRON_STABLE_VERIFICATION_PATH");
    expect(output).toContain("unknown_sandbox_terminated=false");
    expect(output).not.toContain("npm link");
    expect(output).not.toContain("GH_TOKEN=");
    expect(output).not.toContain("github_pat_");
  });

  it("generates the T196 post-release health profile without automatic rollback", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["post-release-health"]
    });

    expect(output).toContain("# Profile: post-release-health");
    expect(output).toContain("Tasks: T196");
    expect(output).toContain("\"release\", \"health\", \"check\"");
    expect(output).toContain("KAIRON_POST_RELEASE_VERIFICATION_PATH");
    expect(output).toContain("KAIRON_POST_RELEASE_TRANSACTION");
    expect(output).toContain("rollback_automatic=false");
    expect(output).toContain("approval_automatic=false");
    expect(output).not.toContain("update rollback");
    expect(output).not.toContain("GH_TOKEN=");
  });

  it("generates the T197 scheduled update profile without secret values or apply", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["scheduled-update-check"]
    });

    expect(output).toContain("# Profile: scheduled-update-check");
    expect(output).toContain("Tasks: T197");
    expect(output).toContain("update schedule install");
    expect(output).toContain("update schedule run");
    expect(output).toContain("update schedule uninstall");
    expect(output).toContain("mutation_detected=false");
    expect(output).toContain("automatic_download=false");
    expect(output).not.toContain("update apply");
    expect(output).not.toContain("update rollback");
    expect(output).not.toContain("GH_TOKEN=");
    expect(output).not.toContain("github_pat_");
  });

  it("generates the T198 rollout profile without automatic update execution", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["multi-project-rollout"]
    });

    expect(output).toContain("# Profile: multi-project-rollout");
    expect(output).toContain("Tasks: T198");
    expect(output).toContain("projects rollout group");
    expect(output).toContain("projects rollout plan");
    expect(output).toContain("projects rollout show");
    expect(output).toContain("execution_performed=false");
    expect(output).toContain("automatic_update=false");
    expect(output).not.toContain("kairon update apply");
    expect(output).not.toContain("kairon update rollback");
    expect(output).not.toContain("GH_TOKEN=");
  });

  it("generates the T199 Stable soak profile without weakening the real-time gate", () => {
    const output = generateOperationTestCommandsCommand({
      profile: ["stable-soak-certification"]
    });

    expect(output).toContain("# Profile: stable-soak-certification");
    expect(output).toContain("Tasks: T199");
    expect(output).toContain("daemon soak start");
    expect(output).toContain("--minimum-hours 168");
    expect(output).toContain("daemon soak status");
    expect(output).toContain("daemon soak report");
    expect(output).toContain("After 168 real-time hours");
    expect(output).toContain("simulated clock evidence is SETUP_REQUIRED");
    expect(output).not.toMatch(
      /--minimum-hours (?:[1-9]|[1-9]\d|1[0-5]\d|16[0-7])(?:\r?\n|$)/u
    );
    expect(output).not.toContain("GH_TOKEN=");
  });

  it("rejects invalid output formats at the CLI command boundary", () => {
    expect(() =>
      generateOperationTestCommandsCommand({ format: "yaml" })
    ).toThrow("Invalid --format: yaml. Expected powershell or json.");
  });
});
