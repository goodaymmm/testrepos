import { readFile, writeFile } from "node:fs/promises";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../../agents/command-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../../core/fs/json-file.js";
import { resolveInside } from "../../core/fs/paths.js";

export type ReleaseCheckResult = {
  schema_version: string;
  package_version: string;
  cli_version: string;
  version_sync: boolean;
  docs: {
    release_checklist: boolean;
    release_notes: boolean;
  };
  recommended_commands: string[];
  manual_checks: string[];
};

export type ReleaseNotesResult = {
  schema_version: string;
  since: string;
  commit_count: number;
  commits: string[];
};

export type ReleaseBumpType = "major" | "minor" | "patch";

export type ReleaseBumpResult = {
  schema_version: string;
  type: ReleaseBumpType;
  current_version: string;
  next_version: string;
  dry_run: boolean;
  write: boolean;
  files: Array<{
    path: string;
    current: string;
    next: string;
    action: "unchanged" | "would_update" | "updated";
  }>;
};

export type ReleaseNotesCommandOptions = {
  since?: string;
  commandRunner?: CommandRunner;
};

export type ReleaseBumpCommandOptions = {
  type?: string;
  dryRun?: boolean;
  write?: boolean;
};

type PackageJson = {
  version?: unknown;
  [key: string]: unknown;
};

export async function releaseCheckCommand(projectRoot: string): Promise<string> {
  return formatReleaseCheck(await collectReleaseCheck(projectRoot));
}

export async function releaseNotesCommand(
  projectRoot: string,
  options: ReleaseNotesCommandOptions = {}
): Promise<string> {
  return formatReleaseNotes(await createReleaseNotesDraft(projectRoot, options));
}

export async function releaseBumpCommand(
  projectRoot: string,
  options: ReleaseBumpCommandOptions = {}
): Promise<string> {
  return formatReleaseBump(await planReleaseBump(projectRoot, options));
}

export async function collectReleaseCheck(
  projectRoot: string
): Promise<ReleaseCheckResult> {
  const packageVersion = await readPackageVersion(projectRoot);
  const cliVersion = await readCliVersion(projectRoot);

  return {
    schema_version: "0.1",
    package_version: packageVersion,
    cli_version: cliVersion,
    version_sync: packageVersion === cliVersion,
    docs: {
      release_checklist: await fileExists(projectRoot, "docs/release-checklist-v0.md"),
      release_notes: await fileExists(projectRoot, "docs/release-notes-v0.md")
    },
    recommended_commands: [
      "git status --short",
      "npm run build",
      "npm test",
      "npx vitest run tests\\pr-release-docs.test.ts"
    ],
    manual_checks: [
      "Confirm release PRs are merged.",
      "Confirm operation-test evidence is recorded when the release scope requires it.",
      "Confirm generated artifacts, local state, and secret values are not committed."
    ]
  };
}

export async function createReleaseNotesDraft(
  projectRoot: string,
  options: ReleaseNotesCommandOptions = {}
): Promise<ReleaseNotesResult> {
  if (options.since === undefined || options.since.trim().length === 0) {
    throw new Error("Specify --since <ref>.");
  }

  const since = options.since.trim();
  const commandRunner = options.commandRunner ?? spawnCommandRunner;
  const result = await commandRunner({
    command: "git",
    args: ["log", "--no-merges", "--pretty=format:%s", `${since}..HEAD`],
    cwd: projectRoot
  });

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Failed to collect release notes: ${result.stderr || result.stdout}`);
  }

  const commits = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    schema_version: "0.1",
    since,
    commit_count: commits.length,
    commits
  };
}

export async function planReleaseBump(
  projectRoot: string,
  options: ReleaseBumpCommandOptions = {}
): Promise<ReleaseBumpResult> {
  const type = parseBumpType(options.type);
  const write = options.write === true;
  if (write && options.dryRun === true) {
    throw new Error("Use either --write or --dry-run, not both.");
  }
  const dryRun = !write;
  const packagePath = resolveInside(projectRoot, "package.json");
  const indexPath = resolveInside(projectRoot, "src", "index.ts");
  const packageJson = await readJsonFile<PackageJson>(packagePath);
  const currentVersion = assertVersion(packageJson.version, "package.json");
  const cliSource = await readFile(indexPath, "utf8");
  const cliVersion = extractCliVersion(cliSource);

  if (currentVersion !== cliVersion) {
    throw new Error(
      `Version mismatch: package.json=${currentVersion}, src/index.ts=${cliVersion}`
    );
  }

  const nextVersion = bumpVersion(currentVersion, type);

  if (write) {
    await writeJsonFileAtomic(packagePath, {
      ...packageJson,
      version: nextVersion
    });
    await writeFile(indexPath, replaceCliVersion(cliSource, nextVersion), "utf8");
  }

  const action = currentVersion === nextVersion
    ? "unchanged"
    : write
      ? "updated"
      : "would_update";

  return {
    schema_version: "0.1",
    type,
    current_version: currentVersion,
    next_version: nextVersion,
    dry_run: dryRun,
    write,
    files: [
      {
        path: "package.json",
        current: currentVersion,
        next: nextVersion,
        action
      },
      {
        path: "src/index.ts",
        current: cliVersion,
        next: nextVersion,
        action
      }
    ]
  };
}

export function formatReleaseCheck(result: ReleaseCheckResult): string {
  return [
    "Kairon release check:",
    `version.package=${result.package_version}`,
    `version.cli=${result.cli_version}`,
    `version.sync=${result.version_sync}`,
    `docs.release_checklist=${formatPresence(result.docs.release_checklist)}`,
    `docs.release_notes=${formatPresence(result.docs.release_notes)}`,
    "recommended.commands:",
    ...result.recommended_commands.map((command) => `- ${command}`),
    "manual.checks:",
    ...result.manual_checks.map((check) => `- ${check}`)
  ].join("\n");
}

export function formatReleaseNotes(result: ReleaseNotesResult): string {
  const summaryLines =
    result.commits.length === 0
      ? ["- No commits found for the selected range."]
      : result.commits.map((commit) => `- ${commit}`);

  return [
    "Kairon release notes draft:",
    `since=${result.since}`,
    `commit_count=${result.commit_count}`,
    "",
    "## Release Notes Draft",
    "",
    "### Summary",
    "",
    ...summaryLines,
    "",
    "### Tests",
    "",
    "- `npm run build`",
    "- `npm test`",
    "",
    "### Manual / Operation Test Evidence",
    "",
    "-",
    "",
    "### Known Limitations",
    "",
    "-"
  ].join("\n");
}

export function formatReleaseBump(result: ReleaseBumpResult): string {
  return [
    result.write
      ? "Kairon release bump applied."
      : "Kairon release bump dry run.",
    `type=${result.type}`,
    `current_version=${result.current_version}`,
    `next_version=${result.next_version}`,
    `dry_run=${result.dry_run}`,
    `write=${result.write}`,
    ...result.files.map(
      (file) =>
        `file=${file.path} current=${file.current} next=${file.next} action=${file.action}`
    )
  ].join("\n");
}

function parseBumpType(value: string | undefined): ReleaseBumpType {
  if (value === "major" || value === "minor" || value === "patch") {
    return value;
  }

  throw new Error("Specify --type major, minor, or patch.");
}

function bumpVersion(version: string, type: ReleaseBumpType): string {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (parsed === null) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);

  if (type === "major") {
    return `${major + 1}.0.0`;
  }

  if (type === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

async function readPackageVersion(projectRoot: string): Promise<string> {
  const packageJson = await readJsonFile<PackageJson>(
    resolveInside(projectRoot, "package.json")
  );
  return assertVersion(packageJson.version, "package.json");
}

async function readCliVersion(projectRoot: string): Promise<string> {
  return extractCliVersion(
    await readFile(resolveInside(projectRoot, "src", "index.ts"), "utf8")
  );
}

function assertVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} does not contain a valid version string.`);
  }

  return value;
}

function extractCliVersion(source: string): string {
  const match = /KAIRON_VERSION\s*=\s*"([^"]+)"/.exec(source);
  if (match === null) {
    throw new Error("src/index.ts does not contain KAIRON_VERSION.");
  }

  return match[1];
}

function replaceCliVersion(source: string, nextVersion: string): string {
  return source.replace(
    /(KAIRON_VERSION\s*=\s*")([^"]+)(")/,
    (_match, prefix: string, _current: string, suffix: string) =>
      `${prefix}${nextVersion}${suffix}`
  );
}

async function fileExists(
  projectRoot: string,
  relativePath: string
): Promise<boolean> {
  try {
    await readFile(resolveInside(projectRoot, relativePath), "utf8");
    return true;
  } catch {
    return false;
  }
}

function formatPresence(value: boolean): "present" | "missing" {
  return value ? "present" : "missing";
}
