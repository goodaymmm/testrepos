import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/cli/commands/init.js";
import {
  correlationArtifactPath,
  correlationAuditPath,
  ensureApprovalCorrelation,
  ensureWorkflowCorrelation,
  inspectCorrelationIntegrity,
  listCorrelations,
  trackCorrelationMember
} from "../src/correlation/store.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { readJsonLines } from "../src/core/fs/jsonl-file.js";
import {
  acquireResourceLock,
  releaseResourceLock
} from "../src/core/fs/resource-lock.js";
import { createTempProject } from "./test-utils.js";

describe("correlation store", () => {
  it("lazily links a legacy approval without persisting secrets", async () => {
    const root = await createInitializedProject();
    const approvalPath = path.join(root, ".kairon", "approvals", "APR-T155-LEGACY.json");
    await writeJsonFileAtomic(approvalPath, {
      schema_version: "0.1",
      id: "APR-T155-LEGACY",
      status: "pending",
      api_token: "must-not-leak",
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z"
    });

    const correlation = await ensureApprovalCorrelation(
      root,
      await readJsonFile(approvalPath),
      { now: new Date("2026-07-16T00:00:00.000Z"), migrated: true }
    );
    const approval = await readJsonFile<Record<string, unknown>>(approvalPath);
    const artifactText = await readFile(
      correlationArtifactPath(root, correlation.correlation_id),
      "utf8"
    );
    const auditText = await readFile(correlationAuditPath(root), "utf8");

    expect(correlation.correlation_id).toBe("COR-000001");
    expect(approval.correlation_id).toBe(correlation.correlation_id);
    expect(correlation.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "approval",
          id: "APR-T155-LEGACY",
          status: "pending",
          artifact_path: ".kairon/approvals/APR-T155-LEGACY.json"
        })
      ])
    );
    expect(correlation.timeline.at(-1)?.action).toBe("migrated");
    expect(artifactText).not.toContain("must-not-leak");
    expect(auditText).not.toContain("must-not-leak");
  });

  it("tracks approval, Discord, follow-up, and workflow under one id", async () => {
    const root = await createInitializedProject();
    const approvalPath = path.join(root, ".kairon", "approvals", "APR-T155-FLOW.json");
    const followUpPath = path.join(root, ".kairon", "follow-ups", "FUP-T155.json");
    const workflowPath = path.join(root, ".kairon", "workflows", "production", "WF-T155.json");
    await writeJsonFileAtomic(approvalPath, {
      id: "APR-T155-FLOW",
      status: "pending",
      created_at: "2026-07-16T01:00:00.000Z"
    });
    await writeJsonFileAtomic(followUpPath, { id: "FUP-T155" });
    await writeJsonFileAtomic(workflowPath, { workflow_id: "WF-T155" });
    const correlation = await ensureApprovalCorrelation(
      root,
      await readJsonFile(approvalPath)
    );

    await Promise.all([
      trackCorrelationMember(root, {
        correlationId: correlation.correlation_id,
        approvalId: "APR-T155-FLOW",
        kind: "discord_message",
        id: "111111111111111111",
        status: "sent",
        artifactPath: ".kairon/approvals/APR-T155-FLOW.json"
      }),
      trackCorrelationMember(root, {
        correlationId: correlation.correlation_id,
        approvalId: "APR-T155-FLOW",
        kind: "follow_up",
        id: "FUP-T155",
        status: "pending",
        artifactPath: ".kairon/follow-ups/FUP-T155.json"
      })
    ]);
    await trackCorrelationMember(root, {
      correlationId: correlation.correlation_id,
      approvalId: "APR-T155-FLOW",
      kind: "discord_message",
      id: "222222222222222222",
      replacesId: "111111111111111111",
      status: "sent",
      artifactPath: ".kairon/approvals/APR-T155-FLOW.json"
    });
    const workflow = await ensureWorkflowCorrelation(root, {
      workflowId: "WF-T155",
      approvalId: "APR-T155-FLOW",
      status: "completed",
      artifactPath: ".kairon/workflows/production/WF-T155.json"
    });
    const stored = await readJsonFile<typeof workflow>(
      correlationArtifactPath(root, correlation.correlation_id)
    );

    expect(workflow.correlation_id).toBe(correlation.correlation_id);
    expect(stored.status).toBe("completed");
    expect(stored.members.map((member) => `${member.kind}:${member.id}`)).toEqual(
      expect.arrayContaining([
        "approval:APR-T155-FLOW",
        "discord_message:222222222222222222",
        "follow_up:FUP-T155",
        "workflow:WF-T155"
      ])
    );
    expect(stored.members).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "111111111111111111" })
      ])
    );
  });

  it("retries a short cross-process correlation lock contention", async () => {
    const root = await createInitializedProject();
    const approvalPath = path.join(root, ".kairon", "approvals", "APR-RETRY.json");
    await writeJsonFileAtomic(approvalPath, {
      id: "APR-RETRY",
      status: "pending",
      created_at: "2026-08-04T00:00:00.000Z"
    });
    const correlation = await ensureApprovalCorrelation(
      root,
      await readJsonFile(approvalPath)
    );
    const artifactPath = correlationArtifactPath(root, correlation.correlation_id);
    const lock = await acquireResourceLock(root, artifactPath, {
      owner: "competing-process"
    });
    const update = trackCorrelationMember(root, {
      correlationId: correlation.correlation_id,
      approvalId: "APR-RETRY",
      kind: "discord_message",
      id: "retry-message",
      status: "sent",
      artifactPath: ".kairon/approvals/APR-RETRY.json"
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    await releaseResourceLock(lock);

    await expect(update).resolves.toMatchObject({
      correlation_id: correlation.correlation_id,
      members: expect.arrayContaining([
        expect.objectContaining({ kind: "discord_message", id: "retry-message" })
      ])
    });
  });

  it("detects missing artifacts, stale messages, and orphan follow-ups", async () => {
    const root = await createInitializedProject();
    const approvalPath = path.join(root, ".kairon", "approvals", "APR-T155-DONE.json");
    await writeJsonFileAtomic(approvalPath, {
      id: "APR-T155-DONE",
      status: "decided",
      created_at: "2026-07-16T02:00:00.000Z"
    });
    const approvalCorrelation = await ensureApprovalCorrelation(
      root,
      await readJsonFile(approvalPath)
    );
    await trackCorrelationMember(root, {
      correlationId: approvalCorrelation.correlation_id,
      kind: "discord_message",
      id: "333333333333333333",
      status: "sent",
      artifactPath: ".kairon/approvals/APR-T155-DONE.json"
    });
    await trackCorrelationMember(root, {
      kind: "workflow",
      id: "WF-T155-MISSING",
      status: "failed",
      artifactPath: ".kairon/workflows/runs/WF-T155-MISSING.json"
    });
    await trackCorrelationMember(root, {
      kind: "follow_up",
      id: "FUP-T155-ORPHAN",
      status: "pending"
    });

    const integrity = await inspectCorrelationIntegrity(root);
    expect(integrity).toMatchObject({
      total: 3,
      missing_artifacts: 1,
      stale_messages: 1,
      orphan_follow_ups: 1
    });
    expect((await listCorrelations(root)).length).toBe(3);
  });
});

async function createInitializedProject(): Promise<string> {
  const root = await createTempProject();
  await initializeProject({ projectRoot: root });
  await mkdir(path.join(root, ".kairon", "follow-ups"), {
    recursive: true
  });
  return root;
}
