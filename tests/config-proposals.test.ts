import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfig, proposeConfig } from "../src/cli/commands/config.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  applyConfigProposal,
  createConfigProposal,
  formatConfigProposalApplyResult,
  type ConfigProposalArtifact
} from "../src/core/config/config-proposals.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("config proposal workflow", () => {
  it("saves a project config proposal without changing project.json", async () => {
    const root = await createProjectForProposal();
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const before = await readFile(projectConfigPath, "utf8");

    const result = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 5, 0)
    });
    const after = await readFile(projectConfigPath, "utf8");
    const artifact = await readJsonFile<ConfigProposalArtifact>(
      path.join(root, result.proposal_path)
    );

    expect(after).toBe(before);
    expect(result.proposal_id).toMatch(/^CFG-20260526040500-[0-9a-f]{8}$/);
    expect(result.proposal_path).toBe(
      `.kairon/config/proposals/${result.proposal_id}.json`
    );
    expect(artifact).toMatchObject({
      proposal_id: result.proposal_id,
      proposal_kind: "project_config",
      target_file: "project.json"
    });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.map((change) => change.path)).toContain("paths.protected");
  });

  it("ignores ordering-only differences in unordered project config arrays", async () => {
    const root = await createProjectForProposal();
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const proposal = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 6, 0)
    });
    const project = proposal.artifact.project_config;

    await writeJsonFileAtomic(projectConfigPath, {
      ...project,
      paths: {
        protected: [...project.paths.protected].reverse(),
        generated: [...project.paths.generated].reverse(),
        source: [...project.paths.source].reverse()
      }
    });

    const result = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 7, 0)
    });

    expect(result.changes).toEqual([]);
  });

  it("preserves manually configured paths that the analyzer does not rediscover", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const project = await readJsonFile<{
      paths: { protected: string[]; generated: string[]; source: string[] };
    }>(projectConfigPath);

    project.paths.protected.push("local-secrets/**");
    project.paths.generated.push("tmpclaude-*");
    project.paths.source.push("manual-docs/**");
    await writeJsonFileAtomic(projectConfigPath, project);

    const proposal = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 8, 0)
    });
    await applyConfigProposal({
      projectRoot: root,
      proposalId: proposal.proposal_id,
      now: new Date(2026, 4, 26, 4, 9, 0)
    });
    const stored = await readJsonFile<{
      paths: { protected: string[]; generated: string[]; source: string[] };
    }>(projectConfigPath);

    expect(proposal.artifact.project_config.paths.protected).toContain("local-secrets/**");
    expect(proposal.artifact.project_config.paths.generated).toContain("tmpclaude-*");
    expect(proposal.artifact.project_config.paths.source).toContain("manual-docs/**");
    expect(stored.paths.protected).toContain("local-secrets/**");
    expect(stored.paths.generated).toContain("tmpclaude-*");
    expect(stored.paths.source).toContain("manual-docs/**");
  });

  it("dry-runs a proposal apply without writing project.json or backups", async () => {
    const root = await createProjectForProposal();
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const before = await readFile(projectConfigPath, "utf8");
    const proposal = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 10, 0)
    });

    const result = await applyConfigProposal({
      projectRoot: root,
      proposalId: proposal.proposal_id,
      dryRun: true,
      now: new Date(2026, 4, 26, 4, 20, 0)
    });
    const after = await readFile(projectConfigPath, "utf8");

    expect(after).toBe(before);
    expect(result).toMatchObject({
      dryRun: true,
      applied: false,
      backups: [],
      validation: { ok: true }
    });
    expect(formatConfigProposalApplyResult(result)).toContain(
      "Kairon config apply dry run."
    );
  });

  it("applies a proposal with a backup and validates configs", async () => {
    const root = await createProjectForProposal();
    const proposal = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 4, 30, 0)
    });

    const result = await applyConfigProposal({
      projectRoot: root,
      proposalId: proposal.proposal_id,
      now: new Date(2026, 4, 26, 4, 35, 0)
    });
    const project = await readJsonFile<{
      paths: { protected: string[]; generated: string[]; source: string[] };
    }>(path.join(root, ".kairon", "config", "project.json"));

    expect(result).toMatchObject({
      dryRun: false,
      applied: true,
      backups: [
        ".kairon/config/project.json.bak-20260526043500"
      ],
      validation: { ok: true }
    });
    await expect(access(path.join(root, result.backups[0] ?? ""))).resolves.toBeUndefined();
    expect(project.paths.protected).toEqual(
      expect.arrayContaining([".mcp.json", ".claude/**", ".antigravitycli/**"])
    );
    expect(project.paths.generated).toContain("tmpclaude-*");
    expect(project.paths.source).toContain("scripts/**");
  });

  it("rejects stale or invalid proposals before writing config", async () => {
    const root = await createProjectForProposal();
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const before = await readFile(projectConfigPath, "utf8");
    const proposal = await createConfigProposal({
      projectRoot: root,
      now: new Date(2026, 4, 26, 5, 0, 0)
    });

    await expect(
      applyConfigProposal({
        projectRoot: root,
        proposalId: proposal.proposal_id,
        now: new Date(2026, 4, 27, 5, 0, 1)
      })
    ).rejects.toThrow("stale");

    const invalidProposalId = "CFG-20260526060000-abcdef12";
    await writeJsonFileAtomic(
      path.join(root, ".kairon", "config", "proposals", `${invalidProposalId}.json`),
      {
        ...proposal.artifact,
        proposal_id: invalidProposalId,
        proposal_kind: "unsupported"
      }
    );

    await expect(
      applyConfigProposal({
        projectRoot: root,
        proposalId: invalidProposalId,
        now: new Date(2026, 4, 26, 6, 1, 0)
      })
    ).rejects.toThrow("Only project.json");

    await expect(readFile(projectConfigPath, "utf8")).resolves.toBe(before);
  });

  it("formats CLI helpers for propose and apply", async () => {
    const root = await createProjectForProposal();

    const proposalText = await proposeConfig(root);
    const proposalId = proposalText.match(/proposal_id=(CFG-\d{14}-[0-9a-f]{8})/)?.[1];
    expect(proposalText).toContain("Kairon config proposal created.");
    expect(proposalId).toBeDefined();

    const applyText = await applyConfig(root, proposalId ?? "", { dryRun: true });

    expect(applyText).toContain("Kairon config apply dry run.");
    expect(applyText).toContain("validation.ok=true");
  });
});

async function createProjectForProposal(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });

  for (const directory of [".claude", ".antigravitycli", "scripts", "tmpclaude-1234-cwd"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }

  await writeFile(path.join(root, ".mcp.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "check.py"), "print('ok')\n", "utf8");
  await writeFile(path.join(root, "docker-compose.yml"), "services: {}\n", "utf8");

  return root;
}
