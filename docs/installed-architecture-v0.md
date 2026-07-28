# Kairon Installed Architecture v0

## 目的

この文書は、Kairon が対象プロジェクトにプリインストールされた状態で、Agent 群がどのように起動し、読み取り、作業し、日次メンテ終了まで Session / Context を保持するかを定義する。

Kairon の Orchestrator はスイッチャーではない。
Orchestrator は制御プロトコル、状態遷移契約、policy contract を定義する層であり、どの Agent に渡すか、どの CLI process をどう動かすかは別コンポーネントが担う。

## 現行実装baseline

<!-- kairon:t192-stable-installed-baseline -->
T191時点のinstalled runtimeは、same-day Terminal-backed CLI Session、daily handoff、
state integrity / backup、Windows daemon、approval follow-up、production workflow、
Discord / Boardの外部read-only経路に加え、transactional update / rollback、
local metrics / SLO、alert policy、bounded self-healing、scheduled multi-project health、
off-device DRを持つ。以下の構成図は構想だけではなく、個人運用向け
`0.3.0` Stable Local Releaseの責務境界を示す。

packageはpublic npm registryへpublishせず、user-local Windows環境へ検証済みtarballとして
導入する。install / update / rollbackはpackage、checksum manifest、SBOM、provenance、
release manifestを検証し、state migration、staging health、post-install healthが成功した
場合だけ完了する。Boardはread-only、external writeはapproval required、
credentialはenvironmentまたは明示したOS credential storeから実行時に解決する。

Stable Acceptance 18 scenarioとStable Readiness 16 gateはsource releaseの配布可能性を
判定する。個々のinstalled projectは`doctor`、`state check`、daemon / remote statusで
継続確認し、GitHub promotion、update apply、restoreをreadinessから自動実行しない。
将来拡張は各節で明示し、実装済み経路と混在させない。

## 責務分離

| Component | 責務 | やらないこと |
| --- | --- | --- |
| Control Protocol | state schema、event schema、policy、capability、workflow contract | Agent 選択、CLI 起動 |
| Schedule Engine | active / standby / maintenance の mode 判定 | Agent 実行 |
| Work Queue | task / job / approval / maintenance item の queue 管理 | job 内容の解釈 |
| Agent Dispatcher | job と agent capability を照合し、実行候補を決める | CLI process の詳細制御 |
| Agent Runner | Codex / Claude / AntigravityCLI の起動、継続、stdout/stderr 収集 | policy 判断 |
| Session Manager | その日の Agent session と context を保持する | canonical state の直接変更 |
| Context Builder | RAG / message / task state から context bundle を作る | Agent 選択 |
| State Applier | outbox を検証し canonical state に反映する | Agent 推論 |
| Git Workspace Manager | worktree、branch、commit、push、rollback metadata | merge / deploy の自動実行 |
| Approval Gateway | Discord / Board decision を command 化する | shell command 実行 |
| Board Projection | canonical data を人間向けに表示する | canonical data の編集 |

## Installed Layout

```text
project-root/
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
      queue.json
      projection/
    events/
      YYYY-MM-DD.jsonl
    tasks/
      TASK-0001/
        task.json
        context.md
        artifacts/
    messages/
      TASK-0001.jsonl
    runs/
      RUN-0001/
        run.json
        context.md
        outbox.json
        stdout.log
        stderr.log
        artifacts/
    sessions/
      2026-05-24/
        codex/
          session.json
          context_manifest.json
          scratch.md
        claude/
          session.json
          context_manifest.json
          scratch.md
        gemini/
          session.json
          context_manifest.json
          scratch.md
    worktrees/
      TASK-0001-codex/
    runtime/
      langgraph/
      locks/
      pids/
    rag/
    approvals/
    cleanup/
    reports/
    tmp/
```

## Runtime Topology

```text
Schedule Engine
  -> Work Queue
    -> Agent Dispatcher
      -> Agent Runner
        -> Official CLI terminal session
          -> stdin / stdout / stderr / terminal session
        -> run artifacts
    -> State Applier
      -> events / tasks / messages / approvals
      -> Git Workspace Manager
      -> Board Projection
      -> Discord Approval
```

## Data Flow

### 1. Task Intake

```text
Board / Discord / local PRD / maintenance finding
  -> intake command
  -> task.propose event
  -> planner normalization job
  -> task.json
  -> queue.json
```

`task.json` は canonical source であり、Agent の自由文 summary ではない。
Board は `task.json`、`messages/*.jsonl`、`runs/*/run.json` を projection して表示する。

### 2. Dispatch

```text
queue item
  -> Schedule Engine checks mode
  -> Agent Dispatcher checks capability / availability / session
  -> lock candidate resources
  -> create run
  -> create or reuse daily agent session
```

Control Protocol は dispatch の入力と出力の schema を定義するだけで、Agent 選択自体は Agent Dispatcher が行う。

### 3. Context Assembly

```text
task.json
  + project rules
  + recent messages
  + same-day session scratch
  + RAG retrieval
  + git diff / files
  -> runs/RUN-xxxx/context.md
```

Agent Runner は `context.md` を CLI に渡す。
CLI の native context に依存しすぎないため、重要な文脈は必ず file artifact として残す。

### 4. Agent Execution

```text
Agent Runner
  -> official CLI command
  -> stdout.log / stderr.log
  -> terminal session reference
  -> outbox.json
```

Kairon は provider の内部 endpoint を呼ばない。
常に公式 CLI を process として起動し、入出力を run artifact として保存する。

### 5. State Apply

```text
outbox.json
  -> schema validation
  -> policy check
  -> event append
  -> task / message / approval materialization
  -> optional commit / push
  -> projection update
```

Agent は canonical state を直接更新しない。
Agent は outbox を出し、State Applier が検証して反映する。

## Session Model

Agent はその日の日次メンテ終了まで Session と Context を保持する。
ここでいう Session は 2 層に分ける。

| Layer | 内容 | 保存先 |
| --- | --- | --- |
| Terminal-backed CLI Session | Terminal / pty 上で保持する Codex / Claude / AntigravityCLI の継続 session | `sessions/YYYY-MM-DD/{agent}/session.json` |
| Kairon Session Context | 当日の作業要約、読んだ artifact、未完了 handoff、注意点 | `sessions/YYYY-MM-DD/{agent}/scratch.md` |

Terminal-backed CLI Session を同日中の主 memory として使う。
resume id は process crash / restart 時の recovery 補助であり、Kairon Session Context からも作業を再開できるようにする。

### session.json

```json
{
  "date": "2026-05-24",
  "agent": "codex",
  "status": "active",
  "native": {
    "type": "codex_exec",
    "thread_id": "optional-provider-session-id",
    "resume_supported": true
  },
  "current_personas": ["implementer", "reviewer"],
  "active_tasks": ["TASK-0001"],
  "last_run_id": "RUN-0004",
  "context_manifest": ".kairon/sessions/2026-05-24/codex/context_manifest.json",
  "expires_at": "2026-05-25T07:00:00+09:00"
}
```

### context_manifest.json

```json
{
  "agent": "codex",
  "date": "2026-05-24",
  "loaded_sources": [
    { "path": ".kairon/tasks/TASK-0001/task.json", "hash": "sha256:..." },
    { "path": ".kairon/messages/TASK-0001.jsonl", "hash": "sha256:..." },
    { "path": ".kairon/runs/RUN-0003/outbox.json", "hash": "sha256:..." }
  ],
  "open_questions": [
    "approval UI の差し戻し理由入力を modal にするか"
  ],
  "handoff_notes": [
    "reviewer は RUN-0003 の diff と secret scan 結果を確認する"
  ]
}
```

## Daily Context Lifecycle

### Start Of Day

```text
read previous daily report
read unresolved approvals
read open tasks
read yesterday session handoffs
refresh RAG index if needed
create sessions/YYYY-MM-DD/{agent}
```

前日の Terminal-backed CLI Session は使わない前提でよい。
翌日は canonical state、daily report、handoff、RAG から context を再構築する。

### During Day

```text
Agent Runner keeps same-day session active
each run appends outbox
Session Manager updates scratch.md
messages record inter-agent handoff
```

当日の中では、Agent の Terminal-backed CLI Session を再利用する。
ただし、重要情報は必ず `.kairon/` に保存し、terminal session のみを唯一の記憶にしない。

### Maintenance End

```text
close active runs
flush session scratch
write daily report
write agent handoff
write cleanup proposals
update RAG index
mark same-day sessions closed
```

日次メンテ終了時点で、翌日に必要な情報を canonical artifact に落とす。
これにより、翌日以降は前日の作業記録を読み込めば再開できる。

## CLI Launch Modes

Vendor 側が「Terminal window が見えているか」を直接 policy boundary として判断しているとは限らない。
Kairon の設計上の境界は、可視 Terminal の有無ではなく、公式 CLI / 公式認証 / provider quota / provider policy に従うことに置く。

| Mode | 用途 | 扱い |
| --- | --- | --- |
| foreground_terminal | 初回 login、手動 debugging、user-approved run | 任意 |
| persistent_terminal_session | scheduled job、maintenance、QA、review | 標準 |
| background_child_process | one-shot fallback、dry run、recovery | 必要時 |
| unofficial_api_client | token 抽出、内部 endpoint 直叩き | 禁止 |

Agent Runner は可視 Terminal に依存しない。
必要なのは、公式 CLI process を起動し、stdin/stdout/stderr、exit code、terminal session id、artifact を追跡できることである。

## Agent Runner Contract

```json
{
  "runner_id": "RUNNER-codex-20260524",
  "agent": "codex",
  "mode": "persistent_terminal_session",
  "command": "codex",
  "args": ["exec", "--sandbox", "workspace-write", "-"],
  "stdin_path": ".kairon/runs/RUN-0001/context.md",
  "stdout_path": ".kairon/runs/RUN-0001/stdout.log",
  "stderr_path": ".kairon/runs/RUN-0001/stderr.log",
  "worktree": ".kairon/worktrees/TASK-0001-codex",
  "session_path": ".kairon/sessions/2026-05-24/codex/session.json",
  "timeout_seconds": 3600,
  "expected_outbox": ".kairon/runs/RUN-0001/outbox.json"
}
```

## Process State

```json
{
  "run_id": "RUN-0001",
  "agent": "codex",
  "pid": 12345,
  "status": "running",
  "started_at": "2026-05-24T10:00:00+09:00",
  "last_output_at": "2026-05-24T10:02:30+09:00",
  "mode": "persistent_terminal_session",
  "kill_policy": "graceful_then_force",
  "usage_limit_detected": false
}
```

## Installed Workflow

### Active Work Time

```text
Morning agenda
  -> approval review
  -> cleanup triage
  -> daily plan
  -> dispatch approved implementation jobs
  -> same-day sessions stay warm
```

### Standby Work Time

```text
finish current approved jobs
defer unclear or high-risk items
send Discord approvals
keep sessions alive if active work remains
```

### Maintenance Time

```text
QA
research
test generation
diff review
cleanup proposal
RAG re-index
daily report
handoff generation
session close at maintenance end
```

## Open Design Questions

- Claude Code の subscription session を同日中どこまで unattended continuation してよいか。
- persistent_terminal_session を標準にした場合の session compaction / context overflow の制御。
- Session を agent 単位にするか、persona 単位にするか。
- 同一 Agent が複数 task を並行する場合、terminal session を分けるか。
