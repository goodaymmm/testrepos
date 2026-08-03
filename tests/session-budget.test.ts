import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSessionBudgetDispatchAllowed,
  confirmSessionCompaction,
  getSessionBudgetReport,
  planSessionCompaction,
  recordSessionPromptBudget,
  rotateSessionBudget,
  SessionBudgetDispatchBlockedError,
  type SessionRotationArtifact
} from "../src/agents/session-budget.js";
import {
  FileSessionHost,
  dispatcherStatusFor,
  sameDaySessionStatus,
  type SessionMetadata
} from "../src/agents/session-host.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createTempProject } from "./test-utils.js";

describe("agent session context budget", () => {
  it("records estimated and provider-observed prompt usage without conflating sources", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 1_000,
      hardPromptBytes: 2_000
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");

    const estimated = await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 100,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:01:00.000Z")
    });
    expect(estimated).toMatchObject({
      status: "within_limit",
      prompt_bytes: 100,
      job_count: 1,
      budget_source: "kairon_estimated"
    });

    const mixed = await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 999,
      providerPromptBytes: 125,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:02:00.000Z")
    });
    expect(mixed).toMatchObject({
      prompt_bytes: 225,
      job_count: 2,
      budget_source: "mixed"
    });
  });

  it("creates a soft-limit proposal and blocks the next dispatch after hard limit", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10,
      hardPromptBytes: 20
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");

    const soft = await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 12,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:01:00.000Z")
    });
    expect(soft.status).toBe("soft_limit");
    expect(soft.active_compaction_plan_id).toMatch(/^CMP-/);
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "sessions",
          "2026-07-23",
          "codex",
          "compactions",
          `${soft.active_compaction_plan_id}.json`
        )
      )
    ).resolves.toMatchObject({
      kind: "session_compaction_plan",
      trigger: "soft_limit",
      status: "planned"
    });

    const hard = await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 10,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:02:00.000Z")
    });
    expect(hard.status).toBe("hard_limit");
    await expect(
      assertSessionBudgetDispatchAllowed(
        root,
        "codex",
        "2026-07-23",
        new Date("2026-07-23T00:03:00.000Z")
      )
    ).rejects.toBeInstanceOf(SessionBudgetDispatchBlockedError);

    const metadata = await readSession(root, "codex");
    expect(
      dispatcherStatusFor(sameDaySessionStatus(metadata), metadata)
    ).toBe("unavailable");
  });

  it("compacts only allowlisted summary data with exact confirmation", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10_000,
      hardPromptBytes: 20_000,
      keepRuns: 2
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");
    await writeFile(
      path.join(
        root,
        ".kairon",
        "sessions",
        "2026-07-23",
        "codex",
        "scratch.md"
      ),
      "api_token=SHOULD_NOT_APPEAR\n",
      "utf8"
    );
    for (let index = 1; index <= 4; index += 1) {
      await host.recordSessionContext(
        "codex",
        "2026-07-23",
        runUpdate(index)
      );
    }
    await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 500,
      jobIncrement: 4,
      now: new Date("2026-07-23T00:05:00.000Z")
    });

    const plan = await planSessionCompaction(root, {
      agent: "codex",
      date: "2026-07-23",
      now: new Date("2026-07-23T00:06:00.000Z")
    });
    expect(plan).toMatchObject({
      status: "planned",
      keep_runs: 2,
      drop_run_count: 2
    });
    await expect(
      confirmSessionCompaction(root, {
        agent: "codex",
        date: "2026-07-23",
        planId: "CMP-invalid",
        now: new Date("2026-07-23T00:07:00.000Z")
      })
    ).rejects.toThrow("Invalid session compaction plan id");

    const completed = await confirmSessionCompaction(root, {
      agent: "codex",
      date: "2026-07-23",
      planId: plan.plan_id,
      now: new Date("2026-07-23T00:07:00.000Z")
    });
    expect(completed.status).toBe("completed");
    const manifest = await readJsonFile<{ runs: unknown[] }>(
      path.join(
        root,
        ".kairon",
        "sessions",
        "2026-07-23",
        "codex",
        "session_context_manifest.json"
      )
    );
    expect(manifest.runs).toHaveLength(2);
    const handoff = await readFile(
      path.join(
        root,
        ".kairon",
        "sessions",
        "2026-07-23",
        "codex",
        "active-handoff.md"
      ),
      "utf8"
    );
    expect(handoff).toContain("Reason: budget_compaction");
    expect(handoff).not.toContain("SHOULD_NOT_APPEAR");
    expect(handoff).not.toContain("api_token");

    const metadata = await readSession(root, "codex");
    expect(metadata).toMatchObject({
      job_count: 0,
      elapsed_seconds: 0,
      compaction_count: 1,
      active_compaction_plan_id: null
    });
  });

  it("rejects stale compaction plans after canonical session progress changes", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10_000,
      hardPromptBytes: 20_000
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");
    const plan = await planSessionCompaction(root, {
      agent: "codex",
      date: "2026-07-23",
      now: new Date("2026-07-23T00:01:00.000Z")
    });
    await host.recordSessionContext(
      "codex",
      "2026-07-23",
      runUpdate(9)
    );

    await expect(
      confirmSessionCompaction(root, {
        agent: "codex",
        date: "2026-07-23",
        planId: plan.plan_id,
        now: new Date("2026-07-23T00:02:00.000Z")
      })
    ).rejects.toThrow("stale");
    await expect(
      readJsonFile(
        path.join(
          root,
          ".kairon",
          "sessions",
          "2026-07-23",
          "codex",
          "compactions",
          `${plan.plan_id}.json`
        )
      )
    ).resolves.toMatchObject({ status: "rejected_stale" });
  });

  it("rotates an idle hard-limit session and preserves one canonical active session", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10,
      hardPromptBytes: 20
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");
    await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 25,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:01:00.000Z")
    });

    const rotation = await rotateSessionBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      reason: "hard limit reached",
      now: new Date("2026-07-23T00:02:00.000Z")
    });
    expect(rotation).toMatchObject({
      status: "completed",
      previous_session_id: "SESSION-2026-07-23-codex",
      new_session_id: "SESSION-2026-07-23-codex-R1"
    });
    const metadata = await readSession(root, "codex");
    expect(metadata).toMatchObject({
      session_id: "SESSION-2026-07-23-codex-R1",
      budget_status: "within_limit",
      prompt_bytes: 0,
      job_count: 0,
      compaction_count: 0,
      rotation_count: 1
    });
    await expect(
      getSessionBudgetReport(
        root,
        "codex",
        "2026-07-23",
        new Date("2026-07-23T00:03:00.000Z")
      )
    ).resolves.toMatchObject({ dispatch_allowed: true });
  });

  it("recovers an interrupted compaction after its process is gone", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10,
      hardPromptBytes: 20
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    await host.openSession("codex", "2026-07-23");
    await recordSessionPromptBudget(root, {
      agent: "codex",
      date: "2026-07-23",
      promptBytes: 15,
      jobIncrement: 1,
      now: new Date("2026-07-23T00:01:00.000Z")
    });
    const plan = await planSessionCompaction(root, {
      agent: "codex",
      date: "2026-07-23",
      now: new Date("2026-07-23T00:02:00.000Z")
    });
    const session = await readSession(root, "codex");
    const planPath = path.join(
      root,
      ".kairon",
      "sessions",
      "2026-07-23",
      "codex",
      "compactions",
      `${plan.plan_id}.json`
    );
    await writeJsonFileAtomic(planPath, {
      ...plan,
      status: "compacting",
      operation_pid: 2_147_483_647
    });
    await writeJsonFileAtomic(
      path.join(
        root,
        ".kairon",
        "sessions",
        "2026-07-23",
        "codex",
        "session.json"
      ),
      {
        ...session,
        budget_status: "compacting",
        active_compaction_plan_id: plan.plan_id
      }
    );

    const recovered = await host.openSession("codex", "2026-07-23");
    expect(recovered.budget_status).toBe("soft_limit");
    expect(recovered.active_compaction_plan_id).toBeNull();
    await expect(readJsonFile(planPath)).resolves.toMatchObject({
      status: "failed",
      failure_reason: "compaction_process_interrupted"
    });
  });

  it("recovers an interrupted rotation with the old canonical session active", async () => {
    const root = await createProjectWithBudget({
      softPromptBytes: 10_000,
      hardPromptBytes: 20_000
    });
    const host = hostAt(root, "2026-07-23T00:00:00.000Z");
    const metadata = await host.openSession("codex", "2026-07-23");
    const rotationsDir = path.join(
      root,
      ".kairon",
      "sessions",
      "2026-07-23",
      "codex",
      "rotations"
    );
    await mkdir(rotationsDir, { recursive: true });
    const artifact = {
      schema_version: "0.1",
      kind: "session_rotation",
      rotation_id: "ROT-20260723T000100Z-0000000000",
      date: "2026-07-23",
      agent: "codex",
      status: "rotating",
      operator_reason: "fixture",
      previous_session_id: metadata.session_id,
      new_session_id: "SESSION-2026-07-23-codex-R1",
      previous_budget: {
        prompt_bytes: 0,
        job_count: 0,
        elapsed_seconds: 0,
        compaction_count: 0,
        budget_source: "unavailable"
      },
      handoff: {
        schema_version: "0.1",
        kind: "session_handoff_summary",
        reason: "budget_rotation",
        objective: null,
        unfinished_work: [],
        decisions: [],
        artifact_references: [],
        source_hash: "sha256:fixture",
        created_at: "2026-07-23T00:01:00.000Z"
      },
      handoff_json_path: ".kairon/fixture.json",
      handoff_markdown_path: ".kairon/fixture.md",
      created_at: "2026-07-23T00:01:00.000Z",
      updated_at: "2026-07-23T00:01:00.000Z"
    } satisfies SessionRotationArtifact;
    await writeJsonFileAtomic(
      path.join(rotationsDir, `${artifact.rotation_id}.json`),
      artifact
    );
    await writeJsonFileAtomic(
      path.join(
        root,
        ".kairon",
        "sessions",
        "2026-07-23",
        "codex",
        "session.json"
      ),
      { ...metadata, budget_status: "rotating" }
    );

    const recovered = await host.openSession("codex", "2026-07-23");
    expect(recovered.session_id).toBe("SESSION-2026-07-23-codex");
    expect(recovered.budget_status).not.toBe("rotating");
    await expect(
      readJsonFile(path.join(rotationsDir, `${artifact.rotation_id}.json`))
    ).resolves.toMatchObject({ status: "recovered_old_active" });
  });
});

async function createProjectWithBudget(options: {
  softPromptBytes: number;
  hardPromptBytes: number;
  keepRuns?: number;
}): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  const configPath = path.join(root, ".kairon", "config", "agents.json");
  const config = await readJsonFile<Record<string, unknown>>(configPath);
  const sessionBudget = config.session_budget as Record<string, unknown>;
  await writeJsonFileAtomic(configPath, {
    ...config,
    session_budget: {
      ...sessionBudget,
      soft_limit: {
        prompt_bytes: options.softPromptBytes,
        job_count: 100,
        elapsed_seconds: 100_000,
        compaction_count: 10
      },
      hard_limit: {
        prompt_bytes: options.hardPromptBytes,
        job_count: 200,
        elapsed_seconds: 200_000,
        compaction_count: 20
      },
      compaction_keep_runs: options.keepRuns ?? 10
    }
  });
  return root;
}

function hostAt(root: string, value: string): FileSessionHost {
  return new FileSessionHost(root, {
    commandAvailability: async () => true,
    now: () => new Date(value)
  });
}

function runUpdate(index: number) {
  const id = String(index).padStart(4, "0");
  return {
    kind: "job" as const,
    run_id: `RUN-${id}`,
    task_id: `TASK-${id}`,
    persona: "implementer",
    context_path: `.kairon/runs/RUN-${id}/context.md`,
    prompt_path: `.kairon/runs/RUN-${id}/stdin.md`,
    outbox_path: `.kairon/runs/RUN-${id}/outbox.json`,
    runner_metadata_path: `.kairon/runs/RUN-${id}/runner.json`,
    status: "completed" as const,
    finished_at: `2026-07-23T00:${String(index).padStart(2, "0")}:00.000Z`
  };
}

async function readSession(
  root: string,
  agent: "codex"
): Promise<SessionMetadata> {
  return readJsonFile<SessionMetadata>(
    path.join(
      root,
      ".kairon",
      "sessions",
      "2026-07-23",
      agent,
      "session.json"
    )
  );
}
