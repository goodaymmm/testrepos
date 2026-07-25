import path from "node:path";
import { z } from "zod";
import {
  isValidCidr,
  isValidDiscordExternalBaseUrl
} from "../../discord/http-profile.js";
import {
  normalizeBoardExternalBaseUrl,
  normalizeBoardOrigin
} from "../../board/profile.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const schemaVersion = z.object({
  schema_version: z.string().min(1)
});

const watchdogSeveritySchema = z.enum(["info", "warning", "high", "critical"]);
const watchdogRuleSchema = z
  .object({
    enabled: z.boolean(),
    severity: watchdogSeveritySchema,
    threshold: z.number().int().positive().optional(),
    threshold_seconds: z.number().int().positive().optional(),
    window_seconds: z.number().int().positive().optional(),
    cooldown_seconds: z.number().int().nonnegative().max(86_400).optional()
  })
  .refine(
    (rule) => rule.threshold !== undefined || rule.threshold_seconds !== undefined,
    { message: "watchdog rule requires threshold or threshold_seconds" }
  );

const runtimeConfigSchema = schemaVersion
  .extend({
    workflow: z
      .object({
        enabled: z.boolean().optional(),
        enabled_env: z.string().trim().min(1).optional(),
        mode: z.literal("production").optional(),
        checkpoint_store: z.enum(["file", "file+sqlite"]).optional(),
        checkpoint_sqlite_path: z
          .string()
          .trim()
          .min(1)
          .refine((value) => !path.isAbsolute(value), {
            message: "workflow checkpoint sqlite path must be project-relative"
          })
          .refine((value) => {
            const normalized = value.replaceAll("\\", "/");
            return (
              normalized.startsWith(".kairon/workflows/") &&
              normalized.endsWith(".sqlite") &&
              !normalized.split("/").includes("..")
            );
          }, {
            message:
              "workflow checkpoint sqlite path must be a .sqlite file under .kairon/workflows"
          })
          .optional(),
        checkpoint_sqlite_busy_timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .optional(),
        resource_lock_ttl_seconds: z
          .number()
          .int()
          .positive()
          .max(604_800)
          .optional(),
        checkpoint_on_transition: z.boolean().optional(),
        retry: z
          .object({
            max_attempts: z.number().int().min(1).max(10),
            backoff_seconds: z.number().int().min(0).max(3_600)
          })
          .optional()
      })
      .optional(),
    watchdog: z
      .object({
        enabled: z.boolean(),
        cooldown_seconds: z.number().int().nonnegative().max(86_400),
        rules: z.object({
          stale_heartbeat: watchdogRuleSchema,
          fatal_runtime_error: watchdogRuleSchema,
          restart_loop: watchdogRuleSchema,
          queue_backlog: watchdogRuleSchema,
          failed_notifications: watchdogRuleSchema,
          provider_suspended: watchdogRuleSchema,
          task_scheduler_missing: watchdogRuleSchema
        })
      })
      .optional()
  })
  .passthrough();

const sessionBudgetThresholdSchema = z.object({
  prompt_bytes: z.number().int().positive(),
  job_count: z.number().int().positive(),
  elapsed_seconds: z.number().int().positive(),
  compaction_count: z.number().int().positive()
});

const sessionBudgetSchema = z
  .object({
    enabled: z.boolean(),
    soft_limit: sessionBudgetThresholdSchema,
    hard_limit: sessionBudgetThresholdSchema,
    compaction_keep_runs: z.number().int().min(1).max(100),
    resource_lock_ttl_seconds: z.number().int().min(5).max(3_600)
  })
  .refine(
    (budget) =>
      (
        [
          "prompt_bytes",
          "job_count",
          "elapsed_seconds",
          "compaction_count"
        ] as const
      ).every(
        (metric) => budget.soft_limit[metric] < budget.hard_limit[metric]
      ),
    { message: "session budget soft limits must be below hard limits" }
  );

const capabilityClassSchema = z.enum([
  "read",
  "workspace_write",
  "git_write",
  "external_read",
  "external_write",
  "privileged"
]);

const supportedCapabilitiesSchema = z
  .array(z.string().trim().min(1))
  .min(1);

const agentsConfigSchema = schemaVersion.extend({
  session_budget: sessionBudgetSchema.optional(),
  provider_policies: z
    .object({
      codex: providerPolicySchema(),
      claude: providerPolicySchema(),
      gemini: providerPolicySchema()
    })
    .optional(),
  agents: z.object({
    codex: z
      .object({
        enabled: z.literal(true),
        supported_capabilities: supportedCapabilitiesSchema.optional(),
        supported_connectors: z.array(z.string().trim().min(1)).optional()
      })
      .passthrough(),
    claude: z
      .object({
        enabled: z.literal(true),
        supported_capabilities: supportedCapabilitiesSchema.optional(),
        supported_connectors: z.array(z.string().trim().min(1)).optional()
      })
      .passthrough(),
    gemini: z
      .object({
        enabled: z.literal(true),
        supported_capabilities: supportedCapabilitiesSchema.optional(),
        supported_connectors: z.array(z.string().trim().min(1)).optional()
      })
      .passthrough()
  })
});

function providerPolicySchema() {
  return z.object({
    unattended_allowed: z.boolean(),
    max_concurrent: z.number().int().positive(),
    cooldown_seconds: z.number().int().nonnegative().max(86_400),
    daily_run_limit: z.number().int().positive()
  });
}

const cleanupRetentionRuleSchema = z
  .object({
    max_age_days: z.number().int().nonnegative(),
    max_files: z.number().int().positive(),
    max_bytes: z.number().int().positive(),
    min_keep: z.number().int().nonnegative()
  })
  .refine((rule) => rule.min_keep <= rule.max_files, {
    message: "min_keep must not exceed max_files"
  });

const cleanupRetentionSchema = z.object({
  enabled: z.boolean(),
  categories: z.object({
    runs: cleanupRetentionRuleSchema,
    sessions: cleanupRetentionRuleSchema,
    daemon_logs: cleanupRetentionRuleSchema,
    audits: cleanupRetentionRuleSchema,
    reports: cleanupRetentionRuleSchema
  })
});

const policiesConfigSchema = schemaVersion.extend({
  git: z
    .object({
      allow_auto_push: z.boolean(),
      require_review_before_commit: z.literal(true),
      allowed_merge_methods: z
        .array(z.enum(["merge", "squash", "rebase"]))
        .min(1)
        .optional(),
      branch_protection: z
        .object({
          expected_status_checks: z.array(z.string().min(1)).optional()
        })
        .optional()
    })
    .passthrough(),
  deploy: z
    .object({
      allowed_providers: z.array(z.string().min(1)).min(1),
      allowed_environments: z.array(z.string().min(1)).min(1),
      production_providers: z.array(z.string().min(1)),
      production_providers_enabled: z.boolean(),
      execution_timeout_ms: z.number().int().min(100).max(300_000)
    })
    .optional(),
  review: z
    .object({
      required_for_code: z.literal(true)
    })
    .passthrough(),
  capability_policy: z
    .object({
      default_effect: z.literal("deny"),
      allowed_classes: z.array(capabilityClassSchema).min(1),
      approval_required_classes: z.array(capabilityClassSchema),
      denied_capabilities: z.array(z.string().trim().min(1)),
      approval_required_capabilities: z.array(z.string().trim().min(1)),
      personas: z
        .record(
          z.string(),
          z.object({
            allowed_capabilities: z
              .array(z.string().trim().min(1))
              .optional(),
            allowed_classes: z.array(capabilityClassSchema).optional()
          })
        )
        .optional(),
      connectors: z.record(
        z.string(),
        z
          .object({
            enabled: z.boolean(),
            trust_level: z.enum([
              "untrusted",
              "restricted",
              "trusted",
              "privileged"
            ]),
            allowed_scopes: z.array(capabilityClassSchema),
            data_egress: z.boolean(),
            write_actions: z.boolean()
          })
          .refine(
            (connector) =>
              connector.trust_level !== "untrusted" ||
              !connector.write_actions,
            {
              message: "untrusted connector cannot enable write_actions"
            }
          )
          .refine(
            (connector) =>
              connector.allowed_scopes.every((scope) =>
                connectorTrustAllowsScope(connector.trust_level, scope)
              ),
            {
              message: "connector trust_level is insufficient for allowed_scopes"
            }
          )
          .refine(
            (connector) =>
              !connector.allowed_scopes.some(
                (scope) =>
                  scope === "external_read" || scope === "external_write"
              ) || connector.data_egress,
            {
              message: "external connector scopes require data_egress"
            }
          )
          .refine(
            (connector) =>
              !connector.allowed_scopes.some((scope) =>
                [
                  "workspace_write",
                  "git_write",
                  "external_write",
                  "privileged"
                ].includes(scope)
              ) || connector.write_actions,
            {
              message: "write connector scopes require write_actions"
            }
          )
      )
    })
    .optional(),
  cleanup: z
    .object({
      delete_directly: z.literal(false),
      proposal_required: z.literal(true),
      retention: cleanupRetentionSchema.optional()
    })
    .passthrough()
});

function connectorTrustAllowsScope(
  trustLevel: "untrusted" | "restricted" | "trusted" | "privileged",
  scope:
    | "read"
    | "workspace_write"
    | "git_write"
    | "external_read"
    | "external_write"
    | "privileged"
): boolean {
  const trustRank = {
    untrusted: 0,
    restricted: 1,
    trusted: 2,
    privileged: 3
  } as const;
  const scopeRank = {
    read: 0,
    external_read: 1,
    workspace_write: 2,
    git_write: 2,
    external_write: 2,
    privileged: 3
  } as const;
  return trustRank[trustLevel] >= scopeRank[scope];
}

const notificationsConfigSchema = schemaVersion.extend({
  primary_provider: z.literal("discord"),
  providers: z.object({
    discord: z.object({
      enabled: z.boolean(),
      mode: z.literal("gateway"),
      public_key_env: z.string().min(1).optional()
    }).passthrough()
  }),
  http: z
    .object({
      profile: z.enum(["loopback", "reverse-proxy"]),
      external_base_url: z
        .string()
        .refine(isValidDiscordExternalBaseUrl)
        .nullable()
        .optional(),
      trusted_proxies: z.array(z.string().refine(isValidCidr)).min(1)
    })
    .superRefine((http, context) => {
      if (http.profile !== "reverse-proxy") {
        return;
      }

      if (http.external_base_url == null) {
        context.addIssue({
          code: "custom",
          path: ["external_base_url"],
          message: "reverse-proxy profile requires external_base_url"
        });
        return;
      }

      if (!isValidDiscordExternalBaseUrl(http.external_base_url)) {
        context.addIssue({
          code: "custom",
          path: ["external_base_url"],
          message: "reverse-proxy external_base_url must use HTTPS"
        });
      }
    })
    .optional(),
  board: z
    .object({
      enabled: z.boolean(),
      base_url: z.string().url(),
      profile: z.enum(["loopback", "remote-readonly"]).optional(),
      external_base_url: z
        .string()
        .refine((value) => normalizeBoardExternalBaseUrl(value) !== undefined)
        .nullable()
        .optional(),
      trusted_proxies: z.array(z.string().refine(isValidCidr)).min(1).optional(),
      allowed_origins: z.array(
        z.string().refine((value) => normalizeBoardOrigin(value) !== undefined)
      ).optional(),
      identity_header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
      rate_limit_per_minute: z.number().int().positive().optional()
    })
    .superRefine((board, context) => {
      if (board.profile !== "remote-readonly") {
        return;
      }
      if (!board.enabled) {
        context.addIssue({
          code: "custom",
          path: ["enabled"],
          message: "remote-readonly Board requires enabled=true"
        });
      }
      if (board.external_base_url == null) {
        context.addIssue({
          code: "custom",
          path: ["external_base_url"],
          message: "remote-readonly Board requires external_base_url"
        });
      }
      if (board.allowed_origins === undefined || board.allowed_origins.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["allowed_origins"],
          message: "remote-readonly Board requires allowed_origins"
        });
      }
    })
    .optional()
});

const ragConfigSchema = schemaVersion.extend({
  enabled: z.boolean(),
  storage: z.object({
    base_dir: z.string().regex(/^\.kairon(?:[\\/][A-Za-z0-9._-]+)*$/u)
  }).passthrough(),
  vector: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(["local_hash", "local_onnx"]),
      model_id: z.string().trim().min(1).max(120),
      dimension: z.number().int().min(8).max(4096)
    })
    .optional(),
  retrieval: z
    .object({
      default_mode: z.enum(["lexical", "vector", "hybrid"]),
      hybrid: z
        .object({
          lexical: z.number().min(0).max(1),
          vector: z.number().min(0).max(1),
          freshness: z.number().min(0).max(1),
          source_diversity_penalty: z.number().min(0).max(1)
        })
        .refine(
          (weights) =>
            weights.lexical + weights.vector + weights.freshness > 0,
          "RAG hybrid ranking requires a positive lexical, vector, or freshness weight"
        )
    })
    .optional(),
  evaluation: z
    .object({
      profiles: z.record(
        z.string().trim().min(1).max(80),
        z.object({
          mode: z.enum(["lexical", "vector", "hybrid"]),
          top_k: z.number().int().min(1).max(100),
          minimum_precision_at_k: z.number().min(0).max(1),
          queries: z
            .array(
              z.object({
                id: z.string().trim().min(1).max(120),
                query: z.string().trim().min(1).max(500),
                expected_paths: z.array(z.string().trim().min(1)).min(1).max(50),
                forbidden_paths: z
                  .array(z.string().trim().min(1))
                  .max(50)
                  .optional()
              })
            )
            .max(100)
        })
      )
    })
    .optional(),
  integrity: z
    .object({
      query_samples: z.array(z.string().trim().min(1).max(200)).max(20),
      context_budget_tokens: z.number().int().positive().max(1_000_000),
      max_duplicate_ratio: z.number().min(0).max(1)
    })
    .optional(),
  rebuild: z
    .object({
      interval_days: z.number().int().positive(),
      retention_days: z.number().int().positive(),
      max_artifacts: z.number().int().positive()
    })
    .optional(),
  security: z.object({ exclude_paths: z.array(z.string().min(1)) }).passthrough()
});

export function validateConfigFile(fileName: string, value: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const baseResult = schemaVersion.safeParse(value);
  if (!baseResult.success) {
    errors.push(`${fileName}: schema_version is required`);
  }

  if (fileName === "agents.json") {
    const result = agentsConfigSchema.safeParse(value);
    if (!result.success) {
      errors.push(
        `${fileName}: agent enablement, provider policy, or session budget settings are invalid`
      );
    }
  }

  if (fileName === "runtime.json") {
    const result = runtimeConfigSchema.safeParse(value);
    if (!result.success) {
      errors.push(`${fileName}: runtime workflow or watchdog settings are invalid`);
    } else if (result.data.workflow?.enabled_env !== undefined) {
      warnings.push(
        `${fileName}: workflow.enabled_env is legacy; use workflow.enabled`
      );
    }
  }

  if (fileName === "policies.json") {
    const result = policiesConfigSchema.safeParse(value);
    if (!result.success) {
      errors.push(
        `${fileName}: review and cleanup safety policies are invalid`
      );
    } else if (result.data.git.allow_auto_push) {
      warnings.push(`${fileName}: allow_auto_push=true should be used only after review`);
    }
  }

  if (fileName === "notifications.json") {
    const result = notificationsConfigSchema.safeParse(value);
    if (!result.success) {
      errors.push(
        `${fileName}: Discord notification and HTTP profile settings are invalid`
      );
    }
  }

  if (fileName === "rag.json") {
    const result = ragConfigSchema.safeParse(value);
    if (!result.success) {
      errors.push(`${fileName}: RAG storage, integrity, or rebuild settings are invalid`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function combineValidationResults(results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((result) => result.errors);
  const warnings = results.flatMap((result) => result.warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}
