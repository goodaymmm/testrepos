import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultConfigs, kaironDirectories } from "../../core/config/defaults.js";
import { writeJsonFileAtomic } from "../../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../../core/fs/paths.js";

export type InitOptions = {
  projectRoot: string;
};

export type InitResult = {
  createdDirectories: string[];
  writtenFiles: string[];
  gitignoreSuggestionNeeded: boolean;
};

const ruleFiles: Record<string, string> = {
  "common.md": [
    "# Kairon Common Rules",
    "",
    "- Treat `.kairon/` JSON / JSONL / MD as canonical Kairon state.",
    "- Do not write secrets to Kairon artifacts.",
    "- Code-producing work requires review before commit.",
    ""
  ].join("\n"),
  "codex/AGENTS.md": [
    "# Kairon Codex Rules",
    "",
    "- Follow root `AGENTS.md` first.",
    "- Use Kairon outbox contracts for run results.",
    ""
  ].join("\n"),
  "claude/CLAUDE.md": [
    "# Kairon Claude Rules",
    "",
    "- Follow root `CLAUDE.md` first when present.",
    "- Use Kairon handoff and review contracts.",
    ""
  ].join("\n"),
  "gemini/GEMINI.md": [
    "# Kairon Gemini Rules",
    "",
    "- Follow root `GEMINI.md` first when present.",
    "- Prefer QA, research, Google ecosystem, and multimodal review tasks.",
    ""
  ].join("\n")
};

export async function initializeProject(options: InitOptions): Promise<InitResult> {
  const paths = getKaironPaths(options.projectRoot);
  const createdDirectories: string[] = [];
  const writtenFiles: string[] = [];

  for (const directory of kaironDirectories) {
    const absolutePath = resolveInside(paths.kaironDir, directory);
    await mkdir(absolutePath, { recursive: true });
    createdDirectories.push(path.relative(paths.root, absolutePath));
  }

  const configs = createDefaultConfigs(paths.root);
  for (const [fileName, value] of Object.entries(configs)) {
    const filePath = resolveInside(paths.configDir, fileName);
    if (!(await fileExists(filePath))) {
      await writeJsonFileAtomic(filePath, value);
      writtenFiles.push(path.relative(paths.root, filePath));
    }
  }

  for (const [fileName, content] of Object.entries(ruleFiles)) {
    const filePath = resolveInside(paths.rulesDir, fileName);
    if (!(await fileExists(filePath))) {
      await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
      writtenFiles.push(path.relative(paths.root, filePath));
    }
  }

  return {
    createdDirectories,
    writtenFiles,
    gitignoreSuggestionNeeded: await needsGitignoreEntry(paths.root)
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function needsGitignoreEntry(projectRoot: string): Promise<boolean> {
  const gitignorePath = resolveInside(projectRoot, ".gitignore");

  try {
    const content = await readFile(gitignorePath, "utf8");
    return !content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(".kairon/");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }

    throw error;
  }
}
