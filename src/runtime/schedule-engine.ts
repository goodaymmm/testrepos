import path from "node:path";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths } from "../core/fs/paths.js";
import { loadConfigFile } from "../core/config/load-config.js";

export type ScheduleMode = "active_work" | "standby_work" | "maintenance";

export type TimeRange = {
  start: string;
  end: string;
};

export type ScheduleConfig = {
  schema_version: string;
  timezone: string;
  active_work_time: TimeRange[];
  standby_work_time: TimeRange[];
  maintenance_time: TimeRange[];
};

export type ScheduleOverride = {
  schema_version: string;
  active_work_closed?: boolean;
  date?: string;
  expires_at?: string;
};

export type ScheduleStatus = {
  mode: ScheduleMode;
  baseMode: ScheduleMode;
  timezone: string;
  activeWorkClosed: boolean;
};

export async function getScheduleStatus(
  projectRoot: string,
  now = new Date()
): Promise<ScheduleStatus> {
  const config = await loadConfigFile<ScheduleConfig>(projectRoot, "schedule.json");
  const baseMode = resolveBaseMode(config, now);
  const activeWorkClosed = await isActiveWorkClosed(
    projectRoot,
    now,
    config.timezone
  );

  return {
    mode: activeWorkClosed && baseMode === "active_work" ? "standby_work" : baseMode,
    baseMode,
    timezone: config.timezone,
    activeWorkClosed
  };
}

export function resolveBaseMode(config: ScheduleConfig, now: Date): ScheduleMode {
  const minutes = localMinutes(now, config.timezone);

  if (config.maintenance_time.some((range) => includesMinute(range, minutes))) {
    return "maintenance";
  }

  if (config.active_work_time.some((range) => includesMinute(range, minutes))) {
    return "active_work";
  }

  return "standby_work";
}

export async function isActiveWorkClosed(
  projectRoot: string,
  now = new Date(),
  timezone?: string
): Promise<boolean> {
  const overridePath = path.join(
    getKaironPaths(projectRoot).stateDir,
    "schedule_override.json"
  );

  try {
    const override = await readJsonFile<ScheduleOverride>(overridePath);

    if (!override.active_work_closed) {
      return false;
    }

    if (override.expires_at === undefined) {
      return (
        override.date === undefined ||
        timezone === undefined ||
        override.date === getLocalDateKey(now, timezone)
      );
    }

    return Date.parse(override.expires_at) > now.getTime();
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return false;
    }

    throw error;
  }
}

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

export function getLocalDateKey(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Unable to resolve local date for timezone: ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

function includesMinute(range: TimeRange, minute: number): boolean {
  const start = parseTime(range.start);
  const end = parseTime(range.end);

  if (start === end) {
    return true;
  }

  if (start < end) {
    return minute >= start && minute < end;
  }

  return minute >= start || minute < end;
}

function parseTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);

  if (match === null) {
    throw new Error(`Invalid time range value: ${value}`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}
