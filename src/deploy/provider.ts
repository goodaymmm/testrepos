export type DeployProviderOperationStatus =
  | "prepared"
  | "running"
  | "completed"
  | "failed"
  | "unknown";

export type DeployProviderRequest = {
  projectRoot: string;
  executionId: string;
  approvalId: string;
  operationId: string;
  target: string;
  environment: string;
  inputDigest: string;
};

export type DeployProviderPreparation = {
  provider: string;
  operation_id: string;
  status: "prepared" | "running" | "completed";
  prepared_at: string;
};

export type DeployProviderOperation = {
  provider: string;
  operation_id: string;
  status: DeployProviderOperationStatus;
  updated_at: string;
  detail?: string;
};

export type DeployProviderRollbackPlan = {
  provider: string;
  operation_id: string;
  strategy: string;
  steps: string[];
  created_at: string;
};

export interface DeployProvider {
  readonly name: string;
  readonly production: boolean;
  prepare(request: DeployProviderRequest): Promise<DeployProviderPreparation>;
  execute(
    request: DeployProviderRequest,
    options?: { signal?: AbortSignal }
  ): Promise<DeployProviderOperation>;
  getStatus(request: DeployProviderRequest): Promise<DeployProviderOperation>;
  createRollbackPlan(
    request: DeployProviderRequest
  ): Promise<DeployProviderRollbackPlan>;
}

export class DeployProviderNotFoundError extends Error {
  constructor(readonly provider: string) {
    super(`Deploy provider is not registered: ${provider}`);
    this.name = "DeployProviderNotFoundError";
  }
}

export function resolveDeployProvider(
  providerName: string,
  providers: ReadonlyMap<string, DeployProvider>
): DeployProvider {
  const provider = providers.get(providerName);
  if (provider === undefined) {
    throw new DeployProviderNotFoundError(providerName);
  }
  return provider;
}
