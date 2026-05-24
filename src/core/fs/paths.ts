import path from "node:path";

export type KaironPaths = {
  root: string;
  kaironDir: string;
  configDir: string;
  rulesDir: string;
  stateDir: string;
  eventsDir: string;
  tasksDir: string;
  messagesDir: string;
  approvalsDir: string;
  runsDir: string;
  sessionsDir: string;
  runtimeDir: string;
  reportsDir: string;
  cleanupDir: string;
  tmpDir: string;
};

export function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = normalizeProjectRoot(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, candidate);

  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return candidate;
  }

  throw new Error(`Path escapes project root: ${candidate}`);
}

export function getKaironPaths(projectRoot: string): KaironPaths {
  const root = normalizeProjectRoot(projectRoot);
  const kaironDir = resolveInside(root, ".kairon");

  return {
    root,
    kaironDir,
    configDir: resolveInside(kaironDir, "config"),
    rulesDir: resolveInside(kaironDir, "rules"),
    stateDir: resolveInside(kaironDir, "state"),
    eventsDir: resolveInside(kaironDir, "events"),
    tasksDir: resolveInside(kaironDir, "tasks"),
    messagesDir: resolveInside(kaironDir, "messages"),
    approvalsDir: resolveInside(kaironDir, "approvals"),
    runsDir: resolveInside(kaironDir, "runs"),
    sessionsDir: resolveInside(kaironDir, "sessions"),
    runtimeDir: resolveInside(kaironDir, "runtime"),
    reportsDir: resolveInside(kaironDir, "reports"),
    cleanupDir: resolveInside(kaironDir, "cleanup"),
    tmpDir: resolveInside(kaironDir, "tmp")
  };
}

export function getConfigPath(projectRoot: string, fileName: string): string {
  return resolveInside(getKaironPaths(projectRoot).configDir, fileName);
}
