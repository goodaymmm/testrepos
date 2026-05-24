# Kairon Config Schema v0

## 目的

この文書は MVP で生成・検証する `.kairon/config/*.json` の最小 schema を定義する。

## Config Files

```text
.kairon/config/
  project.json
  runtime.json
  schedule.json
  agents.json
  dispatch.json
  policies.json
  notifications.json
  rag.json
```

## project.json

```json
{
  "schema_version": "0.1",
  "project_id": "example-app",
  "root": "C:/path/to/project",
  "primary_language": "typescript",
  "frameworks": ["react", "vite"],
  "package_managers": ["npm"],
  "commands": {
    "test": ["npm test"],
    "lint": ["npm run lint"],
    "build": ["npm run build"]
  },
  "paths": {
    "protected": [".env*", "infra/**", ".github/workflows/**"],
    "generated": ["dist/**", "coverage/**", "tmp/**"],
    "source": ["src/**", "tests/**"]
  }
}
```

## runtime.json

```json
{
  "schema_version": "0.1",
  "default_mode": "persistent_terminal_session",
  "visible_terminal_required": false,
  "official_cli_only": true,
  "runtime_lock": ".kairon/runtime/lock.json",
  "session_retention": {
    "scope": "daily",
    "close_at": "maintenance_end",
    "next_day_restore_from": ["daily_report", "handoff", "events", "rag"]
  },
  "process": {
    "no_output_timeout_seconds": 600,
    "graceful_shutdown_seconds": 30
  }
}
```

## schedule.json

```json
{
  "schema_version": "0.1",
  "timezone": "Asia/Tokyo",
  "active_work_time": [{ "start": "07:00", "end": "18:00" }],
  "standby_work_time": [{ "start": "18:00", "end": "01:00" }],
  "maintenance_time": [{ "start": "01:00", "end": "07:00" }],
  "active_start_agenda": ["morning_review", "cleanup_triage", "approval_review"]
}
```

## agents.json

```json
{
  "schema_version": "0.1",
  "agents": {
    "codex": {
      "enabled": true,
      "adapter": "codex_cli",
      "command": "codex",
      "mode": "persistent_terminal_session",
      "personas": ["implementer", "reviewer", "maintainer"],
      "rule_files": ["AGENTS.md", ".kairon/rules/codex/AGENTS.md"]
    },
    "claude": {
      "enabled": true,
      "adapter": "claude_code",
      "command": "claude",
      "mode": "persistent_terminal_session",
      "personas": ["planner", "implementer", "reviewer"],
      "rule_files": ["CLAUDE.md", ".kairon/rules/claude/CLAUDE.md"]
    },
    "gemini": {
      "enabled": true,
      "adapter": "gemini_cli",
      "command": "gemini",
      "mode": "persistent_terminal_session",
      "personas": ["qa", "researcher", "reviewer"],
      "rule_files": ["GEMINI.md", ".kairon/rules/gemini/GEMINI.md"]
    }
  }
}
```

## dispatch.json

```json
{
  "schema_version": "0.1",
  "strategy": "persona_capability_score",
  "default_agent": "codex",
  "personas": {
    "implementer": { "preferred_agents": ["codex"], "max_parallel": 1 },
    "reviewer": { "preferred_agents": ["codex", "claude", "gemini"], "max_parallel": 1 },
    "qa": { "preferred_agents": ["gemini", "codex"], "max_parallel": 1 },
    "researcher": { "preferred_agents": ["gemini"], "max_parallel": 1 },
    "maintainer": { "preferred_agents": ["codex"], "max_parallel": 1 }
  }
}
```

## policies.json

```json
{
  "schema_version": "0.1",
  "git": {
    "default_base_branch": "main",
    "remote": "origin",
    "worktree_root": ".kairon/worktrees",
    "allow_auto_commit": true,
    "allow_auto_push": false,
    "require_review_before_commit": true,
    "branch_template": "auto/{task_id}/{agent}",
    "auto_branch_prefixes": ["auto/", "codex/", "claude/", "gemini/"],
    "protected_branches": ["main", "master", "develop", "release/*"],
    "require_approval_for": ["merge", "deploy", "protected_branch_push", "force_push", "branch_delete"],
    "require_clean_base_worktree": true,
    "max_parallel_writers_per_path": 1,
    "conflict_strategy": {
      "path_overlap": "block",
      "base_branch_moved": "recheck_before_push",
      "merge_conflict": "escalate"
    },
    "rollback_strategy": {
      "pre_commit": "discard_worktree_with_artifact",
      "committed_unpushed": "reset_branch_to_parent",
      "pushed_unmerged": "revert_commit",
      "merged": "revert_commit"
    }
  },
  "security": {
    "official_cli_only": true,
    "disallow_token_extraction": true,
    "detect_api_key_contamination": true,
    "protected_paths": [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
  },
  "cleanup": {
    "delete_directly": false,
    "proposal_required": true
  },
  "review": {
    "required_for_code": true,
    "recommended_reviewers": ["claude", "codex"],
    "max_iterations": 3,
    "minimum_score": 0.85,
    "block_on_severity": ["critical", "high"],
    "allow_medium_findings": 0,
    "require_tests_for_code": true,
    "require_secret_scan": true,
    "require_reviewer_agreement": true,
    "escalate_on_max_iterations": true,
    "claude_opus_review_path": "codex-plugin-cc"
  }
}
```

## notifications.json

```json
{
  "schema_version": "0.1",
  "primary_provider": "discord",
  "providers": {
    "discord": {
      "enabled": false,
      "mode": "gateway",
      "bot_token_env": "KAIRON_DISCORD_BOT_TOKEN",
      "application_id_env": "KAIRON_DISCORD_APPLICATION_ID",
      "guild_id_env": "KAIRON_DISCORD_GUILD_ID",
      "approval_channel_id_env": "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
      "owner_user_id_env": "KAIRON_DISCORD_OWNER_USER_ID",
      "allowed_user_ids_env": "KAIRON_DISCORD_ALLOWED_USER_IDS",
      "use_dm": false,
      "register_commands_on_start": true
    }
  },
  "approval_policy": {
    "default_actions": ["approve", "reject", "request_changes", "snooze"],
    "require_board_reauth_for": ["deploy", "secret_change", "billing_change"],
    "notify_on": ["approval.requested", "approval.decided", "run.failed"],
    "display_mode": "schedule_or_manual"
  },
  "gateway": {
    "ack_timeout_ms": 2500,
    "idempotency_ttl_minutes": 60,
    "reconnect": {
      "enabled": true,
      "max_backoff_seconds": 60
    }
  }
}
```

## rag.json

```json
{
  "schema_version": "0.1",
  "enabled": false,
  "storage": {
    "base_dir": ".kairon/rag",
    "vector": "placeholder",
    "lexical": "placeholder"
  },
  "embedding_profile": "local_default",
  "security": {
    "exclude_paths": [".env*", "**/*.pem", "**/*secret*", "**/*token*"]
  }
}
```

## Validation Rules

- `schema_version` は必須。
- `project.root` は実在する directory である。
- `runtime.default_mode` は `persistent_terminal_session` を既定にする。
- `agents.codex.enabled` は MVP では true。
- `agents.claude.enabled` は MVP では true。
- `agents.gemini.enabled` は MVP では true。
- `policies.git.allow_auto_push` は MVP では false を既定にする。
- `policies.git.require_review_before_commit` は true。
- `policies.review.required_for_code` は true。
- Discord は env が揃わない限り disabled でもよい。
- Discord Gateway の詳細は `docs/discord-gateway-v0.md` に分離する。
- RAG は placeholder disabled から開始してよい。
