import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  buildRagIndex,
  getRagIndexStatus,
  type RagIndex
} from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";

describe("RAG incremental lexical index", () => {
  it("keeps scoped mode when the initial refresh uses filters", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "scoped.md"), "Scoped RAG source.", "utf8");

    const result = await buildRagIndex(root, { sourceTypes: ["document"] });
    expect(result.refresh_mode).toBe("scoped");
    expect(result.index.refresh?.mode).toBe("scoped");
    expect(result.index.sources).toEqual([
      expect.objectContaining({ path: "docs/scoped.md" })
    ]);
  });

  it("reuses unchanged sources and rebuilds only changed content", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const changedDoc = path.join(root, "docs", "changed.md");
    const stableDoc = path.join(root, "docs", "stable.md");
    await writeFile(changedDoc, "Initial incremental RAG content.", "utf8");
    await writeFile(stableDoc, "Stable incremental RAG content.", "utf8");
    const initialMtime = new Date("2026-07-10T00:00:00.000Z");
    await utimes(changedDoc, initialMtime, initialMtime);
    await utimes(stableDoc, initialMtime, initialMtime);

    const first = await buildRagIndex(root, {
      now: () => new Date("2026-07-10T01:00:00.000Z")
    });
    const firstStable = first.index.sources.find(
      (source) => source.path === "docs/stable.md"
    );
    expect(first.refresh_mode).toBe("full");
    expect(first.added_source_count).toBe(first.source_count);
    expect(firstStable).toMatchObject({
      file_mtime_ms: expect.any(Number),
      file_size_bytes: expect.any(Number)
    });

    const unchanged = await buildRagIndex(root, {
      now: () => new Date("2026-07-10T02:00:00.000Z")
    });
    expect(unchanged.refresh_mode).toBe("incremental");
    expect(unchanged.added_source_count).toBe(0);
    expect(unchanged.updated_source_count).toBe(0);
    expect(unchanged.unchanged_source_count).toBe(unchanged.source_count);
    expect(
      unchanged.index.sources.find((source) => source.path === "docs/stable.md")
    ).toMatchObject({
      source_id: firstStable?.source_id,
      content_hash: firstStable?.content_hash,
      first_indexed_at: firstStable?.first_indexed_at,
      last_seen_at: "2026-07-10T02:00:00.000Z"
    });

    await writeFile(changedDoc, "Updated incremental RAG content.", "utf8");
    const changedMtime = new Date("2026-07-10T03:00:00.000Z");
    await utimes(changedDoc, changedMtime, changedMtime);
    const changed = await buildRagIndex(root, {
      now: () => new Date("2026-07-10T04:00:00.000Z")
    });

    expect(changed.refresh_mode).toBe("incremental");
    expect(changed.added_source_count).toBe(0);
    expect(changed.updated_source_count).toBe(1);
    expect(changed.unchanged_source_count).toBe(changed.source_count - 1);
    expect(changed.index.refresh).toMatchObject({
      mode: "incremental",
      updated_source_count: 1,
      skipped_reasons: expect.objectContaining({
        protected: expect.any(Number),
        generated: expect.any(Number)
      })
    });
  });

  it("reports protected, generated, and missing prune reasons", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs", "private"), { recursive: true });
    await mkdir(path.join(root, "docs", "generated"), { recursive: true });
    const protectedDoc = path.join(root, "docs", "private", "internal.md");
    const generatedDoc = path.join(root, "docs", "generated", "output.md");
    const missingDoc = path.join(root, "docs", "missing.md");
    await writeFile(protectedDoc, "Private source initially indexed.", "utf8");
    await writeFile(generatedDoc, "Generated source initially indexed.", "utf8");
    await writeFile(missingDoc, "Missing source initially indexed.", "utf8");
    await buildRagIndex(root);

    const projectPath = path.join(root, ".kairon", "config", "project.json");
    const project = await readJsonFile<{
      paths: { protected: string[]; generated: string[] };
    }>(projectPath);
    project.paths.protected.push("docs/private/**");
    project.paths.generated.push("docs/generated/**");
    await writeJsonFileAtomic(projectPath, project);
    await unlink(missingDoc);

    const refreshed = await buildRagIndex(root, { prune: true });
    expect(refreshed.skipped_reason_counts).toMatchObject({
      protected: 1,
      generated: 1
    });
    expect(refreshed.pruned_reason_counts).toMatchObject({
      protected: 1,
      generated: 1,
      missing: 1
    });
    expect(refreshed.pruned_excluded_source_count).toBe(2);
    expect(refreshed.index.sources.map((source) => source.path)).not.toEqual(
      expect.arrayContaining([
        "docs/private/internal.md",
        "docs/generated/output.md",
        "docs/missing.md"
      ])
    );
  });

  it("shows pending added, changed, and missing sources in freshness status", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    const changedDoc = path.join(root, "docs", "freshness-change.md");
    const removedDoc = path.join(root, "docs", "freshness-remove.md");
    await writeFile(changedDoc, "Fresh source before edit.", "utf8");
    await writeFile(removedDoc, "Fresh source before removal.", "utf8");
    await buildRagIndex(root);

    await expect(getRagIndexStatus(root)).resolves.toMatchObject({
      freshness_status: "fresh",
      pending_added_source_count: 0,
      pending_changed_source_count: 0,
      pending_missing_source_count: 0
    });

    await writeFile(changedDoc, "Stale source after edit.", "utf8");
    await writeFile(path.join(root, "docs", "freshness-add.md"), "New source.", "utf8");
    await unlink(removedDoc);

    await expect(getRagIndexStatus(root)).resolves.toMatchObject({
      freshness_status: "stale",
      pending_added_source_count: 1,
      pending_changed_source_count: 1,
      pending_missing_source_count: 1
    });
  });

  it("loads an index manifest with the latest refresh summary", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await buildRagIndex(root);
    const index = await readJsonFile<RagIndex>(
      path.join(root, ".kairon", "rag", "index.json")
    );

    expect(index.refresh).toMatchObject({
      mode: "full",
      scanned_source_count: expect.any(Number),
      skipped_reasons: expect.any(Object),
      pruned_reasons: expect.any(Object)
    });
  });

  it("upgrades legacy source entries during the next incremental refresh", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const built = await buildRagIndex(root);
    const indexPath = path.join(root, ".kairon", "rag", "index.json");
    const legacyIndex: RagIndex = {
      ...built.index,
      refresh: undefined,
      sources: built.index.sources.map((source) => ({
        ...source,
        file_mtime_ms: undefined,
        file_size_bytes: undefined
      }))
    };
    await writeJsonFileAtomic(indexPath, legacyIndex);

    const refreshed = await buildRagIndex(root);
    expect(refreshed.refresh_mode).toBe("incremental");
    expect(refreshed.updated_source_count).toBe(0);
    expect(refreshed.unchanged_source_count).toBe(refreshed.source_count);
    expect(refreshed.index.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_mtime_ms: expect.any(Number),
          file_size_bytes: expect.any(Number)
        })
      ])
    );
  });
});
