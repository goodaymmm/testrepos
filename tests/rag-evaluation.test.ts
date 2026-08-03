import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  readJsonFile,
  writeJsonFileAtomic
} from "../src/core/fs/json-file.js";
import { evaluateRagRetrieval } from "../src/rag/evaluation.js";
import { buildRagIndex } from "../src/rag/lexical-index.js";
import {
  executeRagVectorBuild,
  planRagVectorBuild
} from "../src/rag/vector-provider.js";
import { createTempProject } from "./test-utils.js";

describe("RAG retrieval quality evaluation", () => {
  it("returns SETUP_REQUIRED when a profile is not configured", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(evaluateRagRetrieval(root)).resolves.toMatchObject({
      status: "SETUP_REQUIRED",
      query_count: 0
    });
  });

  it("passes expected source hits and rejects forbidden source hits", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "approval-policy.md"),
      "Approval routing policy and review requirements.",
      "utf8"
    );
    await writeFile(
      path.join(root, "docs", "unrelated.md"),
      "Unrelated visual design notes.",
      "utf8"
    );
    await configureEvaluation(root, {
      vectorEnabled: true,
      forbiddenPaths: ["docs/private/**"]
    });
    await buildRagIndex(root);
    const plan = await planRagVectorBuild(root);
    await executeRagVectorBuild(root, plan.build_id);

    const result = await evaluateRagRetrieval(root, "default", {
      now: new Date("2026-07-24T05:00:00.000Z")
    });
    expect(result).toMatchObject({
      status: "PASS",
      passed_query_count: 1,
      unpassed_query_count: 0,
      setup_required_query_count: 0
    });
    expect(result.results[0]).toMatchObject({
      required_hit: true,
      forbidden_hit_count: 0,
      retrieval_status: "ready",
      effective_mode: "hybrid"
    });
    expect(result.artifact_path).toMatch(
      /^\.kairon\/rag\/evaluations\/RAG-EVAL-/u
    );
  });

  it("does not treat lexical fallback as vector quality PASS", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "approval-policy.md"),
      "Approval routing policy.",
      "utf8"
    );
    await configureEvaluation(root, {
      vectorEnabled: false,
      forbiddenPaths: []
    });

    const result = await evaluateRagRetrieval(root);
    expect(result).toMatchObject({
      status: "SETUP_REQUIRED",
      setup_required_query_count: 1
    });
    expect(result.results[0]).toMatchObject({
      retrieval_status: "degraded",
      effective_mode: "lexical"
    });
  });
});

async function configureEvaluation(
  root: string,
  options: { vectorEnabled: boolean; forbiddenPaths: string[] }
): Promise<void> {
  const configPath = path.join(root, ".kairon", "config", "rag.json");
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  config.vector = {
    enabled: options.vectorEnabled,
    provider: "local_hash",
    model_id: "kairon-local-hash-v1",
    dimension: 256
  };
  config.retrieval = {
    default_mode: "lexical",
    hybrid: {
      lexical: 0.45,
      vector: 0.45,
      freshness: 0.1,
      source_diversity_penalty: 0.08
    }
  };
  config.evaluation = {
    profiles: {
      default: {
        mode: "hybrid",
        top_k: 3,
        minimum_precision_at_k: 0.3,
        queries: [
          {
            id: "approval-policy",
            query: "approval routing policy",
            expected_paths: ["docs/approval-policy.md"],
            forbidden_paths: options.forbiddenPaths
          }
        ]
      }
    }
  };
  await writeJsonFileAtomic(configPath, config);
}
