import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { buildRagIndex, searchRagIndex } from "../src/rag/lexical-index.js";
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
          content_hash: expect.stringMatching(/^sha256:/)
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
  });
});
