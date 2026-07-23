import { readFile } from "node:fs/promises";
import { getKaironPaths } from "../fs/paths.js";
import { writeJsonFileAtomic } from "../fs/json-file.js";
import { acquireLockFile, releaseLockFile } from "../fs/lock-file.js";

export type CounterKey =
  | "task"
  | "run"
  | "event"
  | "job"
  | "approval"
  | "message"
  | "command"
  | "review"
  | "git_transaction"
  | "correlation"
  | "release"
  | "update_download"
  | "support_bundle"
  | "watchdog_alert"
  | "incident";

export type Counters = Record<CounterKey, number>;

const defaultCounters: Counters = {
  task: 0,
  run: 0,
  event: 0,
  job: 0,
  approval: 0,
  message: 0,
  command: 0,
  review: 0,
  git_transaction: 0,
  correlation: 0,
  release: 0,
  update_download: 0,
  support_bundle: 0,
  watchdog_alert: 0,
  incident: 0
};

const prefixes: Record<CounterKey, string> = {
  task: "TASK",
  run: "RUN",
  event: "EVT",
  job: "JOB",
  approval: "APR",
  message: "MSG",
  command: "CMD",
  review: "REV",
  git_transaction: "GTX",
  correlation: "COR",
  release: "REL",
  update_download: "UPD",
  support_bundle: "SUP",
  watchdog_alert: "ALT",
  incident: "INC"
};

export function formatId(key: CounterKey, value: number): string {
  const width = key === "event" || key === "correlation" ? 6 : 4;
  return `${prefixes[key]}-${String(value).padStart(width, "0")}`;
}

export async function nextId(
  projectRoot: string,
  key: CounterKey
): Promise<string> {
  const paths = getKaironPaths(projectRoot);
  const lock = await acquireLockFile(
    `${paths.runtimeDir}/counters.lock`,
    "counter",
    30_000
  );

  try {
    const counterPath = `${paths.stateDir}/counters.json`;
    let counters = { ...defaultCounters };

    try {
      counters = {
        ...counters,
        ...(JSON.parse(await readFile(counterPath, "utf8")) as Partial<Counters>)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read counters file ${counterPath}: ${String(error)}`);
      }
    }

    counters[key] += 1;
    await writeJsonFileAtomic(counterPath, counters);
    return formatId(key, counters[key]);
  } finally {
    await releaseLockFile(lock);
  }
}
