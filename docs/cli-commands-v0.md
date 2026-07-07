# Kairon CLI Commands v0

## 目的

この文書は MVP で実装する `kairon` CLI のコマンド仕様を定義する。

## Command List

```text
kairon init
kairon migrate
kairon doctor
kairon agent smoke --agent codex|claude|gemini
kairon approval list
kairon approval show APR-0001
kairon approval decide APR-0001 --action approve|reject|request_changes|snooze
kairon approval seed APR-MANUAL-0001 --actions approve,reject
kairon board export
kairon board serve
kairon cleanup list
kairon cleanup show <proposal-id>
kairon cleanup apply <proposal-id> [--dry-run]
kairon cleanup archive <proposal-id>
kairon config propose
kairon config apply <proposal-id> [--dry-run]
kairon docking analyze
kairon git pr list
kairon git pr show <candidate-id>
kairon git pr create <candidate-id> [--dry-run]
kairon git pr create <candidate-id> --execute --approval-id <approval-id>
kairon start
kairon start --daemon [--interval-ms <ms>] [--max-ticks <count>] [--max-idle-ticks <count>]
kairon stop
kairon status
kairon task create
kairon task run TASK-0001
kairon review run REV-0001
kairon recovery run
kairon recovery list
kairon recovery show <target-id-or-fingerprint>
kairon recovery resolve <target-id-or-fingerprint> --reason <reason>
kairon recovery acknowledge <target-id-or-fingerprint> --reason <reason>
kairon leave
kairon maintenance run
kairon maintenance run --build-rag
kairon rag refresh
kairon rag status
kairon rag query <query>
```

## kairon init

対象プロジェクトに `.kairon/` を作成する。

```text
kairon init
```

処理。

```text
detect project root
create .kairon directories
generate config files
discover root rules
generate .kairon/rules
run doctor checks
create sample task if requested
```

## kairon migrate

既存 `.kairon/config/*.json` を現在のschemaやCLI名に合わせて移行する。

```text
kairon migrate --dry-run
kairon migrate
```

処理。

```text
load existing config
detect required migrations
show dry-run diff if requested
create .bak-YYYYMMDDHHmmss before writing
write migrated config
validate config
```

MVPでは、旧 `agents.gemini` 設定を AntigravityCLI 設定へ移行する。

```text
agents.gemini.adapter: gemini_cli -> antigravity_cli
agents.gemini.command: gemini -> agy
```

## kairon doctor

Kairon が稼働できるかを検査する。

```text
kairon doctor
```

検査項目。

- config schema
- project root
- git repository
- CLI availability
- API key contamination
- Discord env
- GitHub branch protection
- runtime recovery targets
- protected path policy
- runtime lock

出力。

```text
doctor.ok=true
summary.pass=8
summary.warning=0
summary.error=0
PASS git.repository Git repository
...
```

`warning` は運用前に確認すべき注意、`error` は通常運用前に解消すべき問題を示す。

GitHub branch protection診断は、remote repository、default branch、branch protection API、required pull request reviews、required status checksを確認する。API tokenは `GH_TOKEN` を優先し、未設定時に `GITHUB_TOKEN` を参照する。GitHub Freeのprivate repositoryなど、外部プラン制約でbranch protection APIが403になる場合は `api_status=plan_or_permission_error` として扱い、Kairon実装不具合ではなく外部条件としてpublic sandbox repositoryでlive API確認を代替する。

## kairon agent smoke

設定済みの公式CLIへ最小promptを投げ、stdout / stderr / runner metadata / outboxを保存する。

```text
kairon agent smoke --agent codex
kairon agent smoke --agent claude
kairon agent smoke --agent gemini
```

Antigravity は互換性維持のため `--agent gemini` で指定する。実際に起動する command は `agy` である。

任意option。

```text
--timeout-ms <ms>
```

処理。

```text
check configured CLI availability
create smoke task artifact under .kairon/tasks/TASK-xxxx/task.json
create run artifact under .kairon/runs/RUN-xxxx/
invoke official CLI with a minimal Kairon job prompt
require .kairon/runs/RUN-xxxx/outbox.json
write stdout.log / stderr.log / runner.json
return setup_required without invoking CLI when command is missing
```

出力例。

```text
Kairon agent smoke completed.
agent=codex
status=completed
run_id=RUN-0001
task_id=TASK-0001
command=codex
command_available=true
runner=.kairon/runs/RUN-0001/runner.json
outbox=.kairon/runs/RUN-0001/outbox.json
```

実CLIを起動するため、unit testではcommand runner mockで検証し、実Agent smokeは手動運用テストとして扱う。

## kairon approval list

承認待ちを一覧する。

```text
kairon approval list
kairon approval list --status all
kairon approval list --status snoozed
```

既定では `pending` の approval だけを表示する。

## kairon approval show

承認内容を安全表示する。

```text
kairon approval show APR-0001
```

表示時は `diff`、`patch`、`log`、`stdout`、`stderr`、secret-like key を省略またはredactする。
完全な artifact は `.kairon/approvals/APR-xxxx.json` に残すが、CLI表示では過剰表示しない。

## kairon approval decide

承認を決定する。

```text
kairon approval decide APR-0001 --action approve
kairon approval decide APR-0001 --action reject --reason "risk accepted only after redesign"
kairon approval decide APR-0001 --action request_changes --reason "tests are missing"
kairon approval decide APR-0001 --action snooze --until 2026-05-26T09:00:00.000Z
```

処理。

```text
load approval
reject when status is not pending or snoozed
validate requested action against approval actions
append approval.decided or approval.snoozed event
materialize approval state
```

`snooze` で `--until` を省略した場合は、実行時刻から1時間後を既定にする。

## kairon approval seed

運用テスト用の手動approvalを作成する。PowerShellからJSON配列をNode引数として渡すと引用符が壊れやすいため、このcommandはカンマ区切りまたは空白区切りの `--actions` を受け取り、内部で `approval.requested` eventとしてmaterializeする。

```text
kairon approval seed APR-MANUAL-0001
kairon approval seed APR-MANUAL-0002 --actions approve,reject
kairon approval seed APR-MANUAL-0003 --actions approve,reject,request_changes,snooze --redaction-fixture
```

主なoption。

```text
--type <type>              既定は manual_test
--title <title>            既定は Manual approval <approvalId>
--actions <actions>        カンマ区切りまたは空白区切り。既定は approve,reject,request_changes,snooze
--task-id <taskId>         eventへtask_idを付与
--run-id <runId>           eventへrun_idを付与
--redaction-fixture        show表示確認用のdiff/stdout/api_tokenを含める
```

出力例。

```text
Kairon approval seeded.
approval_id=APR-MANUAL-0001
status=pending
actions=approve,reject
event_id=EVT-000001
```

## kairon config propose

対象projectのtop-level構成をscanし、`project.json` 向けのconfig proposalを `.kairon/config/proposals/` に保存する。

```text
kairon config propose
```

出力例。

```text
Kairon config proposal created.
proposal_id=CFG-20260526040500-abcdef12
proposal_path=.kairon/config/proposals/CFG-20260526040500-abcdef12.json
target=project.json
changes=3
```

このcommandはproposal artifactだけを書き込み、`.kairon/config/project.json` は変更しない。

## kairon config apply

保存済みconfig proposalを人間確認後に適用する。

```text
kairon config apply CFG-20260526040500-abcdef12 --dry-run
kairon config apply CFG-20260526040500-abcdef12
```

処理。

```text
load .kairon/config/proposals/<proposal-id>.json
reject stale proposal
reject proposal for another project root
show planned project.json changes
create .kairon/config/project.json.bak-YYYYMMDDHHMMSS before writing
write .kairon/config/project.json
run config validation
```

`--dry-run` は差分だけを表示し、backup作成やconfig書き込みは行わない。

## kairon docking analyze

対象projectのtop-level構成をscanし、`project.json` 向けのconfig proposalを表示する。

```text
kairon docking analyze
```

処理。

```text
scan top-level files and directories
classify protected / generated / source path candidates
detect primary_language / frameworks / package_managers
print project_config proposal JSON
do not write .kairon/config/project.json
```

MVPでは、`.mcp.json`、`.claude/**`、`.gemini/**`、`.antigravitycli/**` を protected 候補に寄せる。
`tmpclaude-*`、`dist/**`、`build/**`、`coverage/**`、`node_modules/**` は generated 候補に寄せる。

## kairon git pr

Git transactionが出力した `.kairon/git/pr-candidates/*.json` を確認し、Pull Request作成のdry-runまたは実行を行う。

```text
kairon git pr list
kairon git pr show GTX-0001
kairon git pr create GTX-0001 --dry-run
kairon git pr create GTX-0001 --execute --approval-id APR-0001
```

処理。

```text
load PR candidate artifact
build PR title / body / base / head payload
default to dry-run and do not call GitHub
require --execute, approved approval id, and GitHub token for actual creation
use GH_TOKEN first, then GITHUB_TOKEN
```

主なoption。

```text
--dry-run                 GitHub APIを呼ばず、作成予定payloadを表示する。既定動作。
--execute                 GitHub PRを作成する。
--approval-id <id>        --execute時に必須の承認済みapproval id。
--repository <owner/repo> .git/configのremoteから推定できない場合に明示する。
--draft                   --execute時にDraft PRとして作成する。
--token-env <envName>     GH_TOKEN / GITHUB_TOKEN 以外のtoken環境変数を指定する。
```

PR本文は日本語テンプレートで生成し、raw diffやtokenは表示しない。実作成は `status=ready_for_pr` の候補だけを許可し、それ以外は候補artifactの `create_hint` を表示して停止する。

## kairon board

read-only Board projectionを出力またはloopback HTTPで表示する。

```text
kairon board export
kairon board export --output .kairon/board/projection.json --recent 20
kairon board serve --host 127.0.0.1 --port 8787 --recent 20
```

処理。

```text
read canonical Kairon state
redact large output and secret-like fields
summarize approvals, queue, runs, reviews, recovery, cleanup, Discord decision audit
write .kairon/board/projection.json
serve HTML and projection.json on loopback only when requested
```

`serve` は `127.0.0.1` または `localhost` のようなloopback hostだけを許可する。
Discord approval messageからBoardを開く場合も、MVPではこのloopback URLを在宅時の詳細確認導線として扱う。public Board公開やスマートフォン最適化は後続のcloud / public endpoint設計に含める。

## kairon cleanup

maintenanceが作成したcleanup proposalを確認し、人間確認後に安全にapplyまたはarchiveする。

```text
kairon cleanup list
kairon cleanup show 2026-06-01
kairon cleanup apply 2026-06-01 --dry-run
kairon cleanup apply 2026-06-01
kairon cleanup archive 2026-06-01
```

処理。

```text
list .kairon/cleanup/proposals/*.json
show candidates and safety classification
dry-run planned moves
move reviewed candidates to .kairon/tmp/cleanup-...
write .kairon/cleanup/applied/*.json
archive proposal to .kairon/cleanup/archived/*.json
block protected paths
```

直接削除は行わない。apply対象はreview済み候補とし、protected pathは常に拒否する。

## kairon start

Kairon Runtime を起動する。

```text
kairon start
kairon start --daemon --interval-ms 1000 --max-ticks 2
```

処理。

```text
acquire runtime lock
resolve current schedule mode
run one runtime tick
write .kairon/runtime/last-tick.json
run safe runtime recovery before lock acquisition
when --daemon is set, repeat ticks and append .kairon/runtime/daemon/YYYY-MM-DD.jsonl
```

runtime tick の動作。

```text
active_work:
  process ready queue item

standby_work:
  process command inbox first
  process only standby-safe or approved queue item
  keep normal active work queued

maintenance:
  run daily maintenance once per local date
  skip when .kairon/runtime/maintenance-runs/YYYY-MM-DD.json exists
```

daemon option。

```text
--daemon
--interval-ms <ms>
--max-ticks <count>
--max-idle-ticks <count>
```

`--daemon` は長時間運用の入口であり、heartbeat、last error、stop reasonをruntime lockとdaemon logに記録する。24時間以上の連続運用エビデンス取得は運用テスト側で行う。

## kairon stop

Kairon Runtime を停止する。

```text
kairon stop
```

処理。

```text
stop dispatching new jobs
flush session scratch
write runtime state
gracefully close terminal sessions
release runtime lock
```

## kairon status

現在の Runtime 状態を表示する。

```text
kairon status
```

表示項目。

- schedule mode
- runtime lock
- runtime last error
- active sessions
- queue length
- active runs
- pending approvals
- recovery target counts
- last daily handoff

## kairon task create

手動で task artifact を作成する。

```text
kairon task create --title "Add approval queue" --persona implementer --capability coding
```

主なoption。

```text
--description <text>
--capability <capability>  repeatable
--tag <tag>                repeatable
--approval-required
--code-producing
--commit-requested
--priority <number>
--schedule-mode active_work|standby_work|maintenance
```

生成物。

```text
.kairon/tasks/TASK-xxxx/task.json
task.created event
```

出力例。

```text
Kairon task created.
task_id=TASK-0001
task_path=.kairon/tasks/TASK-0001/task.json
status=ready
persona=implementer
```

## kairon task run

指定 task をqueueへ積み、dispatcher / runner / state applierへ同期的に流す。

```text
kairon task run TASK-0001
kairon task run TASK-0001 --timeout-ms 120000
kairon task run TASK-0001 --no-interactive-agents
```

主なoption。

```text
--timeout-ms <ms>           CLI実行timeoutを指定する。
--worker-id <id>            queue claimに記録するworker idを指定する。
--no-interactive-agents     Antigravityのようなinteractive-only agentをdispatch候補から外す。
```

処理。

```text
load task
enqueue agent.run queue item
claim queued item
build dispatch request from persona / capabilities / tags
select agent through AgentDispatcher
build run context
invoke CliSessionRunner
collect required outbox
apply outbox through StateApplier
complete or fail queue item
```

実行結果は `.kairon/runs/RUN-xxxx/runner.json` と `.kairon/runs/RUN-xxxx/outbox.json` に残る。
code-producing taskでは、既存のreview loop境界に接続される。

## kairon review run

指定 review loop の reviewer を実行し、quality gate を評価する。

```text
kairon review run REV-0001
kairon review run REV-0001 --timeout-ms 120000
```

処理。

```text
load .kairon/reviews/loops/REV-xxxx.json
select configured reviewers from review policy
route Claude Opus implementation review through Codex when configured
invoke CliSessionRunner for each reviewer
load reviewer outbox review_result
validate review_result schema
write .kairon/reviews/results/REV-xxxx.json
evaluate minimum_score / block_on_severity / tests / secret scan
approve loop, request fix, or escalate to approval queue
write per-iteration execution artifact
```

出力例。

```text
Kairon review loop executed.
loop_id=REV-0001
status=approved
decision=passed
next_action=approve
review_runs=RUN-0002
review_results=REV-0002
```

基準未満で最大反復回数未満の場合は `review_fix` 用の `agent.run` queue item を作成する。
最大反復回数に達した場合は `.kairon/approvals/APR-xxxx.json` に `review_escalation` を作成する。
`commit_requested` なreview loopがapprovedになり、対象実装runのdiff snapshotが存在する場合は `git.transaction` queue itemを作成する。

## kairon recovery

stale runtime stateを検出し、安全な再queueまたは人間承認に接続する。

```text
kairon recovery run
kairon recovery list
kairon recovery show <target-id-or-fingerprint>
kairon recovery resolve <target-id-or-fingerprint> --reason "manual cleanup verified"
kairon recovery acknowledge <target-id-or-fingerprint> --reason "operator will recover manually"
```

検出対象。

```text
stale runtime lock
expired claimed queue item
stale running runner metadata
partial outbox
stale Discord gateway state
git transaction mid-state
```

`resolve` と `acknowledge` は `.kairon/recovery/resolutions/*.json` にfingerprint単位で記録し、同一targetが未解決として残り続けることを防ぐ。

## kairon maintenance run

日次メンテを手動実行する。

```text
kairon maintenance run
```

処理。

```text
run QA / review placeholders
create cleanup proposals
run runtime recovery
flush session scratch
write daily report
write handoff
prepare next-day bootstrap
write next-day plan
optionally build RAG index
```

主なoption。

```text
--build-rag
```

`--build-rag` は `rag.json` のautomatic maintenance indexingがdisabledでもlocal RAG indexを作る。

## kairon rag

local lexical RAG indexを作成、状態確認、検索する。

```text
kairon rag refresh
kairon rag status
kairon rag query "approval routing" --type approval --limit 5
```

主なquery option。

```text
--type <type>
--collection <collection>
--limit <count>
--task-id <taskId>
--run-id <runId>
--approval-id <approvalId>
--review-id <reviewId>
--review-loop-id <reviewLoopId>
--date <YYYY-MM-DD>
--severity <severity>
```

RAG indexは `.kairon/rag/index.json` に保存する。secret-like pathとprotected pathはindex対象から除外する。

## kairon leave

本日の Active Work を終了する。

```text
kairon leave
```

処理。

```text
set schedule override active_work_closed_for_today
stop dispatching new active_work jobs
let currently running safe jobs finish or checkpoint
move unresolved decisions to approval queue
notify Discord if enabled
switch runtime behavior to standby_work
```

Discord からは `/kairon leave` を同じ command として扱う。

## Exit Codes

| Code | 意味 |
| --- | --- |
| 0 | success |
| 1 | general failure |
| 2 | config invalid |
| 3 | runtime lock exists |
| 4 | expected CLI operation rejection |
| 5 | policy blocked |
| 6 | approval required |
| 7 | active work closed |

## MVP Notes

- `kairon start` はforeground single tickとdaemon modeの両方を持つ。
- `kairon task run` は現段階では同期実行の最小経路として動く。queue itemの非同期処理はruntime loop経由でも進められる。
- `kairon stop` は terminal session を閉じる前に handoff を書く。
- Discord が disabled の場合、approval は `.kairon/approvals` に file として残す。
- `kairon leave` は Runtime を停止しない。本日の Active Work だけを閉じる。
