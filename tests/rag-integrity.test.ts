import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { validateConfigFile } from "../src/core/config/validate-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { acquireResourceLock, releaseResourceLock } from "../src/core/fs/resource-lock.js";
import {
  executeRagRebuild,
  getRagStats,
  planRagRebuild,
  verifyRagIndex,
  type RagRebuildArtifact
} from "../src/rag/integrity.js";
import {
  buildRagIndex,
  compactRagIndex,
  type RagIndex
} from "../src/rag/lexical-index.js";
import { createRagIndexManifest } from "../src/rag/manifest.js";
import { createTempProject } from "./test-utils.js";

describe("RAG integrity and rebuild", () => {
  it("validates RAG integrity and rebuild policy bounds", async () => {
    const root = await createProjectWithDocument();
    const config = await readJsonFile<Record<string, any>>(
      path.join(root, ".kairon", "config", "rag.json")
    );
    expect(validateConfigFile("rag.json", config)).toMatchObject({ ok: true });
    config.integrity.max_duplicate_ratio = 2;
    expect(validateConfigFile("rag.json", config)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("RAG storage, integrity, or rebuild")]
    });
  });

  it("creates a deterministic manifest and verifies an unchanged index", async () => {
    const root = await createProjectWithDocument();
    const first = await buildRagIndex(root, {
      now: () => new Date("2026-07-16T01:00:00.000Z")
    });
    const candidate = await buildRagIndex(root, {
      now: () => new Date("2026-07-16T02:00:00.000Z"),
      fullRebuild: true,
      writeIndex: false
    });
    const integrity = await verifyRagIndex(root, {
      now: new Date("2026-07-16T02:00:00.000Z")
    });

    expect(first.index.manifest).toMatchObject({
      algorithm: "sha256",
      index_checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      source_manifest_checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
    });
    expect(candidate.index.manifest?.index_checksum).toBe(
      first.index.manifest?.index_checksum
    );
    expect(integrity).toMatchObject({ status: "PASS", issue_count: 0 });
  });

  it("detects count corruption, duplicate ids, orphan chunks, and source drift", async () => {
    const root = await createProjectWithDocument();
    const built = await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const source = built.index.sources[0]!;
    const chunk = built.index.chunks[0]!;
    const corrupted: RagIndex = {
      ...built.index,
      source_count: built.index.source_count,
      sources: [...built.index.sources, { ...source }],
      chunks: [
        ...built.index.chunks,
        { ...chunk },
        {
          ...chunk,
          chunk_id: "orphan#1",
          source_id: "missing-source",
          path: "docs/missing.md"
        }
      ]
    };
    await writeJsonFileAtomic(indexPath, corrupted);
    await writeFile(path.join(root, "docs", "source.md"), "Source changed after indexing.", "utf8");

    const result = await verifyRagIndex(root);
    expect(result.status).toBe("UNPASSED");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "source_count_mismatch",
        "chunk_count_mismatch",
        "duplicate_source_id",
        "duplicate_chunk_id",
        "orphan_chunk",
        "source_drift",
        "index_checksum_mismatch"
      ])
    );
  });

  it("plans without changing the index and executes only with exact confirmation", async () => {
    const root = await createProjectWithDocument();
    const built = await buildRagIndex(root, {
      now: () => new Date("2026-07-16T01:00:00.000Z")
    });
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const before = await readJsonFile<RagIndex>(indexPath);
    const rebuildId = "RAG-REBUILD-20260716T030000000Z";
    const plan = await planRagRebuild(root, {
      now: new Date("2026-07-16T03:00:00.000Z"),
      rebuildId
    });

    expect(plan).toMatchObject({
      rebuild_id: rebuildId,
      status: "ready",
      comparison: { status: "passed", reasons: [] }
    });
    expect((await readJsonFile<RagIndex>(indexPath)).updated_at).toBe(before.updated_at);
    await expect(
      executeRagRebuild(root, rebuildId, {
        confirm: "RAG-REBUILD-20260716T999999999Z"
      })
    ).rejects.toThrow("confirmation must exactly match");

    const executed = await executeRagRebuild(root, rebuildId, {
      confirm: rebuildId,
      now: new Date("2026-07-16T03:05:00.000Z")
    });
    const current = await readJsonFile<RagIndex>(indexPath);
    expect(executed.status).toBe("executed");
    expect(current.manifest?.index_checksum).toBe(plan.candidate.checksum);
    expect(current.manifest?.index_checksum).toBe(built.index.manifest?.index_checksum);
  });

  it("rejects execution when sources changed after the rebuild plan", async () => {
    const root = await createProjectWithDocument();
    await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const before = await readJsonFile<RagIndex>(indexPath);
    const rebuildId = "RAG-REBUILD-20260716T040000000Z";
    await planRagRebuild(root, {
      now: new Date("2026-07-16T04:00:00.000Z"),
      rebuildId
    });
    await writeFile(path.join(root, "docs", "source.md"), "Changed after rebuild planning.", "utf8");

    await expect(
      executeRagRebuild(root, rebuildId, {
        confirm: rebuildId,
        now: new Date("2026-07-16T04:05:00.000Z")
      })
    ).rejects.toThrow("candidate changed after planning");
    expect((await readJsonFile<RagIndex>(indexPath)).manifest?.index_checksum).toBe(
      before.manifest?.index_checksum
    );
    await expect(
      readJsonFile<RagRebuildArtifact>(
        path.join(root, ".kairon", "rag", "rebuilds", `${rebuildId}.json`)
      )
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("blocks a rebuild candidate that loses a configured query sample", async () => {
    const root = await createProjectWithDocument();
    const documentPath = path.join(root, "docs", "source.md");
    await writeFile(documentPath, "uniquequalitysentinel", "utf8");
    const configPath = path.join(root, ".kairon", "config", "rag.json");
    const config = await readJsonFile<Record<string, any>>(configPath);
    config.integrity.query_samples = [
      "token=must-not-leak uniquequalitysentinel"
    ];
    await writeJsonFileAtomic(configPath, config);
    await buildRagIndex(root);
    await unlink(documentPath);

    const plan = await planRagRebuild(root, {
      now: new Date("2026-07-16T04:30:00.000Z"),
      rebuildId: "RAG-REBUILD-20260716T043000000Z"
    });

    expect(plan.status).toBe("blocked");
    expect(plan.comparison).toMatchObject({
      status: "failed",
      reasons: ["query_sample_regression"],
      query_samples: [
        expect.objectContaining({
          query: "token=[redacted] uniquequalitysentinel",
          current_matches: 1,
          candidate_matches: 0,
          regression: true
        })
      ]
    });
    await expect(
      executeRagRebuild(root, plan.rebuild_id, { confirm: plan.rebuild_id })
    ).rejects.toThrow("is not ready");
    expect(JSON.stringify(plan)).not.toContain("must-not-leak");
  });

  it("reports duplicate chunks and configured context budget pressure", async () => {
    const root = await createProjectWithDocument();
    const built = await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const duplicate = {
      ...built.index.chunks[0]!,
      chunk_id: `${built.index.chunks[0]!.source_id}#duplicate`
    };
    const index: RagIndex = {
      ...built.index,
      chunk_count: built.index.chunk_count + 1,
      chunks: [...built.index.chunks, duplicate]
    };
    index.manifest = createRagIndexManifest(index, "2026-07-16T05:00:00.000Z");
    await writeJsonFileAtomic(indexPath, index);
    const configPath = path.join(root, ".kairon", "config", "rag.json");
    const config = await readJsonFile<Record<string, any>>(configPath);
    config.integrity.context_budget_tokens = 1;
    await writeJsonFileAtomic(configPath, config);

    const stats = await getRagStats(root, { now: new Date("2026-07-16T05:00:00.000Z") });
    expect(stats.duplicate_chunk_count).toBeGreaterThanOrEqual(1);
    expect(stats.duplicate_ratio).toBeGreaterThan(0);
    expect(stats.context_budget_tokens).toBe(1);
    expect(stats.chunks_exceeding_context_budget).toBeGreaterThan(0);
  });

  it("uses the same resource lock for compact and rebuild candidates", async () => {
    const root = await createProjectWithDocument();
    await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const lock = await acquireResourceLock(root, indexPath, {
      owner: "test-rag-exclusive-lock",
      ttlMs: 30_000
    });
    try {
      await expect(compactRagIndex(root)).rejects.toThrow("Resource lock already exists");
      await expect(
        buildRagIndex(root, { fullRebuild: true, writeIndex: false })
      ).rejects.toThrow("Resource lock already exists");
    } finally {
      await releaseResourceLock(lock);
    }
  });
});

async function createProjectWithDocument(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "source.md"),
    "Approval routing and runtime recovery review findings.",
    "utf8"
  );
  return root;
}
