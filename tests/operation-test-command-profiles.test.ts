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

  it("rejects invalid output formats at the CLI command boundary", () => {
    expect(() =>
      generateOperationTestCommandsCommand({ format: "yaml" })
    ).toThrow("Invalid --format: yaml. Expected powershell or json.");
  });
});
