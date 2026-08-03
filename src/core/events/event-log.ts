import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, readJsonLines } from "../fs/jsonl-file.js";
import { getKaironPaths, resolveInside } from "../fs/paths.js";
import { withResourceLock } from "../fs/resource-lock.js";
import { nextId } from "../ids/counter.js";
import type { KaironEvent, KaironEventDraft } from "./event-types.js";

export async function appendEvent(
  projectRoot: string,
  draft: KaironEventDraft
): Promise<KaironEvent> {
  const paths = getKaironPaths(projectRoot);
  return withResourceLock(
    projectRoot,
    paths.eventsDir,
    { owner: "event-log-append", ttlMs: 60_000 },
    async () => {
      await assertCompactionIsNotInProgress(projectRoot, draft);
      const createdAt = draft.created_at ?? new Date().toISOString();
      const event: KaironEvent = {
        ...draft,
        event_id: await nextId(projectRoot, "event"),
        created_at: createdAt,
        schema_version: draft.schema_version ?? "0.1"
      };

      const date = createdAt.slice(0, 10);
      const eventPath = resolveInside(paths.eventsDir, `${date}.jsonl`);
      await appendJsonLine(eventPath, event);
      return event;
    }
  );
}

export async function readEventHistory(projectRoot: string): Promise<KaironEvent[]> {
  const paths = getKaironPaths(projectRoot);
  const segmentPaths: string[] = [];
  await collectEventSegments(paths.eventsDir, segmentPaths);
  const events: KaironEvent[] = [];

  for (const segmentPath of segmentPaths.sort()) {
    events.push(...(await readJsonLines<KaironEvent>(segmentPath)));
  }

  const sorted = events.sort(compareEvents);
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    if (event === undefined || eventSequence(event.event_id) !== index + 1) {
      throw new Error(
        `Event history is not continuous at position ${index + 1}: ${event?.event_id ?? "missing"}`
      );
    }
  }
  return sorted;
}

async function collectEventSegments(
  directoryPath: string,
  segmentPaths: string[]
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
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in event history: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      await collectEventSegments(fullPath, segmentPaths);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      segmentPaths.push(fullPath);
    }
  }
}

async function assertCompactionIsNotInProgress(
  projectRoot: string,
  draft: KaironEventDraft
): Promise<void> {
  const markerPath = resolveInside(
    getKaironPaths(projectRoot).runtimeDir,
    "state-compaction.json"
  );
  try {
    const info = await lstat(markerPath);
    if (info.isFile() || info.isSymbolicLink()) {
      if (draft.actor === "runtime-recovery" && draft.type === "approval.requested") {
        return;
      }
      throw new Error(
        "Event log compaction recovery is required before appending new events."
      );
    }
    throw new Error(`Invalid event compaction marker: ${markerPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function compareEvents(left: KaironEvent, right: KaironEvent): number {
  const leftNumber = eventSequence(left.event_id);
  const rightNumber = eventSequence(right.event_id);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber - rightNumber;
  }
  return left.event_id.localeCompare(right.event_id);
}

function eventSequence(eventId: string): number | undefined {
  const match = /^EVT-(\d+)$/u.exec(eventId);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}
