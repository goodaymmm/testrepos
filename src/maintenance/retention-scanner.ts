import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  cleanupRetentionCategories,
  mergeCleanupRetentionPolicy,
  type CleanupRetentionCategory,
  type CleanupRetentionPolicy,
  type CleanupRetentionPolicyInput,
  type CleanupRetentionRule
} from "../core/config/cleanup-retention.js";
import { loadConfigFile } from "../core/config/load-config.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import { listRuntimeRecoveryTargets } from "../recovery/runtime-recovery.js";

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const openApprovalStatuses = new Set([
  "pending",
  "snoozed",
  "confirmation_required"
]);

type PoliciesConfig = {
  cleanup?: {
    retention?: CleanupRetentionPolicyInput;
  };
};

type RetentionItem = {
  category: CleanupRetentionCategory;
  absolutePath: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
};

export type CleanupRetentionCandidate = {
  category: CleanupRetentionCategory;
  absolutePath: string;
  path: string;
  size_bytes: number;
  modified_at: string;
  age_days: number;
  reason: string;
  retention_rule: CleanupRetentionRule;
};

export type CleanupRetentionScanResult = {
  enabled: boolean;
  scanned_items: number;
  protected_items: number;
  skipped_symbolic_links: number;
  candidate_bytes: number;
  candidates: CleanupRetentionCandidate[];
};

export async function scanCleanupRetention(
  projectRoot: string,
  options: { now?: Date } = {}
): Promise<CleanupRetentionScanResult> {
  const now = options.now ?? new Date();
  const policy = await loadRetentionPolicy(projectRoot);
  if (!policy.enabled) {
    return emptyScan(false);
  }

  const inventory = await collectInventory(projectRoot);
  const protectedReferences = await collectProtectedReferences(projectRoot, now);
  const candidates: CleanupRetentionCandidate[] = [];
  let protectedItems = 0;

  for (const category of cleanupRetentionCategories) {
    const items = inventory.items
      .filter((item) => item.category === category)
      .sort(compareOldestFirst);
    const rule = policy.categories[category];
    const protectedPaths = new Set<string>();

    for (const item of items.slice(-rule.min_keep)) {
      protectedPaths.add(item.path);
    }

    for (const item of items) {
      if (isReferenced(item, protectedReferences)) {
        protectedPaths.add(item.path);
      }
    }

    if (category === "runs") {
      const latestCompleted = await findLatestCompletedRun(items);
      if (latestCompleted !== undefined) {
        protectedPaths.add(latestCompleted.path);
      }
    }

    protectedItems += protectedPaths.size;
    candidates.push(
      ...selectCategoryCandidates(items, protectedPaths, rule, now)
    );
  }

  candidates.sort((left, right) =>
    left.category.localeCompare(right.category) || left.path.localeCompare(right.path)
  );

  return {
    enabled: true,
    scanned_items: inventory.items.length,
    protected_items: protectedItems,
    skipped_symbolic_links: inventory.skippedSymbolicLinks,
    candidate_bytes: candidates.reduce(
      (total, candidate) => total + candidate.size_bytes,
      0
    ),
    candidates
  };
}

async function loadRetentionPolicy(projectRoot: string): Promise<CleanupRetentionPolicy> {
  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  return mergeCleanupRetentionPolicy(policies.cleanup?.retention);
}

async function collectInventory(projectRoot: string): Promise<{
  items: RetentionItem[];
  skippedSymbolicLinks: number;
}> {
  const paths = getKaironPaths(projectRoot);
  const items: RetentionItem[] = [];
  let skippedSymbolicLinks = 0;

  for (const specification of [
    { category: "runs" as const, root: paths.runsDir, recursiveFiles: false },
    { category: "sessions" as const, root: paths.sessionsDir, recursiveFiles: false },
    {
      category: "daemon_logs" as const,
      root: resolveInside(paths.runtimeDir, "daemon"),
      recursiveFiles: true,
      extensions: [".jsonl"]
    },
    {
      category: "daemon_logs" as const,
      root: resolveInside(paths.kaironDir, "logs", "daemon"),
      recursiveFiles: true,
      extensions: [".log"]
    },
    {
      category: "audits" as const,
      root: resolveInside(paths.runtimeDir, "discord"),
      recursiveFiles: true,
      extensions: [".jsonl"]
    },
    {
      category: "audits" as const,
      root: resolveInside(paths.runtimeDir, "board"),
      recursiveFiles: true,
      extensions: [".jsonl"]
    },
    {
      category: "reports" as const,
      root: paths.reportsDir,
      recursiveFiles: true,
      extensions: [".json", ".md"]
    }
  ]) {
    const result = specification.recursiveFiles
      ? await collectRecursiveFiles(
          paths.root,
          specification.category,
          specification.root,
          specification.extensions ?? []
        )
      : await collectImmediateItems(paths.root, specification.category, specification.root);
    items.push(...result.items);
    skippedSymbolicLinks += result.skippedSymbolicLinks;
  }

  return {
    items: dedupeItems(items),
    skippedSymbolicLinks
  };
}

async function collectImmediateItems(
  projectRoot: string,
  category: CleanupRetentionCategory,
  root: string
): Promise<{ items: RetentionItem[]; skippedSymbolicLinks: number }> {
  const entries = await readDirectory(root);
  const items: RetentionItem[] = [];
  let skippedSymbolicLinks = 0;

  for (const entry of entries) {
    const absolutePath = resolveInside(root, entry.name);
    const inspected = await inspectPath(absolutePath);
    if (inspected === null) {
      skippedSymbolicLinks += 1;
      continue;
    }
    items.push({
      category,
      absolutePath,
      path: toProjectPath(projectRoot, absolutePath),
      sizeBytes: inspected.sizeBytes,
      modifiedAt: inspected.modifiedAt
    });
  }

  return { items, skippedSymbolicLinks };
}

async function collectRecursiveFiles(
  projectRoot: string,
  category: CleanupRetentionCategory,
  root: string,
  extensions: string[]
): Promise<{ items: RetentionItem[]; skippedSymbolicLinks: number }> {
  const items: RetentionItem[] = [];
  let skippedSymbolicLinks = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readDirectory(directory);
    for (const entry of entries) {
      const absolutePath = resolveInside(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymbolicLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !extensions.includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const stats = await lstat(absolutePath);
      items.push({
        category,
        absolutePath,
        path: toProjectPath(projectRoot, absolutePath),
        sizeBytes: stats.size,
        modifiedAt: stats.mtime
      });
    }
  }

  await visit(root);
  return { items, skippedSymbolicLinks };
}

async function inspectPath(
  absolutePath: string
): Promise<{ sizeBytes: number; modifiedAt: Date } | null> {
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    return null;
  }
  if (!stats.isDirectory()) {
    return { sizeBytes: stats.size, modifiedAt: stats.mtime };
  }

  let sizeBytes = 0;
  let modifiedAt = stats.mtime;
  const entries = await readDirectory(absolutePath);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return null;
    }
    const child = await inspectPath(resolveInside(absolutePath, entry.name));
    if (child === null) {
      return null;
    }
    sizeBytes += child.sizeBytes;
    if (child.modifiedAt.getTime() > modifiedAt.getTime()) {
      modifiedAt = child.modifiedAt;
    }
  }
  return { sizeBytes, modifiedAt };
}

async function collectProtectedReferences(
  projectRoot: string,
  now: Date
): Promise<{ paths: Set<string>; runIds: Set<string> }> {
  const paths = getKaironPaths(projectRoot);
  const references = { paths: new Set<string>(), runIds: new Set<string>() };

  for (const entry of await readDirectory(paths.approvalsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const approval = await readOptionalJson(resolveInside(paths.approvalsDir, entry.name));
    if (
      approval === undefined ||
      !openApprovalStatuses.has(readString(approval.status) ?? "")
    ) {
      continue;
    }
    collectReferences(approval, references);
  }

  const recoveryTargets = await listRuntimeRecoveryTargets(projectRoot, { now });
  for (const target of recoveryTargets) {
    collectReferences(target, references);
  }

  return references;
}

function collectReferences(
  value: unknown,
  output: { paths: Set<string>; runIds: Set<string> },
  key = ""
): void {
  if (typeof value === "string") {
    if (key === "run_id" || /^RUN-[A-Z0-9-]+$/i.test(value)) {
      output.runIds.add(value.toUpperCase());
    }
    if (value.startsWith(".kairon/") || value.startsWith(".kairon\\")) {
      output.paths.add(normalizeProjectPath(value));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, output, key);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectReferences(childValue, output, childKey);
  }
}

function isReferenced(
  item: RetentionItem,
  references: { paths: Set<string>; runIds: Set<string> }
): boolean {
  const normalizedPath = normalizeProjectPath(item.path);
  if (
    [...references.paths].some(
      (reference) =>
        reference === normalizedPath || reference.startsWith(`${normalizedPath}/`)
    )
  ) {
    return true;
  }
  if (item.category !== "runs") {
    return false;
  }
  return references.runIds.has(path.basename(item.absolutePath).toUpperCase());
}

async function findLatestCompletedRun(
  items: RetentionItem[]
): Promise<RetentionItem | undefined> {
  const completed: RetentionItem[] = [];
  for (const item of items) {
    const runner = await readOptionalJson(resolveInside(item.absolutePath, "runner.json"));
    if (readString(runner?.status) === "completed") {
      completed.push(item);
    }
  }
  return completed.sort(compareNewestFirst)[0];
}

function selectCategoryCandidates(
  items: RetentionItem[],
  protectedPaths: Set<string>,
  rule: CleanupRetentionRule,
  now: Date
): CleanupRetentionCandidate[] {
  const selected = new Map<string, Set<string>>();
  const selectable = items.filter((item) => !protectedPaths.has(item.path));

  for (const item of selectable) {
    if (now.getTime() - item.modifiedAt.getTime() > rule.max_age_days * millisecondsPerDay) {
      addReason(selected, item.path, `max_age_days=${rule.max_age_days}`);
    }
  }

  selectUntilCountFits(items, selectable, selected, rule);
  selectUntilBytesFit(items, selectable, selected, rule);

  return selectable
    .filter((item) => selected.has(item.path))
    .map((item) => ({
      category: item.category,
      absolutePath: item.absolutePath,
      path: item.path,
      size_bytes: item.sizeBytes,
      modified_at: item.modifiedAt.toISOString(),
      age_days: Math.max(
        0,
        Math.floor((now.getTime() - item.modifiedAt.getTime()) / millisecondsPerDay)
      ),
      reason: `retention limits exceeded: ${[...(selected.get(item.path) ?? [])].join(", ")}`,
      retention_rule: { ...rule }
    }));
}

function selectUntilCountFits(
  allItems: RetentionItem[],
  selectable: RetentionItem[],
  selected: Map<string, Set<string>>,
  rule: CleanupRetentionRule
): void {
  let remaining = allItems.length - selected.size;
  for (const item of selectable) {
    if (remaining <= rule.max_files) {
      break;
    }
    if (!selected.has(item.path)) {
      remaining -= 1;
    }
    addReason(selected, item.path, `max_files=${rule.max_files}`);
  }
}

function selectUntilBytesFit(
  allItems: RetentionItem[],
  selectable: RetentionItem[],
  selected: Map<string, Set<string>>,
  rule: CleanupRetentionRule
): void {
  const sizeByPath = new Map(allItems.map((item) => [item.path, item.sizeBytes]));
  let remainingBytes = allItems.reduce((total, item) => total + item.sizeBytes, 0);
  for (const selectedPath of selected.keys()) {
    remainingBytes -= sizeByPath.get(selectedPath) ?? 0;
  }
  for (const item of selectable) {
    if (remainingBytes <= rule.max_bytes) {
      break;
    }
    if (!selected.has(item.path)) {
      remainingBytes -= item.sizeBytes;
    }
    addReason(selected, item.path, `max_bytes=${rule.max_bytes}`);
  }
}

function addReason(
  selected: Map<string, Set<string>>,
  itemPath: string,
  reason: string
): void {
  const reasons = selected.get(itemPath) ?? new Set<string>();
  reasons.add(reason);
  selected.set(itemPath, reasons);
}

function compareOldestFirst(left: RetentionItem, right: RetentionItem): number {
  return (
    left.modifiedAt.getTime() - right.modifiedAt.getTime() ||
    left.path.localeCompare(right.path)
  );
}

function compareNewestFirst(left: RetentionItem, right: RetentionItem): number {
  return (
    right.modifiedAt.getTime() - left.modifiedAt.getTime() ||
    left.path.localeCompare(right.path)
  );
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readOptionalJson(
  filePath: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJsonFile<Record<string, unknown>>(filePath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function dedupeItems(items: RetentionItem[]): RetentionItem[] {
  const output = new Map<string, RetentionItem>();
  for (const item of items) {
    output.set(item.absolutePath.toLowerCase(), item);
  }
  return [...output.values()];
}

function normalizeProjectPath(value: string): string {
  return toPosixPath(value).replace(/^\/+/, "").toLowerCase();
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptyScan(enabled: boolean): CleanupRetentionScanResult {
  return {
    enabled,
    scanned_items: 0,
    protected_items: 0,
    skipped_symbolic_links: 0,
    candidate_bytes: 0,
    candidates: []
  };
}
