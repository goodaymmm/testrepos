import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";

export type CleanupCandidate = {
  id: string;
  path: string;
  kind: "file" | "directory";
  reason: string;
  proposed_action: "move_to_kairon_tmp";
  destination: string;
  size_bytes: number;
};

export type CleanupProposal = {
  schema_version: string;
  date: string;
  proposal_path: string;
  direct_delete: false;
  candidates: CleanupCandidate[];
  morning_review_task: {
    type: "cleanup_triage";
    title: string;
    priority: number;
    schedule_mode: "active_work";
    resources: string[];
    acceptance: string[];
  };
  created_at: string;
};

export type CreateCleanupProposalsRequest = {
  date: string;
  candidatePaths?: string[];
};

type ProjectConfig = {
  paths?: {
    generated?: string[];
  };
};

type CandidateRoot = {
  absolutePath: string;
  reason: string;
};

export async function createCleanupProposals(
  projectRoot: string,
  request: CreateCleanupProposalsRequest
): Promise<CleanupProposal> {
  const paths = getKaironPaths(projectRoot);
  const proposalPath = resolveInside(
    paths.cleanupDir,
    "proposals",
    `${request.date}.json`
  );
  const candidateRoots = await resolveCandidateRoots(projectRoot, request);
  const candidates = await Promise.all(
    candidateRoots.map((candidate, index) =>
      buildCandidate(projectRoot, request.date, candidate, index + 1)
    )
  );
  const proposal: CleanupProposal = {
    schema_version: "0.1",
    date: request.date,
    proposal_path: toProjectPath(paths.root, proposalPath),
    direct_delete: false,
    candidates: candidates.filter((candidate): candidate is CleanupCandidate => candidate !== null),
    morning_review_task: {
      type: "cleanup_triage",
      title: `Review cleanup proposals for ${request.date}`,
      priority: 100,
      schedule_mode: "active_work",
      resources: [toProjectPath(paths.root, proposalPath)],
      acceptance: [
        "Review each candidate before moving it to .kairon/tmp.",
        "Do not delete source files directly.",
        "Record approved moves as follow-up work."
      ]
    },
    created_at: new Date().toISOString()
  };

  await writeJsonFileAtomic(proposalPath, proposal);
  return proposal;
}

async function resolveCandidateRoots(
  projectRoot: string,
  request: CreateCleanupProposalsRequest
): Promise<CandidateRoot[]> {
  const paths = getKaironPaths(projectRoot);
  const config = await loadConfigFile<ProjectConfig>(projectRoot, "project.json");
  const configured = [
    ...(config.paths?.generated ?? []),
    ...(request.candidatePaths ?? [])
  ];
  const roots = configured
    .map((pattern) => patternRoot(pattern))
    .filter((candidate) => candidate.length > 0)
    .map((candidate) => resolveInside(paths.root, candidate))
    .filter((candidate) => !isInside(candidate, paths.kaironDir))
    .map((absolutePath) => ({
      absolutePath,
      reason: "configured generated path exists after the work day"
    }));
  const internalCandidates = await resolveOperationalArtifactCandidates(paths);
  const unique = dedupeCandidateRoots([...roots, ...internalCandidates]);
  const existing: CandidateRoot[] = [];

  for (const candidate of unique) {
    try {
      await access(candidate.absolutePath);
      existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return existing.sort((left, right) =>
    toProjectPath(paths.root, left.absolutePath).localeCompare(
      toProjectPath(paths.root, right.absolutePath)
    )
  );
}

async function resolveOperationalArtifactCandidates(
  paths: ReturnType<typeof getKaironPaths>
): Promise<CandidateRoot[]> {
  return [
    ...(await resolveConfigBackupCandidates(paths.configDir)),
    ...(await resolveDiscordAuditCandidates(paths.runtimeDir)),
    ...(await resolveExistingCandidate(
      paths.root,
      "operation-test-results",
      "operation test result directory is local-only evidence",
      true
    )),
    ...(await resolveExistingCandidate(
      paths.kaironDir,
      "worktrees",
      "temporary Kairon worktree root should be triaged",
      true
    )),
    ...(await resolveExistingCandidate(
      paths.root,
      "tmp",
      "root tmp directory exists after the work day",
      true
    ))
  ];
}

async function resolveConfigBackupCandidates(configDir: string): Promise<CandidateRoot[]> {
  try {
    const entries = await readdir(configDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.bak-\d{14}$/.test(entry.name))
      .map((entry) => ({
        absolutePath: resolveInside(configDir, entry.name),
        reason: "config backup can be archived after review"
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function resolveDiscordAuditCandidates(runtimeDir: string): Promise<CandidateRoot[]> {
  const discordDir = resolveInside(runtimeDir, "discord");
  try {
    const entries = await readdir(discordDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => ({
        absolutePath: resolveInside(discordDir, entry.name),
        reason: "Discord audit JSONL should be reviewed before archival"
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function resolveExistingCandidate(
  root: string,
  relativePath: string,
  reason: string,
  requireNonEmpty = false
): Promise<CandidateRoot[]> {
  const absolutePath = resolveInside(root, relativePath);
  if (requireNonEmpty && !(await hasAnyEntry(absolutePath))) {
    return [];
  }

  return [
    {
      absolutePath,
      reason
    }
  ];
}

async function hasAnyEntry(directoryPath: string): Promise<boolean> {
  try {
    const stats = await stat(directoryPath);
    if (!stats.isDirectory()) {
      return true;
    }

    return (await readdir(directoryPath)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function dedupeCandidateRoots(candidates: CandidateRoot[]): CandidateRoot[] {
  const seen = new Set<string>();
  const output: CandidateRoot[] = [];

  for (const candidate of candidates) {
    const key = candidate.absolutePath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(candidate);
  }

  return output;
}

async function buildCandidate(
  projectRoot: string,
  date: string,
  candidate: CandidateRoot,
  index: number
): Promise<CleanupCandidate | null> {
  const candidatePath = candidate.absolutePath;
  const stats = await stat(candidatePath);
  const projectPath = toProjectPath(projectRoot, candidatePath);
  const id = `CLEAN-${date.replaceAll("-", "")}-${String(index).padStart(3, "0")}`;

  return {
    id,
    path: projectPath,
    kind: stats.isDirectory() ? "directory" : "file",
    reason: candidate.reason,
    proposed_action: "move_to_kairon_tmp",
    destination: toPosixPath(path.join(".kairon", "tmp", date, slug(projectPath))),
    size_bytes: await sizeBytes(candidatePath)
  };
}

async function sizeBytes(candidatePath: string): Promise<number> {
  const stats = await stat(candidatePath);
  if (!stats.isDirectory()) {
    return stats.size;
  }

  const entries = await readdir(candidatePath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map((entry) => sizeBytes(path.join(candidatePath, entry.name)))
  );
  return sizes.reduce((total, value) => total + value, 0);
}

function patternRoot(pattern: string): string {
  const normalized = toPosixPath(pattern).replace(/^\/+/, "");
  const wildcardIndex = normalized.search(/[*?[\]{}]/);
  const fixed =
    wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return fixed.replace(/\/+$/, "");
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
