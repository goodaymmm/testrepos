import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { runMaintenance } from "../src/cli/commands/maintenance.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { runDailyMaintenance } from "../src/maintenance/run.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("runDailyMaintenance", () => {
  it("writes cleanup proposal, daily report, and handoffs", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const result = await runDailyMaintenance(root, { date: "2026-05-25" });

    expect(result).toMatchObject({
      date: "2026-05-25",
      daily_report_path: ".kairon/reports/daily/2026-05-25.json",
      cleanup_proposal_path: ".kairon/cleanup/proposals/2026-05-25.json"
    });
    expect(result.handoff_paths).toHaveLength(3);
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "handoff.json"))
    ).resolves.toMatchObject({
      agent: "codex"
    });
  });

  it("expires stale test queue items during daily maintenance", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const queue = new WorkQueue(root);
    const stale = await queue.enqueue({
      type: "agent.run",
      test_scope: {
        kind: "manual_test",
        tags: ["manual-test"],
        expires_at: "2026-05-25T01:00:00.000Z"
      }
    });

    await expect(
      runDailyMaintenance(root, {
        date: "2026-05-25",
        now: new Date("2026-05-25T02:00:00.000Z")
      })
    ).resolves.toMatchObject({
      expired_test_queue_item_ids: [stale.id],
      recovery: {
        artifact_path: expect.stringMatching(/^\.kairon\/recovery\/REC-/)
      }
    });
    await expect(queue.list("failed")).resolves.toMatchObject([
      { id: stale.id, error: { code: "stale_test_queue_item" } }
    ]);
  });

  it("exposes maintenance run through the CLI command handler", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(runMaintenance(root)).resolves.toContain("Kairon maintenance completed");
  });

  it("refreshes the RAG index during maintenance when enabled", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "config", "rag.json"), {
      schema_version: "0.1",
      enabled: true,
      storage: {
        base_dir: ".kairon/rag",
        lexical: "local"
      },
      security: {
        exclude_paths: [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
      }
    });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "maintenance-rag.md"),
      "Maintenance should refresh local RAG memory.",
      "utf8"
    );

    const result = await runDailyMaintenance(root, { date: "2026-05-25" });

    expect(result.rag_index).toMatchObject({
      index_path: ".kairon/rag/index.json",
      chunk_count: expect.any(Number)
    });
    await expect(
      readJsonFile(path.join(root, ".kairon", "rag", "index.json"))
    ).resolves.toMatchObject({
      kind: "rag_lexical_index",
      sources: expect.arrayContaining([
        expect.objectContaining({ path: "docs/maintenance-rag.md" })
      ])
    });
    const output = await runMaintenance(root);
    expect(output).toContain("recovery_artifact=.kairon/recovery/REC-");
    expect(output).toContain("rag_index=.kairon/rag/index.json");
  });
});
