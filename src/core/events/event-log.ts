import path from "node:path";
import { appendJsonLine } from "../fs/jsonl-file.js";
import { getKaironPaths } from "../fs/paths.js";
import { nextId } from "../ids/counter.js";
import type { KaironEvent, KaironEventDraft } from "./event-types.js";

export async function appendEvent(
  projectRoot: string,
  draft: KaironEventDraft
): Promise<KaironEvent> {
  const createdAt = draft.created_at ?? new Date().toISOString();
  const event: KaironEvent = {
    ...draft,
    event_id: await nextId(projectRoot, "event"),
    created_at: createdAt,
    schema_version: draft.schema_version ?? "0.1"
  };

  const date = createdAt.slice(0, 10);
  const eventPath = path.join(getKaironPaths(projectRoot).eventsDir, `${date}.jsonl`);
  await appendJsonLine(eventPath, event);
  return event;
}
