import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentIds, type AgentId } from "../agents/types.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  createDailyReport,
  readDailyReport,
  type DailyReport,
  type DailyRunSummary
} from "./daily-report.js";
import {
  createSessionHandoffSummary,
  type SessionHandoffSummary
} from "../agents/session-handoff.js";

export type AgentHandoff = {
  schema_version: string;
  date: string;
  agent: AgentId;
  handoff_path: string;
  handoff_markdown_path: string;
  daily_report_path: string;
  session: Record<string, unknown> | null;
  scratch_path: string;
  scratch: string;
  runs: DailyRunSummary[];
  pending_approvals: Record<string, unknown>[];
  summary: SessionHandoffSummary;
  next_day_bootstrap_sources: string[];
  created_at: string;
};

export type CreateAgentHandoffRequest = {
  date: string;
  agent: AgentId;
  dailyReport?: DailyReport;
};

export type CreateDailyHandoffsRequest = {
  date: string;
  agents?: AgentId[];
  dailyReport?: DailyReport;
};

export async function createAgentHandoff(
  projectRoot: string,
  request: CreateAgentHandoffRequest
): Promise<AgentHandoff> {
  const paths = getKaironPaths(projectRoot);
  const report =
    request.dailyReport ??
    (await readOrCreateDailyReport(projectRoot, request.date));
  const sessionDir = resolveInside(paths.sessionsDir, request.date, request.agent);
  const handoffPath = resolveInside(sessionDir, "handoff.json");
  const handoffMarkdownPath = resolveInside(sessionDir, "handoff.md");
  const scratchPath = resolveInside(sessionDir, "scratch.md");
  const scratch = await readOptionalText(scratchPath);
  const session = await readOptionalJson(
    resolveInside(sessionDir, "session.json")
  );
  const runs = report.runs.items.filter((run) => run.agent === request.agent);
  const pendingApprovals = report.approvals.items.filter(
    (approval) => approval.status === "pending"
  );
  const now = new Date();
  const summary = createSessionHandoffSummary({
    reason: "daily_boundary",
    objective:
      runs.length === 0
        ? null
        : String(runs.at(-1)?.task_id ?? runs.at(-1)?.run_id ?? ""),
    unfinishedWork: runs
      .filter((run) => run.status !== "completed")
      .map(
        (run) =>
          `run ${run.run_id} task=${run.task_id ?? "none"} status=${run.status}`
      ),
    decisions: [
      ...runs.map((run) => ({
        kind: "run_status" as const,
        reference: run.run_id,
        status: run.status
      })),
      ...pendingApprovals.map((approval) => ({
        kind: "approval" as const,
        reference: String(approval.id ?? "unknown"),
        status: String(approval.status ?? "pending")
      }))
    ],
    artifactReferences: [
      report.report_path,
      toProjectPath(paths.root, resolveInside(sessionDir, "session.json")),
      toProjectPath(paths.root, scratchPath)
    ],
    createdAt: now
  });
  const handoff: AgentHandoff = {
    schema_version: "0.1",
    date: request.date,
    agent: request.agent,
    handoff_path: toProjectPath(paths.root, handoffPath),
    handoff_markdown_path: toProjectPath(paths.root, handoffMarkdownPath),
    daily_report_path: report.report_path,
    session,
    scratch_path: toProjectPath(paths.root, scratchPath),
    scratch,
    runs,
    pending_approvals: pendingApprovals,
    summary,
    next_day_bootstrap_sources: [
      report.report_path,
      toProjectPath(paths.root, handoffPath),
      toProjectPath(paths.root, handoffMarkdownPath)
    ],
    created_at: now.toISOString()
  };

  await writeJsonFileAtomic(handoffPath, handoff);
  await writeText(handoffMarkdownPath, renderHandoffMarkdown(handoff));
  return handoff;
}

export async function createDailyHandoffs(
  projectRoot: string,
  request: CreateDailyHandoffsRequest
): Promise<AgentHandoff[]> {
  const report =
    request.dailyReport ??
    (await readOrCreateDailyReport(projectRoot, request.date));
  const agents = request.agents ?? [...agentIds];

  return Promise.all(
    agents.map((agent) =>
      createAgentHandoff(projectRoot, {
        date: request.date,
        agent,
        dailyReport: report
      })
    )
  );
}

async function readOrCreateDailyReport(
  projectRoot: string,
  date: string
): Promise<DailyReport> {
  try {
    return await readDailyReport(projectRoot, date);
  } catch {
    return createDailyReport(projectRoot, { date });
  }
}

function renderHandoffMarkdown(handoff: AgentHandoff): string {
  const runLines =
    handoff.runs.length === 0
      ? ["- No runs recorded."]
      : handoff.runs.map(
          (run) =>
            `- ${run.run_id}: status=${run.status} task=${run.task_id ?? "none"} persona=${run.persona ?? "none"}`
        );
  const approvalLines =
    handoff.pending_approvals.length === 0
      ? ["- No pending approvals."]
      : handoff.pending_approvals.map(
          (approval) =>
            `- ${String(approval.id ?? approval.approval_id ?? "unknown")}: ${String(
              approval.type ?? "approval"
            )}`
        );

  return [
    "# Kairon Agent Handoff",
    "",
    `Date: ${handoff.date}`,
    `Agent: ${handoff.agent}`,
    `Daily report: ${handoff.daily_report_path}`,
    "",
    "## Runs",
    "",
    ...runLines,
    "",
    "## Pending Approvals",
    "",
    ...approvalLines,
    "",
    "## Scratch",
    "",
    "```text",
    handoff.scratch.trimEnd(),
    "```",
    ""
  ].join("\n");
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    await access(filePath);
    return readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readOptionalJson(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    await access(filePath);
    return readJsonFile<Record<string, unknown>>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
