import { loadConfigFile } from "../core/config/load-config.js";
import type { DeployPolicy, PoliciesConfig } from "../git/workspace-manager.js";

export const defaultDeployPolicy: DeployPolicy = {
  allowed_providers: ["local-sandbox"],
  allowed_environments: ["local-sandbox", "staging"],
  production_providers: ["production-cloud"],
  production_providers_enabled: false,
  execution_timeout_ms: 30_000
};

export async function loadDeployPolicy(projectRoot: string): Promise<DeployPolicy> {
  const policies = await loadConfigFile<PoliciesConfig>(projectRoot, "policies.json");
  return {
    ...defaultDeployPolicy,
    ...(policies.deploy ?? {}),
    allowed_providers:
      policies.deploy?.allowed_providers ?? defaultDeployPolicy.allowed_providers,
    allowed_environments:
      policies.deploy?.allowed_environments ?? defaultDeployPolicy.allowed_environments,
    production_providers:
      policies.deploy?.production_providers ?? defaultDeployPolicy.production_providers
  };
}

export function validateDeployPolicySelection(
  policy: DeployPolicy,
  provider: string,
  environment: string
): string[] {
  const errors: string[] = [];
  if (!policy.allowed_providers.includes(provider)) {
    errors.push(`provider ${provider} is not allowed`);
  }
  if (!policy.allowed_environments.includes(environment)) {
    errors.push(`environment ${environment} is not allowed`);
  }
  if (
    policy.production_providers.includes(provider) &&
    !policy.production_providers_enabled
  ) {
    errors.push(`production provider ${provider} is disabled`);
  }
  return errors;
}

export function assertDeployPolicySelection(
  policy: DeployPolicy,
  provider: string,
  environment: string
): void {
  const errors = validateDeployPolicySelection(policy, provider, environment);
  if (errors.length > 0) {
    throw new Error(`Deploy policy rejected candidate: ${errors.join("; ")}`);
  }
}
