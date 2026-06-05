import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import { readJsonLines } from "../core/fs/jsonl-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  isRagEnabled,
  searchRagIndex,
  type RagSearchResult
} from "../rag/lexical-index.js";
import type { AgentId } from "./types.js";

export type RunContextRequest = {
  runId: string;
  taskId: string;
  agent: AgentId;
  persona: string;
  date: string;
  extraSources?: string[];
};

export type DailyBootstrapRequest = {
  agent: AgentId;
  date: string;
};

export type ContextSource = {
  type:
    | "task"
    | "messages"
    | "rule"
    | "scratch"
    | "daily_report"
    | "handoff"
    | "extra"
    | "rag";
  path: string;
  sha256: string;
  bytes: number;
};

export type ContextBundle = {
  schema_version: string;
  kind: "run" | "daily_bootstrap";
  run_id?: string;
  task_id?: string;
  agent: AgentId;
  persona?: string;
  date: string;
  context_path: string;
  manifest_path: string;
  sources: ContextSource[];
  rag_results?: RagSearchResult[];
  created_at: string;
};

type SourceDraft = {
  type: ContextSource["type"];
  absolutePath: string;
  content: string;
};

export type ContextBuilderOptions = {
  rag?: {
    enabled?: boolean;
    topK?: number;
  };
};

const agentRuleFiles: Record<AgentId, string[]> = {
  codex: ["AGENTS.md", path.join(".kairon", "rules", "codex", "AGENTS.md")],
  claude: ["CLAUDE.md", path.join(".kairon", "rules", "claude", "CLAUDE.md")],
  gemini: ["GEMINI.md", path.join(".kairon", "rules", "gemini", "GEMINI.md")]
};

export class ContextBuilder {
  constructor(
    private readonly projectRoot: string,
    private readonly options: ContextBuilderOptions = {}
  ) {}

  async buildRunContext(request: RunContextRequest): Promise<ContextBundle> {
    const paths = getKaironPaths(this.projectRoot);
    const runDir = resolveInside(paths.runsDir, request.runId);
    await mkdir(runDir, { recursive: true });

    const collectedSources = await this.collectRunSources(request);
    const ragResults = await this.retrieveRagSources(request, collectedSources);
    const sources =
      ragResults.length === 0
        ? collectedSources
        : [...collectedSources, createRagSource(paths.root, ragResults)];
    const contextPath = resolveInside(runDir, "context.md");
    const manifestPath = resolveInside(runDir, "context_manifest.json");
    const bundle = createBundle({
      kind: "run",
      runId: request.runId,
      taskId: request.taskId,
      agent: request.agent,
      persona: request.persona,
      date: request.date,
      contextPath,
      manifestPath,
      sources,
      ragResults,
      projectRoot: paths.root
    });

    await writeContextFiles(bundle, sources, {
      contextPath,
      manifestPath,
      projectRoot: paths.root
    });
    return bundle;
  }

  async buildDailyBootstrap(
    request: DailyBootstrapRequest
  ): Promise<ContextBundle> {
    const paths = getKaironPaths(this.projectRoot);
    const sessionDir = resolveInside(paths.sessionsDir, request.date, request.agent);
    await mkdir(sessionDir, { recursive: true });

    const sources = await this.collectBaseSources(request.agent, request.date);
    const contextPath = resolveInside(sessionDir, "bootstrap.md");
    const manifestPath = resolveInside(sessionDir, "context_manifest.json");
    const bundle = createBundle({
      kind: "daily_bootstrap",
      agent: request.agent,
      date: request.date,
      contextPath,
      manifestPath,
      sources,
      projectRoot: paths.root
    });

    await writeContextFiles(bundle, sources, {
      contextPath,
      manifestPath,
      projectRoot: paths.root
    });
    return bundle;
  }

  private async collectRunSources(
    request: RunContextRequest
  ): Promise<SourceDraft[]> {
    const paths = getKaironPaths(this.projectRoot);
    const sources: SourceDraft[] = [];
    const taskPath = resolveInside(paths.tasksDir, request.taskId, "task.json");
    const messagesPath = resolveInside(paths.messagesDir, `${request.taskId}.jsonl`);

    const task = await readOptionalJson(taskPath);
    if (task !== null) {
      sources.push({
        type: "task",
        absolutePath: taskPath,
        content: `${JSON.stringify(task, null, 2)}\n`
      });
    }

    const messages = await readOptionalJsonLines(messagesPath);
    if (messages !== null) {
      sources.push({
        type: "messages",
        absolutePath: messagesPath,
        content: messages.map((message) => JSON.stringify(message)).join("\n") + "\n"
      });
    }

    sources.push(...(await this.collectBaseSources(request.agent, request.date)));

    for (const extraSource of request.extraSources ?? []) {
      const absolutePath = resolveInside(paths.root, extraSource);
      const content = await readOptionalText(absolutePath);
      if (content !== null) {
        sources.push({ type: "extra", absolutePath, content });
      }
    }

    return sources;
  }

  private async collectBaseSources(
    agent: AgentId,
    date: string
  ): Promise<SourceDraft[]> {
    const paths = getKaironPaths(this.projectRoot);
    const rulePaths = [
      path.join(".kairon", "rules", "common.md"),
      ...agentRuleFiles[agent]
    ];
    const sources: SourceDraft[] = [];

    for (const rulePath of rulePaths) {
      const absolutePath = resolveInside(paths.root, rulePath);
      const content = await readOptionalText(absolutePath);
      if (content !== null) {
        sources.push({ type: "rule", absolutePath, content });
      }
    }

    const scratchPath = resolveInside(paths.sessionsDir, date, agent, "scratch.md");
    const scratch = await readOptionalText(scratchPath);
    if (scratch !== null) {
      sources.push({ type: "scratch", absolutePath: scratchPath, content: scratch });
    }

    sources.push(...(await this.collectPreviousDaySources(agent, date)));

    return sources;
  }

  private async collectPreviousDaySources(
    agent: AgentId,
    date: string
  ): Promise<SourceDraft[]> {
    const paths = getKaironPaths(this.projectRoot);
    const previousDate = previousDateKey(date);
    const dailyReportPath = resolveInside(
      paths.reportsDir,
      "daily",
      `${previousDate}.json`
    );
    const handoffPath = resolveInside(
      paths.sessionsDir,
      previousDate,
      agent,
      "handoff.md"
    );
    const sources: SourceDraft[] = [];
    const dailyReport = await readOptionalText(dailyReportPath);
    if (dailyReport !== null) {
      sources.push({
        type: "daily_report",
        absolutePath: dailyReportPath,
        content: dailyReport
      });
    }

    const handoff = await readOptionalText(handoffPath);
    if (handoff !== null) {
      sources.push({ type: "handoff", absolutePath: handoffPath, content: handoff });
    }

    return sources;
  }

  private async retrieveRagSources(
    request: RunContextRequest,
    sources: SourceDraft[]
  ): Promise<RagSearchResult[]> {
    const enabled =
      this.options.rag?.enabled ?? (await isRagEnabled(this.projectRoot));
    if (!enabled) {
      return [];
    }

    const topK = this.options.rag?.topK ?? 5;
    const existingSourcePaths = new Set(
      sources.map((source) => relativeToProject(this.projectRoot, source.absolutePath))
    );
    const results = await searchRagIndex(this.projectRoot, {
      query: buildRagQuery(request, sources),
      topK: topK * 3
    });

    return results
      .filter((result) => !existingSourcePaths.has(result.path))
      .slice(0, topK);
  }
}

function createBundle(input: {
  kind: ContextBundle["kind"];
  runId?: string;
  taskId?: string;
  agent: AgentId;
  persona?: string;
  date: string;
  contextPath: string;
  manifestPath: string;
  sources: SourceDraft[];
  projectRoot: string;
  ragResults?: RagSearchResult[];
}): ContextBundle {
  return {
    schema_version: "0.1",
    kind: input.kind,
    run_id: input.runId,
    task_id: input.taskId,
    agent: input.agent,
    persona: input.persona,
    date: input.date,
    context_path: relativeToProject(input.projectRoot, input.contextPath),
    manifest_path: relativeToProject(input.projectRoot, input.manifestPath),
    sources: input.sources.map((source) => ({
      type: source.type,
      path: relativeToProject(input.projectRoot, source.absolutePath),
      sha256: sha256(source.content),
      bytes: Buffer.byteLength(source.content, "utf8")
    })),
    rag_results: input.ragResults,
    created_at: new Date().toISOString()
  };
}

async function writeContextFiles(
  bundle: ContextBundle,
  sources: SourceDraft[],
  paths: { contextPath: string; manifestPath: string; projectRoot: string }
): Promise<void> {
  const content = [
    "# Kairon Context Bundle",
    "",
    `Kind: ${bundle.kind}`,
    bundle.run_id === undefined ? null : `Run: ${bundle.run_id}`,
    bundle.task_id === undefined ? null : `Task: ${bundle.task_id}`,
    `Agent: ${bundle.agent}`,
    bundle.persona === undefined ? null : `Persona: ${bundle.persona}`,
    `Date: ${bundle.date}`,
    "",
    ...sources.flatMap((source) => [
      `## Source: ${source.type} ${relativeToProject(paths.projectRoot, source.absolutePath)}`,
      "",
      "```text",
      source.content.trimEnd(),
      "```",
      ""
    ])
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  await writeFile(paths.contextPath, `${content}\n`, "utf8");
  await writeJsonFileAtomic(paths.manifestPath, bundle);
}

function createRagSource(
  projectRoot: string,
  results: RagSearchResult[]
): SourceDraft {
  return {
    type: "rag",
    absolutePath: resolveInside(projectRoot, ".kairon", "rag", "index.json"),
    content: formatRagResults(results).join("\n")
  };
}

function buildRagQuery(
  request: RunContextRequest,
  sources: SourceDraft[]
): string {
  return [
    request.taskId,
    request.persona,
    ...sources
      .filter((source) =>
        ["task", "messages", "extra", "handoff"].includes(source.type)
      )
      .map((source) => source.content)
  ]
    .join("\n")
    .slice(0, 5_000);
}

function formatRagResults(results: RagSearchResult[] | undefined): string[] {
  if (results === undefined || results.length === 0) {
    return [];
  }

  return [
    "# Kairon RAG Retrieval",
    "",
    ...results.flatMap((result, index) => [
      `## Result ${index + 1}`,
      `source_id=${result.source_id}`,
      `path=${result.path}`,
      `source_type=${result.source_type}`,
      `hash=${result.content_hash}`,
      `score=${result.score}`,
      "",
      result.text.trimEnd(),
      ""
    ])
  ];
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
    return readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    await access(filePath);
    return readJsonFile<unknown>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readOptionalJsonLines(filePath: string): Promise<unknown[] | null> {
  try {
    await access(filePath);
    return readJsonLines<unknown>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function relativeToProject(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

function previousDateKey(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }

  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}
