import { access, lstat, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CleanupRetentionCategory,
  CleanupRetentionRule
} from "../core/config/cleanup-retention.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  scanCleanupRetention,
  type CleanupRetentionCandidate,
  type CleanupRetentionScanResult
} from "./retention-scanner.js";

export type CleanupCandidate = {
  id: string;
  path: string;
  kind: "file" | "directory" | "symbolic_link";
  reason: string;
  proposed_action: "move_to_kairon_tmp";
  destination: string;
  size_bytes: number;
  category?: CleanupRetentionCategory | "operation_evidence";
  modified_at?: string;
  age_days?: number;
  retention_rule?: CleanupRetentionRule;
};

export type CleanupProposal = {
  schema_version: string;
  proposal_id?: string;
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
  retention_summary?: Omit<CleanupRetentionScanResult, "candidates"> & {
    candidates: number;
  };
  created_at: string;
};

export type CleanupProposalSummary = {
  proposal_id: string;
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
    | "blocked_invalid_destination"
    | "blocked_symbolic_link"
    | "blocked_retention_changed"
    | "blocked_evidence_catalog";
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
  now?: Date;
};

export type CleanupRetentionPlanOptions = {
  now?: Date;
  writeProposal?: boolean;
  includeEvidenceCatalog?: boolean;
};

export type CleanupRetentionPlanResult = {
  dry_run: boolean;
  written: boolean;
  proposal: CleanupProposal;
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
  retention?: CleanupRetentionCandidate;
};

export async function createCleanupProposals(
  projectRoot: string,
  request: CreateCleanupProposalsRequest
): Promise<CleanupProposal> {
  const now = request.now ?? new Date();
  const paths = getKaironPaths(projectRoot);
  const proposalId = request.date;
  const proposalPath = resolveInside(
    paths.cleanupDir,
    "proposals",
    `${proposalId}.json`
  );
  const retention = await scanCleanupRetention(projectRoot, {
    now,
    includeEvidenceCatalog: true
  });
  const candidateRoots = await resolveCandidateRoots(projectRoot, request, retention);
  const proposal = await buildCleanupProposal({
    projectRoot,
    proposalId,
    date: request.date,
    proposalPath,
    candidateRoots,
    retention,
    now
  });

  await writeJsonFileAtomic(proposalPath, proposal);
  return proposal;
}

export async function planCleanupRetention(
  projectRoot: string,
  options: CleanupRetentionPlanOptions = {}
): Promise<CleanupRetentionPlanResult> {
  const now = options.now ?? new Date();
  const paths = getKaironPaths(projectRoot);
  const date = now.toISOString().slice(0, 10);
  const proposalId = `retention-${formatTimestamp(now)}`;
  const proposalPath = resolveInside(
    paths.cleanupDir,
    "proposals",
    `${proposalId}.json`
  );
  const retention = await scanCleanupRetention(projectRoot, {
    now,
    includeEvidenceCatalog: options.includeEvidenceCatalog === true
  });
  const candidateRoots = retention.candidates.map((candidate) => ({
    absolutePath: candidate.absolutePath,
    reason: candidate.reason,
    retention: candidate
  }));
  const proposal = await buildCleanupProposal({
    projectRoot,
    proposalId,
    date,
    proposalPath,
    candidateRoots,
    retention,
    now
  });

  if (options.writeProposal === true) {
    await writeJsonFileAtomic(proposalPath, proposal);
  }

  return {
    dry_run: options.writeProposal !== true,
    written: options.writeProposal === true,
    proposal
  };
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
        proposal_id: proposal.proposal_id ?? proposal.date,
        date: proposal.date,
        proposal_path: proposal.proposal_path,
        candidates: proposal.candidates.length,
        size_bytes: proposal.candidates.reduce(
          (total, candidate) => total + candidate.size_bytes,
          0
        ),
        created_at: proposal.created_at
      }))
      .sort((left, right) => left.proposal_id.localeCompare(right.proposal_id));
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
  const currentRetention = await scanCleanupRetention(projectRoot, {
    now,
    includeEvidenceCatalog: true
  });
  const currentRetentionPaths = new Set(
    currentRetention.candidates.map((candidate) => candidate.path)
  );
  const candidates = await Promise.all(
    proposal.candidates.map((candidate) =>
      evaluateCleanupCandidate({
        projectRoot,
        tmpDir: paths.tmpDir,
        candidate,
        dryRun,
        protectedPatterns,
        currentRetentionPaths,
        evidenceProtectedPaths: new Set(
          currentRetention.evidence_catalog?.protected_paths ?? []
        )
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
    `${options.proposalId}-${formatTimestamp(now)}.json`
  );

  await mkdir(path.dirname(archivedPath), { recursive: true });
  await rename(proposalPath, archivedPath);

  return {
    proposal_date: proposal.date,
    proposal_path: toProjectPath(projectRoot, proposalPath),
    archived_path: toProjectPath(projectRoot, archivedPath)
  };
}

async function buildCleanupProposal(options: {
  projectRoot: string;
  proposalId: string;
  date: string;
  proposalPath: string;
  candidateRoots: CandidateRoot[];
  retention: CleanupRetentionScanResult;
  now: Date;
}): Promise<CleanupProposal> {
  const candidates = await Promise.all(
    options.candidateRoots.map((candidate, index) =>
      buildCandidate(options.projectRoot, options.date, candidate, index + 1)
    )
  );
  const proposalPath = toProjectPath(options.projectRoot, options.proposalPath);

  return {
    schema_version: "0.1",
    proposal_id: options.proposalId,
    date: options.date,
    proposal_path: proposalPath,
    direct_delete: false,
    candidates: candidates.filter(
      (candidate): candidate is CleanupCandidate => candidate !== null
    ),
    morning_review_task: {
      type: "cleanup_triage",
      title: `Review cleanup proposals for ${options.date}`,
      priority: 100,
      schedule_mode: "active_work",
      resources: [proposalPath],
      acceptance: [
        "Review each candidate before moving it to .kairon/tmp.",
        "Do not delete source files directly.",
        "Record approved moves as follow-up work."
      ]
    },
    retention_summary: {
      enabled: options.retention.enabled,
      scanned_items: options.retention.scanned_items,
      protected_items: options.retention.protected_items,
      skipped_symbolic_links: options.retention.skipped_symbolic_links,
      candidate_bytes: options.retention.candidate_bytes,
      candidates: options.retention.candidates.length
    },
    created_at: options.now.toISOString()
  };
}

async function resolveCandidateRoots(
  projectRoot: string,
  request: CreateCleanupProposalsRequest,
  retention: CleanupRetentionScanResult
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
  const internalCandidates = await resolveOperationalArtifactCandidates(
    paths,
    retention
  );
  const retentionCandidates = retention.candidates.map((candidate) => ({
    absolutePath: candidate.absolutePath,
    reason: candidate.reason,
    retention: candidate
  }));
  const unique = dedupeCandidateRoots([
    ...roots,
    ...internalCandidates,
    ...retentionCandidates
  ]);
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
  paths: ReturnType<typeof getKaironPaths>,
  retention: CleanupRetentionScanResult
): Promise<CandidateRoot[]> {
  return [
    ...(await resolveConfigBackupCandidates(paths.configDir)),
    ...(retention.evidence_catalog === undefined ||
    retention.evidence_catalog.status === "missing"
      ? await resolveExistingCandidate(
          paths.root,
          "operation-test-results",
          "operation test result directory is local-only evidence",
          true
        )
      : []),
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
  const stats = await lstat(candidatePath);
  const projectPath = toProjectPath(projectRoot, candidatePath);
  const id = `CLEAN-${date.replaceAll("-", "")}-${String(index).padStart(3, "0")}`;

  return {
    id,
    path: projectPath,
    kind: stats.isSymbolicLink()
      ? "symbolic_link"
      : stats.isDirectory()
        ? "directory"
        : "file",
    reason: candidate.reason,
    proposed_action: "move_to_kairon_tmp",
    destination: toPosixPath(path.join(".kairon", "tmp", date, slug(projectPath))),
    size_bytes: candidate.retention?.size_bytes ?? (await sizeBytes(candidatePath)),
    category: candidate.retention?.category,
    modified_at: candidate.retention?.modified_at,
    age_days: candidate.retention?.age_days,
    retention_rule: candidate.retention?.retention_rule
  };
}

async function sizeBytes(candidatePath: string): Promise<number> {
  const stats = await lstat(candidatePath);
  if (stats.isSymbolicLink()) {
    return 0;
  }
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
  if (!/^(?:\d{4}-\d{2}-\d{2}|retention-\d{14})$/.test(proposalId)) {
    throw new Error(
      "Invalid cleanup proposal id. Use YYYY-MM-DD or retention-YYYYMMDDHHMMSS."
    );
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
  currentRetentionPaths: Set<string>;
  evidenceProtectedPaths: Set<string>;
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

  if (
    [...options.evidenceProtectedPaths].some((protectedPath) =>
      pathsOverlap(candidate.path, protectedPath)
    )
  ) {
    return {
      ...baseResult,
      status: "blocked_evidence_catalog",
      reason: "candidate contains evidence protected by the verified catalog"
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

  if (
    candidate.category !== undefined &&
    !options.currentRetentionPaths.has(candidate.path)
  ) {
    return {
      ...baseResult,
      status: "blocked_retention_changed",
      reason: "candidate no longer exceeds retention limits or is now protected"
    };
  }

  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isSymbolicLink()) {
    return {
      ...baseResult,
      status: "blocked_symbolic_link",
      reason: "candidate source is a symbolic link"
    };
  }

  const availableDestinationPath = await nextAvailableDestinationPath(destinationPath);
  const destination =
    availableDestinationPath === destinationPath
      ? candidate.destination
      : toProjectPath(options.projectRoot, availableDestinationPath);

  return {
    ...baseResult,
    destination,
    status: "planned",
    reason:
      availableDestinationPath === destinationPath
        ? undefined
        : `destination already exists; using ${destination}`
  };
}

async function nextAvailableDestinationPath(destinationPath: string): Promise<string> {
  if (!(await pathExists(destinationPath))) {
    return destinationPath;
  }

  const parsed = path.parse(destinationPath);
  for (let suffix = 2; ; suffix += 1) {
    const candidatePath = path.join(
      parsed.dir,
      `${parsed.name}-${suffix}${parsed.ext}`
    );
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
  }
}

function matchesProtectedPath(projectPath: string, patterns: string[]): boolean {
  const normalized = normalizeProjectPath(projectPath);
  return patterns.some((pattern) => globToRegExp(normalizeProjectPath(pattern)).test(normalized));
}

function normalizeProjectPath(value: string): string {
  return toPosixPath(value).replace(/^\/+/, "");
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeProjectPath(left);
  const normalizedRight = normalizeProjectPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
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
