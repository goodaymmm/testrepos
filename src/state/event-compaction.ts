import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  acquireResourceLock,
  assertResourceLockFencingToken,
  releaseResourceLock,
  writeJsonFileFenced
} from "../core/fs/resource-lock.js";
import type { KaironEvent } from "../core/events/event-types.js";
import { createStateSnapshot } from "./snapshot.js";

export type EventCompactionStateSummary = {
  files: number;
  bytes: number;
  sha256: string;
};

export type EventCompactionSegment = {
  date: string;
  source_path: string;
  archive_path: string;
  bytes: number;
  sha256: string;
  event_count: number;
  first_event_id: string;
  last_event_id: string;
};

export type EventCompactionPlan = {
  schema_version: "0.1";
  status: "planned" | "nothing_to_compact";
  dry_run: true;
  generated_at: string;
  active_date: string;
  checkpoint_id?: string;
  previous_checkpoint_id?: string;
  source_hash?: string;
  materialized_state?: EventCompactionStateSummary;
  summary: {
    segments: number;
    events: number;
    bytes: number;
  };
  segments: EventCompactionSegment[];
};

export type EventCompactionCheckpoint = {
  schema_version: "0.1";
  artifact_kind: "event_log_checkpoint";
  checkpoint_id: string;
  created_at: string;
  active_date: string;
  previous_checkpoint_id?: string;
  first_event_id: string;
  last_event_id: string;
  event_count: number;
  source_hash: string;
  materialized_state: EventCompactionStateSummary;
  snapshot: {
    snapshot_id: string;
    snapshot_path: string;
    manifest_path: string;
  };
  archive: {
    archive_path: string;
    manifest_path: string;
  };
  segments: EventCompactionSegment[];
};

export type EventCompactionArchiveManifest = {
  schema_version: "0.1";
  artifact_kind: "event_log_archive";
  checkpoint_id: string;
  created_at: string;
  source_hash: string;
  first_event_id: string;
  last_event_id: string;
  event_count: number;
  segments: EventCompactionSegment[];
};

export type EventCompactionMarker = {
  schema_version: "0.1";
  artifact_kind: "state_event_compaction";
  status: "snapshot_created" | "moving_segments" | "archive_written";
  checkpoint_id: string;
  created_at: string;
  updated_at: string;
  source_hash: string;
  materialized_state: EventCompactionStateSummary;
  snapshot: EventCompactionCheckpoint["snapshot"];
  archive_path: string;
  checkpoint_path: string;
  segments: EventCompactionSegment[];
  moved_segments: string[];
  next_action: "roll_forward_or_rollback_after_manual_verification";
};

export type EventCompactionResult = {
  schema_version: "0.1";
  status: "compacted";
  dry_run: false;
  checkpoint_id: string;
  checkpoint_path: string;
  archive_path: string;
  manifest_path: string;
  snapshot_id: string;
  snapshot_path: string;
  completed_at: string;
  summary: EventCompactionPlan["summary"];
};

export type EventCompactionVerification = {
  schema_version: "0.1";
  status: "verified";
  checkpoint_id: string;
  checked_at: string;
  checkpoint_path: string;
  archive_path: string;
  snapshot_id: string;
  source_hash: string;
  materialized_state_hash: string;
  summary: {
    segments: number;
    events: number;
    bytes: number;
  };
};

export type EventCompactionOptions = {
  confirm: string;
  now?: () => Date;
  afterSegmentMoved?: (
    segment: EventCompactionSegment,
    movedCount: number
  ) => Promise<void>;
};

type SegmentRecord = EventCompactionSegment & {
  absolute_path: string;
  events: KaironEvent[];
};

type StateHashRecord = {
  path: string;
  bytes: number;
  sha256: string;
};

const eventSegmentPattern = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const checkpointIdPattern = /^ECP-EVT-\d+-[0-9a-f]{12}$/u;

export class EventCompactionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCompactionSafetyError";
  }
}

export async function planEventCompaction(
  projectRoot: string,
  options: { now?: () => Date } = {}
): Promise<EventCompactionPlan> {
  const now = options.now?.() ?? new Date();
  const activeDate = now.toISOString().slice(0, 10);
  const sourceSegments = await collectClosedSegments(projectRoot, activeDate);
  if (sourceSegments.length === 0) {
    return {
      schema_version: "0.1",
      status: "nothing_to_compact",
      dry_run: true,
      generated_at: now.toISOString(),
      active_date: activeDate,
      summary: { segments: 0, events: 0, bytes: 0 },
      segments: []
    };
  }

  const previousCheckpoint = await readLatestCheckpoint(projectRoot);
  const allEvents = sourceSegments.flatMap((segment) => segment.events);
  validateEventContinuity(
    allEvents,
    previousCheckpoint?.last_event_id
  );
  const sourceHash = hashSegmentSet(sourceSegments);
  const lastEventId = allEvents.at(-1)?.event_id;
  if (lastEventId === undefined) {
    throw new EventCompactionSafetyError("Closed event segments do not contain events.");
  }
  const checkpointId = checkpointIdFor(lastEventId, sourceHash);
  const archivePath = eventArchiveProjectPath(checkpointId);
  const segments = sourceSegments.map(({ absolute_path: _absolute, events: _events, ...segment }) => ({
    ...segment,
    archive_path: `${archivePath}/${path.posix.basename(segment.source_path)}`
  }));
  const materializedState = await collectMaterializedStateSummary(projectRoot);

  return {
    schema_version: "0.1",
    status: "planned",
    dry_run: true,
    generated_at: now.toISOString(),
    active_date: activeDate,
    checkpoint_id: checkpointId,
    previous_checkpoint_id: previousCheckpoint?.checkpoint_id,
    source_hash: sourceHash,
    materialized_state: materializedState,
    summary: summarizeSegments(segments),
    segments
  };
}

export async function compactEventLogs(
  projectRoot: string,
  options: EventCompactionOptions
): Promise<EventCompactionResult> {
  const now = options.now?.() ?? new Date();
  const initialPlan = await planEventCompaction(projectRoot, { now: () => now });
  assertExecutablePlan(initialPlan);
  if (options.confirm !== initialPlan.checkpoint_id) {
    throw new EventCompactionSafetyError(
      `Checkpoint confirmation does not match. Expected --confirm ${initialPlan.checkpoint_id}.`
    );
  }

  const snapshot = await createStateSnapshot(projectRoot, { now: () => now });
  const paths = getKaironPaths(projectRoot);
  const lock = await acquireResourceLock(projectRoot, paths.eventsDir, {
    owner: `event-compaction:${initialPlan.checkpoint_id}`,
    ttlMs: 5 * 60 * 1000
  });

  try {
    await assertNoExistingCompactionMarker(projectRoot);
    const lockedPlan = await planEventCompaction(projectRoot, { now: () => now });
    assertExecutablePlan(lockedPlan);
    if (
      lockedPlan.checkpoint_id !== initialPlan.checkpoint_id ||
      lockedPlan.source_hash !== initialPlan.source_hash ||
      lockedPlan.materialized_state.sha256 !== initialPlan.materialized_state.sha256
    ) {
      throw new EventCompactionSafetyError(
        "Event compaction inputs changed after the snapshot. Run --dry-run again."
      );
    }

    const checkpointPath = eventCheckpointPath(projectRoot, lockedPlan.checkpoint_id);
    const archiveDirectory = eventArchivePath(projectRoot, lockedPlan.checkpoint_id);
    const archiveManifestPath = resolveInside(archiveDirectory, "manifest.json");
    await assertPathDoesNotExist(checkpointPath, "Event checkpoint");
    await assertPathDoesNotExist(archiveDirectory, "Event archive");
    await assertNoSymbolicLinks(paths.kaironDir, paths.eventsDir);
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await mkdir(path.dirname(archiveDirectory), { recursive: true });

    const checkpointProjectPath = toProjectPath(projectRoot, checkpointPath);
    const archiveProjectPath = toProjectPath(projectRoot, archiveDirectory);
    const snapshotRecord = {
      snapshot_id: snapshot.snapshot_id,
      snapshot_path: snapshot.snapshot_path,
      manifest_path: snapshot.manifest_path
    };
    const markerPath = eventCompactionMarkerPath(projectRoot);
    const marker: EventCompactionMarker = {
      schema_version: "0.1",
      artifact_kind: "state_event_compaction",
      status: "snapshot_created",
      checkpoint_id: lockedPlan.checkpoint_id,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      source_hash: lockedPlan.source_hash,
      materialized_state: lockedPlan.materialized_state,
      snapshot: snapshotRecord,
      archive_path: archiveProjectPath,
      checkpoint_path: checkpointProjectPath,
      segments: lockedPlan.segments,
      moved_segments: [],
      next_action: "roll_forward_or_rollback_after_manual_verification"
    };
    await writeJsonFileFenced(lock, markerPath, marker);
    await mkdir(archiveDirectory);
    await assertNoSymbolicLinks(paths.kaironDir, archiveDirectory);

    for (const segment of lockedPlan.segments) {
      await assertResourceLockFencingToken(lock);
      const sourcePath = resolveProjectStatePath(projectRoot, segment.source_path);
      const destinationPath = resolveProjectStatePath(projectRoot, segment.archive_path);
      await assertRegularFile(sourcePath, "Event source segment");
      await rename(sourcePath, destinationPath);
      marker.status = "moving_segments";
      marker.moved_segments.push(segment.source_path);
      marker.updated_at = new Date().toISOString();
      await writeJsonFileFenced(lock, markerPath, marker);
      await options.afterSegmentMoved?.(segment, marker.moved_segments.length);
    }

    const firstEventId = lockedPlan.segments[0]?.first_event_id;
    const lastEventId = lockedPlan.segments.at(-1)?.last_event_id;
    if (firstEventId === undefined || lastEventId === undefined) {
      throw new EventCompactionSafetyError("Compaction plan has no event boundaries.");
    }
    const manifest: EventCompactionArchiveManifest = {
      schema_version: "0.1",
      artifact_kind: "event_log_archive",
      checkpoint_id: lockedPlan.checkpoint_id,
      created_at: now.toISOString(),
      source_hash: lockedPlan.source_hash,
      first_event_id: firstEventId,
      last_event_id: lastEventId,
      event_count: lockedPlan.summary.events,
      segments: lockedPlan.segments
    };
    await writeJsonFileFenced(lock, archiveManifestPath, manifest);
    marker.status = "archive_written";
    marker.updated_at = new Date().toISOString();
    await writeJsonFileFenced(lock, markerPath, marker);

    const checkpoint: EventCompactionCheckpoint = {
      schema_version: "0.1",
      artifact_kind: "event_log_checkpoint",
      checkpoint_id: lockedPlan.checkpoint_id,
      created_at: now.toISOString(),
      active_date: lockedPlan.active_date,
      previous_checkpoint_id: lockedPlan.previous_checkpoint_id,
      first_event_id: firstEventId,
      last_event_id: lastEventId,
      event_count: lockedPlan.summary.events,
      source_hash: lockedPlan.source_hash,
      materialized_state: lockedPlan.materialized_state,
      snapshot: snapshotRecord,
      archive: {
        archive_path: archiveProjectPath,
        manifest_path: toProjectPath(projectRoot, archiveManifestPath)
      },
      segments: lockedPlan.segments
    };
    await writeJsonFileFenced(lock, checkpointPath, checkpoint);
    await assertResourceLockFencingToken(lock);
    await rm(markerPath, { force: true });

    return {
      schema_version: "0.1",
      status: "compacted",
      dry_run: false,
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_path: checkpointProjectPath,
      archive_path: archiveProjectPath,
      manifest_path: checkpoint.archive.manifest_path,
      snapshot_id: snapshot.snapshot_id,
      snapshot_path: snapshot.snapshot_path,
      completed_at: new Date().toISOString(),
      summary: lockedPlan.summary
    };
  } finally {
    await releaseResourceLock(lock);
  }
}

export async function verifyEventCompaction(
  projectRoot: string,
  checkpointId: string,
  options: { now?: () => Date } = {}
): Promise<EventCompactionVerification> {
  assertCheckpointId(checkpointId);
  const checkpointPath = eventCheckpointPath(projectRoot, checkpointId);
  await assertRegularFile(checkpointPath, "Event checkpoint");
  const checkpoint = parseCheckpoint(
    await readJsonFile<unknown>(checkpointPath),
    checkpointId
  );
  const manifestPath = resolveProjectStatePath(
    projectRoot,
    checkpoint.archive.manifest_path
  );
  await assertRegularFile(manifestPath, "Event archive manifest");
  const manifest = parseArchiveManifest(
    await readJsonFile<unknown>(manifestPath),
    checkpointId
  );
  if (
    JSON.stringify(manifest.segments) !== JSON.stringify(checkpoint.segments) ||
    manifest.source_hash !== checkpoint.source_hash ||
    manifest.event_count !== checkpoint.event_count ||
    manifest.first_event_id !== checkpoint.first_event_id ||
    manifest.last_event_id !== checkpoint.last_event_id
  ) {
    throw new EventCompactionSafetyError(
      `Archive manifest does not match checkpoint ${checkpointId}.`
    );
  }

  const verifiedSegments: SegmentRecord[] = [];
  for (const segment of checkpoint.segments) {
    if (
      segment.archive_path !==
      `${checkpoint.archive.archive_path}/${segment.date}.jsonl`
    ) {
      throw new EventCompactionSafetyError(
        `Checkpoint contains an unexpected archive path: ${segment.archive_path}.`
      );
    }
    const archivePath = resolveProjectStatePath(projectRoot, segment.archive_path);
    await assertRegularFile(archivePath, "Archived event segment");
    const content = await readFile(archivePath);
    const events = await readJsonLines<KaironEvent>(archivePath);
    const actual = segmentRecordFromContent(
      archivePath,
      segment.source_path,
      segment.archive_path,
      content,
      events
    );
    if (
      actual.bytes !== segment.bytes ||
      actual.sha256 !== segment.sha256 ||
      actual.event_count !== segment.event_count ||
      actual.first_event_id !== segment.first_event_id ||
      actual.last_event_id !== segment.last_event_id
    ) {
      throw new EventCompactionSafetyError(
        `Archived event segment verification failed: ${segment.archive_path}.`
      );
    }
    verifiedSegments.push(actual);
  }

  const previousCheckpoint = checkpoint.previous_checkpoint_id === undefined
    ? undefined
    : parseCheckpoint(
        await readJsonFile<unknown>(
          eventCheckpointPath(projectRoot, checkpoint.previous_checkpoint_id)
        ),
        checkpoint.previous_checkpoint_id
      );
  const events = verifiedSegments.flatMap((segment) => segment.events);
  validateEventContinuity(events, previousCheckpoint?.last_event_id);
  const sourceHash = hashSegmentSet(verifiedSegments);
  const verifiedSummary = summarizeSegments(verifiedSegments);
  if (
    sourceHash !== checkpoint.source_hash ||
    checkpointIdFor(checkpoint.last_event_id, sourceHash) !== checkpointId ||
    verifiedSummary.events !== checkpoint.event_count ||
    verifiedSegments[0]?.first_event_id !== checkpoint.first_event_id ||
    verifiedSegments.at(-1)?.last_event_id !== checkpoint.last_event_id
  ) {
    throw new EventCompactionSafetyError(
      `Archived event source hash does not match checkpoint ${checkpointId}.`
    );
  }

  const snapshotManifestPath = resolveProjectStatePath(
    projectRoot,
    checkpoint.snapshot.manifest_path
  );
  await assertRegularFile(snapshotManifestPath, "State snapshot manifest");
  const snapshotManifest = toRecord(await readJsonFile<unknown>(snapshotManifestPath));
  if (
    snapshotManifest.artifact_kind !== "state_snapshot" ||
    snapshotManifest.snapshot_id !== checkpoint.snapshot.snapshot_id ||
    !Array.isArray(snapshotManifest.files)
  ) {
    throw new EventCompactionSafetyError(
      `Invalid state snapshot manifest for checkpoint ${checkpointId}.`
    );
  }
  const snapshotRecords = snapshotManifest.files.map(parseStateHashRecord);
  await verifySnapshotPayload(projectRoot, checkpoint.snapshot.snapshot_path, snapshotRecords);
  const snapshotState = summarizeStateHashRecords(
    snapshotRecords.filter((record) => isMaterializedStatePath(record.path))
  );
  if (
    snapshotState.sha256 !== checkpoint.materialized_state.sha256 ||
    snapshotState.files !== checkpoint.materialized_state.files ||
    snapshotState.bytes !== checkpoint.materialized_state.bytes
  ) {
    throw new EventCompactionSafetyError(
      `Materialized state hash does not match checkpoint ${checkpointId}.`
    );
  }
  const snapshotFiles = new Map(snapshotRecords.map((record) => [record.path, record]));
  for (const segment of checkpoint.segments) {
    const snapshotFile = snapshotFiles.get(segment.source_path);
    if (
      snapshotFile === undefined ||
      snapshotFile.bytes !== segment.bytes ||
      snapshotFile.sha256 !== segment.sha256
    ) {
      throw new EventCompactionSafetyError(
        `Snapshot does not preserve source segment ${segment.source_path}.`
      );
    }
  }

  return {
    schema_version: "0.1",
    status: "verified",
    checkpoint_id: checkpointId,
    checked_at: (options.now?.() ?? new Date()).toISOString(),
    checkpoint_path: toProjectPath(projectRoot, checkpointPath),
    archive_path: checkpoint.archive.archive_path,
    snapshot_id: checkpoint.snapshot.snapshot_id,
    source_hash: sourceHash,
    materialized_state_hash: snapshotState.sha256,
    summary: verifiedSummary
  };
}

export function formatEventCompactionPlan(
  result: EventCompactionPlan,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (result.status === "nothing_to_compact") {
    return [
      "Kairon event compaction dry-run.",
      `status=${result.status}`,
      `active_date=${result.active_date}`,
      "segments=0"
    ].join("\n");
  }
  return [
    "Kairon event compaction dry-run.",
    `status=${result.status}`,
    `checkpoint_id=${result.checkpoint_id}`,
    `active_date=${result.active_date}`,
    `source_hash=${result.source_hash}`,
    `materialized_state_hash=${result.materialized_state?.sha256}`,
    `segments=${result.summary.segments}`,
    `events=${result.summary.events}`,
    `bytes=${result.summary.bytes}`,
    ...result.segments.map(
      (segment) =>
        `segment date=${segment.date} events=${segment.event_count} source=${segment.source_path} archive=${segment.archive_path}`
    )
  ].join("\n");
}

export function formatEventCompactionResult(
  result: EventCompactionResult,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon event compaction completed.",
    `status=${result.status}`,
    `checkpoint_id=${result.checkpoint_id}`,
    `checkpoint_path=${result.checkpoint_path}`,
    `archive_path=${result.archive_path}`,
    `manifest_path=${result.manifest_path}`,
    `snapshot_id=${result.snapshot_id}`,
    `snapshot_path=${result.snapshot_path}`,
    `segments=${result.summary.segments}`,
    `events=${result.summary.events}`,
    `bytes=${result.summary.bytes}`
  ].join("\n");
}

export function formatEventCompactionVerification(
  result: EventCompactionVerification,
  options: { format?: "text" | "json" } = {}
): string {
  if (options.format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return [
    "Kairon event compaction verified.",
    `status=${result.status}`,
    `checkpoint_id=${result.checkpoint_id}`,
    `checkpoint_path=${result.checkpoint_path}`,
    `archive_path=${result.archive_path}`,
    `snapshot_id=${result.snapshot_id}`,
    `source_hash=${result.source_hash}`,
    `materialized_state_hash=${result.materialized_state_hash}`,
    `segments=${result.summary.segments}`,
    `events=${result.summary.events}`,
    `bytes=${result.summary.bytes}`
  ].join("\n");
}

export function eventCompactionMarkerPath(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).runtimeDir, "state-compaction.json");
}

async function collectClosedSegments(
  projectRoot: string,
  activeDate: string
): Promise<SegmentRecord[]> {
  const eventsDir = getKaironPaths(projectRoot).eventsDir;
  let entries;
  try {
    entries = await readdir(eventsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: SegmentRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = eventSegmentPattern.exec(entry.name);
    if (match?.[1] === undefined || match[1] >= activeDate) {
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new EventCompactionSafetyError(
        `Closed event segment must be a regular file: ${entry.name}.`
      );
    }
    const absolutePath = resolveInside(eventsDir, entry.name);
    const content = await readFile(absolutePath);
    const events = await readJsonLines<KaironEvent>(absolutePath);
    records.push(
      segmentRecordFromContent(
        absolutePath,
        toProjectPath(projectRoot, absolutePath),
        "",
        content,
        events
      )
    );
  }
  return records;
}

function segmentRecordFromContent(
  absolutePath: string,
  sourcePath: string,
  archivePath: string,
  content: Buffer,
  events: KaironEvent[]
): SegmentRecord {
  const fileName = path.basename(absolutePath);
  const date = eventSegmentPattern.exec(fileName)?.[1];
  if (date === undefined || events.length === 0) {
    throw new EventCompactionSafetyError(
      `Event segment must use a date filename and contain events: ${sourcePath}.`
    );
  }
  for (const event of events) {
    if (eventSequence(event.event_id) === undefined) {
      throw new EventCompactionSafetyError(
        `Event segment contains an invalid event id: ${sourcePath}.`
      );
    }
  }
  return {
    date,
    source_path: sourcePath,
    archive_path: archivePath,
    bytes: content.length,
    sha256: hashBuffer(content),
    event_count: events.length,
    first_event_id: events[0]?.event_id ?? "",
    last_event_id: events.at(-1)?.event_id ?? "",
    absolute_path: absolutePath,
    events
  };
}

function validateEventContinuity(
  events: KaironEvent[],
  previousEventId?: string
): void {
  if (events.length === 0) {
    throw new EventCompactionSafetyError("Event sequence is empty.");
  }
  const previous = previousEventId === undefined ? 0 : eventSequence(previousEventId);
  if (previous === undefined) {
    throw new EventCompactionSafetyError(
      `Previous checkpoint has an invalid event id: ${previousEventId}.`
    );
  }
  let expected = previous + 1;
  for (const event of events) {
    const actual = eventSequence(event.event_id);
    if (actual !== expected) {
      throw new EventCompactionSafetyError(
        `Event sequence is not continuous. Expected EVT-${expected}, received ${event.event_id}.`
      );
    }
    expected += 1;
  }
}

async function collectMaterializedStateSummary(
  projectRoot: string
): Promise<EventCompactionStateSummary> {
  const files: string[] = [];
  await walkMaterializedState(projectRoot, getKaironPaths(projectRoot).kaironDir, files);
  const records: StateHashRecord[] = [];
  for (const filePath of files.sort()) {
    const content = await readFile(filePath);
    records.push({
      path: toProjectPath(projectRoot, filePath),
      bytes: content.length,
      sha256: hashBuffer(content)
    });
  }
  return summarizeStateHashRecords(records);
}

async function walkMaterializedState(
  projectRoot: string,
  directoryPath: string,
  files: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const projectPath = toProjectPath(projectRoot, fullPath);
    if (!isMaterializedStatePath(projectPath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new EventCompactionSafetyError(
        `Symbolic links are not allowed in materialized state: ${projectPath}.`
      );
    }
    if (entry.isDirectory()) {
      await walkMaterializedState(projectRoot, fullPath, files);
    } else if (
      entry.isFile() &&
      [".json", ".jsonl", ".md"].includes(path.extname(entry.name).toLowerCase())
    ) {
      files.push(fullPath);
    }
  }
}

function isMaterializedStatePath(filePath: string): boolean {
  return !(
    filePath === ".kairon/events" ||
    filePath.startsWith(".kairon/events/") ||
    filePath === ".kairon/runtime" ||
    filePath.startsWith(".kairon/runtime/") ||
    filePath === ".kairon/snapshots" ||
    filePath.startsWith(".kairon/snapshots/") ||
    filePath === ".kairon/tmp" ||
    filePath.startsWith(".kairon/tmp/") ||
    filePath === ".kairon/worktrees" ||
    filePath.startsWith(".kairon/worktrees/") ||
    filePath.includes("/.resource-locks/") ||
    filePath.endsWith(".log")
  );
}

function summarizeStateHashRecords(records: StateHashRecord[]): EventCompactionStateSummary {
  const normalized = records
    .map((record) => ({ path: record.path, bytes: record.bytes, sha256: record.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: normalized.length,
    bytes: normalized.reduce((total, record) => total + record.bytes, 0),
    sha256: hashValue(normalized)
  };
}

function parseStateHashRecord(value: unknown): StateHashRecord {
  const record = toRecord(value);
  if (
    typeof record.path !== "string" ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sha256)
  ) {
    throw new EventCompactionSafetyError("Snapshot manifest contains an invalid file record.");
  }
  return { path: record.path, bytes: record.bytes, sha256: record.sha256 };
}

async function verifySnapshotPayload(
  projectRoot: string,
  snapshotPath: string,
  records: StateHashRecord[]
): Promise<void> {
  for (const record of records) {
    if (!record.path.startsWith(".kairon/")) {
      throw new EventCompactionSafetyError(
        `Snapshot manifest contains an unsafe state path: ${record.path}.`
      );
    }
    const payloadPath = resolveProjectStatePath(
      projectRoot,
      `${snapshotPath}/files/${record.path.slice(".kairon/".length)}`
    );
    await assertRegularFile(payloadPath, "State snapshot payload");
    const content = await readFile(payloadPath);
    if (content.length !== record.bytes || hashBuffer(content) !== record.sha256) {
      throw new EventCompactionSafetyError(
        `State snapshot payload verification failed: ${record.path}.`
      );
    }
  }
}

async function readLatestCheckpoint(
  projectRoot: string
): Promise<EventCompactionCheckpoint | undefined> {
  const directory = eventCheckpointsDirectory(projectRoot);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const checkpoints: EventCompactionCheckpoint[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const checkpointId = entry.name.slice(0, -".json".length);
    checkpoints.push(
      parseCheckpoint(
        await readJsonFile<unknown>(resolveInside(directory, entry.name)),
        checkpointId
      )
    );
  }
  return checkpoints.sort(
    (left, right) =>
      (eventSequence(right.last_event_id) ?? 0) -
      (eventSequence(left.last_event_id) ?? 0)
  )[0];
}

function parseCheckpoint(
  value: unknown,
  expectedCheckpointId: string
): EventCompactionCheckpoint {
  assertCheckpointId(expectedCheckpointId);
  const record = toRecord(value);
  const snapshot = toRecord(record.snapshot);
  const archive = toRecord(record.archive);
  if (
    record.schema_version !== "0.1" ||
    record.artifact_kind !== "event_log_checkpoint" ||
    record.checkpoint_id !== expectedCheckpointId ||
    typeof record.created_at !== "string" ||
    typeof record.active_date !== "string" ||
    typeof record.first_event_id !== "string" ||
    typeof record.last_event_id !== "string" ||
    typeof record.event_count !== "number" ||
    !Number.isSafeInteger(record.event_count) ||
    record.event_count < 1 ||
    typeof record.source_hash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.source_hash) ||
    typeof snapshot.snapshot_id !== "string" ||
    typeof snapshot.snapshot_path !== "string" ||
    typeof snapshot.manifest_path !== "string" ||
    typeof archive.archive_path !== "string" ||
    typeof archive.manifest_path !== "string" ||
    !Array.isArray(record.segments) ||
    snapshot.snapshot_path !== `.kairon/snapshots/${String(snapshot.snapshot_id)}` ||
    snapshot.manifest_path !== `${String(snapshot.snapshot_path)}/manifest.json` ||
    archive.archive_path !== eventArchiveProjectPath(expectedCheckpointId) ||
    archive.manifest_path !== `${String(archive.archive_path)}/manifest.json`
  ) {
    throw new EventCompactionSafetyError(
      `Invalid event checkpoint: ${expectedCheckpointId}.`
    );
  }
  return {
    schema_version: "0.1",
    artifact_kind: "event_log_checkpoint",
    checkpoint_id: expectedCheckpointId,
    created_at: record.created_at,
    active_date: record.active_date,
    previous_checkpoint_id:
      typeof record.previous_checkpoint_id === "string"
        ? record.previous_checkpoint_id
        : undefined,
    first_event_id: record.first_event_id,
    last_event_id: record.last_event_id,
    event_count: record.event_count,
    source_hash: record.source_hash,
    materialized_state: parseStateSummary(record.materialized_state),
    snapshot: {
      snapshot_id: snapshot.snapshot_id,
      snapshot_path: snapshot.snapshot_path,
      manifest_path: snapshot.manifest_path
    },
    archive: {
      archive_path: archive.archive_path,
      manifest_path: archive.manifest_path
    },
    segments: record.segments.map(parseSegment)
  };
}

function parseArchiveManifest(
  value: unknown,
  expectedCheckpointId: string
): EventCompactionArchiveManifest {
  const record = toRecord(value);
  if (
    record.schema_version !== "0.1" ||
    record.artifact_kind !== "event_log_archive" ||
    record.checkpoint_id !== expectedCheckpointId ||
    typeof record.created_at !== "string" ||
    typeof record.source_hash !== "string" ||
    typeof record.first_event_id !== "string" ||
    typeof record.last_event_id !== "string" ||
    typeof record.event_count !== "number" ||
    !Number.isSafeInteger(record.event_count) ||
    record.event_count < 1 ||
    !Array.isArray(record.segments)
  ) {
    throw new EventCompactionSafetyError(
      `Invalid event archive manifest: ${expectedCheckpointId}.`
    );
  }
  return {
    schema_version: "0.1",
    artifact_kind: "event_log_archive",
    checkpoint_id: expectedCheckpointId,
    created_at: record.created_at,
    source_hash: record.source_hash,
    first_event_id: record.first_event_id,
    last_event_id: record.last_event_id,
    event_count: record.event_count,
    segments: record.segments.map(parseSegment)
  };
}

function parseSegment(value: unknown): EventCompactionSegment {
  const record = toRecord(value);
  if (
    typeof record.date !== "string" ||
    typeof record.source_path !== "string" ||
    typeof record.archive_path !== "string" ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 1 ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sha256) ||
    typeof record.event_count !== "number" ||
    !Number.isSafeInteger(record.event_count) ||
    record.event_count < 1 ||
    typeof record.first_event_id !== "string" ||
    typeof record.last_event_id !== "string"
  ) {
    throw new EventCompactionSafetyError("Event checkpoint contains an invalid segment.");
  }
  if (
    !eventSegmentPattern.test(`${record.date}.jsonl`) ||
    record.source_path !== `.kairon/events/${record.date}.jsonl` ||
    path.posix.basename(record.archive_path) !== `${record.date}.jsonl`
  ) {
    throw new EventCompactionSafetyError("Event checkpoint contains unsafe segment paths.");
  }
  return {
    date: record.date,
    source_path: record.source_path,
    archive_path: record.archive_path,
    bytes: record.bytes,
    sha256: record.sha256,
    event_count: record.event_count,
    first_event_id: record.first_event_id,
    last_event_id: record.last_event_id
  };
}

function parseStateSummary(value: unknown): EventCompactionStateSummary {
  const record = toRecord(value);
  if (
    typeof record.files !== "number" ||
    !Number.isSafeInteger(record.files) ||
    record.files < 0 ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sha256)
  ) {
    throw new EventCompactionSafetyError("Event checkpoint has invalid state summary.");
  }
  return { files: record.files, bytes: record.bytes, sha256: record.sha256 };
}

function hashSegmentSet(
  segments: Array<
    Pick<
      EventCompactionSegment,
      | "date"
      | "source_path"
      | "bytes"
      | "sha256"
      | "event_count"
      | "first_event_id"
      | "last_event_id"
    >
  >
): string {
  return hashValue(
    segments.map((segment) => ({
      date: segment.date,
      source_path: segment.source_path,
      bytes: segment.bytes,
      sha256: segment.sha256,
      event_count: segment.event_count,
      first_event_id: segment.first_event_id,
      last_event_id: segment.last_event_id
    }))
  );
}

function checkpointIdFor(lastEventId: string, sourceHash: string): string {
  const digest = sourceHash.replace(/^sha256:/u, "").slice(0, 12);
  const checkpointId = `ECP-${lastEventId}-${digest}`;
  assertCheckpointId(checkpointId);
  return checkpointId;
}

function assertExecutablePlan(
  plan: EventCompactionPlan
): asserts plan is EventCompactionPlan & {
  status: "planned";
  checkpoint_id: string;
  source_hash: string;
  materialized_state: EventCompactionStateSummary;
} {
  if (
    plan.status !== "planned" ||
    plan.checkpoint_id === undefined ||
    plan.source_hash === undefined ||
    plan.materialized_state === undefined
  ) {
    throw new EventCompactionSafetyError("No closed event segments are available to compact.");
  }
}

async function assertNoExistingCompactionMarker(projectRoot: string): Promise<void> {
  const markerPath = eventCompactionMarkerPath(projectRoot);
  if (await fileExists(markerPath)) {
    throw new EventCompactionSafetyError(
      `Event compaction recovery is required before starting another compaction: ${toProjectPath(projectRoot, markerPath)}.`
    );
  }
}

async function assertPathDoesNotExist(filePath: string, label: string): Promise<void> {
  if (await fileExists(filePath)) {
    throw new EventCompactionSafetyError(`${label} already exists: ${filePath}.`);
  }
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw new EventCompactionSafetyError(`${label} is missing: ${filePath}. ${String(error)}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new EventCompactionSafetyError(`${label} must be a regular file: ${filePath}.`);
  }
}

async function assertNoSymbolicLinks(root: string, targetPath: string): Promise<void> {
  const relative = path.relative(root, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EventCompactionSafetyError(`Event path escapes .kairon: ${targetPath}.`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter((item) => item.length > 0)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new EventCompactionSafetyError(
          `Symbolic links are not allowed in event compaction paths: ${current}.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function resolveProjectStatePath(projectRoot: string, projectPath: string): string {
  if (
    !projectPath.startsWith(".kairon/") ||
    projectPath.includes("\\") ||
    projectPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new EventCompactionSafetyError(`Invalid .kairon path: ${projectPath}.`);
  }
  return resolveInside(projectRoot, ...projectPath.split("/"));
}

function eventSequence(eventId: string): number | undefined {
  const match = /^EVT-(\d+)$/u.exec(eventId);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function assertCheckpointId(checkpointId: string): void {
  if (!checkpointIdPattern.test(checkpointId)) {
    throw new EventCompactionSafetyError(`Invalid event checkpoint id: ${checkpointId}.`);
  }
}

function eventCheckpointsDirectory(projectRoot: string): string {
  return resolveInside(getKaironPaths(projectRoot).eventsDir, "checkpoints");
}

function eventCheckpointPath(projectRoot: string, checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return resolveInside(eventCheckpointsDirectory(projectRoot), `${checkpointId}.json`);
}

function eventArchivePath(projectRoot: string, checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return resolveInside(getKaironPaths(projectRoot).eventsDir, "archive", checkpointId);
}

function eventArchiveProjectPath(checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return `.kairon/events/archive/${checkpointId}`;
}

function summarizeSegments(
  segments: EventCompactionSegment[]
): EventCompactionPlan["summary"] {
  return {
    segments: segments.length,
    events: segments.reduce((total, segment) => total + segment.event_count, 0),
    bytes: segments.reduce((total, segment) => total + segment.bytes, 0)
  };
}

function hashBuffer(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function hashValue(value: unknown): string {
  return hashBuffer(Buffer.from(JSON.stringify(value), "utf8"));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
