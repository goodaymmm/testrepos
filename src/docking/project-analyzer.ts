import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectRoot, toPosixPath } from "../core/fs/paths.js";

export type ProjectPathCategory = "protected" | "generated" | "source";

export type ProjectPathEvidence = {
  category: ProjectPathCategory;
  path: string;
  reason: string;
};

export type ProjectConfigProposal = {
  schema_version: string;
  project_id: string;
  root: string;
  primary_language: string;
  frameworks: string[];
  package_managers: string[];
  commands: {
    test: string[];
    lint: string[];
    build: string[];
  };
  paths: {
    protected: string[];
    generated: string[];
    source: string[];
  };
};

export type ProjectDockingAnalysis = {
  schema_version: string;
  proposal_kind: "project_config";
  project_config: ProjectConfigProposal;
  evidence: ProjectPathEvidence[];
};

type TopLevelEntry = {
  name: string;
  kind: "file" | "directory" | "other";
};

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type ProjectSignals = {
  packageJson?: PackageJson;
  hasTsconfig: boolean;
  hasPyproject: boolean;
};

const defaultProtectedPaths = [".env*", "infra/**", ".github/workflows/**"];
const defaultGeneratedPaths = [
  "dist/**",
  "build/**",
  "coverage/**",
  "tmp/**",
  ".next/**",
  "out/**",
  "node_modules/**"
];

const protectedExactFiles = new Set([".mcp.json"]);
const protectedDirectoryNames = new Set([
  ".claude",
  ".gemini",
  ".antigravitycli",
  ".codex"
]);
const generatedDirectoryNames = new Set([
  "dist",
  "build",
  "coverage",
  "tmp",
  ".next",
  "out",
  "node_modules"
]);
const ignoredDirectoryNames = new Set([".git", ".kairon"]);
const ignoredFileNames = new Set([".gitignore"]);
const sourceFileExtensions = new Set([
  ".dart",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".md",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
  ".vrm",
  ".glb",
  ".gltf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const specialSourceFiles = new Set(["docker-compose.yml", "docker-compose.yaml"]);

export async function analyzeProjectDocking(
  projectRoot: string
): Promise<ProjectDockingAnalysis> {
  const root = normalizeProjectRoot(projectRoot);
  const entries = await readTopLevelEntries(root);
  const evidence: ProjectPathEvidence[] = [];
  const protectedPaths = new Set(defaultProtectedPaths);
  const generatedPaths = new Set(defaultGeneratedPaths);
  const sourcePaths = new Set<string>();
  const signals = await readProjectSignals(root, entries);

  for (const protectedPath of defaultProtectedPaths) {
    evidence.push({
      category: "protected",
      path: protectedPath,
      reason: "default protected path"
    });
  }

  for (const generatedPath of defaultGeneratedPaths) {
    evidence.push({
      category: "generated",
      path: generatedPath,
      reason: "common generated path"
    });
  }

  for (const entry of entries) {
    classifyEntry(entry, { protectedPaths, generatedPaths, sourcePaths, evidence });
  }

  const frameworks = detectFrameworks(entries, signals);
  const packageManagers = detectPackageManagers(entries);
  const primaryLanguage = detectPrimaryLanguage(entries, signals);
  const commands = detectCommands(signals, packageManagers);

  return {
    schema_version: "0.1",
    proposal_kind: "project_config",
    project_config: {
      schema_version: "0.1",
      project_id: path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      root: toPosixPath(root),
      primary_language: primaryLanguage,
      frameworks,
      package_managers: packageManagers,
      commands,
      paths: {
        protected: sortPaths(protectedPaths),
        generated: sortPaths(generatedPaths),
        source: sortPaths(sourcePaths)
      }
    },
    evidence
  };
}

function classifyEntry(
  entry: TopLevelEntry,
  state: {
    protectedPaths: Set<string>;
    generatedPaths: Set<string>;
    sourcePaths: Set<string>;
    evidence: ProjectPathEvidence[];
  }
): void {
  if (entry.kind === "directory") {
    classifyDirectory(entry.name, state);
    return;
  }

  if (entry.kind === "file") {
    classifyFile(entry.name, state);
  }
}

function classifyDirectory(
  name: string,
  state: {
    protectedPaths: Set<string>;
    generatedPaths: Set<string>;
    sourcePaths: Set<string>;
    evidence: ProjectPathEvidence[];
  }
): void {
  if (ignoredDirectoryNames.has(name)) {
    return;
  }

  if (protectedDirectoryNames.has(name)) {
    addPath(state.protectedPaths, state.evidence, "protected", `${name}/**`, "agent or local tool state may contain credentials");
    return;
  }

  if (generatedDirectoryNames.has(name)) {
    addPath(state.generatedPaths, state.evidence, "generated", `${name}/**`, "known generated directory");
    return;
  }

  if (name.startsWith("tmpclaude-")) {
    addPath(state.generatedPaths, state.evidence, "generated", "tmpclaude-*", "Claude temporary working directory");
    return;
  }

  addPath(state.sourcePaths, state.evidence, "source", `${name}/**`, "top-level project directory");
}

function classifyFile(
  name: string,
  state: {
    protectedPaths: Set<string>;
    generatedPaths: Set<string>;
    sourcePaths: Set<string>;
    evidence: ProjectPathEvidence[];
  }
): void {
  if (ignoredFileNames.has(name)) {
    return;
  }

  if (protectedExactFiles.has(name) || name.startsWith(".env")) {
    addPath(state.protectedPaths, state.evidence, "protected", name, "local credential or tool config");
    return;
  }

  if (name.startsWith("tmpclaude-")) {
    addPath(state.generatedPaths, state.evidence, "generated", "tmpclaude-*", "Claude temporary working file");
    return;
  }

  const lowerName = name.toLowerCase();
  if (specialSourceFiles.has(lowerName)) {
    addPath(state.sourcePaths, state.evidence, "source", name, "known project source file");
    return;
  }

  const extension = path.extname(name).toLowerCase();
  if (sourceFileExtensions.has(extension)) {
    addPath(state.sourcePaths, state.evidence, "source", `*${extension}`, "top-level source or asset extension");
  }
}

function detectFrameworks(entries: TopLevelEntry[], signals: ProjectSignals): string[] {
  const names = new Set(entries.map((entry) => entry.name));
  const frameworks = new Set<string>();

  if (names.has("flutter") || names.has("pubspec.yaml")) {
    frameworks.add("flutter");
  }

  if (entries.some((entry) => entry.kind === "file" && path.extname(entry.name).toLowerCase() === ".py")) {
    frameworks.add("python");
  }

  if (names.has("package.json") || signals.packageJson) {
    frameworks.add("node");
  }

  if ([...names].some((name) => name.startsWith("vite.config."))) {
    frameworks.add("vite");
  }

  if (names.has(".next") || names.has("next.config.js") || names.has("next.config.ts")) {
    frameworks.add("next");
  }

  return [...frameworks].sort();
}

function detectPackageManagers(entries: TopLevelEntry[]): string[] {
  const names = new Set(entries.map((entry) => entry.name));
  const packageManagers = new Set<string>();

  if (names.has("package-lock.json")) {
    packageManagers.add("npm");
  }
  if (names.has("pnpm-lock.yaml")) {
    packageManagers.add("pnpm");
  }
  if (names.has("yarn.lock")) {
    packageManagers.add("yarn");
  }
  if (names.has("pubspec.yaml")) {
    packageManagers.add("flutter");
  }

  return [...packageManagers].sort();
}

function detectPrimaryLanguage(entries: TopLevelEntry[], signals: ProjectSignals): string {
  const extensions = new Set(
    entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => path.extname(entry.name).toLowerCase())
      .filter((extension) => extension.length > 0)
  );
  const names = new Set(entries.map((entry) => entry.name));
  const languages = new Set<string>();

  if (extensions.has(".py")) {
    languages.add("python");
  }
  if (extensions.has(".ts") || extensions.has(".tsx") || signals.hasTsconfig || packageDependsOn(signals.packageJson, "typescript")) {
    languages.add("typescript");
  }
  if (extensions.has(".js") || extensions.has(".jsx")) {
    languages.add("javascript");
  }
  if (extensions.has(".dart") || names.has("flutter") || names.has("pubspec.yaml")) {
    languages.add("dart");
  }
  if (signals.hasPyproject) {
    languages.add("python");
  }

  if (languages.size === 0) {
    return "unknown";
  }

  if (languages.size === 1) {
    return [...languages][0] ?? "unknown";
  }

  return "mixed";
}

function detectCommands(
  signals: ProjectSignals,
  packageManagers: string[]
): ProjectConfigProposal["commands"] {
  const packageJson = signals.packageJson;
  const nodeRunner = packageManagers.find((manager) => ["npm", "pnpm", "yarn"].includes(manager)) ?? "npm";

  return {
    test: scriptCommand(packageJson, nodeRunner, "test"),
    lint: scriptCommand(packageJson, nodeRunner, "lint"),
    build: scriptCommand(packageJson, nodeRunner, "build")
  };
}

function scriptCommand(
  packageJson: PackageJson | undefined,
  nodeRunner: string,
  scriptName: string
): string[] {
  if (!packageJson?.scripts?.[scriptName]) {
    return [];
  }

  if (nodeRunner === "yarn") {
    return [`yarn ${scriptName}`];
  }

  if (nodeRunner === "pnpm") {
    return [`pnpm ${scriptName}`];
  }

  if (scriptName === "test") {
    return ["npm test"];
  }

  return [`npm run ${scriptName}`];
}

async function readProjectSignals(
  projectRoot: string,
  entries: TopLevelEntry[]
): Promise<ProjectSignals> {
  const names = new Set(entries.map((entry) => entry.name));

  return {
    packageJson: names.has("package.json") ? await readPackageJson(projectRoot) : undefined,
    hasTsconfig: [...names].some((name) => name === "tsconfig.json" || name.startsWith("tsconfig.")),
    hasPyproject: names.has("pyproject.toml")
  };
}

async function readPackageJson(projectRoot: string): Promise<PackageJson | undefined> {
  try {
    const text = await readFile(path.join(projectRoot, "package.json"), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as PackageJson;
  } catch {
    return undefined;
  }
}

function packageDependsOn(packageJson: PackageJson | undefined, dependencyName: string): boolean {
  return Boolean(
    packageJson?.dependencies?.[dependencyName] || packageJson?.devDependencies?.[dependencyName]
  );
}

async function readTopLevelEntries(projectRoot: string): Promise<TopLevelEntry[]> {
  const dirents = await readdir(projectRoot, { withFileTypes: true });

  return dirents.map((dirent) => ({
    name: dirent.name,
    kind: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other"
  }));
}

function addPath(
  paths: Set<string>,
  evidence: ProjectPathEvidence[],
  category: ProjectPathCategory,
  pathPattern: string,
  reason: string
): void {
  if (!paths.has(pathPattern)) {
    paths.add(pathPattern);
    evidence.push({ category, path: pathPattern, reason });
  }
}

function sortPaths(paths: Set<string>): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}
