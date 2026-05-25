# Kairon MVP Implementation Tasks v0

## 目的

この文書は `docs/implementation-skeleton-v0.md` を実装可能な task backlog に分解する。
Kairon の最初の実装は、全機能を一度に作らず、file-based state と CLI の往復を先に成立させる。

## 実装原則

- code-producing change は review gate を通す。
- MVP acceptance では Codex / Claude / AntigravityCLI の実 CLI session を必須にする。
- local unit test では process を起動しない fake runner を使ってよい。
- State Applier だけが canonical state を更新する。
- Discord Gateway と Agent Runner は command / outbox を作るだけで、canonical state を直接変更しない。
- Git commit / push は Git Workspace Manager だけが実行する。

## Milestone 0: Project Scaffold

目的: Kairon を TypeScript project として起動可能にする。

### T0-01 package scaffold

成果物。

- `package.json`
- `tsconfig.json`
- `src/cli/main.ts`
- `src/index.ts`
- `tests/`

Done Criteria。

- `npm run typecheck` が実行できる。
- `npm test` が実行できる。
- `npm run kairon -- --help` が実行できる。

### T0-02 development scripts

成果物。

- `npm run kairon`
- `npm run typecheck`
- `npm test`
- `npm run build`

Done Criteria。

- Windows PowerShell で scripts が動作する。
- build output は `dist/` に出る。

## Milestone 1: Core File State

目的: `.kairon/` の file-based canonical state を安全に読み書きできるようにする。

### T1-01 path utilities

成果物。

- `src/core/fs/paths.ts`

Done Criteria。

- project root から `.kairon/` path を解決できる。
- Windows path と POSIX-like relative path を混同しない。
- repository 外への path traversal を拒否できる。

### T1-02 JSON / JSONL utilities

成果物。

- `src/core/fs/json-file.ts`
- `src/core/fs/jsonl-file.ts`

Done Criteria。

- JSON を atomic write できる。
- JSONL に append できる。
- parse failure 時に file path を含む error を返す。

### T1-03 lock file

成果物。

- `src/core/fs/lock-file.ts`
- `src/state/state-lock.ts`

Done Criteria。

- lock acquire / release ができる。
- expired lock を検出できる。
- 同時 writer を拒否できる。

### T1-04 counters

成果物。

- `src/core/ids/counter.ts`

Done Criteria。

- `.kairon/state/counters.json` を使って monotonic id を発行できる。
- `TASK-0001`、`RUN-0001`、`EVT-000001` を生成できる。

## Milestone 2: Config And Init

目的: 対象 repository に Kairon を dock できるようにする。

### T2-01 config defaults

成果物。

- `src/core/config/defaults.ts`
- `src/core/config/load-config.ts`

Done Criteria。

- `project.json`、`runtime.json`、`schedule.json`、`agents.json`、`dispatch.json`、`policies.json`、`notifications.json`、`rag.json` の default を生成できる。
- 旧プロジェクト名を生成しない。

### T2-02 config validation

成果物。

- `src/core/config/validate-config.ts`
- `src/core/schema/validators.ts`

Done Criteria。

- `schema_version` の欠落を検出する。
- `policies.review.required_for_code=false` を拒否する。
- MVP では `agents.codex/claude/gemini.enabled=true` を要求する。
- `allow_auto_push=true` の場合は warning を出す。

### T2-03 `kairon init`

成果物。

- `src/cli/commands/init.ts`

Done Criteria。

- `.kairon/` directory tree を生成する。
- 既存 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` を上書きしない。
- `.kairon/rules/` に Kairon 用 rule を生成する。
- `.kairon/` を `.gitignore` に追加する提案を出せる。

## Milestone 3: Event Store And Materializers

目的: canonical event から materialized state を作れるようにする。

### T3-01 event log

成果物。

- `src/core/events/event-log.ts`
- `src/core/events/event-types.ts`

Done Criteria。

- `events/YYYY-MM-DD.jsonl` に event append できる。
- event id を counters から採番できる。
- event schema version を必ず含める。

### T3-02 materializers

成果物。

- `src/state/materializers.ts`

Done Criteria。

- `task.created` から `tasks/TASK-xxxx/task.json` を生成する。
- `message.created` から `messages/TASK-xxxx.jsonl` に append する。
- `approval.requested` から `approvals/APR-xxxx.json` を生成する。
- `approval.decided` で approval status を更新する。
- `active_work.closed` で schedule override を確認できる。

### T3-03 State Applier

成果物。

- `src/state/state-applier.ts`

Done Criteria。

- outbox を validate して event 化できる。
- internal command を event 化できる。
- state lock 下で二重適用を防ぐ。
- apply result に applied event ids を返す。

## Milestone 4: Queue And Commands

目的: CLI / Discord / runtime から来る作業を queue で処理できるようにする。

### T4-01 Work Queue

成果物。

- `src/queue/work-queue.ts`

Done Criteria。

- enqueue / claim / complete / fail ができる。
- claimed item の timeout を検出できる。
- priority 順に claim できる。

### T4-02 Command Inbox

成果物。

- `src/queue/command-inbox.ts`

Done Criteria。

- `approval.decide` を保存できる。
- `approval.snooze` を保存できる。
- `schedule.close_active_work` を保存できる。
- idempotency key を保存できる。

### T4-03 Queue Worker

成果物。

- `src/queue/queue-worker.ts`

Done Criteria。

- queue item type ごとに handler へ route できる。
- handler failure を queue item に記録できる。
- schedule override が active work dispatch を止める。

## Milestone 5: Runtime And CLI

目的: Kairon Runtime を起動・停止・確認できるようにする。

### T5-01 runtime lock

成果物。

- `src/runtime/runtime-lock.ts`

Done Criteria。

- `kairon start` 時に lock を取得する。
- 既存 lock が有効なら exit code 3 を返す。
- stale lock を検出できる。

### T5-02 schedule engine

成果物。

- `src/runtime/schedule-engine.ts`

Done Criteria。

- active / standby / maintenance を判定できる。
- `state/schedule_override.json` がある場合は Active Work を閉じる。

### T5-03 runtime status

成果物。

- `src/runtime/status.ts`
- `src/cli/commands/status.ts`

Done Criteria。

- schedule mode、runtime lock、queue length、pending approvals を表示できる。

### T5-04 `kairon leave`

成果物。

- `src/cli/commands/leave.ts`

Done Criteria。

- `schedule.close_active_work` command を command inbox に入れる。
- State Applier が `schedule.override.created` と `active_work.closed` を作る。
- exit code 0 で終了する。

## Milestone 6: Agent Interfaces

目的: 実 CLI session を接続する前に、境界と artifact を固定する。

### T6-01 dispatcher

成果物。

- `src/agents/dispatcher.ts`

Done Criteria。

- persona / policy / available sessions から agent を選べる。
- MVP では implementer default を Codex にできる。
- Google ecosystem / multimodal では Gemini を優先候補にできる。

### T6-02 context builder

成果物。

- `src/agents/context-builder.ts`

Done Criteria。

- task / messages / rules / scratch から context bundle を作る。
- human summary を canonical state に書かない。

### T6-03 session host interface

成果物。

- `src/agents/session-host.ts`
- `src/agents/adapters/codex.ts`
- `src/agents/adapters/claude.ts`
- `src/agents/adapters/gemini.ts`

Done Criteria。

- Codex / Claude / AntigravityCLI の command availability を確認できる。
- session metadata を作れる。
- 実 process 接続は次 milestone へ分離できる。

## Milestone 7: Git And Review Gate Skeleton

目的: review-before-commit の境界をコードにする。

### T7-01 git workspace allocation

成果物。

- `src/git/workspace-manager.ts`

Done Criteria。

- branch name を生成できる。
- worktree path を生成できる。
- protected branch を拒否できる。

### T7-02 diff snapshot

成果物。

- `src/git/diff-snapshot.ts`

Done Criteria。

- changed files metadata を保存できる。
- diff hash を保存できる。
- review 後に diff が変わった場合は再 review に戻せる。

### T7-03 review gate skeleton

成果物。

- `src/review/review-loop-manager.ts`
- `src/review/quality-gate.ts`

Done Criteria。

- code-producing job を検出できる。
- review result から pass / fail を判定できる。
- max_iterations 超過で approval queue へ escalated review を作る。

## Milestone 8: Discord Gateway Skeleton

目的: Discord 経由の approval / leave command を受けられる骨格を作る。

### T8-01 gateway service

成果物。

- `src/discord/gateway.ts`

Done Criteria。

- env 不足時に disabled として起動できる。
- enabled かつ env が揃う場合に Gateway 起動準備ができる。

### T8-02 interaction normalization

成果物。

- `src/discord/interactions.ts`
- `src/discord/idempotency.ts`

Done Criteria。

- custom_id を parse できる。
- actor / channel / nonce を検証できる。
- duplicate interaction を拒否できる。

### T8-03 approval message builder

成果物。

- `src/discord/approval-message.ts`

Done Criteria。

- approval から Discord 表示用 payload を作れる。
- full diff / log / secret-like data を含めない。

## Milestone 9: Real CLI Session MVP

目的: Codex / Claude / AntigravityCLI 実 CLI session を接続する。

### T9-01 Codex session

Done Criteria。

- `codex` availability を確認する。
- daily bootstrap を投入する。
- job prompt を送れる。
- stdout / stderr / outbox を `runs/RUN-xxxx` に保存する。

### T9-02 Claude session

Done Criteria。

- `claude` availability を確認する。
- daily bootstrap を投入する。
- job prompt を送れる。
- Claude Opus implementation 時の Codex review path を作れる。

### T9-03 Antigravity/Gemini session

Done Criteria。

- `agy` availability を確認する。
- daily bootstrap を投入する。
- Google ecosystem / multimodal / QA job を送れる。

## Milestone 10: Daily Handoff

目的: 1日の運用を閉じ、翌日に引き継げるようにする。

### T10-01 daily report

成果物。

- `src/maintenance/daily-report.ts`

Done Criteria。

- run / approval / review / git transaction を日次単位で集約できる。

### T10-02 handoff

成果物。

- `src/maintenance/handoff.ts`

Done Criteria。

- agent ごとの handoff を作れる。
- 翌日の bootstrap source に含められる。

### T10-03 cleanup proposals

成果物。

- `src/maintenance/cleanup-proposals.ts`

Done Criteria。

- tmp 移行候補を proposal として作る。
- 直接削除しない。
- MorningReview の最初の task にできる。

## Cross-Milestone Review Gate

各 milestone の code-producing change は次を満たす。

- test 実行結果がある。
- Codex self-review を残す。
- 可能な場合は Claude review を追加する。
- high / critical finding がない。
- review result を `docs/reviews/` または `.kairon/runs/` に保存する。

## 最初に実装する範囲

最初の coding slice は T0-01 から T3-03 までに限定する。

理由。

- `.kairon/` 生成、event log、State Applier が成立すると、以降の Agent / Git / Discord を安全に接続できる。
- ここまでは外部 API や Discord token が不要。
- review gate を小さい差分で回せる。
