import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "../core/fs/json-file.js";
import { resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  listQueueItems,
  selectReadyQueueItem,
  type QueueItem
} from "../queue/work-queue.js";
import {
  searchRagIndexData,
  type RagIndex,
  type RagSearchResult
} from "../rag/lexical-index.js";
import { rankHybridRagResults } from "../rag/hybrid-ranker.js";
import { resolveCurrentCommit } from "../readiness/evidence-manifest.js";
import { workflowCheckpointStateHash } from "../workflow/checkpoint-store.js";
import type { WorkflowRunArtifact } from "../workflow/types.js";
import {
  evaluateAbsolutePerformanceBudget,
  performanceBudgetFor,
  type PerformanceBudgetEvaluation
} from "./budget.js";

export type PerformanceStatus = "PASS" | "UNPASSED" | "UNKNOWN";
export type PerformanceScope = "local_runtime" | "network";
export type PerformanceProfile = "representative" | "full";

export type PerformanceScenarioId =
  | "queue.list.1k"
  | "queue.list.10k"
  | "queue.claim.1k"
  | "queue.claim.10k"
  | "state.integrity.1k"
  | "state.event_compaction.1k"
  | "workflow.checkpoint_replay.100"
  | "workflow.checkpoint_replay.1k"
  | "rag.lexical_query.1k"
  | "rag.lexical_query.10k"
  | "rag.vector_query.1k"
  | "rag.vector_query.10k"
  | "rag.hybrid_query.1k"
  | "rag.hybrid_query.10k"
  | "board.projection.1k"
  | "projects.supervisor_scan.10"
  | "projects.supervisor_scan.50";

export type PerformanceFixtureDescriptor = {
  seed: number;
  size: number;
  description: string;
};

export type PerformanceScenarioDefinition = {
  id: PerformanceScenarioId;
  subsystem: "queue" | "state" | "workflow" | "rag" | "board" | "projects";
  operation: string;
  scope: PerformanceScope;
  profiles: readonly PerformanceProfile[];
  fixture: PerformanceFixtureDescriptor;
  warmup_iterations: number;
  iterations: number;
};

export type PerformanceSample = {
  iteration: number;
  elapsed_ms: number;
  heap_delta_bytes: number;
};

export type PerformanceMetrics = {
  sample_count: number;
  retained_sample_count: number;
  outliers_removed: number;
  median_ms: number;
  p95_ms: number;
  max_heap_delta_bytes: number;
};

export type PerformanceMachineProfile = {
  platform: NodeJS.Platform;
  arch: string;
  cpu_model: string;
  logical_cpu_count: number;
  node_major: number;
};

export type PerformanceEnvironment = {
  runtime_version: string;
  machine: PerformanceMachineProfile;
  fingerprint: string;
};

export type PerformanceScenarioResult = {
  id: PerformanceScenarioId;
  subsystem: PerformanceScenarioDefinition["subsystem"];
  operation: string;
  scope: PerformanceScope;
  fixture: PerformanceFixtureDescriptor;
  warmup_iterations: number;
  iterations: number;
  samples: PerformanceSample[];
  metrics: PerformanceMetrics;
  budget: PerformanceBudgetEvaluation;
  status: PerformanceStatus;
};

export type PerformanceBenchmarkArtifact = {
  schema_version: "0.1";
  artifact_kind: "performance_benchmark_result";
  run_id: string;
  profile: PerformanceProfile;
  status: PerformanceStatus;
  source_commit: string;
  environment: PerformanceEnvironment;
  generated_at: string;
  scenarios: PerformanceScenarioResult[];
  summary: Record<PerformanceStatus, number> & { total: number };
};

export type PerformanceScenarioExecutor = (
  scenario: PerformanceScenarioDefinition
) => Promise<void> | void;

export type PerformanceRunnerDependencies = {
  clock?: () => bigint;
  memoryUsage?: () => number;
  now?: () => Date;
  environment?: PerformanceEnvironment;
  sourceCommit?: string;
  execute?: PerformanceScenarioExecutor;
};

export type RunPerformanceSuiteOptions = {
  profile?: PerformanceProfile;
  scenarioIds?: PerformanceScenarioId[];
  warmupIterations?: number;
  iterations?: number;
  output?: string;
};

export type RunPerformanceSuiteResult = {
  artifact: PerformanceBenchmarkArtifact;
  output_path: string;
};

const minimumIterations = 5;
const defaultSeed = 18_704;
const deterministicFixtureCache = new Map<
  PerformanceScenarioId,
  DeterministicRecord[]
>();

export const performanceScenarioCatalog: readonly PerformanceScenarioDefinition[] = [
  scenario("queue.list.1k", "queue", "list", 1_000, ["representative", "full"]),
  scenario("queue.list.10k", "queue", "list", 10_000, ["full"]),
  scenario("queue.claim.1k", "queue", "claim_candidate", 1_000, ["representative", "full"]),
  scenario("queue.claim.10k", "queue", "claim_candidate", 10_000, ["full"]),
  scenario("state.integrity.1k", "state", "integrity_scan", 1_000, ["representative", "full"]),
  scenario("state.event_compaction.1k", "state", "event_compaction_plan", 1_000, ["full"]),
  scenario("workflow.checkpoint_replay.100", "workflow", "checkpoint_replay", 100, ["representative", "full"]),
  scenario("workflow.checkpoint_replay.1k", "workflow", "checkpoint_replay", 1_000, ["full"]),
  scenario("rag.lexical_query.1k", "rag", "lexical_query", 1_000, ["representative", "full"]),
  scenario("rag.lexical_query.10k", "rag", "lexical_query", 10_000, ["full"]),
  scenario("rag.vector_query.1k", "rag", "vector_query", 1_000, ["full"]),
  scenario("rag.vector_query.10k", "rag", "vector_query", 10_000, ["full"]),
  scenario("rag.hybrid_query.1k", "rag", "hybrid_query", 1_000, ["representative", "full"]),
  scenario("rag.hybrid_query.10k", "rag", "hybrid_query", 10_000, ["full"]),
  scenario("board.projection.1k", "board", "projection", 1_000, ["representative", "full"]),
  scenario("projects.supervisor_scan.10", "projects", "supervisor_scan", 10, ["representative", "full"]),
  scenario("projects.supervisor_scan.50", "projects", "supervisor_scan", 50, ["full"])
] as const;

export async function runPerformanceSuite(
  projectRoot: string,
  options: RunPerformanceSuiteOptions = {},
  dependencies: PerformanceRunnerDependencies = {}
): Promise<RunPerformanceSuiteResult> {
  const profile = options.profile ?? "representative";
  const definitions = selectScenarios(profile, options.scenarioIds).map(
    (definition) => ({
      ...definition,
      warmup_iterations:
        options.warmupIterations ?? definition.warmup_iterations,
      iterations: options.iterations ?? definition.iterations
    })
  );
  if (definitions.length === 0) {
    throw new Error("No performance scenarios were selected.");
  }
  for (const definition of definitions) {
    assertIterationCounts(definition);
  }

  const now = dependencies.now ?? (() => new Date());
  const generatedAt = now();
  const sourceCommit =
    dependencies.sourceCommit ?? (await resolveCurrentCommit(projectRoot));
  const environment =
    dependencies.environment ?? collectPerformanceEnvironment();
  const execute = dependencies.execute ?? executeDeterministicScenario;
  const results: PerformanceScenarioResult[] = [];

  for (const definition of definitions) {
    results.push(
      await runPerformanceScenario(definition, execute, dependencies)
    );
  }

  const artifact: PerformanceBenchmarkArtifact = {
    schema_version: "0.1",
    artifact_kind: "performance_benchmark_result",
    run_id: performanceRunId(generatedAt),
    profile,
    status: combinePerformanceStatuses(results.map((result) => result.status)),
    source_commit: sourceCommit,
    environment,
    generated_at: generatedAt.toISOString(),
    scenarios: results,
    summary: summarizeStatuses(results.map((result) => result.status))
  };
  const outputPath =
    options.output ??
    `.kairon/performance/runs/${artifact.run_id}.json`;
  const absoluteOutput = resolveOutputPath(projectRoot, outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeJsonFileAtomic(absoluteOutput, artifact);
  return {
    artifact,
    output_path: toPosixPath(path.relative(projectRoot, absoluteOutput))
  };
}

export async function runPerformanceScenario(
  definition: PerformanceScenarioDefinition,
  execute: PerformanceScenarioExecutor,
  dependencies: Pick<
    PerformanceRunnerDependencies,
    "clock" | "memoryUsage"
  > = {}
): Promise<PerformanceScenarioResult> {
  assertIterationCounts(definition);
  const clock = dependencies.clock ?? (() => process.hrtime.bigint());
  const memoryUsage =
    dependencies.memoryUsage ?? (() => process.memoryUsage().heapUsed);

  for (let index = 0; index < definition.warmup_iterations; index += 1) {
    await execute(definition);
  }

  const samples: PerformanceSample[] = [];
  for (let index = 0; index < definition.iterations; index += 1) {
    const heapBefore = memoryUsage();
    const started = clock();
    await execute(definition);
    const finished = clock();
    const heapAfter = memoryUsage();
    samples.push({
      iteration: index + 1,
      elapsed_ms: roundMilliseconds(Number(finished - started) / 1_000_000),
      heap_delta_bytes: Math.max(0, heapAfter - heapBefore)
    });
  }

  const metrics = calculatePerformanceMetrics(samples);
  const budget = evaluateAbsolutePerformanceBudget(
    metrics,
    performanceBudgetFor(definition.id)
  );
  return {
    id: definition.id,
    subsystem: definition.subsystem,
    operation: definition.operation,
    scope: definition.scope,
    fixture: definition.fixture,
    warmup_iterations: definition.warmup_iterations,
    iterations: definition.iterations,
    samples,
    metrics,
    budget,
    status: budget.status
  };
}

export function calculatePerformanceMetrics(
  samples: readonly PerformanceSample[]
): PerformanceMetrics {
  if (samples.length < minimumIterations) {
    throw new Error(
      `Performance metrics require at least ${minimumIterations} samples.`
    );
  }
  const sorted = [...samples].sort(
    (left, right) => left.elapsed_ms - right.elapsed_ms
  );
  const retained =
    sorted.length >= 7 ? sorted.slice(1, sorted.length - 1) : sorted;
  const elapsed = retained.map((sample) => sample.elapsed_ms);
  return {
    sample_count: samples.length,
    retained_sample_count: retained.length,
    outliers_removed: samples.length - retained.length,
    median_ms: roundMilliseconds(percentile(elapsed, 0.5)),
    p95_ms: roundMilliseconds(percentile(elapsed, 0.95)),
    max_heap_delta_bytes: Math.max(
      0,
      ...retained.map((sample) => sample.heap_delta_bytes)
    )
  };
}

export function collectPerformanceEnvironment(): PerformanceEnvironment {
  const cpu = os.cpus()[0];
  const machine: PerformanceMachineProfile = {
    platform: process.platform,
    arch: process.arch,
    cpu_model: normalizeCpuModel(cpu?.model ?? "unknown"),
    logical_cpu_count: Math.max(1, os.cpus().length),
    node_major: Number(process.versions.node.split(".")[0])
  };
  return {
    runtime_version: process.versions.node,
    machine,
    fingerprint: performanceEnvironmentFingerprint(machine)
  };
}

export function performanceEnvironmentFingerprint(
  machine: PerformanceMachineProfile
): string {
  return createHash("sha256")
    .update(JSON.stringify(machine))
    .digest("hex")
    .slice(0, 24);
}

export async function readPerformanceBenchmark(
  projectRoot: string,
  artifactPath: string
): Promise<PerformanceBenchmarkArtifact> {
  const absolute = resolveOutputPath(projectRoot, artifactPath);
  return JSON.parse(
    await readFile(absolute, "utf8")
  ) as PerformanceBenchmarkArtifact;
}

export async function writePerformanceReport(
  projectRoot: string,
  content: string,
  outputPath: string
): Promise<string> {
  const absolute = resolveOutputPath(projectRoot, outputPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return toPosixPath(path.relative(projectRoot, absolute));
}

export function combinePerformanceStatuses(
  statuses: readonly PerformanceStatus[]
): PerformanceStatus {
  if (statuses.includes("UNPASSED")) {
    return "UNPASSED";
  }
  if (statuses.includes("UNKNOWN")) {
    return "UNKNOWN";
  }
  return "PASS";
}

function scenario(
  id: PerformanceScenarioId,
  subsystem: PerformanceScenarioDefinition["subsystem"],
  operation: string,
  size: number,
  profiles: readonly PerformanceProfile[]
): PerformanceScenarioDefinition {
  return {
    id,
    subsystem,
    operation,
    scope: "local_runtime",
    profiles,
    fixture: {
      seed: defaultSeed,
      size,
      description: `${subsystem}:${operation}:${size}`
    },
    warmup_iterations: 2,
    iterations: 7
  };
}

function selectScenarios(
  profile: PerformanceProfile,
  ids: PerformanceScenarioId[] | undefined
): PerformanceScenarioDefinition[] {
  if (ids !== undefined && ids.length > 0) {
    const requested = new Set(ids);
    const selected = performanceScenarioCatalog.filter((entry) =>
      requested.has(entry.id)
    );
    const unknown = ids.filter(
      (id) => !performanceScenarioCatalog.some((entry) => entry.id === id)
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown performance scenario: ${unknown.join(", ")}`);
    }
    return selected;
  }
  return performanceScenarioCatalog.filter((entry) =>
    entry.profiles.includes(profile)
  );
}

function assertIterationCounts(
  definition: Pick<
    PerformanceScenarioDefinition,
    "warmup_iterations" | "iterations"
  >
): void {
  if (
    !Number.isInteger(definition.warmup_iterations) ||
    definition.warmup_iterations < 0
  ) {
    throw new Error("Performance warmup iterations must be a non-negative integer.");
  }
  if (
    !Number.isInteger(definition.iterations) ||
    definition.iterations < minimumIterations
  ) {
    throw new Error(
      `Performance iterations must be an integer of at least ${minimumIterations}.`
    );
  }
}

async function executeDeterministicScenario(
  definition: PerformanceScenarioDefinition
): Promise<void> {
  const fixture =
    deterministicFixtureCache.get(definition.id) ??
    deterministicFixture(definition.fixture);
  deterministicFixtureCache.set(definition.id, fixture);
  switch (definition.subsystem) {
    case "queue":
      executeQueueKernel(fixture, definition.operation);
      return;
    case "state":
      executeStateKernel(fixture, definition.operation);
      return;
    case "workflow":
      executeWorkflowKernel(fixture);
      return;
    case "rag":
      await executeRagKernel(fixture, definition.operation);
      return;
    case "board":
      executeBoardKernel(fixture);
      return;
    case "projects":
      executeProjectKernel(fixture);
  }
}

type DeterministicRecord = {
  id: number;
  priority: number;
  score: number;
  status: "ready" | "completed";
  text: string;
  vector: readonly number[];
};

function deterministicFixture(
  descriptor: PerformanceFixtureDescriptor
): DeterministicRecord[] {
  let state = descriptor.seed >>> 0;
  return Array.from({ length: descriptor.size }, (_, index) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const score = state / 0xffff_ffff;
    return {
      id: index,
      priority: state % 100,
      score,
      status: index % 9 === 0 ? "completed" : "ready",
      text:
        index % 17 === 0
          ? `deterministic performance target ${index}`
          : `deterministic fixture record ${index}`,
      vector: [
        score,
        ((state >>> 8) & 0xff) / 255,
        ((state >>> 16) & 0xff) / 255,
        ((state >>> 24) & 0xff) / 255
      ]
    };
  });
}

function executeQueueKernel(
  records: readonly DeterministicRecord[],
  operation: string
): void {
  const items = records.map(toQueueItem);
  if (operation === "list") {
    listQueueItems(items, "ready");
    return;
  }
  selectReadyQueueItem(items);
}

function executeStateKernel(
  records: readonly DeterministicRecord[],
  operation: string
): void {
  if (operation === "integrity_scan") {
    const ids = new Set<number>();
    for (const record of records) {
      const parsed = JSON.parse(JSON.stringify({
        schema_version: "0.1",
        id: record.id,
        status: record.status
      })) as { id: number };
      ids.add(parsed.id);
    }
    if (ids.size !== records.length) {
      throw new Error("Deterministic state fixture is inconsistent.");
    }
    return;
  }
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(`${record.id}:${record.status}:${record.score}\n`);
  }
  hash.digest("hex");
}

function executeWorkflowKernel(records: readonly DeterministicRecord[]): void {
  const checkpoints = records.map((record) => {
    const artifact = toWorkflowArtifact(record);
    return {
      workflow_id: artifact.workflow_id,
      sequence: artifact.sequence,
      state_hash: workflowCheckpointStateHash(artifact)
    };
  });
  checkpoints
    .sort(
      (left, right) =>
        left.workflow_id.localeCompare(right.workflow_id) ||
        left.sequence - right.sequence
    )
    .reduce((digest, checkpoint) => {
      digest.update(JSON.stringify(checkpoint));
      return digest;
    }, createHash("sha256"))
    .digest("hex");
}

async function executeRagKernel(
  records: readonly DeterministicRecord[],
  operation: string
): Promise<void> {
  const index = toRagIndex(records);
  const query = [0.75, 0.5, 0.25, 0.125];
  const lexical = await searchRagIndexData(index, {
    query: "performance target",
    topK: 20
  });
  if (operation === "lexical_query") {
    return;
  }
  const vector = records
    .map((record) => ({
      record,
      score: cosineSimilarity(query, record.vector)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
  if (operation === "vector_query") {
    return;
  }
  rankHybridRagResults(
    lexical,
    vector.map(({ record, score }): RagSearchResult => ({
      chunk_id: `chunk-${record.id}`,
      source_id: `source-${record.id}`,
      source_type: "code_index",
      path: `fixtures/record-${record.id}.txt`,
      content_hash: createHash("sha256").update(record.text).digest("hex"),
      metadata: {
        collection: "code_index",
        source_type: "code_index"
      },
      score,
      text: record.text
    })),
    { topK: 10 }
  );
}

function executeBoardKernel(records: readonly DeterministicRecord[]): void {
  const byStatus = { ready: 0, completed: 0 };
  for (const record of records) {
    byStatus[record.status] += 1;
  }
  records
    .slice()
    .sort((left, right) => right.id - left.id)
    .slice(0, 50)
    .map((record) => ({
      id: `TASK-${record.id}`,
      status: record.status,
      priority: record.priority
    }));
  JSON.stringify({ summary: byStatus });
}

function executeProjectKernel(records: readonly DeterministicRecord[]): void {
  const roots = new Set<string>();
  const ports = new Map<number, number>();
  for (const record of records) {
    roots.add(`C:/kairon/performance/project-${record.id}`);
    const port = 18_000 + (record.id % 100);
    ports.set(port, (ports.get(port) ?? 0) + 1);
  }
  [...ports.entries()].filter(([, count]) => count > 1);
  if (roots.size !== records.length) {
    throw new Error("Deterministic project fixture contains duplicate roots.");
  }
}

function toQueueItem(record: DeterministicRecord): QueueItem {
  const createdAt = new Date(
    Date.UTC(2026, 0, 1, 0, 0, record.id % 60)
  ).toISOString();
  return {
    id: `JOB-${String(record.id).padStart(6, "0")}`,
    type: "maintenance.run",
    status: record.status,
    priority: record.priority,
    attempts: 0,
    created_at: createdAt,
    updated_at: createdAt
  };
}

function toWorkflowArtifact(record: DeterministicRecord): WorkflowRunArtifact {
  const timestamp = new Date(
    Date.UTC(2026, 0, 1, 0, 0, record.id % 60)
  ).toISOString();
  return {
    schema_version: "0.1",
    artifact_kind: "workflow_run",
    runtime: "kairon_workflow_runtime",
    workflow_id: `WF-${String(record.id).padStart(6, "0")}`,
    status: "completed",
    sequence: record.id + 1,
    objective: "deterministic performance checkpoint",
    task_id: `TASK-${String(record.id).padStart(6, "0")}`,
    resource_keys: [],
    retry_policy: { max_attempts: 1, backoff_seconds: 0 },
    nodes: [],
    edges: [],
    source: { kind: "new" },
    recovery: {
      last_action: "run",
      reconciled_queue_item_ids: []
    },
    created_at: timestamp,
    updated_at: timestamp
  };
}

function toRagIndex(records: readonly DeterministicRecord[]): RagIndex {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: "0.1",
    kind: "rag_lexical_index",
    created_at: timestamp,
    updated_at: timestamp,
    source_count: records.length,
    chunk_count: records.length,
    sources: records.map((record) => ({
      source_id: `source-${record.id}`,
      source_type: "code_index",
      path: `fixtures/record-${record.id}.txt`,
      content_hash: createHash("sha256").update(record.text).digest("hex"),
      bytes: Buffer.byteLength(record.text),
      updated_at: timestamp,
      first_indexed_at: timestamp,
      last_seen_at: timestamp,
      last_modified_at: timestamp,
      source_category: "code",
      metadata: {
        collection: "code_index",
        source_type: "code_index"
      }
    })),
    chunks: records.map((record) => ({
      chunk_id: `chunk-${record.id}`,
      source_id: `source-${record.id}`,
      source_type: "code_index",
      path: `fixtures/record-${record.id}.txt`,
      content_hash: createHash("sha256").update(record.text).digest("hex"),
      metadata: {
        collection: "code_index",
        source_type: "code_index"
      },
      text: record.text
    }))
  };
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[]
): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function percentile(values: readonly number[], quantile: number): number {
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
  );
  return values[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function normalizeCpuModel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 160) || "unknown";
}

function summarizeStatuses(
  statuses: readonly PerformanceStatus[]
): Record<PerformanceStatus, number> & { total: number } {
  return {
    PASS: statuses.filter((status) => status === "PASS").length,
    UNPASSED: statuses.filter((status) => status === "UNPASSED").length,
    UNKNOWN: statuses.filter((status) => status === "UNKNOWN").length,
    total: statuses.length
  };
}

function performanceRunId(now: Date): string {
  return `PERF-${now.toISOString().replace(/\D/gu, "").slice(0, 17)}`;
}

function resolveOutputPath(projectRoot: string, outputPath: string): string {
  return resolveInside(projectRoot, outputPath);
}
