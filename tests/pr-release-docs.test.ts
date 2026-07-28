import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PR and release documentation", () => {
  it("exposes stable machine-readable anchors for PR template checks", async () => {
    const template = await readUtf8(".github/pull_request_template.md");

    expect(template).toContain("<!-- kairon:purpose -->");
    expect(template).toContain("<!-- kairon:changes -->");
    expect(template).toContain("<!-- kairon:tests -->");
    expect(template).toContain("<!-- kairon:manual-operation-test -->");
    expect(template).toContain("<!-- kairon:readme-update -->");
    expect(template).toContain("<!-- kairon:evidence -->");
    expect(template).toContain("<!-- kairon:follow-up -->");
    expect(template).toContain("検証");
  });

  it("exposes stable anchors for manual result and generated artifact policy checks", async () => {
    const manualResults = await readUtf8("docs/manual-test-results-v0.md");
    const checklist = await readUtf8("docs/pr-release-checklist-v0.md");

    expect(manualResults).toContain("<!-- kairon:pr-body-policy -->");
    expect(manualResults).toContain("<!-- kairon:generated-artifact-policy -->");
    expect(checklist).toContain("<!-- kairon:pr-body-policy -->");
    expect(checklist).toContain("<!-- kairon:readme-update -->");
    expect(checklist).toContain("<!-- kairon:generated-artifact-policy -->");
    expect(checklist).toContain("-Encoding UTF8");
  });

  it("keeps README links to the operation test and release documents", async () => {
    const readme = await readUtf8("README.md");

    expect(readme).toContain(".github/workflows/ci.yml");
    expect(readme).toContain("docs/operation-test-harness-v0.md");
    expect(readme).toContain("docs/github-branch-protection-sandbox-v0.md");
    expect(readme).toContain("docs/manual-test-results-v0.md");
    expect(readme).toContain("docs/pr-release-checklist-v0.md");
    expect(readme).toContain("docs/release-checklist-v0.md");
    expect(readme).toContain("docs/release-provenance-v0.md");
    expect(readme).toContain("docs/release-notes-v0.md");
    expect(readme).toContain("docs/installation.md");
  });

  it("documents private Stable Local packaging and state-preserving uninstall", async () => {
    const installation = await readUtf8("docs/installation.md");
    const commands = await readUtf8("docs/cli-commands-v0.md");
    const checklist = await readUtf8("docs/release-checklist-v0.md");

    expect(installation).toContain("npm run release:pack");
    expect(installation).toContain("kairon release verify");
    expect(installation).toContain("kairon release manifest");
    expect(installation).toContain("release-manifest.json");
    expect(installation).toContain("install-local-beta.ps1");
    expect(installation).toContain("update-local-beta.ps1");
    expect(installation).toContain("uninstall-local-beta.ps1");
    expect(installation).toContain("`.kairon/`");
    expect(installation).toContain("削除しません");
    expect(commands).toContain("kairon release pack");
    expect(commands).toContain("kairon release verify");
    expect(commands).toContain("kairon release manifest");
    expect(commands).toContain("kairon release sbom");
    expect(commands).toContain("kairon release provenance");
    expect(commands).toContain("--verification-context source|consumer");
    expect(installation).toContain("--verification-context consumer");
    expect(commands).toContain("kairon release github plan");
    expect(commands).toContain("kairon release github publish");
    expect(commands).toContain("kairon release github verify");
    expect(checklist).toContain("<!-- kairon:github-release-distribution -->");
    expect(checklist).toContain("docs/release-provenance-v0.md");
  });

  it("documents deterministic SBOM and local build provenance boundaries", async () => {
    const provenance = await readUtf8("docs/release-provenance-v0.md");

    expect(provenance).toContain("<!-- kairon:release-provenance-sbom -->");
    expect(provenance).toContain("CycloneDX JSON 1.6");
    expect(provenance).toContain("kairon_local_build_provenance");
    expect(provenance).toContain("SLSA認証や署名済みattestationを称しない");
    expect(provenance).toContain("kairon release sbom");
    expect(provenance).toContain("kairon release provenance");
    expect(provenance).toContain("## Verification context");
    expect(provenance).toContain("source_tree_check");
    expect(provenance).toContain("artifact_source_binding");
    expect(provenance).toContain("token");
    expect(provenance).toContain("絶対path");
  });

  it("documents GitHub branch protection sandbox and token redaction policy", async () => {
    const sandbox = await readUtf8("docs/github-branch-protection-sandbox-v0.md");
    const harness = await readUtf8("docs/operation-test-harness-v0.md");

    expect(sandbox).toContain("token値を出力しない");
    expect(sandbox).toContain("GH_TOKEN");
    expect(sandbox).toContain("GITHUB_TOKEN");
    expect(sandbox).toContain("present");
    expect(sandbox).toContain("missing");
    expect(sandbox).toContain("goodaymmm/14Forge");
    expect(sandbox).toContain("Administration: Read-only");
    expect(sandbox).toContain("api_status=plan_or_permission_error");
    expect(sandbox).toContain("http_status=403");
    expect(sandbox).toContain("public sandbox");
    expect(harness).toContain("BranchProtectionPublicSandbox");
    expect(harness).toContain("SETUP_REQUIRED");
    expect(harness).toContain("token値を出力しない");
  });

  it("documents release readiness and versioning policy", async () => {
    const readme = await readUtf8("README.md");
    const checklist = await readUtf8("docs/release-checklist-v0.md");
    const notes = await readUtf8("docs/release-notes-v0.md");
    const prChecklist = await readUtf8("docs/pr-release-checklist-v0.md");

    expect(readme).toContain("<!-- kairon:t192-stable-baseline -->");
    expect(readme).toContain("Stable Local Release baseline");
    expect(readme).toContain("<!-- kairon:t175-rc-baseline -->");
    expect(readme).toContain("<!-- kairon:t177-local-rc-baseline -->");
    expect(checklist).toContain("<!-- kairon:release-readiness -->");
    expect(checklist).toContain("<!-- kairon:versioning-policy -->");
    expect(checklist).toContain("<!-- kairon:release-evidence -->");
    expect(checklist).toContain("<!-- kairon:t175-rc-validation-baseline -->");
    expect(checklist).toContain("npm run build");
    expect(checklist).toContain("npm test");
    expect(checklist).toContain("kairon release validate");
    expect(checklist).toContain("kairon readiness rc check");
    expect(checklist).toContain("<!-- kairon:t190-stable-readiness -->");
    expect(checklist).toContain("<!-- kairon:t192-stable-baseline -->");
    expect(checklist).toContain("kairon readiness stable check");
    expect(checklist).toContain("stable_ready=true");
    expect(checklist).toContain("14 gateがすべて`PASS`");
    expect(checklist).toContain("rc_ready=true");
    expect(checklist).toContain("external_required");
    expect(notes).toContain("<!-- kairon:release-notes-unreleased -->");
    expect(notes).toContain("<!-- kairon:versioning-policy -->");
    expect(notes).toContain("## 0.3.0 - 2026-07-28");
    expect(notes).toContain("現在のStable Local Release versionは `0.3.0`");
    expect(notes).toContain("T191");
    expect(notes).toContain("kairon release validate");
    expect(prChecklist).toContain("docs/release-checklist-v0.md");
    expect(prChecklist).toContain("docs/release-notes-v0.md");
  });

  it("documents the Release Candidate readiness command and artifacts", async () => {
    const commands = await readUtf8("docs/cli-commands-v0.md");
    const checklist = await readUtf8("docs/release-checklist-v0.md");

    for (const command of ["manifest", "check", "report"]) {
      expect(commands).toContain(`kairon readiness rc ${command}`);
      expect(checklist).toContain(`kairon readiness rc ${command}`);
    }
    expect(commands).toContain("rc-evidence-manifest.json");
    expect(commands).toContain("rc-result.json");
    expect(commands).toContain("rc-report.md");
    expect(commands).toContain("high / critical incident");
  });

  it("documents the Stable readiness decision and non-automatic promotion", async () => {
    const commands = await readUtf8("docs/cli-commands-v0.md");
    const checklist = await readUtf8("docs/release-checklist-v0.md");
    const notes = await readUtf8("docs/release-notes-v0.md");

    for (const command of ["manifest", "check", "report"]) {
      expect(commands).toContain(`kairon readiness stable ${command}`);
      expect(checklist).toContain(`kairon readiness stable ${command}`);
    }
    expect(commands).toContain("stable-evidence-manifest.json");
    expect(commands).toContain("stable-result.json");
    expect(commands).toContain("stable-report.md");
    expect(checklist).toContain("16 gate");
    expect(checklist).toContain("exact-ID cleanup");
    expect(checklist).toContain("Stable昇格はapproval-bound");
    expect(notes).toContain("T190");
    expect(notes).toContain("global blocker");
  });

  it("documents Discord HTTP Interactions signature verification", async () => {
    const approval = await readUtf8("docs/discord-approval-v0.md");

    expect(approval).toContain("HTTP Interactions");
    expect(approval).toContain("signature");
    expect(approval).toContain("Gateway");
    expect(approval).toContain("TLS");
  });

  it("documents the Windows daemon task CLI and dry-run safety", async () => {
    const guide = await readUtf8("docs/windows-daemon-ops-v0.md");
    const commands = await readUtf8("docs/cli-commands-v0.md");

    for (const command of ["status", "install", "uninstall", "restart"]) {
      expect(guide).toContain(`kairon daemon task ${command}`);
      expect(commands).toContain(`kairon daemon task ${command}`);
    }
    expect(guide).toContain("--dry-run");
    expect(guide).toContain("secret_values=not_in_task_arguments");
    expect(commands).toContain("status=setup_required");
  });

  it("keeps package and CLI versions synchronized", async () => {
    const packageJson = JSON.parse(await readUtf8("package.json")) as {
      version: string;
    };
    const packageLock = JSON.parse(await readUtf8("package-lock.json")) as {
      version: string;
      packages: { "": { version: string } };
    };
    const index = await readUtf8("src/index.ts");

    expect(index).toContain(`KAIRON_VERSION = "${packageJson.version}"`);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
  });

  it("keeps CI scoped to deterministic local checks", async () => {
    const workflow = await readUtf8(".github/workflows/ci.yml");
    const packageJson = JSON.parse(await readUtf8("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:docs"]).toBe(
      "vitest run tests/pr-release-docs.test.ts tests/documentation-inventory.test.ts"
    );
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run test:docs");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm test");
    expect(workflow).not.toContain("GH_TOKEN");
    expect(workflow).not.toContain("GITHUB_TOKEN");
    expect(workflow).not.toContain("KAIRON_DISCORD_BOT_TOKEN");
    expect(workflow).not.toContain("kairon doctor");
    expect(workflow).not.toContain("kairon start");
  });
});

async function readUtf8(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}
