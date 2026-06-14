import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderBoardHtml } from "../src/board/html.js";
import { createBoardProjection, exportBoardProjection } from "../src/board/projection.js";
import { startBoardServer } from "../src/board/server.js";
import { exportBoard } from "../src/cli/commands/board.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { createTempProject } from "./test-utils.js";

describe("board projection", () => {
  it("exports a read-only sanitized board projection", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await seedBoardArtifacts(root);

    await new WorkQueue(root).enqueue({
      type: "agent.run",
      task_id: "TASK-0001",
      priority: 80,
      payload: {
        api_token: "SHOULD_NOT_LEAK",
        safe: "shown"
      }
    });

    const projection = await createBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      recentLimit: 5
    });

    expect(projection).toMatchObject({
      schema_version: "0.1",
      kind: "board_projection",
      generated_at: "2026-06-01T00:00:00.000Z",
      queue: {
        ready: 1
      },
      operations: {
        pending_approvals: 1,
        failed_runs: 1,
        setup_required_runs: 1,
        recovery_targets: 1,
        git_transactions_requiring_approval: 1,
        attention_total: 5
      },
      tasks: {
        total: 1,
        by_status: {
          ready: 1
        }
      },
      runs: {
        total: 3
      },
      approvals: {
        pending: 1
      },
      reviews: {
        loops_total: 1,
        results_total: 1
      },
      git: {
        transactions_total: 2,
        transactions_requiring_approval: 1
      },
      cleanup: {
        proposals_total: 1
      },
      maintenance: {
        daily_reports_total: 1,
        latest_daily_report: {
          date: "2026-06-01",
          failed_runs: 1
        }
      },
      discord: {
        gateway: {
          status: "ready"
        },
        notifications: {
          total: 2,
          by_status: {
            sent: 1,
            failed: 1
          }
        },
        decisions: {
          total: 1,
          by_status: {
            applied: 1
          },
          by_decision: {
            approve: 1
          }
        }
      }
    });
    expect(projection.queue.recent[0]).toMatchObject({
      id: "JOB-0001",
      type: "agent.run",
      task_id: "TASK-0001"
    });
    expect(projection.queue.recent[0]).not.toHaveProperty("payload");
    expect(projection.runs.recent[0]).toMatchObject({
      run_id: "RUN-0003",
      status: "setup_required"
    });
    expect(projection.runs.recent[2]).toMatchObject({
      run_id: "RUN-0001",
      outbox_status: "completed",
      outbox_event_count: 1
    });
    expect(projection.runs.recent[0]).not.toHaveProperty("stdout");
    expect(projection.approvals.recent[0]).toMatchObject({
      id: "APR-0001",
      status: "pending",
      title: "Deploy approval"
    });
    expect(projection.approvals.recent[0]).not.toHaveProperty("diff");
    expect(projection.discord.notifications.recent[0]).toMatchObject({
      approval_id: "APR-0001",
      status: "failed",
      message_id: "discord-message-2",
      board_anchor: "#approval-APR-0001",
      board_url: "http://127.0.0.1:8787/#approval-APR-0001",
      reason: "token=[redacted] failed"
    });
    expect(projection.discord.decisions.recent[0]).toMatchObject({
      approval_id: "APR-0001",
      decision: "approve",
      actor_hash: "abcdef1234567890",
      message_id: "discord-message-1",
      command_status: "completed",
      message_update_status: "updated",
      message_update_reason: "status message updated"
    });
    expect(projection.git.recent_transactions[0]).toMatchObject({
      transaction_id: "GTX-0002",
      status: "pushing"
    });
    expect(projection.git.recent_transactions[1]).toMatchObject({
      transaction_id: "GTX-0001",
      status: "approval_required",
      approval_id: "APR-0001"
    });
    expect(projection.operations.priority).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approval",
          id: "APR-0001",
          anchor: "#approval-APR-0001"
        }),
        expect.objectContaining({
          kind: "run",
          id: "RUN-0002",
          anchor: "#run-RUN-0002"
        }),
        expect.objectContaining({
          kind: "run",
          id: "RUN-0003",
          anchor: "#run-RUN-0003"
        }),
        expect.objectContaining({
          kind: "git_transaction",
          id: "GTX-0001",
          anchor: "#git-transaction-GTX-0001"
        }),
        expect.objectContaining({
          kind: "recovery",
          id: "recovery",
          anchor: "#recovery"
        })
      ])
    );

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("SHOULD_NOT_BE_EXPOSED");
    expect(serialized).not.toContain("FULL_DIFF_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("FULL_STDOUT_SHOULD_NOT_APPEAR");

    const result = await exportBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z")
    });
    expect(result.projection_path).toBe(".kairon/board/projection.json");
    await expect(
      readJsonFile(path.join(root, ".kairon", "board", "projection.json"))
    ).resolves.toMatchObject({
      kind: "board_projection",
      queue: {
        ready: 1
      }
    });
  });

  it("formats the CLI export result", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const output = await exportBoard(root, { recent: "3" });

    expect(output).toContain("Kairon board projection exported.");
    expect(output).toContain("projection=.kairon/board/projection.json");
    expect(output).toContain("operations.attention=0");
  });

  it("renders sanitized read-only board HTML with approval anchors", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await seedBoardArtifacts(root);

    const projection = await createBoardProjection(root, {
      now: () => new Date("2026-06-01T00:00:00.000Z")
    });
    const html = renderBoardHtml(projection);

    expect(html).toContain("<title>Kairon Board</title>");
    expect(html).toContain('href="#operations"');
    expect(html).toContain('id="operations"');
    expect(html).toContain('href="#runtime"');
    expect(html).toContain('id="runtime"');
    expect(html).toContain('id="recovery"');
    expect(html).toContain('id="maintenance"');
    expect(html).toContain('id="discord"');
    expect(html).toContain('id="approval-APR-0001"');
    expect(html).toContain('href="#approval-APR-0001"');
    expect(html).toContain('id="run-RUN-0002"');
    expect(html).toContain('href="#run-RUN-0002"');
    expect(html).toContain('id="review-loop-REV-0001"');
    expect(html).toContain('id="review-result-REV-RESULT-0001"');
    expect(html).toContain('id="git"');
    expect(html).toContain('id="git-transaction-GTX-0001"');
    expect(html).toContain("Operations");
    expect(html).toContain("Git Transactions");
    expect(html).toContain("Discord Summary");
    expect(html).toContain("Discord Decision Audit");
    expect(html).toContain("discord-message-1");
    expect(html).toContain("discord-message-2");
    expect(html).toContain("http://127.0.0.1:8787/#approval-APR-0001");
    expect(html).toContain("#approval-APR-0001");
    expect(html).toContain("status message updated");
    expect(html).toContain("failedRuns");
    expect(html).toContain("/projection.json");
    expect(html).not.toContain("FULL_DIFF_SHOULD_NOT_APPEAR");
    expect(html).not.toContain("FULL_STDOUT_SHOULD_NOT_APPEAR");
    expect(html).not.toContain("SHOULD_NOT_LEAK");
    expect(html).not.toContain("SHOULD_NOT_BE_EXPOSED");
  });

  it("serves the board on loopback only", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await seedBoardArtifacts(root);

    await expect(
      startBoardServer(root, { host: "0.0.0.0", port: 0 })
    ).rejects.toThrow("127.0.0.1");

    const server = await startBoardServer(root, {
      host: "localhost",
      port: 0,
      now: () => new Date("2026-06-01T00:00:00.000Z")
    });

    try {
      expect(server.board_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(server.projection_path).toBe(".kairon/board/projection.json");

      const htmlResponse = await fetch(server.board_url);
      expect(htmlResponse.status).toBe(200);
      expect(await htmlResponse.text()).toContain("Kairon Board");

      const projectionResponse = await fetch(`${server.board_url}projection.json`);
      expect(projectionResponse.status).toBe(200);
      expect(await projectionResponse.json()).toMatchObject({
        kind: "board_projection",
        generated_at: "2026-06-01T00:00:00.000Z"
      });
    } finally {
      await server.stop();
    }
  });
});

async function seedBoardArtifacts(root: string): Promise<void> {
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "tasks", "TASK-0001", "task.json"),
    {
      schema_version: "0.1",
      id: "TASK-0001",
      title: "Board smoke",
      status: "ready",
      version: 1,
      persona: "implementer",
      capabilities: ["coding"],
      tags: ["operation-test"],
      approval_required: false,
      code_producing: true,
      commit_requested: false,
      priority: 80,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:01:00.000Z"
    }
  );

  const runDir = path.join(root, ".kairon", "runs", "RUN-0001");
  await mkdir(runDir, { recursive: true });
  await writeJsonFileAtomic(path.join(runDir, "runner.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    agent: "codex",
    persona: "implementer",
    status: "completed",
    command: "codex",
    command_available: true,
    exit_code: 0,
    timed_out: false,
    stdout_log: ".kairon/runs/RUN-0001/stdout.log",
    stderr_log: ".kairon/runs/RUN-0001/stderr.log",
    created_at: "2026-06-01T00:02:00.000Z",
    finished_at: "2026-06-01T00:03:00.000Z"
  });
  await writeJsonFileAtomic(path.join(runDir, "outbox.json"), {
    schema_version: "0.1",
    run_id: "RUN-0001",
    task_id: "TASK-0001",
    status: "completed",
    events: [
      {
        type: "message.created",
        payload: {
          stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR"
        }
      }
    ]
  });

  const failedRunDir = path.join(root, ".kairon", "runs", "RUN-0002");
  await mkdir(failedRunDir, { recursive: true });
  await writeJsonFileAtomic(path.join(failedRunDir, "runner.json"), {
    schema_version: "0.1",
    run_id: "RUN-0002",
    task_id: "TASK-0001",
    agent: "claude",
    persona: "reviewer",
    status: "failed",
    command: "claude",
    command_available: true,
    exit_code: 1,
    timed_out: false,
    stdout_log: ".kairon/runs/RUN-0002/stdout.log",
    stderr_log: ".kairon/runs/RUN-0002/stderr.log",
    created_at: "2026-06-01T00:03:30.000Z",
    finished_at: "2026-06-01T00:03:40.000Z"
  });
  await writeJsonFileAtomic(path.join(failedRunDir, "outbox.json"), {
    schema_version: "0.1",
    run_id: "RUN-0002",
    task_id: "TASK-0001",
    status: "failed",
    events: [
      {
        type: "message.created",
        payload: {
          stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR"
        }
      }
    ]
  });

  const setupRunDir = path.join(root, ".kairon", "runs", "RUN-0003");
  await mkdir(setupRunDir, { recursive: true });
  await writeJsonFileAtomic(path.join(setupRunDir, "runner.json"), {
    schema_version: "0.1",
    run_id: "RUN-0003",
    task_id: "TASK-0001",
    agent: "gemini",
    persona: "researcher",
    status: "setup_required",
    command: "agy",
    command_available: true,
    exit_code: 1,
    timed_out: false,
    stdout_log: ".kairon/runs/RUN-0003/stdout.log",
    stderr_log: ".kairon/runs/RUN-0003/stderr.log",
    created_at: "2026-06-01T00:03:50.000Z",
    finished_at: "2026-06-01T00:04:10.000Z"
  });

  await writeJsonFileAtomic(path.join(root, ".kairon", "approvals", "APR-0001.json"), {
    schema_version: "0.1",
    id: "APR-0001",
    status: "pending",
    type: "deploy",
    title: "Deploy approval",
    actions: ["approve", "reject", "request_changes", "snooze"],
    api_token: "SHOULD_NOT_LEAK",
    diff: "FULL_DIFF_SHOULD_NOT_APPEAR",
    stdout: "FULL_STDOUT_SHOULD_NOT_APPEAR",
    created_at: "2026-06-01T00:04:00.000Z",
    updated_at: "2026-06-01T00:04:00.000Z"
  });

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "git", "transactions", "GTX-0001.json"),
    {
      schema_version: "0.1",
      transaction_id: "GTX-0001",
      task_id: "TASK-0001",
      run_id: "RUN-0001",
      review_loop_id: "REV-0001",
      branch: "auto/TASK-0001/codex",
      status: "approval_required",
      push: {
        requested: true,
        allowed: false,
        remote: "origin",
        remote_ref: "main",
        pushed: false,
        approval_id: "APR-0001",
        reason: "protected_branch_push requires approval"
      },
      transaction_path: ".kairon/git/transactions/GTX-0001.json",
      created_at: "2026-06-01T00:04:30.000Z",
      updated_at: "2026-06-01T00:04:30.000Z"
    }
  );
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "git", "transactions", "GTX-0002.json"),
    {
      schema_version: "0.1",
      transaction_id: "GTX-0002",
      task_id: "TASK-0001",
      run_id: "RUN-0002",
      review_loop_id: "REV-0001",
      branch: "auto/TASK-0001/claude",
      status: "pushing",
      push: {
        requested: true,
        allowed: true,
        remote: "origin",
        remote_ref: "auto/TASK-0001/claude",
        pushed: false
      },
      transaction_path: ".kairon/git/transactions/GTX-0002.json",
      created_at: "2026-06-01T00:04:40.000Z",
      updated_at: "2026-06-01T00:04:40.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "reviews", "loops", "REV-0001.json"),
    {
      schema_version: "0.1",
      loop_id: "REV-0001",
      task_id: "TASK-0001",
      status: "running",
      iteration: 1,
      max_iterations: 3,
      implementer: "codex",
      reviewers: ["claude"],
      code_producing: true,
      created_at: "2026-06-01T00:05:00.000Z",
      updated_at: "2026-06-01T00:05:00.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "reviews", "results", "REV-RESULT-0001.json"),
    {
      schema_version: "0.1",
      review_id: "REV-RESULT-0001",
      run_id: "RUN-0001",
      reviewer: "claude",
      status: "approved",
      score: 1,
      tests_passed: true,
      secret_scan_passed: true,
      findings: [{ severity: "low", body: "FULL_DIFF_SHOULD_NOT_APPEAR" }],
      created_at: "2026-06-01T00:06:00.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "cleanup", "proposals", "2026-06-01.json"),
    {
      schema_version: "0.1",
      date: "2026-06-01",
      proposal_path: ".kairon/cleanup/proposals/2026-06-01.json",
      direct_delete: false,
      candidates: [{ id: "CLEAN-001", path: "dist" }],
      created_at: "2026-06-01T00:07:00.000Z"
    }
  );

  await writeJsonFileAtomic(
    path.join(root, ".kairon", "runtime", "discord", "gateway.json"),
    {
      schema_version: "0.1",
      status: "ready",
      commands_registered: true,
      updated_at: "2026-06-01T00:08:00.000Z"
    }
  );
  await writeFile(
    path.join(root, ".kairon", "runtime", "discord", "approval-notifications.jsonl"),
    [
      JSON.stringify({
        schema_version: "0.1",
        approval_id: "APR-0001",
        status: "sent",
        message_id: "discord-message-1",
        board_url: "http://127.0.0.1:8787/#approval-APR-0001",
        board_anchor: "#approval-APR-0001",
        channel_id: "SHOULD_NOT_BE_EXPOSED",
        recorded_at: "2026-06-01T00:09:00.000Z"
      }),
      JSON.stringify({
        schema_version: "0.1",
        approval_id: "APR-0001",
        status: "failed",
        message_id: "discord-message-2",
        board_url: "http://127.0.0.1:8787/#approval-APR-0001",
        board_anchor: "#approval-APR-0001",
        reason: "token=SHOULD_NOT_LEAK failed",
        channel_id: "SHOULD_NOT_BE_EXPOSED",
        recorded_at: "2026-06-01T00:10:00.000Z"
      })
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(root, ".kairon", "runtime", "discord", "decision-interactions.jsonl"),
    `${JSON.stringify({
      schema_version: "0.1",
      approval_id: "APR-0001",
      decision: "approve",
      status: "applied",
      actor_hash: "abcdef1234567890",
      message_id: "discord-message-1",
      actor_id: "SHOULD_NOT_BE_EXPOSED",
      command_status: "completed",
      message_update_status: "updated",
      message_update_reason: "status message updated",
      recorded_at: "2026-06-01T00:11:00.000Z"
    })}\n`,
    "utf8"
  );
  await writeJsonFileAtomic(
    path.join(root, ".kairon", "reports", "daily", "2026-06-01.json"),
    {
      schema_version: "0.1",
      date: "2026-06-01",
      report_path: ".kairon/reports/daily/2026-06-01.json",
      summary: {
        completed_runs: 3,
        failed_runs: 1,
        setup_required_runs: 0,
        pending_approvals: 1,
        failed_notifications: 1
      },
      created_at: "2026-06-01T00:12:00.000Z"
    }
  );
}
