import {
  access,
  mkdir,
  readFile,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCleanupCommand,
  archiveCleanupCommand,
  listCleanupCommand,
  planCleanupRetentionCommand,
  showCleanupCommand
} from "../src/cli/commands/cleanup.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
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

  it("uses a unique tmp destination when the proposed cleanup destination exists", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "bundle.js"), "new build\n", "utf8");
    await createCleanupProposals(root, {
      date: "2026-06-05",
      candidatePaths: ["dist"]
    });
    await mkdir(path.join(root, ".kairon", "tmp", "2026-06-05", "dist"), {
      recursive: true
    });
    await writeFile(
      path.join(root, ".kairon", "tmp", "2026-06-05", "dist", "bundle.js"),
      "old build\n",
      "utf8"
    );

    const dryRunOutput = await applyCleanupCommand(root, "2026-06-05", {
      dryRun: true
    });
    expect(dryRunOutput).toContain(
      ".kairon/tmp/2026-06-05/dist-2 reason=destination already exists"
    );

    const result = await applyCleanupProposal({
      projectRoot: root,
      proposalId: "2026-06-05"
    });

    expect(result).toMatchObject({
      moved: 1,
      blocked: 0,
      candidates: [
        expect.objectContaining({
          status: "moved",
          destination: ".kairon/tmp/2026-06-05/dist-2",
          reason:
            "destination already exists; using .kairon/tmp/2026-06-05/dist-2"
        })
      ]
    });
    await expect(
      readFile(
        path.join(root, ".kairon", "tmp", "2026-06-05", "dist", "bundle.js"),
        "utf8"
      )
    ).resolves.toBe("old build\n");
    await expect(
      readFile(
        path.join(root, ".kairon", "tmp", "2026-06-05", "dist-2", "bundle.js"),
        "utf8"
      )
    ).resolves.toBe("new build\n");
  });

  it("dry-runs and writes retention-only proposals for operator review", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const policiesPath = path.join(root, ".kairon", "config", "policies.json");
    const policies = await readJsonFile<TestPoliciesConfig>(policiesPath);
    policies.cleanup.retention.categories.daemon_logs = {
      max_age_days: 1,
      max_files: 10,
      max_bytes: 1_000_000,
      min_keep: 1
    };
    await writeJsonFileAtomic(policiesPath, policies);
    const daemonDir = path.join(root, ".kairon", "runtime", "daemon");
    const oldLog = path.join(daemonDir, "2026-01-01.jsonl");
    const currentLog = path.join(daemonDir, "2026-01-02.jsonl");
    await writeFile(oldLog, "{}\n", "utf8");
    await writeFile(currentLog, "{}\n", "utf8");
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const currentTime = new Date("2026-01-02T00:00:00Z");
    await utimes(oldLog, oldTime, oldTime);
    await utimes(currentLog, currentTime, currentTime);

    const dryRun = await planCleanupRetentionCommand(root, { dryRun: true });

    expect(dryRun).toContain("Kairon cleanup retention dry run.");
    expect(dryRun).toContain("written=false");
    expect(dryRun).toContain("category=daemon_logs");
    expect(dryRun).toContain("path=.kairon/runtime/daemon/2026-01-01.jsonl");

    const written = await planCleanupRetentionCommand(root, {
      writeProposal: true
    });
    expect(written).toContain("Kairon cleanup retention proposal created.");
    expect(written).toContain("written=true");
    await expect(listCleanupCommand(root)).resolves.toContain(
      "proposal_id=retention-"
    );

    const proposalId = /proposal_id=(retention-\d{14})/.exec(written)?.[1];
    expect(proposalId).toBeDefined();
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "approvals", "APR-RETENTION.json"),
      {
        schema_version: "0.1",
        id: "APR-RETENTION",
        status: "pending",
        artifact_path: ".kairon/runtime/daemon/2026-01-01.jsonl"
      }
    );
    const rechecked = await applyCleanupProposal({
      projectRoot: root,
      proposalId: proposalId!,
      dryRun: true
    });
    expect(rechecked).toMatchObject({
      planned: 0,
      blocked: 1,
      candidates: [
        expect.objectContaining({
          status: "blocked_retention_changed"
        })
      ]
    });
  });

  it("rejects conflicting retention plan modes", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      planCleanupRetentionCommand(root, {
        dryRun: true,
        writeProposal: true
      })
    ).rejects.toThrow("Use either --dry-run or --write-proposal");
  });

  it("blocks symbolic links and proposal paths that escape the project", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const target = path.join(root, "linked-target");
    const link = path.join(root, "linked-output");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "output.txt"), "keep\n", "utf8");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const proposal = await createCleanupProposals(root, {
      date: "2026-06-06",
      candidatePaths: ["linked-output"]
    });

    expect(proposal.candidates).toEqual([
      expect.objectContaining({
        path: "linked-output",
        kind: "symbolic_link",
        size_bytes: 0
      })
    ]);
    await expect(
      applyCleanupProposal({
        projectRoot: root,
        proposalId: "2026-06-06",
        dryRun: true
      })
    ).resolves.toMatchObject({
      blocked: 1,
      candidates: [
        expect.objectContaining({ status: "blocked_symbolic_link" })
      ]
    });

    proposal.candidates[0]!.path = "../outside";
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "cleanup", "proposals", "2026-06-06.json"),
      proposal
    );
    await expect(
      applyCleanupProposal({
        projectRoot: root,
        proposalId: "2026-06-06",
        dryRun: true
      })
    ).resolves.toMatchObject({
      blocked: 1,
      candidates: [
        expect.objectContaining({ status: "blocked_invalid_destination" })
      ]
    });
  });
});

type TestPoliciesConfig = {
  cleanup: {
    retention: {
      categories: Record<string, TestRetentionRule>;
    };
  };
};

type TestRetentionRule = {
  max_age_days: number;
  max_files: number;
  max_bytes: number;
  min_keep: number;
};
