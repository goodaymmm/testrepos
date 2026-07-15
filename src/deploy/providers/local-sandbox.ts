import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../../core/fs/paths.js";
import type {
  DeployProvider,
  DeployProviderOperation,
  DeployProviderPreparation,
  DeployProviderRequest,
  DeployProviderRollbackPlan
} from "../provider.js";

type LocalSandboxOperation = DeployProviderOperation & {
  schema_version: "0.1";
  artifact_kind: "local_sandbox_deploy_operation";
  execution_id: string;
  approval_id: string;
  target: string;
  environment: string;
  input_digest: string;
  previous_input_digest?: string;
  prepared_at: string;
  completed_at?: string;
};

type LocalSandboxEnvironment = {
  schema_version: "0.1";
  artifact_kind: "local_sandbox_environment";
  environment: string;
  target: string;
  input_digest: string;
  operation_id: string;
  updated_at: string;
};

export class LocalSandboxDeployProvider implements DeployProvider {
  readonly name = "local-sandbox";
  readonly production = false;

  async prepare(request: DeployProviderRequest): Promise<DeployProviderPreparation> {
    const existing = await readOptionalOperation(request);
    if (existing !== null) {
      return {
        provider: this.name,
        operation_id: existing.operation_id,
        status:
          existing.status === "completed"
            ? "completed"
            : existing.status === "running"
              ? "running"
              : "prepared",
        prepared_at: existing.prepared_at
      };
    }

    const preparedAt = new Date().toISOString();
    const previous = await readOptionalEnvironment(request);
    const operation: LocalSandboxOperation = {
      schema_version: "0.1",
      artifact_kind: "local_sandbox_deploy_operation",
      provider: this.name,
      execution_id: request.executionId,
      approval_id: request.approvalId,
      operation_id: request.operationId,
      target: request.target,
      environment: request.environment,
      input_digest: request.inputDigest,
      previous_input_digest: previous?.input_digest,
      status: "prepared",
      prepared_at: preparedAt,
      updated_at: preparedAt
    };
    await writeJsonFileAtomic(operationPath(request), operation);
    return {
      provider: this.name,
      operation_id: request.operationId,
      status: "prepared",
      prepared_at: preparedAt
    };
  }

  async execute(
    request: DeployProviderRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<DeployProviderOperation> {
    options.signal?.throwIfAborted();
    let operation = await requireOperation(request);
    if (operation.status === "completed") {
      return operation;
    }

    const runningAt = new Date().toISOString();
    operation = {
      ...operation,
      status: "running",
      updated_at: runningAt
    };
    await writeJsonFileAtomic(operationPath(request), operation);
    options.signal?.throwIfAborted();

    const completedAt = new Date().toISOString();
    const environment: LocalSandboxEnvironment = {
      schema_version: "0.1",
      artifact_kind: "local_sandbox_environment",
      environment: request.environment,
      target: request.target,
      input_digest: request.inputDigest,
      operation_id: request.operationId,
      updated_at: completedAt
    };
    await writeJsonFileAtomic(environmentPath(request), environment);
    operation = {
      ...operation,
      status: "completed",
      completed_at: completedAt,
      updated_at: completedAt,
      detail: "local sandbox state updated"
    };
    await writeJsonFileAtomic(operationPath(request), operation);
    return operation;
  }

  async getStatus(request: DeployProviderRequest): Promise<DeployProviderOperation> {
    const operation = await readOptionalOperation(request);
    return (
      operation ?? {
        provider: this.name,
        operation_id: request.operationId,
        status: "unknown",
        updated_at: new Date().toISOString(),
        detail: "operation artifact not found"
      }
    );
  }

  async createRollbackPlan(
    request: DeployProviderRequest
  ): Promise<DeployProviderRollbackPlan> {
    const operation = await requireOperation(request);
    const previous = operation.previous_input_digest;
    return {
      provider: this.name,
      operation_id: request.operationId,
      strategy: previous === undefined ? "clear_local_sandbox_state" : "restore_previous_digest",
      steps:
        previous === undefined
          ? [
              `Verify execution ${request.executionId}.`,
              `Remove the disposable local sandbox state for ${request.environment}.`
            ]
          : [
              `Verify execution ${request.executionId}.`,
              `Restore the previous local sandbox input digest ${previous}.`
            ],
      created_at: new Date().toISOString()
    };
  }
}

export function localSandboxOperationId(approvalId: string, inputDigest: string): string {
  const digest = createHash("sha256")
    .update(`${approvalId}:${inputDigest}`)
    .digest("hex")
    .slice(0, 20);
  return `LSD-${digest}`;
}

function operationPath(request: DeployProviderRequest): string {
  assertSafeArtifactId(request.operationId, "operation id");
  return resolveInside(
    getKaironPaths(request.projectRoot).kaironDir,
    "deploy",
    "providers",
    "local-sandbox",
    "operations",
    `${request.operationId}.json`
  );
}

function environmentPath(request: DeployProviderRequest): string {
  const digest = createHash("sha256").update(request.environment).digest("hex").slice(0, 20);
  return resolveInside(
    getKaironPaths(request.projectRoot).kaironDir,
    "deploy",
    "providers",
    "local-sandbox",
    "environments",
    `${digest}.json`
  );
}

async function readOptionalOperation(
  request: DeployProviderRequest
): Promise<LocalSandboxOperation | null> {
  try {
    return await readJsonFile<LocalSandboxOperation>(operationPath(request));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function requireOperation(request: DeployProviderRequest): Promise<LocalSandboxOperation> {
  const operation = await readOptionalOperation(request);
  if (operation === null) {
    throw new Error(`Local sandbox deploy operation is not prepared: ${request.operationId}`);
  }
  return operation;
}

async function readOptionalEnvironment(
  request: DeployProviderRequest
): Promise<LocalSandboxEnvironment | null> {
  try {
    return await readJsonFile<LocalSandboxEnvironment>(environmentPath(request));
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function assertSafeArtifactId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/u.test(value) || path.basename(value) !== value) {
    throw new Error(`Invalid local sandbox ${label}: ${value}`);
  }
}
