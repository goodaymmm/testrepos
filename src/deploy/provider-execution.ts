import { createHash } from "node:crypto";
import path from "node:path";
import { appendEvent } from "../core/events/event-log.js";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside, toPosixPath } from "../core/fs/paths.js";
import {
  withResourceLock,
  writeJsonFileFenced,
  type ResourceLockHandle
} from "../core/fs/resource-lock.js";
import {
  buildExecutionPreflight,
  loadExecutionDryRunArtifact,
  type ExecutionGuardPreflight
} from "./execution-guard.js";
import { loadDeployPolicy } from "./policy.js";
import {
  resolveDeployProvider,
  type DeployProvider,
  type DeployProviderOperation,
  type DeployProviderRequest,
  type DeployProviderRollbackPlan
} from "./provider.js";
import { LocalSandboxDeployProvider } from "./providers/local-sandbox.js";

export type DeployExecutionStatus =
  | "rejected"
  | "prepared"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export type DeployExecutionArtifact = {
  schema_version: "0.1";
  artifact_kind: "deploy_execution";
  execution_id: string;
  dry_run_id: string;
  approval_id: string;
  provider: string;
  environment: string;
  target: string;
  input_digest: string;
  operation_id: string;
  status: Exclude<DeployExecutionStatus, "rejected">;
  attempts: number;
  preflight: {
    status: "passed";
    checks: Array<{ name: string; status: string }>;
  };
  rollback_plan_path?: string;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
  completed_at?: string;
};

export type DeployExecutionRequest = {
  dryRunArtifact: string;
  provider: string;
  approvalId?: string;
  confirm?: string;
  expectedHeadSha?: string;
  actualHeadSha?: string;
  requiredChecks?: string[];
};

export type DeployExecutionResult = {
  status: DeployExecutionStatus;
  execution_allowed: boolean;
  execution_performed: boolean;
  idempotent: boolean;
  preflight: ExecutionGuardPreflight;
  execution?: DeployExecutionArtifact;
  execution_path?: string;
  rollback_plan_path?: string;
};

export type DeployExecutionOptions = {
  providers?: ReadonlyMap<string, DeployProvider>;
  timeoutMs?: number;
};

export function createDefaultDeployProviders(): ReadonlyMap<string, DeployProvider> {
  const local = new LocalSandboxDeployProvider();
  return new Map([[local.name, local]]);
}

export async function executeDeployProvider(
  projectRoot: string,
  request: DeployExecutionRequest,
  options: DeployExecutionOptions = {}
): Promise<DeployExecutionResult> {
  const preflight = await buildExecutionPreflight(projectRoot, {
    operation: "deploy",
    dryRunArtifact: request.dryRunArtifact,
    mode: "execute",
    provider: request.provider,
    approvalId: request.approvalId,
    confirm: request.confirm,
    expectedHeadSha: request.expectedHeadSha,
    actualHeadSha: request.actualHeadSha,
    requiredChecks: request.requiredChecks
  });
  if (!preflight.execution_allowed) {
    return {
      status: "rejected",
      execution_allowed: false,
      execution_performed: false,
      idempotent: false,
      preflight
    };
  }

  const { artifact } = await loadExecutionDryRunArtifact(
    projectRoot,
    request.dryRunArtifact,
    "deploy"
  );
  const providerName = artifact.provider!;
  const environment = artifact.environment!;
  const inputDigest = artifact.input_digest!;
  const executionId = deployExecutionId(artifact.approval_id);
  const operationId = deployProviderOperationId(
    providerName,
    artifact.approval_id,
    inputDigest
  );
  const executionPath = deployExecutionPath(projectRoot, executionId);
  const provider = resolveDeployProvider(
    providerName,
    options.providers ?? createDefaultDeployProviders()
  );
  if (provider.production) {
    const policy = await loadDeployPolicy(projectRoot);
    if (!policy.production_providers_enabled) {
      throw new Error(`Production deploy provider is disabled: ${provider.name}`);
    }
  }
  const policy = await loadDeployPolicy(projectRoot);
  const timeoutMs = options.timeoutMs ?? policy.execution_timeout_ms;
  const providerRequest: DeployProviderRequest = {
    projectRoot,
    executionId,
    approvalId: artifact.approval_id,
    operationId,
    target: artifact.target_branch,
    environment,
    inputDigest
  };

  return withResourceLock(
    projectRoot,
    executionPath,
    { owner: "deploy-provider-execution", ttlMs: timeoutMs + 30_000 },
    async (lock) => {
      const existing = await readOptionalExecution(executionPath);
      if (existing !== null) {
        return reconcileExistingExecution({
          projectRoot,
          provider,
          providerRequest,
          executionPath,
          execution: existing,
          preflight,
          lock
        });
      }

      const createdAt = new Date().toISOString();
      await provider.prepare(providerRequest);
      let execution: DeployExecutionArtifact = {
        schema_version: "0.1",
        artifact_kind: "deploy_execution",
        execution_id: executionId,
        dry_run_id: artifact.approval_id,
        approval_id: artifact.approval_id,
        provider: providerName,
        environment,
        target: artifact.target_branch,
        input_digest: inputDigest,
        operation_id: operationId,
        status: "prepared",
        attempts: 1,
        preflight: {
          status: "passed",
          checks: preflight.checks.map((check) => ({
            name: check.name,
            status: check.status
          }))
        },
        created_at: createdAt,
        updated_at: createdAt
      };
      await writeJsonFileFenced(lock, executionPath, execution);

      try {
        const operation = await executeWithTimeout(
          provider,
          providerRequest,
          timeoutMs
        );
        execution = await applyProviderStatus({
          projectRoot,
          provider,
          providerRequest,
          execution,
          executionPath,
          lock,
          operation
        });
      } catch (error) {
        if (error instanceof DeployProviderTimeoutError) {
          const observed = await safeProviderStatus(provider, providerRequest);
          if (observed.status === "completed") {
            execution = await applyProviderStatus({
              projectRoot,
              provider,
              providerRequest,
              execution,
              executionPath,
              lock,
              operation: observed
            });
          } else {
            execution = {
              ...execution,
              status: "timed_out",
              error: {
                code: "provider_timeout",
                message: `Provider operation did not complete within ${timeoutMs} ms.`
              },
              updated_at: new Date().toISOString()
            };
            await writeJsonFileFenced(lock, executionPath, execution);
          }
        } else {
          const observed = await safeProviderStatus(provider, providerRequest);
          if (observed.status === "completed") {
            execution = await applyProviderStatus({
              projectRoot,
              provider,
              providerRequest,
              execution,
              executionPath,
              lock,
              operation: observed
            });
          } else {
            execution = {
              ...execution,
              status: "failed",
              error: {
                code: "provider_execution_failed",
                message: sanitizeError(error)
              },
              updated_at: new Date().toISOString()
            };
            await writeJsonFileFenced(lock, executionPath, execution);
          }
        }
      }

      await recordDeployExecutionEvent(projectRoot, execution);
      return executionResult(projectRoot, preflight, executionPath, execution, true, false);
    }
  );
}

export async function getDeployExecutionStatus(
  projectRoot: string,
  executionId: string,
  options: Pick<DeployExecutionOptions, "providers"> = {}
): Promise<DeployExecutionResult> {
  const executionPath = deployExecutionPath(projectRoot, executionId);
  return withResourceLock(
    projectRoot,
    executionPath,
    { owner: "deploy-provider-status", ttlMs: 30_000 },
    async (lock) => {
      const execution = await readJsonFile<DeployExecutionArtifact>(executionPath);
      const provider = resolveDeployProvider(
        execution.provider,
        options.providers ?? createDefaultDeployProviders()
      );
      const providerRequest = providerRequestFromExecution(projectRoot, execution);
      const observed = await safeProviderStatus(provider, providerRequest);
      const preflight = statusPreflight(execution);
      const updated = await applyProviderStatus({
        projectRoot,
        provider,
        providerRequest,
        execution,
        executionPath,
        lock,
        operation: observed
      });
      return executionResult(projectRoot, preflight, executionPath, updated, false, true);
    }
  );
}

export function formatDeployExecutionResult(result: DeployExecutionResult): string {
  const header =
    result.status === "rejected"
      ? "Kairon deploy provider execution rejected."
      : result.status === "completed"
        ? "Kairon deploy provider execution completed."
        : "Kairon deploy provider execution recorded.";
  return [
    header,
    `status=${result.status}`,
    `execution_allowed=${result.execution_allowed}`,
    `execution_performed=${result.execution_performed}`,
    `idempotent=${result.idempotent}`,
    `preflight.status=${result.preflight.status}`,
    ...(result.execution === undefined
      ? []
      : [
          `execution_id=${result.execution.execution_id}`,
          `dry_run_id=${result.execution.dry_run_id}`,
          `provider=${result.execution.provider}`,
          `environment=${result.execution.environment}`,
          `operation_id=${result.execution.operation_id}`,
          `attempts=${result.execution.attempts}`
        ]),
    ...(result.execution_path === undefined
      ? []
      : [`execution_artifact=${result.execution_path}`]),
    ...(result.rollback_plan_path === undefined
      ? []
      : [`rollback_plan=${result.rollback_plan_path}`]),
    ...result.preflight.checks.map(
      (check) => `check.${check.name}=${check.status} ${sanitizeText(check.detail)}`
    )
  ].join("\n");
}

async function reconcileExistingExecution(input: {
  projectRoot: string;
  provider: DeployProvider;
  providerRequest: DeployProviderRequest;
  executionPath: string;
  execution: DeployExecutionArtifact;
  preflight: ExecutionGuardPreflight;
  lock: ResourceLockHandle;
}): Promise<DeployExecutionResult> {
  if (input.execution.status === "completed") {
    return executionResult(
      input.projectRoot,
      input.preflight,
      input.executionPath,
      input.execution,
      false,
      true
    );
  }
  const observed = await safeProviderStatus(input.provider, input.providerRequest);
  const updated = await applyProviderStatus({ ...input, operation: observed });
  if (updated.status !== input.execution.status) {
    await recordDeployExecutionEvent(input.projectRoot, updated);
  }
  return executionResult(
    input.projectRoot,
    input.preflight,
    input.executionPath,
    updated,
    false,
    true
  );
}

async function applyProviderStatus(input: {
  projectRoot: string;
  provider: DeployProvider;
  providerRequest: DeployProviderRequest;
  executionPath: string;
  execution: DeployExecutionArtifact;
  lock: ResourceLockHandle;
  operation: DeployProviderOperation;
}): Promise<DeployExecutionArtifact> {
  const mapped = mapProviderStatus(input.operation.status, input.execution.status);
  let rollbackPlanPath = input.execution.rollback_plan_path;
  if (mapped === "completed" && rollbackPlanPath === undefined) {
    const plan = await input.provider.createRollbackPlan(input.providerRequest);
    rollbackPlanPath = await writeRollbackPlan(
      input.projectRoot,
      input.execution.execution_id,
      plan
    );
  }
  const now = new Date().toISOString();
  const updated: DeployExecutionArtifact = {
    ...input.execution,
    status: mapped,
    rollback_plan_path: rollbackPlanPath,
    error:
      mapped === "failed"
        ? {
            code: "provider_reported_failed",
            message: "Provider reported a failed operation."
          }
        : undefined,
    updated_at: now,
    completed_at: mapped === "completed" ? now : input.execution.completed_at
  };
  await writeJsonFileFenced(input.lock, input.executionPath, updated);
  return updated;
}

async function writeRollbackPlan(
  projectRoot: string,
  executionId: string,
  rawPlan: DeployProviderRollbackPlan
): Promise<string> {
  const rollbackPath = resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "deploy",
    "rollback-plans",
    `${executionId}.json`
  );
  const plan = {
    schema_version: "0.1",
    artifact_kind: "deploy_rollback_plan",
    execution_id: executionId,
    provider: rawPlan.provider,
    operation_id: rawPlan.operation_id,
    strategy: sanitizeText(rawPlan.strategy),
    steps: rawPlan.steps.map(sanitizeText),
    created_at: rawPlan.created_at
  };
  // The execution resource lock serializes rollback plan creation for this execution id.
  const syntheticLockPath = deployExecutionPath(projectRoot, executionId);
  await withResourceLock(
    projectRoot,
    rollbackPath,
    { owner: `deploy-rollback-${path.basename(syntheticLockPath)}` },
    async (lock) => writeJsonFileFenced(lock, rollbackPath, plan)
  );
  return toProjectPath(projectRoot, rollbackPath);
}

async function executeWithTimeout(
  provider: DeployProvider,
  request: DeployProviderRequest,
  timeoutMs: number
): Promise<DeployProviderOperation> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.execute(request, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DeployProviderTimeoutError(timeoutMs));
          controller.abort();
        }, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class DeployProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Deploy provider timed out after ${timeoutMs} ms.`);
    this.name = "DeployProviderTimeoutError";
  }
}

async function safeProviderStatus(
  provider: DeployProvider,
  request: DeployProviderRequest
): Promise<DeployProviderOperation> {
  try {
    return await provider.getStatus(request);
  } catch {
    return {
      provider: provider.name,
      operation_id: request.operationId,
      status: "unknown",
      updated_at: new Date().toISOString()
    };
  }
}

function mapProviderStatus(
  status: DeployProviderOperation["status"],
  current: DeployExecutionArtifact["status"]
): DeployExecutionArtifact["status"] {
  if (status === "completed" || status === "failed" || status === "running") {
    return status;
  }
  if (status === "prepared") {
    return "prepared";
  }
  return current === "timed_out" ? "timed_out" : current;
}

async function readOptionalExecution(
  executionPath: string
): Promise<DeployExecutionArtifact | null> {
  try {
    return await readJsonFile<DeployExecutionArtifact>(executionPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function providerRequestFromExecution(
  projectRoot: string,
  execution: DeployExecutionArtifact
): DeployProviderRequest {
  return {
    projectRoot,
    executionId: execution.execution_id,
    approvalId: execution.approval_id,
    operationId: execution.operation_id,
    target: execution.target,
    environment: execution.environment,
    inputDigest: execution.input_digest
  };
}

function executionResult(
  projectRoot: string,
  preflight: ExecutionGuardPreflight,
  executionPath: string,
  execution: DeployExecutionArtifact,
  executionPerformed: boolean,
  idempotent: boolean
): DeployExecutionResult {
  return {
    status: execution.status,
    execution_allowed: true,
    execution_performed: executionPerformed,
    idempotent,
    preflight,
    execution,
    execution_path: toProjectPath(projectRoot, executionPath),
    rollback_plan_path: execution.rollback_plan_path
  };
}

function statusPreflight(execution: DeployExecutionArtifact): ExecutionGuardPreflight {
  return {
    schema_version: "0.1",
    operation: "deploy",
    mode: "execute",
    status: "passed",
    execution_allowed: true,
    dry_run_artifact_path: `.kairon/deploy/dry-runs/${execution.dry_run_id}.json`,
    approval_id: execution.approval_id,
    target_branch: execution.target,
    environment: execution.environment,
    provider: execution.provider,
    input_digest: execution.input_digest,
    required_checks: [],
    rollback_plan: execution.rollback_plan_path ?? "pending",
    checks: execution.preflight.checks.map((check) => ({
      name: check.name,
      status:
        check.status === "passed" || check.status === "failed"
          ? check.status
          : "skipped",
      detail: "recorded execution preflight"
    })),
    next_action: "Inspect the provider operation and rollback plan."
  };
}

async function recordDeployExecutionEvent(
  projectRoot: string,
  execution: DeployExecutionArtifact
): Promise<void> {
  await appendEvent(projectRoot, {
    type:
      execution.status === "completed"
        ? "deploy.execution.completed"
        : execution.status === "timed_out"
          ? "deploy.execution.timed_out"
          : execution.status === "failed"
            ? "deploy.execution.failed"
            : "deploy.execution.updated",
    actor: "deploy-provider",
    payload: {
      execution_id: execution.execution_id,
      approval_id: execution.approval_id,
      provider: execution.provider,
      environment: execution.environment,
      operation_id: execution.operation_id,
      status: execution.status,
      attempts: execution.attempts
    }
  });
}

function deployExecutionId(approvalId: string): string {
  if (!/^APR-[A-Za-z0-9_-]+$/u.test(approvalId)) {
    throw new Error(`Invalid deploy approval id: ${approvalId}`);
  }
  return `DEP-${approvalId.slice(4)}`;
}

function deployProviderOperationId(
  provider: string,
  approvalId: string,
  inputDigest: string
): string {
  const digest = createHash("sha256")
    .update(`${provider}:${approvalId}:${inputDigest}`)
    .digest("hex")
    .slice(0, 20);
  return `DOP-${digest}`;
}

function deployExecutionPath(projectRoot: string, executionId: string): string {
  if (!/^DEP-[A-Za-z0-9_-]+$/u.test(executionId)) {
    throw new Error(`Invalid deploy execution id: ${executionId}`);
  }
  return resolveInside(
    getKaironPaths(projectRoot).kaironDir,
    "deploy",
    "executions",
    `${executionId}.json`
  );
}

function sanitizeError(error: unknown): string {
  return sanitizeText(String(error)).slice(0, 240);
}

function sanitizeText(value: string): string {
  return value
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]"
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}
