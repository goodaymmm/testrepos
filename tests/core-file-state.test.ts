import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { appendJsonLine, readJsonLines } from "../src/core/fs/jsonl-file.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../src/core/fs/lock-file.js";
import { resolveInside } from "../src/core/fs/paths.js";
import { nextId } from "../src/core/ids/counter.js";
import { createTempProject } from "./test-utils.js";

describe("core file state utilities", () => {
  it("rejects paths outside the project root", async () => {
    const root = await createTempProject();

    expect(() => resolveInside(root, ".kairon", "config")).not.toThrow();
    expect(() => resolveInside(root, "..", "outside")).toThrow(
      /escapes project root/
    );
  });

  it("writes JSON atomically and appends JSONL", async () => {
    const root = await createTempProject();
    const jsonPath = path.join(root, ".kairon", "state", "sample.json");
    const jsonlPath = path.join(root, ".kairon", "events", "sample.jsonl");

    await writeJsonFileAtomic(jsonPath, { ok: true });
    await appendJsonLine(jsonlPath, { index: 1 });
    await appendJsonLine(jsonlPath, { index: 2 });

    expect(await readJsonFile(jsonPath)).toEqual({ ok: true });
    expect(await readJsonLines(jsonlPath)).toEqual([{ index: 1 }, { index: 2 }]);
  });

  it("blocks duplicate lock acquisition", async () => {
    const root = await createTempProject();
    const lockPath = path.join(root, ".kairon", "runtime", "state.lock");
    const lock = await acquireLockFile(lockPath, "test", 30_000);

    await expect(acquireLockFile(lockPath, "test-2", 30_000)).rejects.toThrow(
      /Lock already exists/
    );

    await releaseLockFile(lock);
  });

  it("generates monotonic Kairon ids", async () => {
    const root = await createTempProject();

    await expect(nextId(root, "task")).resolves.toBe("TASK-0001");
    await expect(nextId(root, "task")).resolves.toBe("TASK-0002");
    await expect(nextId(root, "event")).resolves.toBe("EVT-000001");
  });

  it("does not reset ids when counters are corrupt", async () => {
    const root = await createTempProject();
    const stateDir = path.join(root, ".kairon", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "counters.json"), "not-json", "utf8");

    await expect(nextId(root, "task")).rejects.toThrow(/Failed to read counters/);
  });
});
