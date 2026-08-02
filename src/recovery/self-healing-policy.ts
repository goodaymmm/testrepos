import { loadConfigFile } from "../core/config/load-config.js";

export const selfHealingRunbookIds = [
  "workflow_checkpoint_index_rebuild",
  "rag_index_verified_rebuild",
  "discord_notification_retry",
  "stale_runtime_lock_recovery_plan",
  "read_only_helper_health_plan"
] as const;

export type SelfHealingRunbookId = (typeof selfHealingRunbookIds)[number];
export type SelfHealingMode = "notify_only" | "bounded_auto";
export type SelfHealingRisk = "low" | "medium" | "high" | "critical";

export type SelfHealingActionPolicy = {
  enabled: boolean;
  max_attempts: number;
  cooldown_seconds: number;
  time_budget_seconds: number;
};

export type SelfHealingPolicy = {
  mode: SelfHealingMode;
  approval_threshold: SelfHealingRisk;
  actions: Record<SelfHealingRunbookId, SelfHealingActionPolicy>;
};

export type SelfHealingRuntimeConfig = {
  self_healing?: {
    mode?: SelfHealingMode;
    approval_threshold?: SelfHealingRisk;
    actions?: Partial<
      Record<
        SelfHealingRunbookId,
        Partial<SelfHealingActionPolicy>
      >
    >;
  };
};

export const defaultSelfHealingPolicy: SelfHealingPolicy = {
  mode: "notify_only",
  approval_threshold: "medium",
  actions: {
    workflow_checkpoint_index_rebuild: {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 86_400,
      time_budget_seconds: 120
    },
    rag_index_verified_rebuild: {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 86_400,
      time_budget_seconds: 180
    },
    discord_notification_retry: {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 300,
      time_budget_seconds: 30
    },
    stale_runtime_lock_recovery_plan: {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 3_600,
      time_budget_seconds: 30
    },
    read_only_helper_health_plan: {
      enabled: true,
      max_attempts: 1,
      cooldown_seconds: 3_600,
      time_budget_seconds: 30
    }
  }
};

export async function resolveSelfHealingPolicy(
  projectRoot: string
): Promise<SelfHealingPolicy> {
  const runtime = await loadConfigFile<SelfHealingRuntimeConfig>(
    projectRoot,
    "runtime.json"
  );
  return prepareSelfHealingPolicy(runtime.self_healing);
}

export function prepareSelfHealingPolicy(
  input: SelfHealingRuntimeConfig["self_healing"]
): SelfHealingPolicy {
  return {
    mode: input?.mode ?? defaultSelfHealingPolicy.mode,
    approval_threshold:
      input?.approval_threshold ?? defaultSelfHealingPolicy.approval_threshold,
    actions: Object.fromEntries(
      selfHealingRunbookIds.map((runbookId) => {
        const fallback = defaultSelfHealingPolicy.actions[runbookId];
        const configured = input?.actions?.[runbookId];
        return [
          runbookId,
          {
            enabled: configured?.enabled ?? fallback.enabled,
            max_attempts: configured?.max_attempts ?? fallback.max_attempts,
            cooldown_seconds:
              configured?.cooldown_seconds ?? fallback.cooldown_seconds,
            time_budget_seconds:
              configured?.time_budget_seconds ?? fallback.time_budget_seconds
          }
        ];
      })
    ) as Record<SelfHealingRunbookId, SelfHealingActionPolicy>
  };
}

export function selfHealingRiskRequiresApproval(
  risk: SelfHealingRisk,
  threshold: SelfHealingRisk
): boolean {
  return riskOrder[risk] >= riskOrder[threshold];
}

export function isSelfHealingRunbookId(
  value: string
): value is SelfHealingRunbookId {
  return selfHealingRunbookIds.includes(value as SelfHealingRunbookId);
}

const riskOrder: Record<SelfHealingRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};
