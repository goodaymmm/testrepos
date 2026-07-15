import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approval-queue.js";
import {
  deployDryRunCommand,
  deployExecuteCommand,
  deployStatusCommand
} from "../src/cli/commands/deploy.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { readJsonFile, writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import { createDryRunApproval } from "../src/deploy/dry-run.js";
import {
  executeDeployProvider,
  formatDeployExecutionResult,
  type DeployExecutionArtifact
} from "../src/deploy/provider-execution.js";
import type {
  DeployProvider,
  DeployProviderOperation,
  DeployProviderPreparation,
  DeployProviderRequest,
  DeployProviderRollbackPlan
} from "../src/deploy/provider.js";
import { createTempProject } from "./test-utils.js";

describe("deploy provider execution", () => {
  it("completes a local sandbox lifecycle and writes sanitized execution artifacts", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await deployDryRunCommand(root, {
      target: "main",
      environment: "local-sandbox",
      provider: "local-sandbox",
      check: ["smoke:passed"]
    });
    await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "approve",
      reason: "local re-auth completed"
    });

    const options = {
      dryRunArtifact: "APR-0001",
      execute: true,
      provider: "local-sandbox",
      approvalId: "APR-0001",
      expectedHeadSha: "head-sha",
      actualHeadSha: "head-sha",
      requiredCheck: ["smoke"],
      confirm: "APR-0001"
    };
    const output = await deployExecuteCommand(root, options);
    const execution = await readJsonFile<DeployExecutionArtifact>(
      path.join(root, ".kairon", "deploy", "executions", "DEP-0001.json")
    );
    const rollback = await readJsonFile<Record<string, unknown>>(
      path.join(root, ".kairon", "deploy", "rollback-plans", "DEP-0001.json")
    );

    expect(output).toContain("status=completed");
    expect(output).toContain("execution_performed=true");
    expect(execution).toMatchObject({
      execution_id: "DEP-0001",
      dry_run_id: "APR-0001",
      provider: "local-sandbox",
      environment: "local-sandbox",
      status: "completed",
      attempts: 1,
      rollback_plan_path: ".kairon/deploy/rollback-plans/DEP-0001.json"
    });
    expect(execution).not.toHaveProperty("provider_response");
    expect(rollback).toMatchObject({
      artifact_kind: "deploy_rollback_plan",
      execution_id: "DEP-0001",
      provider: "local-sandbox"
    });

    const repeated = await deployExecuteCommand(root, options);
    expect(repeated).toContain("execution_performed=false");
    expect(repeated).toContain("idempotent=true");
    await expect(deployStatusCommand(root, "DEP-0001")).resolves.toContain(
      "status=completed"
    );
  });

  it("rejects execution when local re-authentication or exact confirmation is missing", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await deployDryRunCommand(root, {
      target: "main",
      environment: "local-sandbox",
      check: ["smoke:passed"]
    });
    await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "approve",
      actor: { source: "discord" }
    });

    const reauthRejected = await deployExecuteCommand(root, {
      dryRunArtifact: "APR-0001",
      execute: true,
      provider: "local-sandbox",
      approvalId: "APR-0001",
      confirm: "APR-0001",
      requiredCheck: ["smoke"]
    });
    expect(reauthRejected).toContain("status=rejected");
    expect(reauthRejected).toContain("check.local_reauthentication=failed");

    const secondRoot = await createTempProject();
    await initializeProject({ projectRoot: secondRoot });
    await deployDryRunCommand(secondRoot, {
      target: "main",
      environment: "local-sandbox",
      check: ["smoke:passed"]
    });
    await new ApprovalQueue(secondRoot).decide({
      approvalId: "APR-0001",
      action: "approve"
    });
    const confirmRejected = await deployExecuteCommand(secondRoot, {
      dryRunArtifact: "APR-0001",
      execute: true,
      provider: "local-sandbox",
      approvalId: "APR-0001",
      confirm: "APR-WRONG",
      requiredCheck: ["smoke"]
    });
    expect(confirmRejected).toContain("status=rejected");
    expect(confirmRejected).toContain("check.local_confirmation=failed");
  });

  it("rejects changed provider binding and input digest before provider execution", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await deployDryRunCommand(root, {
      target: "main",
      environment: "local-sandbox",
      check: ["smoke:passed"]
    });
    await new ApprovalQueue(root).decide({
      approvalId: "APR-0001",
      action: "approve"
    });
    const artifactPath = path.join(
      root,
      ".kairon",
      "deploy",
      "dry-runs",
      "APR-0001.json"
    );
    const artifact = await readJsonFile<Record<string, unknown>>(artifactPath);
    await writeJsonFileAtomic(artifactPath, {
      ...artifact,
      input_digest: "sha256:changed"
    });

    const digestRejected = await deployExecuteCommand(root, {
      dryRunArtifact: "APR-0001",
      execute: true,
      provider: "local-sandbox",
      approvalId: "APR-0001",
      confirm: "APR-0001",
      requiredCheck: ["smoke"]
    });
    expect(digestRejected).toContain("check.deploy_input_digest=failed");
    await expect(
      readJsonFile(
        path.join(root, ".kairon", "deploy", "executions", "DEP-0001.json")
      )
    ).rejects.toThrow("ENOENT");
  });

  it("reconciles a timeout without calling provider execute twice", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await allowProvider(root, "recovering-sandbox");
    const dryRun = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "local-sandbox",
      provider: "recovering-sandbox",
      checks: [{ name: "smoke", status: "passed" }]
    });
    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve"
    });
    const provider = new RecoveringTimeoutProvider();
    const request = {
      dryRunArtifact: dryRun.approval_id,
      provider: provider.name,
      approvalId: dryRun.approval_id,
      confirm: dryRun.approval_id,
      requiredChecks: ["smoke"]
    };

    const first = await executeDeployProvider(root, request, {
      providers: new Map([[provider.name, provider]]),
      timeoutMs: 5
    });
    expect(first).toMatchObject({ status: "timed_out", execution_performed: true });

    const second = await executeDeployProvider(root, request, {
      providers: new Map([[provider.name, provider]]),
      timeoutMs: 5
    });
    expect(second).toMatchObject({
      status: "completed",
      execution_performed: false,
      idempotent: true
    });
    expect(provider.executeCalls).toBe(1);
  });

  it("redacts provider errors before writing artifacts or output", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    await allowProvider(root, "failing-sandbox");
    const dryRun = await createDryRunApproval(root, {
      operation: "deploy",
      targetBranch: "main",
      environment: "local-sandbox",
      provider: "failing-sandbox",
      checks: [{ name: "smoke", status: "passed" }]
    });
    await new ApprovalQueue(root).decide({
      approvalId: dryRun.approval_id,
      action: "approve"
    });
    const provider = new FailingProvider();
    const result = await executeDeployProvider(
      root,
      {
        dryRunArtifact: dryRun.approval_id,
        provider: provider.name,
        approvalId: dryRun.approval_id,
        confirm: dryRun.approval_id,
        requiredChecks: ["smoke"]
      },
      { providers: new Map([[provider.name, provider]]) }
    );
    const raw = JSON.stringify(result.execution);
    const output = formatDeployExecutionResult(result);

    expect(result.status).toBe("failed");
    expect(raw).toContain("token=[redacted]");
    expect(raw).not.toContain("T150_SHOULD_NOT_LEAK");
    expect(output).not.toContain("T150_SHOULD_NOT_LEAK");
  });
});

class RecoveringTimeoutProvider implements DeployProvider {
  readonly name = "recovering-sandbox";
  readonly production = false;
  executeCalls = 0;
  private statusCalls = 0;

  async prepare(request: DeployProviderRequest): Promise<DeployProviderPreparation> {
    return prepared(this.name, request);
  }

  async execute(
    _request: DeployProviderRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<DeployProviderOperation> {
    this.executeCalls += 1;
    return new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true
      });
    });
  }

  async getStatus(request: DeployProviderRequest): Promise<DeployProviderOperation> {
    this.statusCalls += 1;
    return operation(
      this.name,
      request,
      this.statusCalls === 1 ? "running" : "completed"
    );
  }

  async createRollbackPlan(
    request: DeployProviderRequest
  ): Promise<DeployProviderRollbackPlan> {
    return rollback(this.name, request);
  }
}

class FailingProvider implements DeployProvider {
  readonly name = "failing-sandbox";
  readonly production = false;

  async prepare(request: DeployProviderRequest): Promise<DeployProviderPreparation> {
    return prepared(this.name, request);
  }

  async execute(): Promise<DeployProviderOperation> {
    throw new Error("token=T150_SHOULD_NOT_LEAK provider failed");
  }

  async getStatus(request: DeployProviderRequest): Promise<DeployProviderOperation> {
    return operation(this.name, request, "failed");
  }

  async createRollbackPlan(
    request: DeployProviderRequest
  ): Promise<DeployProviderRollbackPlan> {
    return rollback(this.name, request);
  }
}

function prepared(
  provider: string,
  request: DeployProviderRequest
): DeployProviderPreparation {
  return {
    provider,
    operation_id: request.operationId,
    status: "prepared",
    prepared_at: new Date().toISOString()
  };
}

function operation(
  provider: string,
  request: DeployProviderRequest,
  status: DeployProviderOperation["status"]
): DeployProviderOperation {
  return {
    provider,
    operation_id: request.operationId,
    status,
    updated_at: new Date().toISOString()
  };
}

function rollback(
  provider: string,
  request: DeployProviderRequest
): DeployProviderRollbackPlan {
  return {
    provider,
    operation_id: request.operationId,
    strategy: "clear sandbox state",
    steps: ["Clear disposable sandbox state."],
    created_at: new Date().toISOString()
  };
}

async function allowProvider(root: string, provider: string): Promise<void> {
  const policyPath = path.join(root, ".kairon", "config", "policies.json");
  const policies = await readJsonFile<Record<string, unknown>>(policyPath);
  const deploy = policies.deploy as Record<string, unknown>;
  await writeJsonFileAtomic(policyPath, {
    ...policies,
    deploy: {
      ...deploy,
      allowed_providers: ["local-sandbox", provider]
    }
  });
}
