import { z } from "zod";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const schemaVersion = z.object({
  schema_version: z.string().min(1)
});

const agentsConfigSchema = schemaVersion.extend({
  agents: z.object({
    codex: z.object({ enabled: z.literal(true) }).passthrough(),
    claude: z.object({ enabled: z.literal(true) }).passthrough(),
    gemini: z.object({ enabled: z.literal(true) }).passthrough()
  })
});

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
