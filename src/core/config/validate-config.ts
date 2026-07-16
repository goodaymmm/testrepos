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

const agentsConfigSchema = schemaVersion.extend({
  provider_policies: z
    .object({
      codex: providerPolicySchema(),
      claude: providerPolicySchema(),
      gemini: providerPolicySchema()
    })
    .optional(),
  agents: z.object({
    codex: z.object({ enabled: z.literal(true) }).passthrough(),
    claude: z.object({ enabled: z.literal(true) }).passthrough(),
    gemini: z.object({ enabled: z.literal(true) }).passthrough()
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
  cleanup: z
    .object({
      delete_directly: z.literal(false),
      proposal_required: z.literal(true),
      retention: cleanupRetentionSchema.optional()
    })
    .passthrough()
});

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
        `${fileName}: codex, claude, and gemini (Antigravity compatibility id) must be enabled for MVP`
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
