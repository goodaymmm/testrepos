import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  compactRagIndexCommand,
  queryRagIndexCommand,
  rebuildRagIndexCommand,
  refreshRagIndexCommand,
  statsRagIndexCommand,
  statusRagIndexCommand,
  verifyRagIndexCommand
} from "../src/cli/commands/rag.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import type { RagIndex } from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";

describe("RAG CLI commands", () => {
  it("reports status before and after refreshing the index", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "rag-status.md"),
      "RAG status should show source and chunk counts after refresh.",
      "utf8"
    );

    await expect(statusRagIndexCommand(root)).resolves.toContain("exists=false");

    const refreshOutput = await refreshRagIndexCommand(root);
    expect(refreshOutput).toContain("Kairon RAG index refreshed.");
    expect(refreshOutput).toContain("index=.kairon/rag/index.json");
    expect(refreshOutput).toContain("mode=full");
    expect(refreshOutput).toMatch(/sources=\d+/);
    expect(refreshOutput).toMatch(/chunks=\d+/);
    expect(refreshOutput).toMatch(/scanned_sources=\d+/);
    expect(refreshOutput).toMatch(/added_sources=\d+/);
    expect(refreshOutput).toContain("updated_sources=0");
    expect(refreshOutput).toContain("unchanged_sources=0");
    expect(refreshOutput).toMatch(/skipped_protected=\d+/);
    expect(refreshOutput).toMatch(/skipped_generated=\d+/);
    expect(refreshOutput).toContain("skipped_reason.protected=");
    expect(refreshOutput).toMatch(/pruned_sources=\d+/);
    expect(refreshOutput).toContain("pruned_reason.missing=");
    expect(refreshOutput).toMatch(/pruned_ephemeral_sources=\d+/);

    const statusOutput = await statusRagIndexCommand(root);
    expect(statusOutput).toContain("exists=true");
    expect(statusOutput).toContain("index=.kairon/rag/index.json");
    expect(statusOutput).toContain("freshness=fresh");
    expect(statusOutput).toContain("pending_added_sources=0");
    expect(statusOutput).toContain("pending_changed_sources=0");
    expect(statusOutput).toContain("pending_missing_sources=0");
    expect(statusOutput).toMatch(/index_size_bytes=\d+/);
    expect(statusOutput).toContain("last_refresh_at=");
    expect(statusOutput).toContain("last_refresh_mode=full");
    expect(statusOutput).toContain("last_refresh_added_sources=");
    expect(statusOutput).toContain("last_refresh_skipped_reason.protected=");
    expect(statusOutput).toContain("updated_at=");
  });

  it("compacts the index and reports the last compaction in status", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const staleDoc = path.join(root, "docs", "stale-rag.md");
    await writeFile(staleDoc, "Stale RAG source should be compacted.", "utf8");
    await refreshRagIndexCommand(root);
    await unlink(staleDoc);

    const compactOutput = await compactRagIndexCommand(root);
    expect(compactOutput).toContain("Kairon RAG index compacted.");
    expect(compactOutput).toContain("exists=true");
    expect(compactOutput).toContain("removed_missing_sources=1");
    expect(compactOutput).toContain("compacted_at=");

    const statusOutput = await statusRagIndexCommand(root);
    expect(statusOutput).toContain("last_compacted_at=");
    expect(statusOutput).toContain("last_compaction_removed_sources=1");
  });

  it("refreshes a scoped subset while retaining the previous index", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const oldDoc = path.join(root, "docs", "old-rag.md");
    const freshDoc = path.join(root, "docs", "fresh-rag.md");
    await writeFile(oldDoc, "Old RAG source remains searchable.", "utf8");
    await writeFile(freshDoc, "Fresh RAG source before scoped refresh.", "utf8");
    await utimes(
      oldDoc,
      new Date("2026-05-24T00:00:00.000Z"),
      new Date("2026-05-24T00:00:00.000Z")
    );
    await utimes(
      freshDoc,
      new Date("2026-05-25T00:00:00.000Z"),
      new Date("2026-05-25T00:00:00.000Z")
    );

    await refreshRagIndexCommand(root);
    await writeFile(freshDoc, "Fresh RAG source after scoped refresh.", "utf8");
    await utimes(
      freshDoc,
      new Date("2026-05-27T00:00:00.000Z"),
      new Date("2026-05-27T00:00:00.000Z")
    );

    const output = await refreshRagIndexCommand(root, {
      since: "2026-05-26T00:00:00.000Z",
      type: "document",
      limit: "1"
    });
    expect(output).toContain("mode=scoped");

    const index = await readJsonFile<RagIndex>(
      path.join(root, ".kairon", "rag", "index.json")
    );
    expect(index.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/old-rag.md" }),
        expect.objectContaining({ path: "docs/fresh-rag.md" })
      ])
    );
    expect(index.chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "Fresh RAG source after scoped refresh."
    );
  });

  it("queries with metadata filters and redacts secret-like output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, ".kairon", "approvals"), { recursive: true });
    await writeFile(
      path.join(root, ".kairon", "approvals", "APR-0007.json"),
      JSON.stringify({
        id: "APR-0007",
        task_id: "TASK-0007",
        status: "pending",
        title: "Manual approval evidence needs review",
        api_token: "SHOULD_NOT_LEAK",
        created_at: "2026-05-25T01:00:00.000Z"
      }),
      "utf8"
    );
    await refreshRagIndexCommand(root);

    const output = await queryRagIndexCommand(root, "approval evidence", {
      type: "approval",
      limit: "5",
      taskId: "TASK-0007",
      approvalId: "APR-0007"
    });

    expect(output).toContain("Kairon RAG query completed.");
    expect(output).toContain("matches=1");
    expect(output).toContain("source_type=approval");
    expect(output).toContain("metadata.task_id=TASK-0007");
    expect(output).toContain("metadata.approval_id=APR-0007");
    expect(output).not.toContain("explain.");
    expect(output).not.toContain("api_token");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
  });

  it("prints query explanation and stale source warnings on request", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const doc = path.join(root, "docs", "rag-freshness.md");
    await writeFile(
      doc,
      "Approval freshness evidence should explain matched terms.",
      "utf8"
    );
    await utimes(
      doc,
      new Date("2026-05-25T00:00:00.000Z"),
      new Date("2026-05-25T00:00:00.000Z")
    );

    await refreshRagIndexCommand(root);
    await writeFile(
      doc,
      "Approval freshness evidence should explain matched terms after edit.",
      "utf8"
    );
    await utimes(
      doc,
      new Date("2026-05-27T00:00:00.000Z"),
      new Date("2026-05-27T00:00:00.000Z")
    );

    const output = await queryRagIndexCommand(root, "freshness evidence", {
      explain: true,
      limit: "1"
    });

    expect(output).toContain("Kairon RAG query completed.");
    expect(output).toContain("matches=1");
    expect(output).toContain("explain.lexical_score=");
    expect(output).toContain("explain.matched_terms=freshness,evidence");
    expect(output).toContain("explain.term_hits=evidence:1,freshness:1");
    expect(output).toContain("freshness.source_last_modified_at=");
    expect(output).toContain("freshness.source_current_modified_at=");
    expect(output).toContain("freshness.stale_source=true");
    expect(output).toContain("warning=source_modified_after_index");
  });

  it("rejects invalid query filters", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      queryRagIndexCommand(root, "anything", { type: "unknown" })
    ).rejects.toThrow("Invalid RAG source type");
  });

  it("verifies, summarizes, plans, and executes a full rebuild", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "rebuild.md"),
      "Approval routing runtime recovery review findings.",
      "utf8"
    );
    await refreshRagIndexCommand(root);

    const verifyOutput = await verifyRagIndexCommand(root);
    expect(verifyOutput).toContain("status=PASS");
    expect(verifyOutput).toMatch(/index_checksum=sha256:[0-9a-f]{64}/u);
    const statsOutput = await statsRagIndexCommand(root);
    expect(statsOutput).toContain("duplicate_ratio=");
    expect(statsOutput).toContain("context_budget_tokens=12000");
    expect(statsOutput).toContain("rebuild_due=false");

    const planOutput = await rebuildRagIndexCommand(root, {
      dryRun: true,
      compare: true
    });
    expect(planOutput).toContain("Kairon RAG rebuild compared.");
    expect(planOutput).toContain("status=ready");
    expect(planOutput).toContain("comparison=passed");
    const rebuildId = /^rebuild_id=(.+)$/mu.exec(planOutput)?.[1];
    expect(rebuildId).toMatch(/^RAG-REBUILD-/u);

    const executeOutput = await rebuildRagIndexCommand(root, {
      execute: true,
      confirm: rebuildId
    });
    expect(executeOutput).toContain("Kairon RAG rebuild executed.");
    expect(executeOutput).toContain("status=executed");
    await expect(
      rebuildRagIndexCommand(root, { execute: true })
    ).rejects.toThrow("requires --confirm");
  });
});
