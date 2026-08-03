# Kairon MVP Plan v0

## 目的

Kairon MVP は、設計済みの 24 時間自律環境を最小実装に落とし、実際に対象プロジェクトへドッキングして 1 日の運用 loop を回せる状態を作る。

MVP の焦点は「多機能」ではなく、次の 5 点を実証することに置く。

1. `kairon init` で対象プロジェクトに `.kairon/` を生成できる。
2. `kairon start` で Kairon Runtime と Terminal-backed CLI Agent Session を起動できる。
3. Agent に job を渡し、outbox を回収し、review gate を通して canonical state に反映できる。
4. Discord で approval request / decision を扱える。
5. 日次メンテ終了時に handoff を作り、翌日に新 session へ引き継げる。

## MVP の定義

MVP で「動いた」と言える条件。

```text
project-root に Kairon を init
  -> Codex / Claude / Antigravity terminal session を開始
  -> sample task を queue に追加
  -> Codex に差分 job prompt を投入
  -> outbox.json を取得
  -> review feedback loop を実行
  -> event log / task state / message を更新
  -> commit / push policy を評価
  -> Discord approval を送信
  -> user decision を event 化
  -> maintenance handoff を作成
```

## MVP Scope

### 含める

- `.kairon/` directory generation
- config schema validation
- project inventory
- root rule discovery
- Terminal-backed Codex session
- Terminal-backed Claude session
- Terminal-backed Antigravity session
- Review Loop Manager
- Work Queue
- Agent Dispatcher
- Context Builder
- State Applier
- Git Workspace Manager の最小版
- Discord Approval Gateway の最小版
- file-based canonical state
- daily session scratch / handoff
- local RAG の placeholder interface

### 含めない

- Board UI
- mobile Board
- full LangGraph implementation
- full LangChain RAG implementation
- deploy execution
- merge execution
- cloud hosting
- multi-user auth
- advanced secret scanning

## Agent Scope

| Agent | MVP 扱い | 理由 |
| --- | --- | --- |
| Codex | 実CLIで対応 | coding / review / repo write / terminal session の主経路を検証する |
| Claude | 実CLIで対応 | planner / implementer / reviewer と Codex review loop を検証する |
| Antigravity | 実CLIで対応 | QA / research / Google ecosystem / multimodal review を検証する。内部 agent id は互換性のため `gemini` を維持 |

MVP では 3 Agent の実 CLI session を起動する。
ただし、code-producing job の最初の推奨 loop は Claude + Codex とする。

## Phase Plan

### Phase 0: Documentation Lock

- architecture-v0 と workflow-v0 をレビューする。
- Runtime の意味を「実行中の自律環境」として固定する。
- Terminal-backed CLI Session を標準経路として固定する。
- one-shot CLI は fallback / dry run / recovery に限定する。

### Phase 1: Project Docking

- `kairon init`
- `.kairon/config/*.json` generation
- `.kairon/rules/*` generation
- project inventory
- root rule discovery
- CLI availability check
- Discord config check

### Phase 2: Runtime Skeleton

- `kairon start`
- runtime lock
- schedule mode detection
- queue worker
- session manager
- terminal session host skeleton
- `kairon status`
- `kairon stop`

### Phase 3: CLI Session MVP

- Codex terminal session start
- Claude terminal session start
- Antigravity terminal session start
- daily bootstrap prompt injection
- incremental job prompt injection
- stdout / stderr capture
- run artifact generation
- outbox detection / fallback failure outbox

### Phase 4: State Loop

- task queue
- context builder
- dispatch request / decision
- state applier
- event append
- task materialization
- message materialization
- daily scratch update

### Phase 4.5: Review Loop

- code-producing job detection
- review.requested event
- Claude + Codex recommended review pair
- codex-plugin-cc path for Claude Opus implementation review
- configurable quality gate
- feedback loop iteration
- review escalation

### Phase 5: Git Safety

- worktree creation
- branch naming
- allowed path checks
- auto commit
- auto push flag only, initially disabled by default
- rollback metadata

### Phase 6: Discord Approval

- Discord bot connection
- Gateway process lifecycle
- slash command registration
- approval message post
- approve / reject / request_changes
- actor allowlist
- nonce / idempotency
- decision event
- `/kairon status`
- `/kairon leave`

### Phase 7: Daily Handoff

- maintenance mode trigger
- daily report artifact
- per-agent handoff
- session close
- next-day bootstrap from handoff

## MVP Directory Output

```text
.kairon/
  config/
    project.json
    runtime.json
    schedule.json
    agents.json
    dispatch.json
    policies.json
    notifications.json
    rag.json
  rules/
    common.md
    codex/AGENTS.md
    claude/CLAUDE.md
    gemini/GEMINI.md
  events/
  tasks/
  messages/
  approvals/
  runs/
  sessions/
  runtime/
    lock.json
    pids/
    terminals/
  reports/
    daily/
  cleanup/
  tmp/
```

## MVP Commands

```text
kairon init
kairon doctor
kairon start
kairon stop
kairon status
kairon task create
kairon task run TASK-0001
kairon leave
kairon maintenance run
```

詳細は `docs/cli-commands-v0.md` に分離する。

## MVP Risks

| Risk | 対応 |
| --- | --- |
| CLI session 制御が provider ごとに異なる | 3 CLI を実 adapter で起動し、fallback は foreground / one-shot に限定 |
| Terminal context が肥大化する | scratch / handoff / compaction を必須化 |
| outbox が安定しない | schema validate、structured output、failure outbox fallback |
| review loop が止まらない | max_iterations と escalation を必須化 |
| Discord interaction の二重送信 | nonce と idempotency |
| auto commit / push の事故 | MVP は auto push disabled by default |
| subscription policy の境界 | official CLI only、token extraction 禁止、API key contamination 検出 |

## Done Criteria

- `kairon init` が空ではない既存 repo に `.kairon/` を生成する。
- `kairon doctor` が CLI / config / Discord / Git 状態を検査する。
- `kairon start` が Runtime Host と Codex / Claude / Antigravity Terminal-backed Session を起動する。
- sample task を実装 Agent session に流せる。
- `runs/RUN-xxxx/outbox.json` が作られる。
- code-producing run が review gate を通過するまで done にならない。
- `events/YYYY-MM-DD.jsonl` に run 結果が追記される。
- `kairon leave` が本日の Active Work を終了させる。
- Discord approval に approve / reject / request_changes を返せる。
- `kairon maintenance run` が daily handoff を作る。
- 翌日の `kairon start` が前日 handoff を bootstrap context に含める。

## Next Documents

- `docs/config-schema-v0.md`
- `docs/cli-commands-v0.md`
- `docs/session-host-v0.md`
- `docs/state-store-v0.md`
- `docs/review-loop-v0.md`
- `docs/git-workspace-v0.md`
- `docs/discord-gateway-v0.md`
- `docs/implementation-skeleton-v0.md`
- `docs/mvp-implementation-tasks-v0.md`
- `docs/technology-stack-v0.md`
