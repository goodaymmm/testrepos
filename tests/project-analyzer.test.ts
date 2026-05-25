import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeDocking } from "../src/cli/commands/docking.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { analyzeProjectDocking } from "../src/docking/project-analyzer.js";
import { createTempProject } from "./test-utils.js";

describe("analyzeProjectDocking", () => {
  it("proposes protected, generated, and source paths without writing config", async () => {
    const root = await createEnglishAppLikeProject();
    await initializeProject({ projectRoot: root });
    const projectConfigPath = path.join(root, ".kairon", "config", "project.json");
    const before = await readFile(projectConfigPath, "utf8");

    const analysis = await analyzeProjectDocking(root);
    const project = analysis.project_config;
    const after = await readFile(projectConfigPath, "utf8");

    expect(after).toBe(before);
    expect(analysis).toMatchObject({
      schema_version: "0.1",
      proposal_kind: "project_config"
    });
    expect(project.primary_language).toBe("mixed");
    expect(project.frameworks).toEqual(["flutter", "python"]);
    expect(project.package_managers).toEqual(["flutter"]);
    expect(project.paths.protected).toEqual(
      expect.arrayContaining([
        ".env*",
        ".github/workflows/**",
        ".mcp.json",
        ".claude/**",
        ".gemini/**",
        ".antigravitycli/**"
      ])
    );
    expect(project.paths.generated).toEqual(
      expect.arrayContaining([
        "dist/**",
        "build/**",
        "coverage/**",
        "tmp/**",
        "node_modules/**",
        "tmpclaude-*"
      ])
    );
    expect(project.paths.source).toEqual(
      expect.arrayContaining([
        "facespeak/**",
        "flutter/**",
        "scripts/**",
        "AgentDoc/**",
        "Doc/**",
        "Knowledge/**",
        "memo/**",
        "*.py",
        "*.md",
        "*.xml",
        "*.vrm",
        "*.png",
        "docker-compose.yml"
      ])
    );
    expect(project.paths.source).not.toContain(".mcp.json");
    expect(project.paths.source).not.toContain(".claude/**");
  });

  it("prints the docking analysis as JSON from the CLI command helper", async () => {
    const root = await createEnglishAppLikeProject();
    const text = await analyzeDocking(root);
    const parsed = JSON.parse(text) as Awaited<ReturnType<typeof analyzeProjectDocking>>;

    expect(parsed.project_config.paths.protected).toContain(".mcp.json");
    expect(parsed.project_config.paths.source).toContain("scripts/**");
  });

  it("infers Node TypeScript projects and package scripts from package metadata", async () => {
    const root = await createTempProject();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          scripts: {
            build: "tsc -p tsconfig.build.json",
            test: "vitest run"
          },
          devDependencies: {
            typescript: "^5.0.0"
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf8");
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "tests"));

    const analysis = await analyzeProjectDocking(root);
    const project = analysis.project_config;

    expect(project.primary_language).toBe("typescript");
    expect(project.frameworks).toContain("node");
    expect(project.package_managers).toContain("npm");
    expect(project.commands.test).toEqual(["npm test"]);
    expect(project.commands.build).toEqual(["npm run build"]);
    expect(project.commands.lint).toEqual([]);
  });
});

async function createEnglishAppLikeProject(): Promise<string> {
  const root = await createTempProject();
  const directories = [
    ".claude",
    ".gemini",
    ".antigravitycli",
    ".git",
    ".kairon",
    "AgentDoc",
    "Doc",
    "facespeak",
    "flutter",
    "Knowledge",
    "memo",
    "scripts",
    "tmpclaude-1234-cwd"
  ];

  for (const directory of directories) {
    await mkdir(path.join(root, directory), { recursive: true });
  }

  const files = [
    ".gitignore",
    ".mcp.json",
    "AGENTS.md",
    "AvatarSample_A.vrm",
    "check_blender.py",
    "docker-compose.yml",
    "image.png",
    "lesson_view.xml",
    "pubspec.yaml"
  ];

  for (const file of files) {
    await writeFile(path.join(root, file), "{}\n", "utf8");
  }

  return root;
}
