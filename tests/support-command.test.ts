import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram } from "../src/cli/main.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  supportBundleCommand,
  supportVerifyCommand
} from "../src/cli/commands/support.js";
import type { SupportBundleDependencies } from "../src/diagnostics/support-bundle.js";
import type { RuntimeStatus } from "../src/runtime/status.js";
import { createTempProject } from "./test-utils.js";

describe("support commands", () => {
  it("registers bundle and verify under the top-level support command", () => {
    const support = createProgram().commands.find((command) => command.name() === "support");
    expect(support).toBeDefined();
    expect(support?.commands.map((command) => command.name())).toEqual(["bundle", "verify"]);
    const bundle = support?.commands.find((command) => command.name() === "bundle");
    expect(bundle?.options.map((option) => option.long)).toEqual(["--dry-run", "--output"]);
  });

  it("formats a dry run without writing a plan or ZIP", async () => {
    const root = await createProject();
    const output = await supportBundleCommand(root, { dryRun: true }, dependencies());

    expect(output).toContain("Kairon support bundle dry run.");
    expect(output).toContain("bundle_id=SUP-DRY-RUN");
    expect(output).toContain("archive=not_created");
    expect(output).toContain("exclude=agent_output");
    await expect(access(path.join(root, ".kairon", "support"))).rejects.toThrow();
  });

  it("creates and verifies a support ZIP through command wrappers", async () => {
    const root = await createProject();
    const created = await supportBundleCommand(root, {}, dependencies());
    const archivePath = created.match(/^archive=(.+)$/mu)?.[1];
    expect(archivePath).toBeDefined();

    const verified = await supportVerifyCommand(archivePath!);
    expect(verified).toContain("verification.ok=true");
    expect(verified).toContain("secret_scan=passed");
    expect(verified).toContain("PASS manifest");
  });

  it("rejects a malformed bundle through the verify command", async () => {
    const root = await createProject();
    const malformed = path.join(root, "malformed.zip");
    await writeFile(malformed, "not-a-zip", "utf8");

    await expect(supportVerifyCommand(malformed)).rejects.toThrow("verification.ok=false");
    expect((await readFile(malformed, "utf8"))).toBe("not-a-zip");
  });
});

async function createProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  return root;
}

function dependencies(): SupportBundleDependencies {
  return {
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    doctor: async () => ({
      ok: true,
      summary: { pass: 1, warning: 0, error: 0 },
      checks: [{
        id: "git.repository",
        title: "Git repository",
        status: "pass",
        details: ["ready"]
      }]
    }),
    runtimeStatus: async () => ({
      schedule: { mode: "standby_work", baseMode: "standby_work", activeWorkClosed: false },
      runtimeLock: { locked: false },
      queue: { ready: 0, claimed: 0, failed: 0 },
      approvals: { pending: 0 },
      followUps: { pending: 0, snoozed: 0 },
      recovery: {
        targets: 0,
        stale_locks: 0,
        expired_claims: 0,
        run_issues: 0,
        gateway_issues: 0,
        git_transaction_issues: 0,
        resolved_targets: 0
      },
      artifacts: { last_tick: ".kairon/runtime/last-tick.json" }
    } as RuntimeStatus),
    providerHealth: async () => [],
    ragIntegrity: async () => ({
      schema_version: "0.1",
      artifact_kind: "rag_integrity",
      status: "SETUP_REQUIRED",
      index_path: ".kairon/rag/index.json",
      source_count: 0,
      chunk_count: 0,
      issue_count: 0,
      issues: [],
      checked_at: "2026-07-23T00:00:00.000Z"
    })
  };
}
