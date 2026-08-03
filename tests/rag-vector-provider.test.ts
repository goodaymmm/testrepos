import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../src/core/fs/json-file.js";
import { buildRagIndex } from "../src/rag/lexical-index.js";
import {
  executeRagVectorBuild,
  getRagVectorProviderStatus,
  inspectRagVectorIntegrity,
  planRagVectorBuild,
  searchRagVectorIndex,
  type RagVectorIndex,
  type RagVectorManifest
} from "../src/rag/vector-provider.js";
import { createTempProject } from "./test-utils.js";

describe("RAG local vector provider", () => {
  it("classifies the disabled local provider as SETUP_REQUIRED without network use", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(getRagVectorProviderStatus(root)).resolves.toMatchObject({
      capability: "setup_required",
      provider: "local_hash",
      local_only: true,
      external_network: false,
      enabled: false
    });
    const plan = await planRagVectorBuild(root, {
      now: new Date("2026-07-24T01:02:03.456Z")
    });
    expect(plan).toMatchObject({
      status: "setup_required",
      entry_count: 0,
      embedded_entry_count: 0
    });
    expect(plan.build_id).toMatch(
      /^RAG-VECTOR-BUILD-20260724T010203456Z-[0-9a-f]{8}$/u
    );

    const configPath = path.join(root, ".kairon", "config", "rag.json");
    const config = await readJsonFile<Record<string, any>>(configPath);
    config.vector.enabled = true;
    config.vector.provider = "local_onnx";
    await writeJsonFileAtomic(configPath, config);
    await expect(getRagVectorProviderStatus(root)).resolves.toMatchObject({
      capability: "setup_required",
      provider: "local_onnx",
      reason: "local ONNX runtime is not installed"
    });
  });

  it("plans and executes a confirmed local vector build without logging embeddings", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableLocalVector(root);
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "approval-routing.md"),
      "Approval routing requires protected branch review.",
      "utf8"
    );
    await buildRagIndex(root);

    const plan = await planRagVectorBuild(root, {
      now: new Date("2026-07-24T02:00:00.000Z")
    });
    expect(plan).toMatchObject({
      status: "ready",
      provider: expect.objectContaining({
        provider: "local_hash",
        model_id: "kairon-local-hash-v1",
        dimension: 256
      }),
      embedded_entry_count: expect.any(Number)
    });
    expect(JSON.stringify(plan)).not.toContain('"vector"');

    const executed = await executeRagVectorBuild(root, plan.build_id, {
      now: new Date("2026-07-24T02:01:00.000Z")
    });
    expect(executed.status).toBe("executed");

    const manifest = await readJsonFile<RagVectorManifest>(
      path.join(root, ".kairon", "rag", "vector", "manifest.json")
    );
    const index = await readJsonFile<RagVectorIndex>(
      path.join(root, ".kairon", "rag", "vector", "index.json")
    );
    expect(manifest).toMatchObject({
      dimension: 256,
      entry_count: index.entries.length,
      index_checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      source_manifest_checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
    });
    expect(index.entries[0]).toMatchObject({
      embedding_cache_key: expect.stringMatching(/^sha256:/u),
      embedding_checksum: expect.stringMatching(/^sha256:/u),
      vector: expect.any(Array)
    });

    const search = await searchRagVectorIndex(root, {
      query: "approval routing",
      topK: 3,
      explain: true,
      filters: { collections: ["documents"] }
    });
    expect(search.status).toBe("ready");
    expect(search.results[0]).toMatchObject({
      path: "docs/approval-routing.md",
      explain: expect.objectContaining({
        vector_score: expect.any(Number)
      })
    });
  });

  it("reuses cached embeddings and detects vector drift", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableLocalVector(root);
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "memory.md"),
      "Runtime recovery memory quality.",
      "utf8"
    );
    const lexical = await buildRagIndex(root);
    const firstPlan = await planRagVectorBuild(root, {
      now: new Date("2026-07-24T03:00:00.000Z")
    });
    await executeRagVectorBuild(root, firstPlan.build_id, {
      now: new Date("2026-07-24T03:01:00.000Z")
    });

    const secondPlan = await planRagVectorBuild(root, {
      now: new Date("2026-07-24T03:02:00.000Z")
    });
    expect(secondPlan.reused_entry_count).toBe(secondPlan.entry_count);
    expect(secondPlan.embedded_entry_count).toBe(0);
    await executeRagVectorBuild(root, secondPlan.build_id, {
      now: new Date("2026-07-24T03:03:00.000Z")
    });

    const vectorPath = path.join(root, ".kairon", "rag", "vector", "index.json");
    const vector = await readJsonFile<RagVectorIndex>(vectorPath);
    vector.entries[0]!.vector = vector.entries[0]!.vector.slice(1);
    await writeJsonFileAtomic(vectorPath, vector);

    await expect(
      inspectRagVectorIntegrity(root, lexical.index)
    ).resolves.toEqual(
      expect.arrayContaining([
        "vector_dimension_mismatch",
        "vector_index_checksum_mismatch"
      ])
    );
    await expect(
      searchRagVectorIndex(root, { query: "runtime recovery" })
    ).resolves.toMatchObject({
      status: "stale",
      results: []
    });
  });
});

async function enableLocalVector(root: string): Promise<void> {
  const configPath = path.join(root, ".kairon", "config", "rag.json");
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  config.vector = {
    enabled: true,
    provider: "local_hash",
    model_id: "kairon-local-hash-v1",
    dimension: 256
  };
  await writeJsonFileAtomic(configPath, config);
}
