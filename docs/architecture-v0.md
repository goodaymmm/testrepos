# Kairon Architecture v0

## 目的

この文書は、対象プロジェクトに Kairon をプリインストールした状態の静的アーキテクチャだけを定義する。
起動順序、日次運用、Job 実行手順は `docs/workflow-v0.md` に分離する。
実装 module 構成と内部 API は `docs/implementation-skeleton-v0.md` に分離する。

## T175実装baseline

<!-- kairon:t175-architecture-baseline -->
T175時点では、file-based canonical state、公式CLI session、approval / review / Git guard、Windows daemon、Watchdog / Incident recovery、branch / join / compensationを含むproduction workflow、durable checkpoint store、capability trust policy、hybrid local RAG、multi-project supervisor、Discord Gateway / HTTP Interactions、stable remote read-only Board、reproducible local package、verified update / rollback、Release Candidate readiness 14 gateまでを実装・operation test済みである。

`.kairon/`をcanonical sourceとする境界、external writeのapproval、Boardのread-only、public npmへpublishしない方針は継続する。credentialはenvironmentまたは明示したOS credential storeから実行時に解決し、canonical stateやevidenceへ保存しない。`.kairon/experimental/workflows/`はcandidate compatibility pathであり、production workflow stateは`.kairon/workflows/`に保存する。

T187ではdeterministic capacity benchmark、絶対値budget、同一環境baseline比を追加し、
`PERFORMANCE_REGRESSION`を15番目のRC gateとして接続する。benchmark artifactは
`.kairon/performance/`へ保存し、hostname、username、credential、project source本文を
含めない。実時間の閾値は通常unit testから分離する。

T188ではdependency / lockfile / license、archive / portable path、credential redaction、
HTTP、child process、generated artifact、canonical stateを`security_baseline_result`へ
集約する。既存`SECURITY_INTEGRITY` gateはexternal-requiredとなり、offline checkが
PASSでもfreshなnpm audit evidenceがなければ`SETUP_REQUIRED`とする。

## 前提

- Kairon は対象プロジェクトの root にインストールされる。
- Kairon Runtime は、Kairon が実行中に構築する自律稼働環境である。
- Orchestrator は実行スイッチャーではなく、制御プロトコルである。
- Agent 選択は Agent Dispatcher が担う。
- CLI Session の起動、維持、stdin / stdout / stderr 収集は Agent Session Host が担う。
- canonical source は `.kairon/` 配下の JSON / JSONL / MD である。

## 用語

| Term | 意味 |
| --- | --- |
| Kairon Runtime | `kairon start` 後に動作する実行中の自律環境 |
| runtime.json | Kairon Runtime の挙動を決める設定 |
| Agent Session | Terminal / pty 上で保持される CLI Agent の継続 session |
| Agent Runner | Agent Session に job 指示を投入し、結果を収集する実行制御 |

この文書での Runtime は「実行時のこと」、つまり Kairon が起動して Component 群を呼び出し、自律環境を構築している状態を指す。
「実行時に必要なもの」は config、binary、rules、state store として別に扱う。

## Project Root Topology

```text
project-root/
  AGENTS.md
  CLAUDE.md
  GEMINI.md
  .kairon/
    config/
      project.json
      schedule.json
      agents.json
      dispatch.json
      policies.json
      runtime.json
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
    worktrees/
    runtime/
    watchdog/
    incidents/
    rag/
    reports/
    cleanup/
    tmp/
```

Root の `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` は既存プロジェクトのルールとして扱う。
Kairon 固有の追加ルールは `.kairon/rules/` に置き、既存ファイルを上書きしない。

## Static Component Map

```text
Kairon Runtime Host
  ├─ Control Protocol
  ├─ Schedule Engine
  ├─ Work Queue
  ├─ Agent Dispatcher
  ├─ Agent Session Host
  │   ├─ Codex Terminal Session
  │   ├─ Claude Terminal Session
  │   └─ Antigravity Terminal Session
  ├─ Agent Runner
  ├─ Session Manager
  ├─ Context Builder
  ├─ State Applier
  ├─ Incident Lifecycle
  ├─ Git Workspace Manager
  ├─ RAG Memory Service
  ├─ Discord Approval Gateway
  └─ Board Projection Server
```

## Responsibility Boundaries

| Component | 責務 |
| --- | --- |
| Kairon Runtime Host | 各 service の process lifecycle を管理する local host |
| Control Protocol | schema、state transition、policy contract、capability contract |
| Schedule Engine | active / standby / maintenance の現在 mode を判定する |
| Work Queue | task、job、approval、maintenance item の queue を保持する |
| Agent Dispatcher | job に対して利用可能な Agent / persona / runner mode を決める |
| Agent Session Host | 公式 CLI を Terminal / pty session として起動し、日次メンテ終了まで保持する |
| Agent Runner | 既存 Agent Session に job 指示を投入し、ログと outbox を収集する |
| Session Manager | 同日 Agent session と context manifest を保持する |
| Context Builder | task、message、RAG、session scratch から context bundle を作る |
| State Applier | outbox を検証し、canonical state に反映する |
| Incident Lifecycle | Watchdog alertとrecovery targetを参照で集約し、timelineと承認付き復旧を管理する |
| Git Workspace Manager | worktree、branch、commit、push、rollback metadata を扱う |
| RAG Memory Service | canonical source から derived index を生成・検索する |
| Discord Approval Gateway | Discord interaction を approval decision command に変換する |
| Board Projection Server | canonical data を UI 表示用に projection する |

## Runtime Process Boundary

```text
User / OS service / scheduled task
  -> kairon start
    -> Kairon Runtime Host
      -> Board Server process
      -> Discord Gateway process
      -> Queue Worker process
      -> RAG Worker process
      -> Agent Session Host
        -> codex CLI terminal session
        -> claude CLI terminal session
        -> agy CLI terminal session
```

Kairon Runtime Host は各 CLI の内部 API を呼ばない。
Agent Session Host が公式 CLI を persistent terminal session として起動し、Agent Runner がその session に job 指示を投入する。

## Control Protocol Is Not A Switcher

Control Protocol は以下を定義する。

- task schema
- run schema
- outbox schema
- approval schema
- message schema
- policy schema
- capability schema
- dispatch request / decision schema

Control Protocol は以下を行わない。

- Agent の選択
- CLI process の起動
- stdout / stderr の読み取り
- commit / push の実行
- Discord bot の接続

## Agent Dispatch Architecture

Agent Dispatcher は `dispatch.json` と runtime 状態を読む。

```json
{
  "dispatch_request": {
    "task_id": "TASK-0001",
    "persona": "implementer",
    "model_class": "coding",
    "capabilities": ["filesystem.write", "git.commit", "git.push"],
    "resources": ["repo:path:src/**"],
    "schedule_mode": "active_work"
  },
  "dispatch_decision": {
    "agent": "codex",
    "runner_mode": "persistent_terminal_session",
    "session_scope": "daily",
    "reason": "coding persona and workspace-write capability"
  }
}
```

Dispatcher の出力は command ではない。
実際の command line は Agent Runner が adapter 設定から生成する。

## Agent Runtime Architecture

```text
Agent Session Host
  -> load agent adapter
  -> start or attach same-day terminal session
  -> inject daily bootstrap context once
  -> keep stdin/stdout/stderr streams open

Agent Runner
  -> receive dispatch decision
  -> receive context bundle path
  -> build incremental job prompt
  -> send prompt to existing Agent Session
  -> stream stdout / stderr
  -> collect or synthesize outbox
  -> update session store
```

Runner が保持する情報。

```text
.kairon/runtime/pids/
.kairon/runtime/terminals/
.kairon/runs/RUN-xxxx/stdout.log
.kairon/runs/RUN-xxxx/stderr.log
.kairon/runs/RUN-xxxx/outbox.json
.kairon/sessions/YYYY-MM-DD/{agent}/session.json
.kairon/sessions/YYYY-MM-DD/{agent}/context_manifest.json
.kairon/sessions/YYYY-MM-DD/{agent}/scratch.md
```

## Session And Context Architecture

Session は 2 層に分ける。

| Layer | 内容 | 目的 |
| --- | --- | --- |
| Terminal-backed CLI Session | Terminal / pty 上で開いた Codex / Claude / AntigravityCLI の継続 session | 同日中の会話 context を保ち、毎回 0 から読ませない |
| Kairon Session Context | scratch、context manifest、handoff、loaded source hash | CLI session が切れても再開できるようにする |

```text
Same-day bootstrap context
  = task.json
  + messages/*.jsonl
  + runs/*/outbox.json
  + sessions/YYYY-MM-DD/{agent}/scratch.md
  + RAG retrieval
  + project rules
```

同日中の各 job は、bootstrap context 全体ではなく差分 job prompt を既存 Terminal-backed CLI Session に投入する。
翌日は Terminal-backed CLI Session に依存しない。
前日 daily report、handoff、events、RAG index から context を再構築する。

## Canonical State Boundary

Agent は canonical state を直接変更しない。
Agent は worktree と run artifact に出力する。

```text
Agent output
  -> runs/RUN-xxxx/outbox.json
  -> State Applier
  -> events/YYYY-MM-DD.jsonl
  -> tasks/*/task.json
  -> messages/*.jsonl
  -> approvals/*.json
```

これにより、Agent の出力と state 反映を分離する。

## Vendor Policy Boundary

Kairon の policy boundary は「Terminal window が見えているか」ではない。
Kairon が守る境界は次である。

- 公式 CLI を公式認証状態で起動する。
- OAuth token、session cookie、内部 endpoint を抽出しない。
- quota、rate limit、protective measure を回避しない。
- API key usage と subscription usage を混ぜない。
- usage limit / permission prompt を検出したら run を止める。
- すべての run について command、pid、exit code、stdout、stderr、outbox を保存する。

## Provider Adapter Boundary

| Agent | Runtime boundary | Session strategy |
| --- | --- | --- |
| Codex | `codex` / `codex exec` の公式 CLI process | Terminal-backed session primary。resume は recovery 補助 |
| Claude | `claude` / `claude -p` 等の公式 CLI process | Terminal-backed session primary。unattended は restricted |
| Antigravity | `agy` / `agy --prompt-interactive` 等の公式 CLI process | Terminal-backed session primary。QA / research を優先。Kairon 内部の agent id は互換性のため `gemini` を維持 |

Provider ごとの細部は `docs/agent-runtime-v0.md` と `docs/subscription-compliance-v0.md` に置く。

## External Interfaces

```text
Human
  -> Board UI
  -> Discord Approval

Project
  -> Git repository
  -> Test / lint / build command
  -> root rule files

Vendors
  -> Official CLI process only

Kairon
  -> JSON / JSONL / MD state
  -> RAG derived index
  -> Git worktree
```

## Architecture Decisions

- Kairon Runtime Host は起動責務だけを持つ。
- Orchestrator / Control Protocol は Agent selection を持たない。
- Agent Dispatcher と Agent Runner を分離する。
- Terminal-backed CLI Session を同日中の主 memory とする。
- Provider resume id は recovery 補助であり、唯一の memory にしない。
- Kairon Session Context を同日中の継続 memory とする。
- 日次メンテ終了時に翌日再構築可能な artifact へ落とす。
- Discord は承認 channel であり、command execution channel ではない。
