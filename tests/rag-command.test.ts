import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  queryRagIndexCommand,
  refreshRagIndexCommand,
  statusRagIndexCommand
} from "../src/cli/commands/rag.js";
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
    expect(refreshOutput).toMatch(/sources=\d+/);
    expect(refreshOutput).toMatch(/chunks=\d+/);

    const statusOutput = await statusRagIndexCommand(root);
    expect(statusOutput).toContain("exists=true");
    expect(statusOutput).toContain("index=.kairon/rag/index.json");
    expect(statusOutput).toContain("updated_at=");
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
    expect(output).not.toContain("api_token");
    expect(output).not.toContain("SHOULD_NOT_LEAK");
  });

  it("rejects invalid query filters", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      queryRagIndexCommand(root, "anything", { type: "unknown" })
    ).rejects.toThrow("Invalid RAG source type");
  });
});
