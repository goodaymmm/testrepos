import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { workflowRunCommand } from "../src/cli/commands/workflow.js";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  experimentalWorkflowArtifactPath,
  runWorkflowRuntimeCandidate,
  workflowRuntimeRecoveryArtifactPath,
  WorkflowRuntimeCandidateDisabledError
} from "../src/experimental/workflow-runtime.js";
import { WorkQueue } from "../src/queue/work-queue.js";
import { StateApplier } from "../src/state/state-applier.js";
import { TaskRunner } from "../src/tasks/task-runner.js";
import { createTempProject } from "./test-utils.js";

describe("workflow runtime production candidate", () => {
  it("rejects candidate flow when the feature flag is disabled", async () => {
    const root = await createTempProject();

    await expect(
      runWorkflowRuntimeCandidate(
        root,
        {
          candidate: true,
          workflowId: "EXP-WF-CANDIDATE-0001"
        },
        { env: {} }
      )
    ).rejects.toThrow(WorkflowRuntimeCandidateDisabledError);
    await expect(fileExists(experimentalWorkflowArtifactPath(root, "EXP-WF-CANDIDATE-0001"))).resolves.toBe(false);

    await expect(
      workflowRunCommand(
        root,
        {
          candidate: true,
          workflowId: "EXP-WF-CANDIDATE-0001"
        },
        {}
      )
    ).resolves.toContain("reason=feature_flag_disabled");
  });

  it("writes a candidate artifact from queue, task, and pending approval inputs without claiming work", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root, {
      now: () => new Date("2026-07-09T00:00:00.000Z")
    }).createTask({
      title: "T128 workflow candidate",
      persona: "researcher",
      approvalRequired: true,
      priority: 80
    });
    const queueItem = await new WorkQueue(root).enqueue({
      type: "agent.run",
      task_id: task.task_id,
      priority: 80,
      payload: {
        persona: "researcher"
      },
      created_at: "2026-07-09T00:01:00.000Z"
    });
    await new StateApplier(root).appendEvent({
      type: "approval.requested",
      actor: "workflow-candidate-test",
      payload: {
        approval: {
          id: "APR-WF-0001",
          type: "workflow_candidate",
          title: "Workflow candidate approval",
          actions: ["approve", "reject", "request_changes"]
        }
      },
      created_at: "2026-07-09T00:02:00.000Z"
    });

    const artifact = await runWorkflowRuntimeCandidate(
      root,
      {
        candidate: true,
        workflowId: "EXP-WF-CANDIDATE-0002",
        queueItemId: queueItem.id,
        approvalId: "APR-WF-0001",
        objective: "Check production candidate boundaries."
      },
      {
        env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "1" },
        now: () => new Date("2026-07-09T00:03:00.000Z")
      }
    );

    expect(artifact).toMatchObject({
      artifact_kind: "workflow_runtime_candidate",
      runtime: "kairon_workflow_runtime_candidate",
      candidate: true,
      dry_run: true,
      workflow_id: "EXP-WF-CANDIDATE-0002",
      status: "waiting_for_approval",
      task_id: task.task_id,
      queue_item_id: queueItem.id,
      approval_id: "APR-WF-0001",
      production_boundary: {
        flag_enabled: true,
        production_runtime_touched: false,
        queue_read: true,
        queue_claimed: false,
        queue_completed: false,
        approval_read: true,
        approval_created: false,
        task_read: true,
        task_runner_touched: false,
        state_applier_touched: false,
        artifact_path: ".kairon/experimental/workflows/EXP-WF-CANDIDATE-0002.json"
      }
    });
    expect(artifact.recommendation.ready_for_runtime_integration).toBe(false);
    expect(artifact.nodes.map((node) => node.id)).toEqual([
      "queue_intake",
      "task_placeholder",
      "approval_gate",
      "production_handoff"
    ]);
    expect(artifact.nodes.find((node) => node.id === "approval_gate")).toMatchObject({
      status: "waiting"
    });
    await expect(
      readJson(experimentalWorkflowArtifactPath(root, "EXP-WF-CANDIDATE-0002"))
    ).resolves.toMatchObject({
      status: "waiting_for_approval",
      queue_item_id: queueItem.id
    });
    await expect(new WorkQueue(root).list("ready")).resolves.toMatchObject([
      {
        id: queueItem.id,
        status: "ready",
        attempts: 0
      }
    ]);
    await expect(new ApprovalQueue(root).show("APR-WF-0001")).resolves.toMatchObject({
      id: "APR-WF-0001",
      status: "pending"
    });
  });

  it("marks the candidate ready after the referenced approval is approved", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await new StateApplier(root).appendEvent({
      type: "approval.requested",
      actor: "workflow-candidate-test",
      payload: {
        approval: {
          id: "APR-WF-0002",
          type: "workflow_candidate",
          title: "Workflow candidate approval",
          actions: ["approve", "reject", "request_changes"]
        }
      }
    });
    await new ApprovalQueue(root).decide({
      approvalId: "APR-WF-0002",
      action: "approve"
    });

    const text = await workflowRunCommand(
      root,
      {
        candidate: true,
        dryRun: true,
        workflowId: "EXP-WF-CANDIDATE-0003",
        approvalId: "APR-WF-0002"
      },
      { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "true" }
    );

    expect(text).toContain("Kairon workflow runtime candidate generated.");
    expect(text).toContain("status=candidate_ready");
    expect(text).toContain("approval_gate=completed");
    expect(text).toContain("ready_for_runtime_integration=true");
  });

  it("blocks the candidate when a requested queue item is missing", async () => {
    const root = await createTempProject();

    const artifact = await runWorkflowRuntimeCandidate(
      root,
      {
        candidate: true,
        workflowId: "EXP-WF-CANDIDATE-0004",
        queueItemId: "JOB-MISSING"
      },
      { env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "1" } }
    );

    expect(artifact.status).toBe("blocked");
    expect(artifact.recommendation.blockers).toEqual([
      "queue item not found: JOB-MISSING"
    ]);
    expect(artifact.nodes.find((node) => node.id === "queue_intake")).toMatchObject({
      status: "failed"
    });
  });

  it("connects an approved task to WorkQueue with execution and recovery metadata", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root, {
      now: () => new Date("2026-07-14T00:00:00.000Z")
    }).createTask({
      title: "T138 connected workflow candidate",
      persona: "researcher",
      approvalRequired: true,
      priority: 80
    });
    await new StateApplier(root).appendEvent({
      type: "approval.requested",
      actor: "workflow-connection-test",
      payload: {
        approval: {
          id: "APR-WF-0138",
          type: "workflow_candidate",
          title: "Connect workflow candidate",
          actions: ["approve", "reject"]
        }
      }
    });
    await new ApprovalQueue(root).decide({
      approvalId: "APR-WF-0138",
      action: "approve"
    });

    const artifact = await runWorkflowRuntimeCandidate(
      root,
      {
        candidate: true,
        dryRun: false,
        connectQueue: true,
        workflowId: "EXP-WF-CONNECT-0138",
        taskId: task.task_id,
        approvalId: "APR-WF-0138",
        resourceLocks: ["task:TASK-0138", "workspace:source"],
        retryMaxAttempts: 3,
        retryBackoffSeconds: 30
      },
      {
        env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "1" },
        now: () => new Date("2026-07-14T00:05:00.000Z")
      }
    );

    expect(artifact).toMatchObject({
      dry_run: false,
      status: "candidate_ready",
      queue_connection: {
        requested: true,
        status: "connected",
        queue_item_type: "agent.run"
      },
      execution_policy: {
        approval_gate: {
          required: true,
          approval_id: "APR-WF-0138",
          status: "decided"
        },
        resource_locks: {
          mode: "exclusive",
          keys: ["task:TASK-0138", "workspace:source"]
        },
        retry_policy: {
          max_attempts: 3,
          backoff_seconds: 30
        }
      },
      recovery: {
        required: true,
        written: true,
        rollback_strategy: "fail_queue_item_before_claim"
      },
      production_boundary: {
        queue_enqueued: true,
        queue_claimed: false,
        task_runner_touched: true
      }
    });
    await expect(new WorkQueue(root).list("ready")).resolves.toMatchObject([
      {
        id: artifact.queue_item_id,
        task_id: task.task_id,
        attempts: 0,
        metadata: {
          workflow_runtime: {
            workflow_id: "EXP-WF-CONNECT-0138",
            feature_flag: "KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME",
            retry_policy: { max_attempts: 3, backoff_seconds: 30 }
          }
        }
      }
    ]);
    await expect(
      readJson(workflowRuntimeRecoveryArtifactPath(root, "EXP-WF-CONNECT-0138"))
    ).resolves.toMatchObject({
      artifact_kind: "workflow_runtime_queue_recovery",
      queue_item_id: artifact.queue_item_id,
      status: "queued",
      rollback: {
        automatic: false,
        strategy: "fail_queue_item_before_claim"
      }
    });
  });

  it("keeps an approval-gated connection out of WorkQueue until approval", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const task = await new TaskRunner(root).createTask({
      title: "T138 pending workflow candidate",
      persona: "researcher",
      approvalRequired: true
    });
    await new StateApplier(root).appendEvent({
      type: "approval.requested",
      actor: "workflow-connection-test",
      payload: {
        approval: {
          id: "APR-WF-PENDING-0138",
          type: "workflow_candidate",
          title: "Pending workflow candidate",
          actions: ["approve", "reject"]
        }
      }
    });

    const artifact = await runWorkflowRuntimeCandidate(
      root,
      {
        candidate: true,
        connectQueue: true,
        workflowId: "EXP-WF-PENDING-0138",
        taskId: task.task_id,
        approvalId: "APR-WF-PENDING-0138"
      },
      { env: { KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME: "true" } }
    );

    expect(artifact).toMatchObject({
      status: "waiting_for_approval",
      queue_connection: {
        requested: true,
        status: "blocked",
        reason: "approval decision is required before queue connection"
      },
      recovery: { required: true, written: false }
    });
    await expect(new WorkQueue(root).list()).resolves.toEqual([]);
    await expect(
      fileExists(workflowRuntimeRecoveryArtifactPath(root, "EXP-WF-PENDING-0138"))
    ).resolves.toBe(false);
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}
