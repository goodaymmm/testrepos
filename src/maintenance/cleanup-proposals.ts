import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
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

export type CleanupProposalSummary = {
  date: string;
  proposal_path: string;
  candidates: number;
  size_bytes: number;
  created_at: string;
};

export type CleanupApplyOptions = {
  projectRoot: string;
  proposalId: string;
  dryRun?: boolean;
  now?: Date;
};

export type CleanupArchiveOptions = {
  projectRoot: string;
  proposalId: string;
  now?: Date;
};

export type CleanupCandidateApplyResult = {
  id: string;
  path: string;
  destination: string;
  status:
    | "planned"
    | "moved"
    | "missing"
    | "blocked_protected_path"
    | "blocked_invalid_action"
    | "blocked_invalid_destination";
  reason?: string;
};

export type CleanupApplyResult = {
  dry_run: boolean;
  proposal_date: string;
  proposal_path: string;
  applied: boolean;
  moved: number;
  planned: number;
  missing: number;
  blocked: number;
  artifact_path?: string;
  candidates: CleanupCandidateApplyResult[];
};

export type CleanupArchiveResult = {
  proposal_date: string;
  proposal_path: string;
  archived_path: string;
};

export type CreateCleanupProposalsRequest = {
  date: string;
  candidatePaths?: string[];
};

type ProjectConfig = {
  paths?: {
    protected?: string[];
    generated?: string[];
  };
};

type PoliciesConfig = {
  security?: {
    protected_paths?: string[];
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

export async function listCleanupProposals(
  projectRoot: string
): Promise<CleanupProposalSummary[]> {
  const paths = getKaironPaths(projectRoot);
  const proposalsDir = resolveInside(paths.cleanupDir, "proposals");

  try {
    const entries = await readdir(proposalsDir, { withFileTypes: true });
    const proposals = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJsonFile<CleanupProposal>(resolveInside(proposalsDir, entry.name))
        )
    );

    return proposals
      .map((proposal) => ({
        date: proposal.date,
        proposal_path: proposal.proposal_path,
        candidates: proposal.candidates.length,
        size_bytes: proposal.candidates.reduce(
          (total, candidate) => total + candidate.size_bytes,
          0
        ),
        created_at: proposal.created_at
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readCleanupProposalById(
  projectRoot: string,
  proposalId: string
): Promise<CleanupProposal> {
  return readJsonFile<CleanupProposal>(cleanupProposalPath(projectRoot, proposalId));
}

export async function applyCleanupProposal(
  options: CleanupApplyOptions
): Promise<CleanupApplyResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const proposalPath = cleanupProposalPath(projectRoot, options.proposalId);
  const proposal = await readJsonFile<CleanupProposal>(proposalPath);
  validateCleanupProposal(proposal);

  const paths = getKaironPaths(projectRoot);
  const protectedPatterns = await loadProtectedPatterns(projectRoot);
  const candidates = await Promise.all(
    proposal.candidates.map((candidate) =>
      evaluateCleanupCandidate({
        projectRoot,
        tmpDir: paths.tmpDir,
        candidate,
        dryRun,
        protectedPatterns
      })
    )
  );

  for (const candidate of candidates) {
    if (dryRun || candidate.status !== "planned") {
      continue;
    }

    const sourcePath = resolveInside(projectRoot, candidate.path);
    const destinationPath = resolveInside(projectRoot, candidate.destination);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
    candidate.status = "moved";
  }

  const moved = candidates.filter((candidate) => candidate.status === "moved").length;
  const planned = candidates.filter((candidate) => candidate.status === "planned").length;
  const missing = candidates.filter((candidate) => candidate.status === "missing").length;
  const blocked = candidates.filter((candidate) => candidate.status.startsWith("blocked_")).length;
  const artifactPath =
    dryRun
      ? undefined
      : resolveInside(
          paths.cleanupDir,
          "applied",
          `${proposal.date}-${formatTimestamp(now)}.json`
        );
  const result: CleanupApplyResult = {
    dry_run: dryRun,
    proposal_date: proposal.date,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    applied: !dryRun && moved > 0,
    moved,
    planned,
    missing,
    blocked,
    artifact_path: artifactPath === undefined ? undefined : toProjectPath(projectRoot, artifactPath),
    candidates
  };

  if (artifactPath !== undefined) {
    await writeJsonFileAtomic(artifactPath, {
      schema_version: "0.1",
      ...result,
      created_at: now.toISOString()
    });
  }

  return result;
}

export async function archiveCleanupProposal(
  options: CleanupArchiveOptions
): Promise<CleanupArchiveResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const now = options.now ?? new Date();
  const proposalPath = cleanupProposalPath(projectRoot, options.proposalId);
  const proposal = await readJsonFile<CleanupProposal>(proposalPath);
  validateCleanupProposal(proposal);
  const paths = getKaironPaths(projectRoot);
  const archivedPath = resolveInside(
    paths.cleanupDir,
    "archived",
    `${proposal.date}-${formatTimestamp(now)}.json`
  );

  await mkdir(path.dirname(archivedPath), { recursive: true });
  await rename(proposalPath, archivedPath);

  return {
    proposal_date: proposal.date,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    archived_path: toProjectPath(projectRoot, archivedPath)
  };
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

function cleanupProposalPath(projectRoot: string, proposalId: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(proposalId)) {
    throw new Error("Invalid cleanup proposal id. Use a YYYY-MM-DD proposal date.");
  }

  return resolveInside(getKaironPaths(projectRoot).cleanupDir, "proposals", `${proposalId}.json`);
}

function validateCleanupProposal(proposal: CleanupProposal): void {
  if (proposal.schema_version !== "0.1") {
    throw new Error("Unsupported cleanup proposal schema version.");
  }

  if (proposal.direct_delete !== false) {
    throw new Error("Cleanup proposal direct_delete must be false.");
  }

  for (const candidate of proposal.candidates) {
    if (candidate.proposed_action !== "move_to_kairon_tmp") {
      throw new Error(`Unsupported cleanup action for ${candidate.id}.`);
    }
  }
}

async function loadProtectedPatterns(projectRoot: string): Promise<string[]> {
  const project = await loadConfigFile<ProjectConfig>(projectRoot, "project.json");
  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");

  return [
    ...(project.paths?.protected ?? []),
    ...(policies.security?.protected_paths ?? [])
  ];
}

async function evaluateCleanupCandidate(options: {
  projectRoot: string;
  tmpDir: string;
  candidate: CleanupCandidate;
  dryRun: boolean;
  protectedPatterns: string[];
}): Promise<CleanupCandidateApplyResult> {
  const candidate = options.candidate;
  const baseResult = {
    id: candidate.id,
    path: candidate.path,
    destination: candidate.destination
  };

  if (candidate.proposed_action !== "move_to_kairon_tmp") {
    return {
      ...baseResult,
      status: "blocked_invalid_action",
      reason: `unsupported action: ${candidate.proposed_action}`
    };
  }

  if (matchesProtectedPath(candidate.path, options.protectedPatterns)) {
    return {
      ...baseResult,
      status: "blocked_protected_path",
      reason: "candidate path matches protected path policy"
    };
  }

  let sourcePath: string;
  let destinationPath: string;
  try {
    sourcePath = resolveInside(options.projectRoot, candidate.path);
    destinationPath = resolveInside(options.projectRoot, candidate.destination);
  } catch {
    return {
      ...baseResult,
      status: "blocked_invalid_destination",
      reason: "candidate source or destination escapes project root"
    };
  }

  if (!isInside(destinationPath, options.tmpDir)) {
    return {
      ...baseResult,
      status: "blocked_invalid_destination",
      reason: "destination is not inside .kairon/tmp"
    };
  }

  if (!(await pathExists(sourcePath))) {
    return {
      ...baseResult,
      status: "missing",
      reason: "candidate source path does not exist"
    };
  }

  if (await pathExists(destinationPath)) {
    return {
      ...baseResult,
      status: "blocked_invalid_destination",
      reason: "destination already exists"
    };
  }

  return {
    ...baseResult,
    status: "planned"
  };
}

function matchesProtectedPath(projectPath: string, patterns: string[]): boolean {
  const normalized = normalizeProjectPath(projectPath);
  return patterns.some((pattern) => globToRegExp(normalizeProjectPath(pattern)).test(normalized));
}

function normalizeProjectPath(value: string): string {
  return toPosixPath(value).replace(/^\/+/, "");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      regex += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegExp(char ?? "");
  }

  return new RegExp(`${regex}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
