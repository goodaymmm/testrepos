import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { listCorrelations } from "../src/correlation/store.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  ensureCapabilityApproval,
  evaluateCapabilityPolicy,
  inspectCapabilityPolicyConfig,
  writeCapabilityDecision
} from "../src/policy/trust-policy.js";
import { createTempProject } from "./test-utils.js";

describe("capability trust policy", () => {
  it("allows supported read-only capabilities without approval", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const decision = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "reviewer",
      agent: "codex",
      requestedCapabilities: ["read", "review", "json.output"],
      now: new Date("2026-07-24T00:00:00.000Z")
    });

    expect(decision).toMatchObject({
      status: "allowed",
      requested: ["json.output", "read", "review"],
      effective: ["json.output", "read", "review"],
      denied: [],
      approval_required: [],
      policy_source: "config"
    });
  });

  it("denies unknown capabilities by default", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const decision = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "implementer",
      agent: "codex",
      requestedCapabilities: ["coding", "unknown.superpower"]
    });

    expect(decision).toMatchObject({
      status: "denied",
      denied: ["unknown.superpower"],
      effective: ["coding"],
      reasons: ["unknown_capability:unknown.superpower"]
    });
  });

  it("default-denies unknown and over-scoped connectors", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    const unknown = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "researcher",
      agent: "codex",
      requestedCapabilities: ["connector:missing:external_read"]
    });
    const overScoped = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0002",
      persona: "implementer",
      agent: "codex",
      requestedCapabilities: ["connector:native.mcp:external_write"]
    });

    expect(unknown).toMatchObject({
      status: "denied",
      denied: ["connector:missing:external_read"],
      reasons: ["unknown_connector:missing"]
    });
    expect(overScoped).toMatchObject({
      status: "denied",
      denied: ["connector:native.mcp:external_write"],
      reasons: ["connector_scope_denied:connector:native.mcp:external_write"]
    });
  });

  it("reports disabled configured connectors as setup_required", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const policiesPath = path.join(root, ".kairon", "config", "policies.json");
    const policies = await readJsonFile<{
      capability_policy: {
        connectors: Record<string, { enabled: boolean }>;
      };
    }>(policiesPath);
    const connector = policies.capability_policy.connectors["native.mcp"];
    if (connector === undefined) {
      throw new Error("Expected native.mcp connector policy.");
    }
    connector.enabled = false;
    await writeJsonFileAtomic(policiesPath, policies);

    const decision = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "researcher",
      agent: "codex",
      requestedCapabilities: ["native.mcp"]
    });

    expect(decision).toMatchObject({
      status: "setup_required",
      setup_required: ["connector:native.mcp:external_read"],
      reasons: ["connector_disabled:native.mcp"]
    });
  });

  it("requires and consumes an existing Approval Queue decision", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const initial = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "implementer",
      agent: "codex",
      requestedCapabilities: ["git.write"],
      now: new Date("2026-07-24T00:00:00.000Z")
    });
    const requested = await ensureCapabilityApproval(root, initial);

    expect(requested).toMatchObject({
      status: "approval_required",
      approval_required: ["git.write"],
      approval_id: "APR-0001"
    });

    await new ApprovalQueue(root, {
      now: () => new Date("2026-07-24T00:01:00.000Z")
    }).decide({
      approvalId: "APR-0001",
      action: "approve",
      reason: "approved for test"
    });

    const approved = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "implementer",
      agent: "codex",
      requestedCapabilities: ["git.write"],
      now: new Date("2026-07-24T00:02:00.000Z")
    });

    expect(approved).toMatchObject({
      status: "allowed",
      approved: ["git.write"],
      effective: ["git.write"],
      approval_id: "APR-0001"
    });
  });

  it("writes a sanitized per-run decision artifact", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const decision = await evaluateCapabilityPolicy(root, {
      taskId: "TASK-0001",
      persona: "reviewer",
      agent: "codex",
      requestedCapabilities: ["review"]
    });

    const relativePath = await writeCapabilityDecision(root, "RUN-0001", decision);
    const artifact = await readJsonFile<{
      correlation_id?: string;
    }>(path.join(root, relativePath));
    const raw = JSON.stringify(artifact);

    expect(relativePath).toBe(
      ".kairon/runs/RUN-0001/capability-decision.json"
    );
    expect(artifact.correlation_id).toBe("COR-000001");
    await expect(listCorrelations(root)).resolves.toEqual([
      expect.objectContaining({
        correlation_id: "COR-000001",
        members: [
          expect.objectContaining({
            kind: "capability_decision",
            id: "RUN-0001",
            artifact_path:
              ".kairon/runs/RUN-0001/capability-decision.json"
          })
        ]
      })
    ]);
    expect(raw).not.toMatch(/authorization|cookie|token|password/iu);
  });

  it("diagnoses explicit and compatibility policy configurations", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await expect(inspectCapabilityPolicyConfig(root)).resolves.toMatchObject({
      status: "ready"
    });

    const policiesPath = path.join(root, ".kairon", "config", "policies.json");
    const policies = await readJsonFile<Record<string, unknown>>(policiesPath);
    delete policies.capability_policy;
    await writeJsonFileAtomic(policiesPath, policies);

    await expect(inspectCapabilityPolicyConfig(root)).resolves.toMatchObject({
      status: "compatibility"
    });
  });
});
