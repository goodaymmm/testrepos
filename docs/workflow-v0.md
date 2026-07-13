# Kairon Workflow v0

## 目的

この文書は、Kairon をどのように開始し、CLI Agent の Session / Context をどのように保持し、各 vendor policy boundary をどのタイミングで確認するかを時系列だけで定義する。
静的なコンポーネント構成は `docs/architecture-v0.md` に分離する。

## 0. 初回プリインストール

```text
user runs kairon init
  -> project inventory
  -> root rule discovery
  -> create .kairon/config
  -> create .kairon/rules
  -> create .kairon/runtime
  -> create .kairon/sessions
  -> verify official CLI availability
  -> verify Discord bot config
  -> initialize RAG index
  -> dry run
```

初回に確認する CLI。

```text
codex --version
claude --version
agy --help
```

ログインが必要な場合は、Kairon は自動化せず setup task として止める。

## 1. Kairon Start

```text
user or OS runs kairon start
  -> acquire runtime lock
  -> load .kairon/config/runtime.json
  -> load .kairon/config/schedule.json
  -> load .kairon/config/agents.json
  -> load .kairon/config/dispatch.json
  -> load .kairon/config/policies.json
  -> start Board Projection Server
  -> start Discord Approval Gateway
  -> start Queue Worker
  -> start RAG Worker
  -> start Session Manager
  -> start Agent Session Host
  -> restore today's terminal sessions or create new terminal sessions
  -> inject daily bootstrap context into enabled Agent sessions
  -> enter schedule loop
```

`kairon start` は Runtime Host と日次 Agent Session を起動する。
ただし、起動直後に task を勝手に進めるわけではない。
最初に Kairon Runtime を構築し、各 enabled Agent の Terminal-backed CLI Session に日次 bootstrap context を投入する。
その後、queue と schedule に基づいて必要な job 指示だけを既存 session に流す。

## 2. Start Preflight

```text
check project root
check git status
check protected paths
check config schema
check runtime lock
check Discord connection
check CLI binaries
check API key contamination
check previous crash recovery
```

API key contamination とは、subscription usage 前提なのに `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY` などが検出される状態を指す。
検出した場合、Kairon は warning を出し、その Agent を pause するか user approval を要求する。

## 3. Session Restore

```text
if sessions/YYYY-MM-DD exists
  -> load session.json for each agent
  -> attach existing terminal session if alive
  -> verify native resume support only for recovery
  -> load scratch.md
  -> load context_manifest.json
else
  -> create sessions/YYYY-MM-DD/{codex,claude,gemini}
  -> start terminal session for each enabled agent
  -> read previous daily report
  -> read unresolved handoff
  -> read open approvals
  -> create daily bootstrap context
  -> inject bootstrap context into each enabled agent session
```

同日中は Terminal-backed CLI Session を優先する。
翌日は前日の Terminal-backed CLI Session を前提にせず、前日 artifact から bootstrap context を再構築する。
resume id は session crash / process restart 時の recovery 補助であり、翌日運用の主経路ではない。

## 4. Schedule Loop

```text
every tick
  -> determine schedule mode
  -> apply schedule override
  -> read queue
  -> enqueue mode-specific jobs
  -> dispatch eligible jobs
```

Schedule mode。

```text
active_work_time
standby_work_time
maintenance_time
```

Morning Review は mode ではなく、active_work_time の先頭 agenda として処理する。

`kairon leave` により `active_work_closed_for_today` override が有効な場合、Active Work Time 内でも新規 active work job は dispatch しない。

## 5. Job Dispatch Workflow

```text
queue item selected
  -> build dispatch_request
  -> Agent Dispatcher evaluates capability and availability
  -> Agent Dispatcher emits dispatch_decision
  -> Session Manager selects same-day terminal session
  -> Context Builder creates incremental job context
  -> Policy Guard runs pre-launch checks
  -> Agent Runner sends job prompt to existing official CLI session
```

Control Protocol は `dispatch_request` と `dispatch_decision` の schema だけを定義する。
Agent を選ぶのは Agent Dispatcher である。

## 6. Context Build Workflow

```text
read task.json
read relevant messages
read same-day scratch.md
read previous outbox artifacts
query RAG with metadata filters
read project rules only if not already loaded in daily session
read target files or git diff
write runs/RUN-xxxx/context.md
write runs/RUN-xxxx/context_sources.json
```

`context.md` は CLI Agent に渡す job 単位の差分入力である。
日次 bootstrap 済みの内容を毎回すべて再送しない。
Terminal-backed CLI Session に重要情報を閉じ込めず、重要な判断や結果は outbox / message / scratch に落とす。

Terminal-backed CLI Session は Kairon からの再送量を減らすための仕組みである。
ただし、vendor 側の model context が無限に保持されるわけではないため、長時間 session では要約、compaction、handoff を挟む。

## 7. Vendor Policy Pre-Launch Gate

```text
before CLI launch
  -> assert official_cli_only
  -> assert no token extraction
  -> assert no unofficial endpoint
  -> assert no quota sharding
  -> detect API key contamination
  -> verify allowed tools / permissions
  -> verify approval requirements
  -> verify command and args are from adapter template
```

この gate は Terminal window の可視性を見ない。
見るのは、公式 CLI、公式認証、権限、usage、ログ追跡である。

## 8. Agent Launch Workflow

### Codex

```text
Agent Runner
  -> attach codex terminal session
  -> send incremental context.md as next prompt
  -> stream stdout / stderr
  -> store JSONL or final message
  -> detect usage limit / permission prompt
  -> collect outbox
```

Codex は同日中の Terminal-backed CLI Session を基本にする。
`codex exec` は one-shot fallback、dry run、recovery 用に使える。
resume id が取得できる場合は recovery 補助として同日 session に保存する。

### Claude

```text
Agent Runner
  -> attach claude terminal session
  -> send incremental context as next prompt
  -> stream structured output
  -> detect permission prompt / usage boundary
  -> collect outbox
```

Claude は unattended mode を `restricted` とする。
`ANTHROPIC_API_KEY` が存在する場合は subscription usage と異なる可能性があるため、その run を止めて user confirmation に回す。

### Antigravity

```text
Agent Runner
  -> attach Antigravity terminal session backed by agy
  -> send incremental context as next prompt
  -> request file-based outbox output
  -> detect usage limit / permission prompt
  -> collect outbox
```

Antigravity は QA、research、large context review、Google ecosystem、multimodal review を優先する。
Kairon 内部の agent id は互換性のため `gemini` を維持する。
AntigravityCLI の背後 service に third-party client として直接アクセスしない。

## 9. Runtime Monitoring

```text
while process running
  -> append stdout.log
  -> append stderr.log
  -> update pids/RUN-xxxx.json
  -> detect no-output timeout
  -> detect login required
  -> detect usage limited
  -> detect permission prompt
  -> detect outbox written
```

検出結果。

| Detected state | Action |
| --- | --- |
| login required | setup approval に回す |
| usage limited | Agent を pause / defer |
| permission prompt | approval queue に積む |
| no output timeout | graceful stop 後 retry / handoff |
| outbox missing | failure outbox を生成 |
| policy blocked | run failed として State Applier へ渡す |

## 10. Outbox Apply Workflow

```text
process exits
  -> collect exit code
  -> locate outbox.json
  -> schema validate
  -> policy validate
  -> append events
  -> materialize task state
  -> materialize messages
  -> materialize approvals
  -> update Board projection
  -> update same-day scratch.md
```

Agent が `outbox.json` を生成できなかった場合。

```text
try structured output conversion
  -> try final message extraction
  -> create minimal failure outbox
```

## 11. Git Workflow

```text
if outbox requests commit / push
  -> snapshot diff.patch / changed-files.json
  -> verify branch prefix
  -> verify protected branch not targeted
  -> verify lock ownership
  -> verify review gate passed
  -> verify diff hash unchanged
  -> run configured checks
  -> secret scan
  -> start git transaction
  -> commit
  -> push only if policy allows
  -> record commit_sha / parent_sha / rollback metadata
```

Merge / deploy はここでは実行しない。
必ず approval を作成する。

詳細は `docs/git-workspace-v0.md` に分離する。

## 12. Agent Handoff Workflow

```text
Agent A finishes run
  -> writes outbox
  -> State Applier writes message
  -> Session Manager updates Agent A scratch
  -> Work Queue creates next job
  -> Context Builder reads message for Agent B
  -> Agent B receives context.md
```

Agent 同士の直接会話は必須にしない。
handoff は canonical message と context bundle で行う。

## 13. Discord Approval Workflow

```text
approval.requested event
  -> Discord Approval Gateway posts message
  -> user clicks approve / reject / request_changes / snooze
  -> Discord interaction arrives through Gateway
  -> validate actor
  -> validate nonce
  -> validate approval status
  -> create decision command
  -> Work Queue
  -> State Applier
  -> approval.decided event
```

Discord は approval channel であり、shell command execution channel ではない。
Gateway の詳細は `docs/discord-gateway-v0.md` に分離する。

## 14. Same-Day Session Update

```text
after every run
  -> update session.json last_run_id
  -> update context_manifest.json loaded sources
  -> append scratch.md with operational memory
  -> persist terminal session state
  -> persist native resume id if available for recovery
```

`scratch.md` は人間向け要約ではない。
同日中に次の CLI Agent run へ渡す作業記憶である。

## 15. Maintenance Workflow

```text
maintenance_time starts
  -> run QA jobs
  -> run research jobs
  -> run test generation jobs
  -> run diff review jobs
  -> create cleanup proposals
  -> refresh RAG index
  -> create next-day plan
  -> create approval queue
```

Maintenance 中も write job は capability と policy に従う。
cleanup は原則 proposal を作る。

## 15.5 Leave Workflow

```text
user runs kairon leave or Discord /kairon leave
  -> create schedule.override.created event
  -> write state/schedule_override.json
  -> emit active_work.closed event
  -> stop dispatching new active_work jobs
  -> let safe active runs finish or checkpoint
  -> move unresolved decisions to approval queue
  -> switch dispatch policy to standby_work for the rest of today
  -> notify Discord if enabled
```

`kairon leave` は Kairon Runtime を停止しない。
本日の Active Work を終了し、以降は Standby Work 相当の非常勤運用へ切り替える。

## 16. Maintenance End And Session Close

```text
maintenance_time ends
  -> stop accepting new same-day jobs
  -> wait or gracefully stop active runs
  -> flush session scratch
  -> write daily report
  -> write agent handoff files
  -> update RAG index
  -> mark sessions closed
  -> release runtime locks if stopping
```

この時点で翌日の再開に必要な情報を canonical artifact に落とす。

## 17. Next Day Restore

```text
next kairon start or next active day
  -> close previous day terminal sessions
  -> read daily report
  -> read handoff files
  -> read unresolved approvals
  -> read open tasks
  -> query RAG
  -> create new terminal sessions
  -> inject previous-day handoff as bootstrap context
```

前日の Terminal-backed CLI Session が残っていても、翌日再開の主記憶にはしない。

## 18. Stop Workflow

```text
user runs kairon stop
  -> stop dispatching new jobs
  -> notify active runners
  -> graceful shutdown timeout
  -> persist process state
  -> flush logs
  -> close Discord Gateway
  -> close Board Server
  -> release runtime lock
```

停止しても canonical state は残る。
次回 `kairon start` で recovery workflow が走る。

## 19. Recovery Workflow

```text
kairon start detects dirty runtime
  -> read pids
  -> inspect runs without terminal state
  -> mark orphan processes
  -> validate partial outbox
  -> recover or fail run
  -> requeue safe jobs
  -> require approval for ambiguous jobs
```

ambiguous job は自動再実行しない。
二重 commit / push を避けるため approval queue に積む。

## 20. Workflow Decisions

- Kairon start は Runtime Host と日次 Terminal-backed CLI Session を起動する。
- CLI Agent は日次 session として先に起動し、job は差分 prompt として投入する。
- 同日中は Terminal-backed CLI Session と Kairon session context の両方を使う。
- 翌日は Kairon artifact から context を再構築する。
- Policy gate は起動前、実行中、outbox apply 前の 3 箇所に置く。
- Terminal window の可視性ではなく、公式 CLI と追跡可能な process 実行を境界にする。

## 21. Experimental Workflow Runtime Boundary

T110 の LangGraph-style runtime spike は production runtime path ではない。

- `RuntimeLoop` から自動起動しない。
- `WorkQueue` を claim / complete / fail しない。
- `TaskRunner`、`ReviewLoopExecutor`、`StateApplier` を呼ばない。
- artifact は `.kairon/experimental/workflows/` にのみ出力する。

判断材料は `docs/langgraph-runtime-spike-v0.md` に分離する。

T128 の workflow runtime production candidate も同じ境界を維持する。

- `KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME=1` がない場合はcandidate flowへ入らない。
- `kairon workflow run --candidate --dry-run` は queue / task / approval をread-onlyで観測する。
- queue itemをclaimせず、approvalを作らず、task runnerを起動せず、canonical eventをappendしない。
- candidate artifactには queue intake、task placeholder、approval gate、production handoff の状態を残す。
- production runtimeへの接続可否はcandidate artifactの `recommendation` と `blockers` を見て判断する。

T138では明示的なqueue接続だけを追加する。

- `kairon workflow run --candidate --connect-queue --task-id <TASK-ID>` で既存taskを`agent.run`へ変換する。
- approval必須taskは、参照したapprovalがapprove済みになるまでenqueueしない。
- queue metadataにapproval gate、resource lock、retry policy、recovery artifact pathを残す。
- recovery / rollback導線を `<workflow_id>-recovery.json` に保存する。
- feature flagが無効なRuntimeLoopはworkflow metadata付きitemをclaimしない。
- workflow runtimeはcanonical stateを直接更新せず、dispatch時は既存TaskRunner / QueueWorker境界を使う。
