import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ContextBuilder } from "../src/agents/context-builder.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { writeJsonFileAtomic, readJsonFile } from "../src/core/fs/json-file.js";
import { createDailyReport } from "../src/maintenance/daily-report.js";
import { createAgentHandoff, createDailyHandoffs } from "../src/maintenance/handoff.js";
import { createTempProject } from "./test-utils.js";

describe("handoff", () => {
  it("creates per-agent handoff files from daily report and session scratch", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const sessionDir = path.join(root, ".kairon", "sessions", "2026-05-25", "codex");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "scratch.md"), "Keep reviewing RUN-0001.", "utf8");
    await writeJsonFileAtomic(path.join(sessionDir, "session.json"), {
      schema_version: "0.1",
      session_id: "SESSION-2026-05-25-codex",
      status: "ready"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "runs", "RUN-0001", "runner.json"), {
      schema_version: "0.1",
      run_id: "RUN-0001",
      task_id: "TASK-0001",
      agent: "codex",
      persona: "reviewer",
      status: "completed",
      created_at: "2026-05-25T01:00:00.000Z",
      finished_at: "2026-05-25T01:02:00.000Z"
    });
    await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
      schema_version: "0.1",
      id: "APR-0001",
      status: "pending",
      type: "merge",
      created_at: "2026-05-25T02:00:00.000Z"
    });
    const report = await createDailyReport(root, { date: "2026-05-25" });

    const handoff = await createAgentHandoff(root, {
      date: "2026-05-25",
      agent: "codex",
      dailyReport: report
    });

    expect(handoff.runs).toHaveLength(1);
    expect(handoff.pending_approvals).toHaveLength(1);
    expect(handoff.next_day_bootstrap_sources).toEqual(
      expect.arrayContaining([
        ".kairon/reports/daily/2026-05-25.json",
        ".kairon/sessions/2026-05-25/codex/handoff.md"
      ])
    );
    await expect(readFile(path.join(root, handoff.handoff_markdown_path), "utf8")).resolves.toContain(
      "Keep reviewing RUN-0001."
    );
  });

  it("creates handoffs for all agents and includes previous day artifacts in next bootstrap", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const report = await createDailyReport(root, { date: "2026-05-25" });

    const handoffs = await createDailyHandoffs(root, {
      date: "2026-05-25",
      dailyReport: report
    });

    expect(handoffs).toHaveLength(3);
    await expect(
      readJsonFile(path.join(root, ".kairon", "sessions", "2026-05-25", "gemini", "handoff.json"))
    ).resolves.toMatchObject({
      agent: "gemini"
    });

    const bundle = await new ContextBuilder(root).buildDailyBootstrap({
      agent: "gemini",
      date: "2026-05-26"
    });

    expect(bundle.sources.map((source) => source.type)).toEqual(
      expect.arrayContaining(["daily_report", "handoff"])
    );
  });
});
