import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { buildRagIndex } from "../src/rag/lexical-index.js";
import { retrieveRag } from "../src/rag/retriever.js";
import {
  executeRagVectorBuild,
  planRagVectorBuild
} from "../src/rag/vector-provider.js";
import { createTempProject } from "./test-utils.js";

describe("RAG unified retriever", () => {
  it("falls back to lexical with an explicit degraded status", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "fallback.md"),
      "Lexical fallback for approval routing.",
      "utf8"
    );

    const response = await retrieveRag(root, {
      query: "approval routing",
      mode: "vector",
      explain: true
    });
    expect(response).toMatchObject({
      requested_mode: "vector",
      effective_mode: "lexical",
      status: "degraded",
      fallback_reason: "local vector retrieval is disabled"
    });
    expect(response.results[0]).toMatchObject({
      path: "docs/fallback.md",
      explain: expect.objectContaining({
        retrieval_mode: "lexical",
        warnings: expect.arrayContaining([
          "vector_fallback:local_vector_retrieval_is_disabled"
        ])
      })
    });
  });

  it("does not use a stale vector index after lexical source changes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await enableVector(root);
    await mkdir(path.join(root, "docs"), { recursive: true });
    const doc = path.join(root, "docs", "stale.md");
    await writeFile(doc, "Initial runtime recovery evidence.", "utf8");
    await buildRagIndex(root);
    const plan = await planRagVectorBuild(root);
    await executeRagVectorBuild(root, plan.build_id);

    await writeFile(doc, "Updated runtime recovery evidence.", "utf8");
    await buildRagIndex(root);
    await expect(
      retrieveRag(root, {
        query: "updated runtime recovery",
        mode: "hybrid"
      })
    ).resolves.toMatchObject({
      status: "degraded",
      effective_mode: "lexical",
      fallback_reason: "vector source manifest is stale",
      results: [expect.objectContaining({ path: "docs/stale.md" })]
    });
  });
});

async function enableVector(root: string): Promise<void> {
  const configPath = path.join(root, ".kairon", "config", "rag.json");
  const config = await readJsonFile<Record<string, any>>(configPath);
  config.vector.enabled = true;
  await writeJsonFileAtomic(configPath, config);
}
