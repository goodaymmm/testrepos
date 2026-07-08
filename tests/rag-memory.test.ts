import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  buildRagIndex,
  compactRagIndex,
  searchRagIndex,
  type RagIndex
} from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";

describe("RAG lexical memory", () => {
  it("indexes rules, task state, handoffs, and docs with hashes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "approval-board.md"),
      "Approval board routing should preserve reviewer evidence.",
      "utf8"
    );
    await mkdir(path.join(root, ".kairon", "tasks", "TASK-0001"), {
      recursive: true
    });
    await writeFile(
      path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"),
      JSON.stringify({ id: "TASK-0001", title: "Approval board routing" }),
      "utf8"
    );
    await mkdir(path.join(root, ".kairon", "sessions", "2026-05-25", "codex"), {
      recursive: true
    });
    await writeFile(
      path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "handoff.md"),
      "Continue with approval board evidence.",
      "utf8"
    );

    const result = await buildRagIndex(root, {
      now: () => new Date("2026-05-25T00:00:00.000Z")
    });

    expect(result.index_path).toBe(".kairon/rag/index.json");
    expect(result.source_count).toBeGreaterThanOrEqual(3);
    expect(result.chunk_count).toBeGreaterThanOrEqual(3);
    expect(result.index.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "document",
          path: "docs/approval-board.md",
          content_hash: expect.stringMatching(/^sha256:/),
          first_indexed_at: "2026-05-25T00:00:00.000Z",
          last_seen_at: "2026-05-25T00:00:00.000Z",
          last_modified_at: expect.any(String),
          source_category: "project_document"
        }),
        expect.objectContaining({
          source_type: "task_state",
          path: ".kairon/tasks/TASK-0001/task.json"
        }),
        expect.objectContaining({
          source_type: "handoff",
          path: ".kairon/sessions/2026-05-25/codex/handoff.md"
        })
      ])
    );

    await expect(
      readJsonFile(path.join(root, ".kairon", "rag", "index.json"))
    ).resolves.toMatchObject({
      kind: "rag_lexical_index",
      chunk_count: result.chunk_count
    });
  });

  it("searches lexical chunks and excludes protected or secret-like paths", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "retrieval.md"),
      "The maintainer retrieval context must cite source hashes.",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "api-token-notes.md"),
      "token value should never be indexed",
      "utf8"
    );
    await writeFile(path.join(root, ".env.local"), "SECRET=1", "utf8");

    const result = await buildRagIndex(root);
    expect(result.skipped_protected_count).toBeGreaterThanOrEqual(1);
    expect(result.index.sources.map((source) => source.path)).not.toContain(
      "docs/api-token-notes.md"
    );
    expect(result.index.sources.map((source) => source.path)).not.toContain(
      ".env.local"
    );

    const matches = await searchRagIndex(root, {
      query: "retrieval source hashes",
      topK: 1
    });

    expect(matches).toMatchObject([
      {
        path: "docs/retrieval.md",
        source_id: expect.stringContaining("document:docs/retrieval.md"),
        content_hash: expect.stringMatching(/^sha256:/),
        score: expect.any(Number)
      }
    ]);

    const explained = await searchRagIndex(root, {
      query: "retrieval source hashes",
      topK: 1,
      explain: true,
      now: () => new Date("2026-05-26T00:00:00.000Z")
    });

    expect(explained[0].explain).toMatchObject({
      matched_terms: ["retrieval", "source", "hashes"],
      term_hits: {
        retrieval: 1,
        source: 1,
        hashes: 1
      },
      stale_source: false,
      warnings: []
    });
    expect(explained[0].explain?.source_last_modified_at).toEqual(
      expect.any(String)
    );
    expect(explained[0].explain?.indexed_age_days).toEqual(expect.any(Number));
  });

  it("prunes missing sources during scoped refresh", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const keptDoc = path.join(root, "docs", "keep-rag.md");
    const removedDoc = path.join(root, "docs", "remove-rag.md");
    await writeFile(keptDoc, "Keep this source in the RAG index.", "utf8");
    await writeFile(removedDoc, "Remove this source from the RAG index.", "utf8");

    await buildRagIndex(root);
    await unlink(removedDoc);

    const result = await buildRagIndex(root, {
      sourceTypes: ["document"],
      prune: true
    });

    expect(result.refresh_mode).toBe("scoped");
    expect(result.pruned_source_count).toBe(1);
    expect(result.index.sources.map((source) => source.path)).toContain(
      "docs/keep-rag.md"
    );
    expect(result.index.sources.map((source) => source.path)).not.toContain(
      "docs/remove-rag.md"
    );
  });

  it("compacts missing, archived, and stale ephemeral sources", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, ".kairon", "sessions", "2026-05-01", "codex"), {
      recursive: true
    });
    await mkdir(path.join(root, ".kairon", "runs", "RUN-0009"), {
      recursive: true
    });
    const keptDoc = path.join(root, "docs", "kept.md");
    const removedDoc = path.join(root, "docs", "missing.md");
    const oldHandoff = path.join(
      root,
      ".kairon",
      "sessions",
      "2026-05-01",
      "codex",
      "handoff.md"
    );
    const oldRunner = path.join(root, ".kairon", "runs", "RUN-0009", "runner.json");
    await writeFile(keptDoc, "Keep this compacted RAG source.", "utf8");
    await writeFile(removedDoc, "This missing RAG source should be compacted.", "utf8");
    await writeFile(oldHandoff, "Old handoff should age out of RAG.", "utf8");
    await writeFile(
      oldRunner,
      JSON.stringify({
        run_id: "RUN-0009",
        task_id: "TASK-0009",
        status: "failed",
        failure_reason: "old failure should age out"
      }),
      "utf8"
    );
    const oldDate = new Date("2026-05-01T00:00:00.000Z");
    await utimes(oldHandoff, oldDate, oldDate);
    await utimes(oldRunner, oldDate, oldDate);

    const built = await buildRagIndex(root, {
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const archivedSource = {
      ...built.index.sources[0],
      source_id: "document:.kairon/cleanup/archived/2026-05-01:archived",
      path: ".kairon/cleanup/archived/2026-05-01.json"
    };
    const archivedChunk = {
      ...built.index.chunks[0],
      chunk_id: `${archivedSource.source_id}#1`,
      source_id: archivedSource.source_id,
      path: archivedSource.path
    };
    await writeJsonFileAtomic(indexPath, {
      ...built.index,
      source_count: built.index.sources.length + 1,
      chunk_count: built.index.chunks.length + 1,
      sources: [...built.index.sources, archivedSource],
      chunks: [...built.index.chunks, archivedChunk]
    } satisfies RagIndex);
    await unlink(removedDoc);

    const compacted = await compactRagIndex(root, {
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      maxArtifactAgeDays: 30
    });

    expect(compacted.removed_missing_source_count).toBe(1);
    expect(compacted.removed_archived_source_count).toBe(1);
    expect(compacted.removed_ephemeral_source_count).toBeGreaterThanOrEqual(2);
    expect(compacted.index?.last_compacted_at).toBe("2026-06-15T00:00:00.000Z");
    expect(compacted.index?.sources.map((source) => source.path)).toContain(
      "docs/kept.md"
    );
    expect(compacted.index?.sources.map((source) => source.path)).not.toEqual(
      expect.arrayContaining([
        "docs/missing.md",
        ".kairon/cleanup/archived/2026-05-01.json",
        ".kairon/sessions/2026-05-01/codex/handoff.md",
        ".kairon/runs/RUN-0009/runner.json"
      ])
    );
  });

  it("indexes decision, review, approval, and failure memories with metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, ".kairon", "events"), { recursive: true });
    await mkdir(path.join(root, ".kairon", "approvals"), { recursive: true });
    await mkdir(path.join(root, ".kairon", "reviews", "results"), {
      recursive: true
    });
    await mkdir(path.join(root, ".kairon", "reviews", "loops"), {
      recursive: true
    });
    await mkdir(path.join(root, ".kairon", "runs", "RUN-0007"), {
      recursive: true
    });

    await writeFile(
      path.join(root, ".kairon", "events", "2026-05-25.jsonl"),
      JSON.stringify({
        type: "approval.decide",
        approval_id: "APR-0007",
        task_id: "TASK-0007",
        decision: "request_changes",
        created_at: "2026-05-25T01:00:00.000Z"
      }) + "\n",
      "utf8"
    );
    await writeFile(
      path.join(root, ".kairon", "approvals", "APR-0007.json"),
      JSON.stringify({
        id: "APR-0007",
        task_id: "TASK-0007",
        status: "decided",
        decision: "request_changes",
        api_token: "SHOULD_NOT_BE_INDEXED",
        created_at: "2026-05-25T01:00:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(root, ".kairon", "reviews", "results", "REV-0007.json"),
      JSON.stringify({
        review_id: "REV-0007",
        task_id: "TASK-0007",
        run_id: "RUN-0007",
        status: "changes_requested",
        secret_scan_passed: false,
        findings: [{ severity: "high", body: "Retry guard must be added." }],
        created_at: "2026-05-25T01:10:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(root, ".kairon", "reviews", "loops", "REV-0007-iteration-1.json"),
      JSON.stringify({
        loop_id: "REV-0007",
        task_id: "TASK-0007",
        status: "changes_requested",
        decision: {
          status: "failed",
          reasons: [
            "REV-0007: secret_scan_passed is required",
            "Review runner did not produce validation evidence."
          ]
        },
        created_at: "2026-05-25T01:15:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      path.join(root, ".kairon", "runs", "RUN-0007", "runner.json"),
      JSON.stringify({
        run_id: "RUN-0007",
        task_id: "TASK-0007",
        status: "failed",
        failure_reason: "transient tool failure",
        args: [
          "Required review_result fields include secret_scan_passed: boolean",
          "Never expose GH_TOKEN in context."
        ],
        finished_at: "2026-05-25T01:20:00.000Z"
      }),
      "utf8"
    );

    const result = await buildRagIndex(root);
    expect(result.index.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "decision",
          metadata: expect.objectContaining({
            collection: "decisions",
            task_id: "TASK-0007",
            approval_id: "APR-0007"
          })
        }),
        expect.objectContaining({
          source_type: "approval",
          metadata: expect.objectContaining({
            collection: "approvals",
            approval_id: "APR-0007",
            task_id: "TASK-0007"
          })
        }),
        expect.objectContaining({
          source_type: "review",
          metadata: expect.objectContaining({
            collection: "reviews",
            task_id: "TASK-0007",
            run_id: "RUN-0007",
            severity: "high"
          })
        }),
        expect.objectContaining({
          source_type: "failure",
          metadata: expect.objectContaining({
            collection: "failures",
            task_id: "TASK-0007",
            run_id: "RUN-0007",
            status: "failed"
          })
        })
      ])
    );

    const indexedText = result.index.chunks.map((chunk) => chunk.text).join("\n");
    expect(indexedText).not.toContain("api_token");
    expect(indexedText).not.toContain("secret_scan_passed");
    expect(indexedText).not.toContain("GH_TOKEN");
    expect(indexedText).not.toContain("SHOULD_NOT_BE_INDEXED");

    await expect(
      searchRagIndex(root, {
        query: "transient tool failure",
        topK: 1,
        filters: {
          task_id: "TASK-0007",
          source_types: ["failure"]
        }
      })
    ).resolves.toMatchObject([
      {
        source_type: "failure",
        path: ".kairon/runs/RUN-0007/runner.json",
        metadata: expect.objectContaining({
          task_id: "TASK-0007",
          run_id: "RUN-0007"
        })
      }
    ]);
  });
});
