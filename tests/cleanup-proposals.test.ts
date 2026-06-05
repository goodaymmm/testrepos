import { describe, expect, it } from "vitest";
import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import { createCleanupProposals } from "../src/maintenance/cleanup-proposals.js";
import { createTempProject } from "./test-utils.js";

describe("createCleanupProposals", () => {
  it("creates tmp move proposals without deleting or moving generated paths", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "bundle.js"), "console.log('built');\n", "utf8");
    await mkdir(path.join(root, "coverage"), { recursive: true });
    await writeFile(path.join(root, "coverage", "summary.json"), "{}\n", "utf8");
    await writeFile(
      path.join(root, ".kairon", "config", "project.json.bak-20260601010101"),
      "{}\n",
      "utf8"
    );
    await mkdir(path.join(root, ".kairon", "tmp", "existing"), { recursive: true });
    await writeFile(path.join(root, ".kairon", "tmp", "existing", "keep.txt"), "keep\n", "utf8");

    const proposal = await createCleanupProposals(root, { date: "2026-05-25" });

    expect(proposal.direct_delete).toBe(false);
    expect(proposal.candidates.map((candidate) => candidate.path)).toEqual([
      ".kairon/config/project.json.bak-20260601010101",
      "coverage",
      "dist"
    ]);
    expect(proposal.candidates[0]).toMatchObject({
      proposed_action: "move_to_kairon_tmp"
    });
    expect(proposal.morning_review_task).toMatchObject({
      type: "cleanup_triage",
      priority: 100,
      schedule_mode: "active_work"
    });
    await expect(access(path.join(root, "dist", "bundle.js"))).resolves.toBeUndefined();
    await expect(
      readJsonFile(path.join(root, ".kairon", "cleanup", "proposals", "2026-05-25.json"))
    ).resolves.toMatchObject({
      date: "2026-05-25",
      direct_delete: false
    });
  });
});
