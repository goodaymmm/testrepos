import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCleanupCommand,
  archiveCleanupCommand,
  listCleanupCommand,
  showCleanupCommand
} from "../src/cli/commands/cleanup.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile } from "../src/core/fs/json-file.js";
import {
  applyCleanupProposal,
  archiveCleanupProposal,
  createCleanupProposals,
  type CleanupApplyResult
} from "../src/maintenance/cleanup-proposals.js";
import { createTempProject } from "./test-utils.js";

describe("cleanup proposal commands", () => {
  it("lists, shows, dry-runs, and applies reviewed cleanup candidates safely", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "bundle.js"), "built\n", "utf8");
    await writeFile(path.join(root, ".env.local"), "SECRET=value\n", "utf8");
    await createCleanupProposals(root, {
      date: "2026-06-02",
      candidatePaths: [".env.local"]
    });

    await expect(listCleanupCommand(root)).resolves.toContain(
      "date=2026-06-02 candidates=2"
    );
    await expect(showCleanupCommand(root, "2026-06-02")).resolves.toContain(
      "candidate=CLEAN-20260602-002 kind=directory path=dist"
    );

    const dryRun = await applyCleanupProposal({
      projectRoot: root,
      proposalId: "2026-06-02",
      dryRun: true,
      now: new Date(2026, 5, 2, 3, 4, 5)
    });

    expect(dryRun).toMatchObject({
      dry_run: true,
      applied: false,
      moved: 0,
      planned: 1,
      blocked: 1
    });
    expect(dryRun.candidates.map((candidate) => candidate.status)).toEqual([
      "blocked_protected_path",
      "planned"
    ]);
    await expect(access(path.join(root, "dist", "bundle.js"))).resolves.toBeUndefined();

    const apply = await applyCleanupProposal({
      projectRoot: root,
      proposalId: "2026-06-02",
      now: new Date(2026, 5, 2, 3, 4, 5)
    });

    expect(apply).toMatchObject({
      dry_run: false,
      applied: true,
      moved: 1,
      planned: 0,
      blocked: 1,
      artifact_path: ".kairon/cleanup/applied/2026-06-02-20260602030405.json"
    });
    await expect(access(path.join(root, "dist"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      readFile(
        path.join(root, ".kairon", "tmp", "2026-06-02", "dist", "bundle.js"),
        "utf8"
      )
    ).resolves.toBe("built\n");
    await expect(readFile(path.join(root, ".env.local"), "utf8")).resolves.toBe(
      "SECRET=value\n"
    );
    await expect(
      readJsonFile<CleanupApplyResult>(
        path.join(
          root,
          ".kairon",
          "cleanup",
          "applied",
          "2026-06-02-20260602030405.json"
        )
      )
    ).resolves.toMatchObject({
      schema_version: "0.1",
      moved: 1,
      blocked: 1
    });

    await expect(applyCleanupCommand(root, "2026-06-02", { dryRun: true })).resolves.toContain(
      "dry_run=true"
    );
  });

  it("archives reviewed cleanup proposals", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "coverage"), { recursive: true });
    await writeFile(path.join(root, "coverage", "summary.json"), "{}\n", "utf8");
    await createCleanupProposals(root, { date: "2026-06-03" });

    const result = await archiveCleanupProposal({
      projectRoot: root,
      proposalId: "2026-06-03",
      now: new Date(2026, 5, 3, 4, 5, 6)
    });

    expect(result).toEqual({
      proposal_date: "2026-06-03",
      proposal_path: ".kairon/cleanup/proposals/2026-06-03.json",
      archived_path: ".kairon/cleanup/archived/2026-06-03-20260603040506.json"
    });
    await expect(
      access(path.join(root, ".kairon", "cleanup", "proposals", "2026-06-03.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readJsonFile(path.join(root, ".kairon", "cleanup", "archived", "2026-06-03-20260603040506.json"))
    ).resolves.toMatchObject({
      date: "2026-06-03"
    });

    await createCleanupProposals(root, { date: "2026-06-04" });
    await expect(archiveCleanupCommand(root, "2026-06-04")).resolves.toContain(
      "Kairon cleanup proposal archived."
    );
  });
});
