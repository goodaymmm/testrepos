import { describe, expect, it } from "vitest";
import path from "node:path";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  getScheduleStatus,
  resolveBaseMode,
  type ScheduleConfig
} from "../src/runtime/schedule-engine.js";
import { createTempProject } from "./test-utils.js";

const schedule: ScheduleConfig = {
  schema_version: "0.1",
  timezone: "UTC",
  active_work_time: [{ start: "07:00", end: "18:00" }],
  standby_work_time: [{ start: "18:00", end: "01:00" }],
  maintenance_time: [{ start: "01:00", end: "07:00" }]
};

describe("schedule engine", () => {
  it("resolves active, standby, and maintenance modes", () => {
    expect(resolveBaseMode(schedule, new Date("2026-05-25T08:00:00.000Z"))).toBe(
      "active_work"
    );
    expect(resolveBaseMode(schedule, new Date("2026-05-25T20:00:00.000Z"))).toBe(
      "standby_work"
    );
    expect(resolveBaseMode(schedule, new Date("2026-05-25T02:00:00.000Z"))).toBe(
      "maintenance"
    );
  });

  it("switches active work to standby when leave override exists", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "config", "schedule.json"), schedule);
    await writeJsonFileAtomic(path.join(root, ".kairon", "state", "schedule_override.json"), {
      schema_version: "0.1",
      active_work_closed: true
    });

    await expect(
      getScheduleStatus(root, new Date("2026-05-25T08:00:00.000Z"))
    ).resolves.toMatchObject({
      baseMode: "active_work",
      mode: "standby_work",
      activeWorkClosed: true
    });
  });

  it("limits dated leave override to the configured local day", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await writeJsonFileAtomic(path.join(root, ".kairon", "config", "schedule.json"), schedule);
    await writeJsonFileAtomic(path.join(root, ".kairon", "state", "schedule_override.json"), {
      schema_version: "0.1",
      active_work_closed: true,
      date: "2026-05-25"
    });

    await expect(
      getScheduleStatus(root, new Date("2026-05-25T08:00:00.000Z"))
    ).resolves.toMatchObject({
      mode: "standby_work",
      activeWorkClosed: true
    });
    await expect(
      getScheduleStatus(root, new Date("2026-05-26T08:00:00.000Z"))
    ).resolves.toMatchObject({
      mode: "active_work",
      activeWorkClosed: false
    });
  });
});
