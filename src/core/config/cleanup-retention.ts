export const cleanupRetentionCategories = [
  "runs",
  "sessions",
  "daemon_logs",
  "audits",
  "reports",
  "metrics_raw",
  "metrics_rollups"
] as const;

export type CleanupRetentionCategory =
  (typeof cleanupRetentionCategories)[number];

export type CleanupRetentionRule = {
  max_age_days: number;
  max_files: number;
  max_bytes: number;
  min_keep: number;
};

export type CleanupRetentionPolicy = {
  enabled: boolean;
  categories: Record<CleanupRetentionCategory, CleanupRetentionRule>;
};

export type CleanupRetentionPolicyInput = {
  enabled?: boolean;
  categories?: Partial<
    Record<CleanupRetentionCategory, Partial<CleanupRetentionRule>>
  >;
};

export const defaultCleanupRetentionPolicy: CleanupRetentionPolicy = {
  enabled: true,
  categories: {
    runs: {
      max_age_days: 30,
      max_files: 200,
      max_bytes: 1_073_741_824,
      min_keep: 10
    },
    sessions: {
      max_age_days: 30,
      max_files: 60,
      max_bytes: 536_870_912,
      min_keep: 7
    },
    daemon_logs: {
      max_age_days: 30,
      max_files: 60,
      max_bytes: 268_435_456,
      min_keep: 7
    },
    audits: {
      max_age_days: 90,
      max_files: 30,
      max_bytes: 268_435_456,
      min_keep: 1
    },
    reports: {
      max_age_days: 180,
      max_files: 365,
      max_bytes: 536_870_912,
      min_keep: 30
    },
    metrics_raw: {
      max_age_days: 14,
      max_files: 14,
      max_bytes: 268_435_456,
      min_keep: 2
    },
    metrics_rollups: {
      max_age_days: 180,
      max_files: 400,
      max_bytes: 268_435_456,
      min_keep: 7
    }
  }
};

export function mergeCleanupRetentionPolicy(
  configured: CleanupRetentionPolicyInput | undefined
): CleanupRetentionPolicy {
  const configuredCategories = configured?.categories ?? {};
  return {
    enabled: configured?.enabled ?? defaultCleanupRetentionPolicy.enabled,
    categories: Object.fromEntries(
      cleanupRetentionCategories.map((category) => [
        category,
        {
          ...defaultCleanupRetentionPolicy.categories[category],
          ...(configuredCategories[category] ?? {})
        }
      ])
    ) as Record<CleanupRetentionCategory, CleanupRetentionRule>
  };
}
