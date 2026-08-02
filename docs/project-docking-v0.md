# Kairon Project Docking v0

## 目的

Project Docking は、既存プロジェクトに Kairon を接続し、24 時間自律可能な Agent 運用を始めるための初期設定手順である。
Kairon はプロジェクトを乗っ取らず、既存の Git、rule file、CI、issue 管理、deploy flow を尊重して接続する。

## Docking の成果物

```text
.kairon/
  config/
    project.json
    schedule.json
    agents.json
    dispatch.json
    policies.json
    notifications.json
    rag.json
    runtime.json
  rules/
    common.md
    codex/AGENTS.md
    claude/CLAUDE.md
    gemini/GEMINI.md
  state/
  events/
  tasks/
  approvals/
  messages/
  runs/
  locks/
  cleanup/
  reports/
  tmp/
```

既存 root に `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` がある場合は上書きしない。
Kairon 用 rule は `.kairon/rules/` に作成し、必要な参照方法だけ提案する。

## Docking Flow

1. Project inventory
2. Rule discovery
3. Git policy detection
4. Test / build command detection
5. Agent availability check
6. Agent runtime setup
7. LangGraph / RAG runtime setup
8. Schedule setup
9. Discord notification setup
10. Security / secret boundary setup
11. Subscription compliance setup
12. Initial task import
13. Dry run

## Project Inventory

初回に収集する情報。

```json
{
  "project": {
    "name": "example-app",
    "root": "C:/path/to/project",
    "primary_language": "typescript",
    "frameworks": ["react", "vite"],
    "package_managers": ["npm"],
    "test_commands": ["npm test"],
    "lint_commands": ["npm run lint"],
    "build_commands": ["npm run build"],
    "deploy_commands": [],
    "protected_paths": [".env*", "infra/**", ".github/workflows/**"],
    "generated_paths": ["dist/**", "coverage/**", "tmp/**"]
  }
}
```

## Rule Discovery

既存 rule を読み、Agent ごとの master rule を生成する。

| File | 用途 |
| --- | --- |
| `AGENTS.md` | Codex / generic agent rule |
| `CLAUDE.md` | Claude Code rule |
| `GEMINI.md` | Antigravity rule。内部 agent id は互換性のため `gemini` を維持 |
| `.cursorrules` | editor agent rule |
| `.github/copilot-instructions.md` | GitHub Copilot rule |
| `README.md` | project overview |
| `CONTRIBUTING.md` | contribution flow |

生成物は `.kairon/rules/common.md` と agent-specific rule に分割する。

## Git Docking

```json
{
  "git": {
    "default_base_branch": "main",
    "remote": "origin",
    "worktree_root": ".kairon/worktrees",
    "auto_branch_prefixes": ["auto/", "codex/", "claude/", "gemini/"],
    "allow_auto_commit": true,
    "allow_auto_push": false,
    "require_review_before_commit": true,
    "require_approval_for": ["merge", "deploy", "protected_branch_push", "force_push", "branch_delete"],
    "rollback_strategy": {
      "merged": "revert",
      "unmerged_auto_branch": "reset_or_recreate_branch"
    }
  }
}
```

Kairon は job ごとに worktree を作成する。
同じ branch を複数 Agent が同時に write しない。
code-producing job は review gate を通過するまで commit / push しない。
Git Workspace の詳細は `docs/git-workspace-v0.md` に分離する。

## Schedule Setup

初期値は user の生活リズムに合わせる。

```json
{
  "timezone": "Asia/Tokyo",
  "active_work_time": [{ "start": "07:00", "end": "18:00" }],
  "standby_work_time": [{ "start": "18:00", "end": "01:00" }],
  "maintenance_time": [{ "start": "01:00", "end": "07:00" }],
  "active_start_agenda": ["morning_review", "cleanup_triage", "approval_review"]
}
```

## Notification Setup

MVP は Discord provider から開始する。
Discord は approval decision だけを受け取り、command execution は行わない。

```json
{
  "notification_provider": "discord",
  "approval_channel": "mobile",
  "fallback": "board",
  "require_reauth_for": ["deploy", "secret_change", "billing_change"]
}
```

## LangGraph / RAG Runtime Setup

Control Protocol は LangGraph で state transition contract を定義し、Runtime は LangChain retriever で project memory を取得する。
RAG index は canonical source から再生成できる derived data として扱う。

```json
{
  "runtime": {
    "graph": "langgraph",
    "checkpoint_store": ".kairon/runtime/langgraph/checkpoints.sqlite",
    "memory_store": ".kairon/runtime/langgraph/store.sqlite"
  },
  "rag": {
    "config": ".kairon/config/rag.json",
    "base_dir": ".kairon/rag",
    "embedding_profile": "local_default"
  }
}
```

## Agent Runtime Setup

Kairon は公式 CLI を Terminal-backed session として起動し、日次メンテ終了まで保持する。
可視 Terminal window の有無ではなく、公式 CLI / 公式認証 / usage limit / run log を runtime boundary とする。

```json
{
  "runtime": {
    "default_mode": "persistent_terminal_session",
    "visible_terminal_required": false,
    "official_cli_only": true,
    "session_retention": {
      "scope": "daily",
      "close_at": "maintenance_end"
    }
  }
}
```

## Security Boundary

初回ドッキング時に必ず決める。

- Kairon が書いてよい path。
- Kairon が読んではいけない secret path。
- 自動 commit / push の対象 branch。
- approval 必須の操作。
- 外部 network を使ってよい persona。
- MCP / Skills の許可範囲。
- cleanup で自動 tmp 移行してよい path。

## Subscription Compliance Setup

Kairon は subscription CLI usage を前提にするため、初回ドッキング時に provider ごとの認証方式を確認する。

```json
{
  "subscription_compliance": {
    "official_cli_only": true,
    "disallow_token_extraction": true,
    "pause_on_usage_limit": true,
    "detect_api_keys": true,
    "provider_modes": {
      "codex": "chatgpt_subscription",
      "claude": "claude_pro_or_max_subscription",
      "gemini": "google_account_or_ai_subscription"
    }
  }
}
```

API key が検出された場合は、subscription usage ではなく API usage になる可能性があるため警告する。

## Initial Task Import

要件定義から deploy まで昇華するため、task source は複数許可する。

- local markdown PRD
- issue tracker
- board UI 入力
- chat command
- existing TODO / FIXME
- test failure
- maintenance finding

Import 後は必ず `planner` が task を正規化する。

## End-to-End Expansion

将来的には次の lifecycle を扱う。

```text
requirements
  -> planning
  -> design
  -> task breakdown
  -> implementation
  -> qa
  -> review
  -> approval
  -> merge
  -> deploy
  -> monitoring
  -> maintenance
```

MVP では deploy は実行しない。
deploy plan と deploy approval の作成までに留める。

## Dry Run

Docking 完了後、最初に dry run を行う。

- sample task を作る。
- planner が分解する。
- implementer が小さな変更を行う。
- reviewer / qa が結果を見る。
- approval request を Discord に送る。
- user decision を event log に保存する。
- merge / deploy は実行しない。

## MVP Scope

- `.kairon/config/*.json` を生成する。
- `.kairon/rules/*` を生成する。
- Agent availability を確認する。
- Discord approval を設定する。
- LangGraph checkpoint を設定する。
- RAG project memory を初期indexする。
- Git worktree / branch policy を設定する。
- dry run を 1 周できる。
