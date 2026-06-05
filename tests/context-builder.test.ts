import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ContextBuilder } from "../src/agents/context-builder.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { appendJsonLine } from "../src/core/fs/jsonl-file.js";
import { buildRagIndex } from "../src/rag/lexical-index.js";
import { createTempProject } from "./test-utils.js";

describe("ContextBuilder", () => {
  it("builds run context from task, messages, rules, and scratch", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const taskDir = path.join(root, ".kairon", "tasks", "TASK-0001");
    await mkdir(taskDir, { recursive: true });
    await writeJsonFileAtomic(path.join(taskDir, "task.json"), {
      schema_version: "0.1",
      id: "TASK-0001",
      title: "Build agent dispatcher",
      status: "ready"
    });
    await appendJsonLine(path.join(root, ".kairon", "messages", "TASK-0001.jsonl"), {
      schema_version: "0.1",
      message_type: "handoff",
      body: "Use the dispatcher contract."
    });
    await mkdir(path.join(root, ".kairon", "sessions", "2026-05-25", "codex"), {
      recursive: true
    });
    await writeFile(
      path.join(root, ".kairon", "sessions", "2026-05-25", "codex", "scratch.md"),
      "Current same-day scratch.",
      "utf8"
    );

    const bundle = await new ContextBuilder(root).buildRunContext({
      runId: "RUN-0001",
      taskId: "TASK-0001",
      agent: "codex",
      persona: "implementer",
      date: "2026-05-25"
    });

    expect(bundle.sources.map((source) => source.type)).toEqual(
      expect.arrayContaining(["task", "messages", "rule", "scratch"])
    );
    await expect(readFile(path.join(root, bundle.context_path), "utf8")).resolves.toContain(
      "Build agent dispatcher"
    );
    await expect(
      readJsonFile(path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"))
    ).resolves.not.toHaveProperty("human_summary");
  });

  it("builds a daily bootstrap context without a task", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const bundle = await new ContextBuilder(root).buildDailyBootstrap({
      agent: "gemini",
      date: "2026-05-25"
    });

    expect(bundle.kind).toBe("daily_bootstrap");
    expect(bundle.task_id).toBeUndefined();
    await expect(readFile(path.join(root, bundle.context_path), "utf8")).resolves.toContain(
      "Kairon Context Bundle"
    );
  });

  it("injects RAG retrieval results into run context when enabled", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "approval-routing.md"),
      "Approval routing context must include board projection evidence.",
      "utf8"
    );
    const taskDir = path.join(root, ".kairon", "tasks", "TASK-0002");
    await mkdir(taskDir, { recursive: true });
    await writeJsonFileAtomic(path.join(taskDir, "task.json"), {
      schema_version: "0.1",
      id: "TASK-0002",
      title: "Implement approval routing context"
    });
    await buildRagIndex(root);

    const bundle = await new ContextBuilder(root, {
      rag: { enabled: true, topK: 1 }
    }).buildRunContext({
      runId: "RUN-0002",
      taskId: "TASK-0002",
      agent: "codex",
      persona: "implementer",
      date: "2026-05-25"
    });

    expect(bundle.sources.map((source) => source.type)).toContain("rag");
    expect(bundle.rag_results).toMatchObject([
      {
        path: "docs/approval-routing.md",
        source_id: expect.stringContaining("document:docs/approval-routing.md"),
        content_hash: expect.stringMatching(/^sha256:/)
      }
    ]);
    await expect(readFile(path.join(root, bundle.context_path), "utf8")).resolves.toContain(
      "source_id=document:docs/approval-routing.md"
    );
    await expect(readJsonFile(path.join(root, bundle.manifest_path))).resolves.toMatchObject({
      rag_results: [
        {
          path: "docs/approval-routing.md"
        }
      ]
    });
  });
});
