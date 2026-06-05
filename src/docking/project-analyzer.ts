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
  fileNames: string[];
  nestedFileNames: string[];
  hasTsconfig: boolean;
  hasPyproject: boolean;
  hasPubspec: boolean;
  hasPackageJson: boolean;
  hasDockerfile: boolean;
  hasDockerCompose: boolean;
  hasRequirements: boolean;
  hasPythonFile: boolean;
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
  const packageManagers = detectPackageManagers(entries, signals);
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

  if (names.has("flutter") || signals.hasPubspec) {
    frameworks.add("flutter");
  }

  if (signals.hasPythonFile || signals.hasPyproject || signals.hasRequirements) {
    frameworks.add("python");
  }

  if (signals.hasPackageJson || signals.packageJson) {
    frameworks.add("node");
  }

  if (hasFileSignal(signals, (name) => name.startsWith("vite.config."))) {
    frameworks.add("vite");
  }

  if (names.has(".next") || hasFileSignal(signals, (name) => ["next.config.js", "next.config.ts"].includes(name))) {
    frameworks.add("next");
  }

  if (signals.hasDockerfile || signals.hasDockerCompose) {
    frameworks.add("docker");
  }

  return [...frameworks].sort();
}

function detectPackageManagers(entries: TopLevelEntry[], signals: ProjectSignals): string[] {
  const names = new Set(entries.map((entry) => entry.name));
  const packageManagers = new Set<string>();

  if (names.has("package-lock.json") || signals.nestedFileNames.includes("package-lock.json")) {
    packageManagers.add("npm");
  }
  if (names.has("pnpm-lock.yaml") || signals.nestedFileNames.includes("pnpm-lock.yaml")) {
    packageManagers.add("pnpm");
  }
  if (names.has("yarn.lock") || signals.nestedFileNames.includes("yarn.lock")) {
    packageManagers.add("yarn");
  }
  if (signals.hasPubspec) {
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
  if (extensions.has(".dart") || names.has("flutter") || signals.hasPubspec) {
    languages.add("dart");
  }
  if (signals.hasPyproject || signals.hasRequirements || signals.hasPythonFile) {
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
  const fileNames = entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.name);
  const nestedFileNames = await readNestedFileNames(projectRoot, entries);
  const names = new Set(entries.map((entry) => entry.name));
  const signalNames = new Set([...fileNames, ...nestedFileNames]);

  return {
    packageJson: names.has("package.json") ? await readPackageJson(projectRoot) : undefined,
    fileNames,
    nestedFileNames,
    hasTsconfig: [...signalNames].some((name) => name === "tsconfig.json" || name.startsWith("tsconfig.")),
    hasPyproject: signalNames.has("pyproject.toml"),
    hasPubspec: signalNames.has("pubspec.yaml"),
    hasPackageJson: signalNames.has("package.json"),
    hasDockerfile: signalNames.has("Dockerfile"),
    hasDockerCompose: signalNames.has("docker-compose.yml") || signalNames.has("docker-compose.yaml"),
    hasRequirements: signalNames.has("requirements.txt"),
    hasPythonFile: [...signalNames].some((name) => path.extname(name).toLowerCase() === ".py")
  };
}

async function readNestedFileNames(
  projectRoot: string,
  entries: TopLevelEntry[]
): Promise<string[]> {
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.kind === "directory")
      .filter((entry) => !ignoredDirectoryNames.has(entry.name))
      .filter((entry) => !protectedDirectoryNames.has(entry.name))
      .filter((entry) => !generatedDirectoryNames.has(entry.name))
      .map(async (entry) => {
        try {
          const children = await readdir(path.join(projectRoot, entry.name), {
            withFileTypes: true
          });
          return children
            .filter((child) => child.isFile())
            .map((child) => child.name);
        } catch {
          return [];
        }
      })
  );

  return [...new Set(nested.flat())];
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

function hasFileSignal(
  signals: ProjectSignals,
  predicate: (name: string) => boolean
): boolean {
  return [...signals.fileNames, ...signals.nestedFileNames].some(predicate);
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
