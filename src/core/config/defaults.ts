import path from "node:path";
import { normalizeProjectRoot, toPosixPath } from "../fs/paths.js";
import { mergeCleanupRetentionPolicy } from "./cleanup-retention.js";

export type ConfigMap = Record<string, unknown>;

export function createDefaultConfigs(projectRoot: string): ConfigMap {
  const root = normalizeProjectRoot(projectRoot);
  const projectId = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  return {
    "project.json": {
      schema_version: "0.1",
      project_id: projectId || "kairon-project",
      root: toPosixPath(root),
      primary_language: "unknown",
      frameworks: [],
      package_managers: [],
      commands: {
        test: [],
        lint: [],
        build: []
      },
      paths: {
        protected: [".env*", "infra/**", ".github/workflows/**"],
        generated: ["dist/**", "coverage/**", "tmp/**"],
        source: ["src/**", "tests/**"]
      }
    },
    "runtime.json": {
      schema_version: "0.1",
      default_mode: "persistent_terminal_session",
      visible_terminal_required: false,
      official_cli_only: true,
      runtime_lock: ".kairon/runtime/lock.json",
      session_retention: {
        scope: "daily",
        close_at: "maintenance_end",
        next_day_restore_from: ["daily_report", "handoff", "events", "rag"]
      },
      process: {
        no_output_timeout_seconds: 600,
        graceful_shutdown_seconds: 30
      },
      workflow: {
        enabled: false,
        mode: "production",
        checkpoint_store: "file",
        checkpoint_sqlite_path: ".kairon/workflows/checkpoints.sqlite",
        checkpoint_sqlite_busy_timeout_ms: 5000,
        resource_lock_ttl_seconds: 86400,
        checkpoint_on_transition: true,
        retry: {
          max_attempts: 3,
          backoff_seconds: 30
        }
      },
      watchdog: {
        enabled: true,
        cooldown_seconds: 900,
        rules: {
          stale_heartbeat: {
            enabled: true,
            severity: "critical",
            threshold_seconds: 120
          },
          fatal_runtime_error: {
            enabled: true,
            severity: "critical",
            threshold: 1
          },
          restart_loop: {
            enabled: true,
            severity: "high",
            threshold: 3,
            window_seconds: 300
          },
          queue_backlog: {
            enabled: true,
            severity: "warning",
            threshold: 20
          },
          failed_notifications: {
            enabled: true,
            severity: "high",
            threshold: 3,
            window_seconds: 300
          },
          provider_suspended: {
            enabled: true,
            severity: "high",
            threshold: 1
          },
          task_scheduler_missing: {
            enabled: true,
            severity: "warning",
            threshold: 1
          }
        }
      }
    },
    "schedule.json": {
      schema_version: "0.1",
      timezone: "Asia/Tokyo",
      active_work_time: [{ start: "07:00", end: "18:00" }],
      standby_work_time: [{ start: "18:00", end: "01:00" }],
      maintenance_time: [{ start: "01:00", end: "07:00" }],
      active_start_agenda: [
        "morning_review",
        "cleanup_triage",
        "approval_review"
      ]
    },
    "agents.json": {
      schema_version: "0.1",
      session_budget: {
        enabled: true,
        soft_limit: {
          prompt_bytes: 8_000_000,
          job_count: 40,
          elapsed_seconds: 21_600,
          compaction_count: 3
        },
        hard_limit: {
          prompt_bytes: 16_000_000,
          job_count: 80,
          elapsed_seconds: 43_200,
          compaction_count: 5
        },
        compaction_keep_runs: 10,
        resource_lock_ttl_seconds: 60
      },
      provider_policies: {
        codex: {
          unattended_allowed: true,
          max_concurrent: 1,
          cooldown_seconds: 300,
          daily_run_limit: 100
        },
        claude: {
          unattended_allowed: true,
          max_concurrent: 1,
          cooldown_seconds: 300,
          daily_run_limit: 100
        },
        gemini: {
          unattended_allowed: true,
          max_concurrent: 1,
          cooldown_seconds: 300,
          daily_run_limit: 50
        }
      },
      agents: {
        codex: {
          enabled: true,
          adapter: "codex_cli",
          command: "codex",
          mode: "persistent_terminal_session",
          personas: ["implementer", "reviewer", "maintainer"],
          supported_capabilities: [
            "coding",
            "filesystem.write",
            "workspace.write",
            "git.write",
            "json.output",
            "qa",
            "read",
            "resume",
            "research",
            "review"
          ],
          supported_connectors: ["native.mcp"],
          rule_files: ["AGENTS.md", ".kairon/rules/codex/AGENTS.md"]
        },
        claude: {
          enabled: true,
          adapter: "claude_code",
          command: "claude",
          mode: "persistent_terminal_session",
          personas: ["planner", "implementer", "reviewer"],
          supported_capabilities: [
            "coding",
            "filesystem.write",
            "workspace.write",
            "git.write",
            "json.output",
            "planning",
            "qa",
            "read",
            "research",
            "review"
          ],
          supported_connectors: ["native.mcp"],
          rule_files: ["CLAUDE.md", ".kairon/rules/claude/CLAUDE.md"]
        },
        gemini: {
          enabled: true,
          adapter: "antigravity_cli",
          command: "agy",
          mode: "persistent_terminal_session",
          personas: ["qa", "researcher", "reviewer"],
          supported_capabilities: [
            "external.read",
            "filesystem.write",
            "google.ecosystem",
            "json.output",
            "large.context",
            "multimodal",
            "qa",
            "read",
            "research",
            "review"
          ],
          supported_connectors: [],
          rule_files: ["GEMINI.md", ".kairon/rules/gemini/GEMINI.md"]
        }
      }
    },
    "dispatch.json": {
      schema_version: "0.1",
      strategy: "persona_capability_score",
      default_agent: "codex",
      personas: {
        implementer: { preferred_agents: ["codex"], max_parallel: 1 },
        reviewer: { preferred_agents: ["codex", "claude", "gemini"], max_parallel: 1 },
        qa: { preferred_agents: ["gemini", "codex"], max_parallel: 1 },
        researcher: { preferred_agents: ["gemini"], max_parallel: 1 },
        maintainer: { preferred_agents: ["codex"], max_parallel: 1 }
      }
    },
    "policies.json": {
      schema_version: "0.1",
      git: {
        default_base_branch: "main",
        remote: "origin",
        worktree_root: ".kairon/worktrees",
        allow_auto_commit: true,
        allow_auto_push: false,
        require_review_before_commit: true,
        branch_template: "auto/{task_id}/{agent}",
        auto_branch_prefixes: ["auto/", "codex/", "claude/", "gemini/"],
        protected_branches: ["main", "master", "develop", "release/*"],
        require_approval_for: [
          "merge",
          "deploy",
          "protected_branch_push",
          "force_push",
          "branch_delete"
        ],
        allowed_merge_methods: ["squash"],
        require_clean_base_worktree: true,
        branch_protection: {
          expected_status_checks: []
        },
        max_parallel_writers_per_path: 1,
        conflict_strategy: {
          path_overlap: "block",
          base_branch_moved: "recheck_before_push",
          merge_conflict: "escalate"
        },
        rollback_strategy: {
          pre_commit: "discard_worktree_with_artifact",
          committed_unpushed: "reset_branch_to_parent",
          pushed_unmerged: "revert_commit",
          merged: "revert_commit"
        }
      },
      deploy: {
        allowed_providers: ["local-sandbox"],
        allowed_environments: ["local-sandbox", "staging"],
        production_providers: ["production-cloud"],
        production_providers_enabled: false,
        execution_timeout_ms: 30000
      },
      security: {
        official_cli_only: true,
        disallow_token_extraction: true,
        detect_api_key_contamination: true,
        protected_paths: [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
      },
      capability_policy: {
        default_effect: "deny",
        allowed_classes: [
          "read",
          "workspace_write",
          "git_write",
          "external_read",
          "external_write",
          "privileged"
        ],
        approval_required_classes: [
          "git_write",
          "external_write",
          "privileged"
        ],
        denied_capabilities: [],
        approval_required_capabilities: [],
        connectors: {
          "native.mcp": {
            enabled: true,
            trust_level: "restricted",
            allowed_scopes: ["read", "external_read"],
            data_egress: true,
            write_actions: false
          }
        }
      },
      cleanup: {
        delete_directly: false,
        proposal_required: true,
        retention: mergeCleanupRetentionPolicy(undefined)
      },
      review: {
        required_for_code: true,
        recommended_reviewers: ["claude", "codex"],
        max_iterations: 3,
        minimum_score: 0.85,
        block_on_severity: ["critical", "high"],
        allow_medium_findings: 0,
        require_tests_for_code: true,
        require_secret_scan: true,
        require_reviewer_agreement: true,
        escalate_on_max_iterations: true,
        claude_opus_review_path: "codex-plugin-cc"
      }
    },
    "notifications.json": {
      schema_version: "0.1",
      primary_provider: "discord",
      providers: {
        discord: {
          enabled: false,
          mode: "gateway",
          bot_token_env: "KAIRON_DISCORD_BOT_TOKEN",
          public_key_env: "KAIRON_DISCORD_PUBLIC_KEY",
          application_id_env: "KAIRON_DISCORD_APPLICATION_ID",
          guild_id_env: "KAIRON_DISCORD_GUILD_ID",
          approval_channel_id_env: "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
          owner_user_id_env: "KAIRON_DISCORD_OWNER_USER_ID",
          allowed_user_ids_env: "KAIRON_DISCORD_ALLOWED_USER_IDS",
          use_dm: false,
          register_commands_on_start: true
        }
      },
      approval_policy: {
        default_actions: ["approve", "reject", "request_changes", "snooze"],
        require_board_reauth_for: [
          "deploy",
          "secret_change",
          "billing_change",
          "protected_branch_push",
          "git_protected_branch_push",
          "force_push",
          "branch_delete"
        ],
        require_board_confirmation_for: [
          "deploy",
          "secret_change",
          "billing_change",
          "protected_branch_push",
          "git_protected_branch_push",
          "force_push",
          "branch_delete"
        ],
        require_local_confirmation_for: [
          "merge",
          "protected_branch_push",
          "git_protected_branch_push",
          "force_push",
          "branch_delete"
        ],
        notify_on: ["approval.requested", "approval.decided", "run.failed"],
        display_mode: "schedule_or_manual"
      },
      gateway: {
        ack_timeout_ms: 2500,
        idempotency_ttl_minutes: 60,
        reconnect: {
          enabled: true,
          max_backoff_seconds: 60
        }
      },
      http: {
        profile: "loopback",
        external_base_url: null,
        trusted_proxies: ["127.0.0.1/32", "::1/128"]
      },
      board: {
        enabled: false,
        base_url: "http://127.0.0.1:8787",
        profile: "loopback",
        external_base_url: null,
        trusted_proxies: ["127.0.0.1/32", "::1/128"],
        allowed_origins: [],
        identity_header: "x-kairon-verified-identity",
        rate_limit_per_minute: 60
      }
    },
    "rag.json": {
      schema_version: "0.1",
      enabled: false,
      storage: {
        base_dir: ".kairon/rag",
        vector: "placeholder",
        lexical: "placeholder"
      },
      embedding_profile: "local_default",
      integrity: {
        query_samples: ["approval routing", "runtime recovery", "review findings"],
        context_budget_tokens: 12000,
        max_duplicate_ratio: 0.25
      },
      rebuild: {
        interval_days: 30,
        retention_days: 90,
        max_artifacts: 20
      },
      security: {
        exclude_paths: [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
      }
    }
  };
}

export const kaironDirectories = [
  "config",
  "config/proposals",
  "rules",
  "rules/codex",
  "rules/claude",
  "rules/gemini",
  "events",
  "tasks",
  "messages",
  "approvals",
  "correlations",
  "audit",
  "runs",
  "workflows",
  "workflows/runs",
  "workflows/checkpoints",
  "workflows/checkpoint-rebuild",
  "workflows/events",
  "workflows/compensations",
  "git",
  "git/branches",
  "git/transactions",
  "git/locks",
  "worktrees",
  "reviews",
  "reviews/results",
  "reviews/loops",
  "sessions",
  "runtime",
  "runtime/daemon",
  "runtime/pids",
  "runtime/terminals",
  "runtime/ticks",
  "runtime/discord",
  "watchdog",
  "watchdog/alerts",
  "incidents",
  "incidents/plans",
  "recovery",
  "recovery/resolutions",
  "state",
  "rag",
  "rag/integrity",
  "rag/rebuilds",
  "board",
  "reports",
  "reports/daily",
  "reports/next-day",
  "cleanup",
  "cleanup/proposals",
  "cleanup/applied",
  "cleanup/archived",
  "deploy",
  "deploy/dry-runs",
  "deploy/executions",
  "deploy/rollback-plans",
  "deploy/providers/local-sandbox/operations",
  "deploy/providers/local-sandbox/environments",
  "tmp"
];
