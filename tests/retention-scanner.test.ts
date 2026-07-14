import {
  mkdir,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { scanCleanupRetention } from "../src/maintenance/retention-scanner.js";
import { createTempProject } from "./test-utils.js";

describe("scanCleanupRetention", () => {
  it("accepts legacy policies without retention and rejects invalid retention limits", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const policiesPath = path.join(root, ".kairon", "config", "policies.json");
    const policies = await readJsonFile<TestPoliciesConfig>(policiesPath);
    delete policies.cleanup.retention;

    expect(validateConfigFile("policies.json", policies)).toMatchObject({
      ok: true,
      errors: []
    });

    policies.cleanup.retention = {
      enabled: true,
      categories: {
        runs: invalidRule(),
        sessions: invalidRule(),
        daemon_logs: invalidRule(),
        audits: invalidRule(),
        reports: invalidRule()
      }
    };
    expect(validateConfigFile("policies.json", policies)).toMatchObject({
      ok: false,
      errors: ["policies.json: review and cleanup safety policies are invalid"]
    });
  });

  it("protects current references and proposes only unreferenced old runs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await configureRetention(root, "runs", {
      max_age_days: 1,
      max_files: 2,
      max_bytes: 1_000_000,
      min_keep: 1
    });
    const old = new Date("2026-06-01T00:00:00.000Z");
    const now = new Date("2026-07-15T00:00:00.000Z");

    await writeRun(root, "RUN-OLD", "failed", old, true);
    await writeRun(root, "RUN-PENDING", "failed", old, true);
    await writeRun(root, "RUN-RECOVERY", "completed", old, false);
    await writeRun(root, "RUN-LATEST", "completed", now, true);
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-PENDING.json"),
      {
        schema_version: "0.1",
        id: "APR-PENDING",
        status: "pending",
        run_id: "RUN-PENDING"
      }
    );

    const result = await scanCleanupRetention(root, { now });

    expect(result).toMatchObject({
      enabled: true,
      scanned_items: 4,
      protected_items: 3
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        category: "runs",
        path: ".kairon/runs/RUN-OLD",
        age_days: 44,
        reason: expect.stringContaining("max_age_days=1")
      })
    ]);
    expect(result.candidates[0]?.reason).toContain("max_files=2");
  });

  it("selects complete JSONL files by size without splitting their contents", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await configureRetention(root, "audits", {
      max_age_days: 10_000,
      max_files: 10,
      max_bytes: 12,
      min_keep: 1
    });
    const auditDir = path.join(root, ".kairon", "runtime", "discord");
    const olderPath = path.join(auditDir, "2026-05-01.jsonl");
    const newerPath = path.join(auditDir, "2026-05-02.jsonl");
    await writeFile(olderPath, "{\"a\":1}\n", "utf8");
    await writeFile(newerPath, "{\"b\":2}\n", "utf8");
    await utimes(olderPath, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));
    await utimes(newerPath, new Date("2026-05-02T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));

    const result = await scanCleanupRetention(root, {
      now: new Date("2026-07-15T00:00:00Z")
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        category: "audits",
        path: ".kairon/runtime/discord/2026-05-01.jsonl",
        size_bytes: 8,
        reason: "retention limits exceeded: max_bytes=12"
      })
    ]);
  });

  it("skips symbolic-link artifact roots", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const target = path.join(root, "linked-target");
    const link = path.join(root, ".kairon", "runs", "RUN-LINK");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "runner.json"), "{}\n", "utf8");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");

    const result = await scanCleanupRetention(root, {
      now: new Date("2026-07-15T00:00:00Z")
    });

    expect(result.skipped_symbolic_links).toBe(1);
    expect(result.candidates).toEqual([]);
  });
});

async function configureRetention(
  root: string,
  category: string,
  rule: {
    max_age_days: number;
    max_files: number;
    max_bytes: number;
    min_keep: number;
  }
): Promise<void> {
  const policiesPath = path.join(root, ".kairon", "config", "policies.json");
  const policies = await readJsonFile<TestPoliciesConfig>(policiesPath);
  policies.cleanup.retention!.categories[category] = rule;
  await writeJsonFileAtomic(policiesPath, policies);
}

function invalidRule() {
  return {
    max_age_days: 30,
    max_files: 1,
    max_bytes: 1_000,
    min_keep: 2
  };
}

type TestPoliciesConfig = {
  cleanup: {
    retention?: {
      enabled: boolean;
      categories: Record<string, TestRetentionRule>;
    };
  };
};

type TestRetentionRule = {
  max_age_days: number;
  max_files: number;
  max_bytes: number;
  min_keep: number;
};

async function writeRun(
  root: string,
  runId: string,
  status: string,
  modifiedAt: Date,
  writeOutbox: boolean
): Promise<void> {
  const runDir = path.join(root, ".kairon", "runs", runId);
  const runnerPath = path.join(runDir, "runner.json");
  await mkdir(runDir, { recursive: true });
  await writeJsonFileAtomic(runnerPath, {
    schema_version: "0.1",
    kind: "job",
    run_id: runId,
    status,
    outbox_path: `.kairon/runs/${runId}/outbox.json`,
    created_at: modifiedAt.toISOString(),
    finished_at: modifiedAt.toISOString()
  });
  await utimes(runnerPath, modifiedAt, modifiedAt);
  if (writeOutbox) {
    const outboxPath = path.join(runDir, "outbox.json");
    await writeJsonFileAtomic(outboxPath, {
      schema_version: "0.1",
      run_id: runId,
      status
    });
    await utimes(outboxPath, modifiedAt, modifiedAt);
  }
  await utimes(runDir, modifiedAt, modifiedAt);
}
