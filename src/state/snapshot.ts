import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getKaironPaths, toPosixPath } from "../core/fs/paths.js";

export type StateSnapshotDryRunResult = {
  schema_version: "0.1";
  dry_run: true;
  generated_at: string;
  summary: {
    files: number;
    bytes: number;
  };
  targets: StateSnapshotTarget[];
};

export type StateSnapshotTarget = {
  path: string;
  bytes: number;
  category: string;
};

export type StateSnapshotOptions = {
  now?: () => Date;
};

const snapshotExtensions = new Set([".json", ".jsonl", ".md"]);

export async function collectStateSnapshotDryRun(
  projectRoot: string,
  options: StateSnapshotOptions = {}
): Promise<StateSnapshotDryRunResult> {
  const now = options.now?.() ?? new Date();
  const kaironDir = getKaironPaths(projectRoot).kaironDir;
  const files: string[] = [];
  await walk(kaironDir, files);
  const targets: StateSnapshotTarget[] = [];

  for (const file of files.sort()) {
    const relativePath = toProjectPath(projectRoot, file);
    if (ignoredSnapshotPath(relativePath) || !snapshotExtensions.has(path.extname(file))) {
      continue;
    }
    const info = await stat(file);
    targets.push({
      path: relativePath,
      bytes: info.size,
      category: snapshotCategory(relativePath)
    });
  }

  return {
    schema_version: "0.1",
    dry_run: true,
    generated_at: now.toISOString(),
    summary: {
      files: targets.length,
      bytes: targets.reduce((total, target) => total + target.bytes, 0)
    },
    targets
  };
}

export function formatStateSnapshotDryRun(
  result: StateSnapshotDryRunResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "Kairon state snapshot dry-run.",
    `dry_run=${result.dry_run}`,
    `targets.files=${result.summary.files}`,
    `targets.bytes=${result.summary.bytes}`,
    ...result.targets.map(
      (target) =>
        `target category=${target.category} bytes=${target.bytes} path=${target.path}`
    )
  ].join("\n");
}

async function walk(directoryPath: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function ignoredSnapshotPath(filePath: string): boolean {
  return (
    filePath.startsWith(".kairon/tmp/") ||
    filePath.startsWith(".kairon/worktrees/") ||
    filePath.includes("/.resource-locks/")
  );
}

function snapshotCategory(filePath: string): string {
  const segments = filePath.split("/");
  if (segments.length < 3 || segments[0] !== ".kairon") {
    return "unknown";
  }

  if (segments[1] === "runtime" && segments[2] !== undefined) {
    return `runtime/${segments[2]}`;
  }
  if (segments[1] === "reports" && segments[2] !== undefined) {
    return `reports/${segments[2]}`;
  }
  if (segments[1] === "reviews" && segments[2] !== undefined) {
    return `reviews/${segments[2]}`;
  }
  if (segments[1] === "git" && segments[2] !== undefined) {
    return `git/${segments[2]}`;
  }
  if (segments[1] === "cleanup" && segments[2] !== undefined) {
    return `cleanup/${segments[2]}`;
  }

  return segments[1];
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
