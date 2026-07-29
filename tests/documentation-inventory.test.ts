import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/main.js";
import { createDefaultConfigs } from "../src/core/config/defaults.js";

describe("T192 documentation inventory", () => {
  it("identifies the current 0.3.0 Stable Local Release boundary", async () => {
    const readme = await readUtf8("README.md");

    expect(readme).toContain("<!-- kairon:t192-stable-baseline -->");
    expect(readme).toContain("Stable Local Release baseline");
    expect(readme).toContain("Stable Readiness 16 gate");
    expect(readme).toContain("Stable Acceptanceは18 / 18 scenario");
    expect(readme).toContain("stable_ready=true");
    expect(readme).toContain("global blocker 0件");
    expect(readme).toContain("現在のStable Local Release versionは `0.3.0`");
    expect(readme).toContain("24時間daemon");
    expect(readme).toContain("production workflow");
    expect(readme).toContain("HTTP Interactions");
    expect(readme).toContain("remote-readonly");
    expect(readme).toContain("install / update / rollback / uninstall");
    expect(readme).not.toContain("T67-T75完了後も残る主な後続作業の範囲");
    expect(readme).not.toContain("LangGraph workflow runtime の本格導入");
    expect(readme).not.toContain("cloud / public HTTP endpoint でのDiscord Interactions運用");
    expect(readme).not.toContain("<!-- kairon:t159-beta-baseline -->");
  });

  it("keeps the Stable baseline synchronized across operator documents", async () => {
    const baselines = [
      {
        path: "README.md",
        marker: "<!-- kairon:t192-stable-baseline -->",
        baseline: "T191"
      },
      {
        path: "docs/architecture-v0.md",
        marker: "<!-- kairon:t192-stable-architecture-baseline -->",
        baseline: "T191"
      },
      {
        path: "docs/installed-architecture-v0.md",
        marker: "<!-- kairon:t192-stable-installed-baseline -->",
        baseline: "T191"
      },
      {
        path: "docs/release-checklist-v0.md",
        marker: "<!-- kairon:t192-stable-baseline -->",
        baseline: "T191"
      },
      {
        path: "docs/installation.md",
        marker: "<!-- kairon:t192-stable-distribution -->",
        baseline: "T191"
      }
    ];

    for (const baseline of baselines) {
      const document = await readUtf8(baseline.path);
      expect(document, `missing Stable baseline in ${baseline.path}`).toContain(
        baseline.marker
      );
      expect(document, `missing ${baseline.baseline} baseline wording in ${baseline.path}`).toContain(
        baseline.baseline
      );
      expect(document, `missing Stable Local Release wording in ${baseline.path}`).toContain(
        "Stable Local Release"
      );
    }

    const readme = await readUtf8("README.md");
    const daemon = await readUtf8("docs/windows-daemon-ops-v0.md");
    const remote = await readUtf8("docs/stable-remote-operations-v0.md");
    expect(readme).toContain("<!-- kairon:t175-rc-baseline -->");
    expect(readme).toContain("<!-- kairon:t177-local-rc-baseline -->");
    expect(daemon).toContain("<!-- kairon:t175-daemon-baseline -->");
    expect(remote).toContain("<!-- kairon:t175-stable-remote-baseline -->");
    expect(daemon).not.toContain("<!-- kairon:t159-daemon-baseline -->");
  });

  it("documents every registered top-level CLI command", async () => {
    const commands = await readUtf8("docs/cli-commands-v0.md");
    const registered = createProgram().commands.map((command) => command.name());

    for (const command of registered) {
      expect(commands, `missing CLI documentation for ${command}`).toContain(
        `kairon ${command}`
      );
    }
  });

  it("documents every generated default config file", async () => {
    const architecture = await readUtf8("docs/architecture-v0.md");
    const defaults = createDefaultConfigs("C:\\kairon-documentation-inventory");

    for (const filename of Object.keys(defaults)) {
      expect(architecture, `missing config documentation for ${filename}`).toContain(
        filename
      );
    }
  });

  it("binds major implemented modules to operator documentation", async () => {
    const documents = {
      readme: await readUtf8("README.md"),
      daemon: await readUtf8("docs/windows-daemon-ops-v0.md"),
      installation: await readUtf8("docs/installation.md"),
      release: await readUtf8("docs/release-checklist-v0.md"),
      provenance: await readUtf8("docs/release-provenance-v0.md"),
      schema: await readUtf8("docs/schema-evolution-v0.md"),
      workflow: await readUtf8("docs/workflow-v0.md"),
      watchdog: await readUtf8("docs/runtime-watchdog-v0.md"),
      incident: await readUtf8("docs/incident-lifecycle-v0.md"),
      cli: await readUtf8("docs/cli-commands-v0.md"),
      remote: await readUtf8("docs/stable-remote-operations-v0.md"),
      disasterRecovery: await readUtf8("docs/disaster-recovery-v0.md"),
      performance: await readUtf8("docs/performance-budget-v0.md"),
      security: await readUtf8("docs/security-baseline-v0.md"),
      threatModel: await readUtf8("docs/threat-model-v0.md"),
      stableAcceptance: await readUtf8("docs/stable-acceptance-v0.md"),
      agentSession: await readUtf8("docs/agent-session-v0.md"),
      diagnosticsTriage: await readUtf8("docs/diagnostics-triage-v0.md")
    };
    const inventory = [
      {
        source: "src/runtime/daemon-certification.ts",
        document: documents.daemon,
        marker: "daemon certify"
      },
      {
        source: "src/runtime/watchdog.ts",
        document: documents.watchdog,
        marker: "<!-- kairon:runtime-watchdog -->"
      },
      {
        source: "src/incidents/lifecycle.ts",
        document: documents.incident,
        marker: "<!-- kairon:incident-lifecycle -->"
      },
      {
        source: "src/incidents/store.ts",
        document: documents.cli,
        marker: "kairon incident"
      },
      {
        source: "src/state/backup.ts",
        document: documents.cli,
        marker: "kairon state backup"
      },
      {
        source: "src/state/disaster-recovery.ts",
        document: documents.disasterRecovery,
        marker: "<!-- kairon:off-device-disaster-recovery -->"
      },
      {
        source: "src/state/backup-catalog.ts",
        document: documents.disasterRecovery,
        marker: "user-local"
      },
      {
        source: "src/state/event-compaction.ts",
        document: documents.cli,
        marker: "kairon state events compact"
      },
      {
        source: "src/migration/schema-registry.ts",
        document: documents.schema,
        marker: "## Schema Registry"
      },
      {
        source: "src/migration/migration-plan.ts",
        document: documents.schema,
        marker: "## Apply"
      },
      {
        source: "src/workflow/runtime.ts",
        document: documents.workflow,
        marker: "<!-- kairon:production-workflow -->"
      },
      {
        source: "src/discord/http-interactions.ts",
        document: documents.readme,
        marker: "HTTP Interactions"
      },
      {
        source: "src/board/access-token.ts",
        document: documents.readme,
        marker: "short-lived access token"
      },
      {
        source: "src/rag/integrity.ts",
        document: documents.readme,
        marker: "RAG integrity"
      },
      {
        source: "src/release/local-beta.ts",
        document: documents.installation,
        marker: "kairon release verify"
      },
      {
        source: "src/release/release-manifest.ts",
        document: documents.installation,
        marker: "release-manifest.json"
      },
      {
        source: "src/release/sbom.ts",
        document: documents.provenance,
        marker: "<!-- kairon:release-provenance-sbom -->"
      },
      {
        source: "src/release/provenance.ts",
        document: documents.provenance,
        marker: "kairon_local_build_provenance"
      },
      {
        source: "src/release/github-release.ts",
        document: documents.release,
        marker: "<!-- kairon:github-release-distribution -->"
      },
      {
        source: "src/github/release-client.ts",
        document: documents.cli,
        marker: "kairon release github publish"
      },
      {
        source: "src/update/channel.ts",
        document: documents.cli,
        marker: "kairon update channel set"
      },
      {
        source: "src/update/downloader.ts",
        document: documents.installation,
        marker: "kairon update download"
      },
      {
        source: "src/update/registry.ts",
        document: documents.installation,
        marker: ".kairon/update/registry.json"
      },
      {
        source: "src/diagnostics/support-bundle.ts",
        document: documents.cli,
        marker: "kairon support bundle"
      },
      {
        source: "src/diagnostics/support-redaction.ts",
        document: documents.readme,
        marker: "sanitized support bundle"
      },
      {
        source: "src/readiness/beta-readiness.ts",
        document: documents.readme,
        marker: "kairon readiness check"
      },
      {
        source: "src/remote/profile.ts",
        document: documents.remote,
        marker: "<!-- kairon:stable-remote-operations -->"
      },
      {
        source: "src/remote/status.ts",
        document: documents.remote,
        marker: "kairon remote doctor"
      },
      {
        source: "src/performance/benchmark.ts",
        document: documents.performance,
        marker: "<!-- kairon:performance-regression-gate -->"
      },
      {
        source: "src/performance/budget.ts",
        document: documents.cli,
        marker: "kairon performance compare"
      },
      {
        source: "src/security/baseline.ts",
        document: documents.security,
        marker: "<!-- kairon:security-check-report -->"
      },
      {
        source: "src/security/dependency-policy.ts",
        document: documents.security,
        marker: "## Dependency Policy"
      },
      {
        source: "src/security/path-policy.ts",
        document: documents.threatModel,
        marker: "<!-- kairon:stable-security-baseline -->"
      },
      {
        source: "src/operation-test/stable-acceptance.ts",
        document: documents.stableAcceptance,
        marker: "<!-- kairon:stable-acceptance -->"
      },
      {
        source: "src/agents/compatibility-certification.ts",
        document: documents.agentSession,
        marker: "<!-- kairon:agent-cli-compatibility-certification -->"
      },
      {
        source: "src/diagnostics/triage.ts",
        document: documents.diagnosticsTriage,
        marker: "<!-- kairon:diagnostics-triage -->"
      }
    ];

    for (const entry of inventory) {
      await expect(access(path.resolve(entry.source))).resolves.toBeUndefined();
      expect(entry.document, `missing documentation marker for ${entry.source}`).toContain(
        entry.marker
      );
    }
  });

  it("separates production workflow state from the experimental compatibility path", async () => {
    const workflow = await readUtf8("docs/workflow-v0.md");
    const readme = await readUtf8("README.md");

    expect(workflow).toContain("<!-- kairon:production-workflow -->");
    expect(workflow).toContain("<!-- kairon:experimental-workflow-compatibility -->");
    expect(workflow).toContain(".kairon/workflows/");
    expect(workflow).toContain(".kairon/experimental/workflows/");
    expect(readme).toContain("production canonical stateの代替ではありません");
  });

  it("keeps all local Markdown links in README resolvable", async () => {
    const readme = await readUtf8("README.md");
    const links = Array.from(
      readme.matchAll(/\[[^\]]+\]\((?<target>(?:docs|\.github)\/[^)#]+\.md)\)/gu),
      (match) => match.groups?.target
    ).filter((target): target is string => target !== undefined);

    expect(links.length).toBeGreaterThan(0);
    for (const target of links) {
      await expect(access(path.resolve(target))).resolves.toBeUndefined();
    }
  });
});

async function readUtf8(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}
