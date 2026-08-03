import { loadConfigFile } from "../core/config/load-config.js";

export const workflowRuntimeEnvName = "KAIRON_WORKFLOW_RUNTIME";

export type WorkflowRuntimeConfig = {
  enabled: boolean;
  mode: "production";
  checkpoint_store: "file" | "file+sqlite";
  checkpoint_sqlite_path: string;
  checkpoint_sqlite_busy_timeout_ms: number;
  resource_lock_ttl_seconds: number;
  checkpoint_on_transition: boolean;
  retry: {
    max_attempts: number;
    backoff_seconds: number;
  };
};

export type WorkflowRuntimeEnablementSource =
  | "config"
  | "environment"
  | "default";

export type WorkflowRuntimeConfigResolution = {
  config: WorkflowRuntimeConfig;
  effective_enabled: boolean;
  effective_source: WorkflowRuntimeEnablementSource;
  environment_name: string;
  environment_value?: boolean;
  explicit_enabled: boolean;
  legacy_enabled_env: boolean;
  conflict: boolean;
  warnings: string[];
};

type RuntimeConfigFile = {
  schema_version?: string;
  workflow?: Partial<WorkflowRuntimeConfig> & {
    enabled_env?: string;
    retry?: Partial<WorkflowRuntimeConfig["retry"]>;
  };
};

export const defaultWorkflowRuntimeConfig: WorkflowRuntimeConfig = {
  enabled: false,
  mode: "production",
  checkpoint_store: "file",
  checkpoint_sqlite_path: ".kairon/workflows/checkpoints.sqlite",
  checkpoint_sqlite_busy_timeout_ms: 5_000,
  resource_lock_ttl_seconds: 86_400,
  checkpoint_on_transition: true,
  retry: {
    max_attempts: 3,
    backoff_seconds: 30
  }
};

export async function resolveWorkflowRuntimeConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<WorkflowRuntimeConfigResolution> {
  const runtime = await loadConfigFile<RuntimeConfigFile>(
    projectRoot,
    "runtime.json"
  );
  return resolveWorkflowRuntimeConfigValue(runtime, env);
}

export function resolveWorkflowRuntimeConfigValue(
  runtime: RuntimeConfigFile,
  env: NodeJS.ProcessEnv = process.env
): WorkflowRuntimeConfigResolution {
  const workflow = runtime.workflow ?? {};
  const explicitEnabled = typeof workflow.enabled === "boolean";
  const environmentName =
    readNonEmptyString(workflow.enabled_env) ?? workflowRuntimeEnvName;
  const environmentValue = parseBooleanEnvironmentValue(env[environmentName]);
  const config = normalizeWorkflowRuntimeConfig(workflow);
  const effectiveEnabled = explicitEnabled
    ? config.enabled
    : environmentValue ?? false;
  const effectiveSource: WorkflowRuntimeEnablementSource = explicitEnabled
    ? "config"
    : environmentValue === undefined
      ? "default"
      : "environment";
  const conflict =
    explicitEnabled &&
    environmentValue !== undefined &&
    environmentValue !== config.enabled;
  const warnings: string[] = [];

  if (!explicitEnabled && workflow.enabled_env !== undefined) {
    warnings.push(
      `legacy workflow enabled_env fallback is active; create a workflow config proposal`
    );
  }
  if (effectiveSource === "environment") {
    warnings.push(
      `workflow runtime enablement is using environment fallback ${environmentName}`
    );
  }
  if (conflict) {
    warnings.push(
      `workflow config enabled=${String(config.enabled)} overrides ${environmentName}=${String(environmentValue)}`
    );
  }

  return {
    config,
    effective_enabled: effectiveEnabled,
    effective_source: effectiveSource,
    environment_name: environmentName,
    environment_value: environmentValue,
    explicit_enabled: explicitEnabled,
    legacy_enabled_env: workflow.enabled_env !== undefined,
    conflict,
    warnings
  };
}

export function normalizeWorkflowRuntimeConfig(
  workflow:
    | (Partial<WorkflowRuntimeConfig> & {
        retry?: Partial<WorkflowRuntimeConfig["retry"]>;
      })
    | undefined,
  enabled = workflow?.enabled ?? false
): WorkflowRuntimeConfig {
  return {
    enabled,
    mode: workflow?.mode ?? defaultWorkflowRuntimeConfig.mode,
    checkpoint_store:
      workflow?.checkpoint_store ?? defaultWorkflowRuntimeConfig.checkpoint_store,
    checkpoint_sqlite_path:
      readNonEmptyString(workflow?.checkpoint_sqlite_path) ??
      defaultWorkflowRuntimeConfig.checkpoint_sqlite_path,
    checkpoint_sqlite_busy_timeout_ms:
      workflow?.checkpoint_sqlite_busy_timeout_ms ??
      defaultWorkflowRuntimeConfig.checkpoint_sqlite_busy_timeout_ms,
    resource_lock_ttl_seconds:
      workflow?.resource_lock_ttl_seconds ??
      defaultWorkflowRuntimeConfig.resource_lock_ttl_seconds,
    checkpoint_on_transition:
      workflow?.checkpoint_on_transition ??
      defaultWorkflowRuntimeConfig.checkpoint_on_transition,
    retry: {
      max_attempts:
        workflow?.retry?.max_attempts ??
        defaultWorkflowRuntimeConfig.retry.max_attempts,
      backoff_seconds:
        workflow?.retry?.backoff_seconds ??
        defaultWorkflowRuntimeConfig.retry.backoff_seconds
    }
  };
}

export function isWorkflowRuntimeEnabledFromEnvironment(
  env: NodeJS.ProcessEnv,
  environmentName = workflowRuntimeEnvName
): boolean {
  return parseBooleanEnvironmentValue(env[environmentName]) === true;
}

function parseBooleanEnvironmentValue(
  value: string | undefined
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
