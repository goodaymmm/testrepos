# Kairon CLI Commands v0

## 目的

この文書は MVP で実装する `kairon` CLI のコマンド仕様を定義する。

## Command List

```text
kairon init
kairon migrate
kairon doctor
kairon agent smoke --agent codex|claude|gemini
kairon agent health [--agent codex|claude|gemini]
kairon agent suspend --agent codex|claude|gemini --reason <text>
kairon agent resume --agent codex|claude|gemini --reason <text>
kairon approval list
kairon approval show APR-0001
kairon approval decide APR-0001 --action approve|reject|request_changes|snooze
kairon approval seed APR-MANUAL-0001 --actions approve,reject
kairon board export
kairon board serve
kairon board access issue --ttl-minutes 15
kairon board access revoke <access-id>
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
kairon git pr merge <candidate-id> --dry-run --follow-up-id <follow-up-id>
kairon git pr merge <candidate-id> --execute --confirm <candidate-id> --follow-up-id <follow-up-id>
kairon merge dry-run --candidate-id <candidate-id> --source <branch> --target <branch>
kairon merge execute --dry-run-artifact <id> [--preflight]
kairon deploy dry-run --target <branch> [--environment <name>] [--provider <name>]
kairon deploy execute --dry-run-artifact <id> [--preflight]
kairon deploy execute --dry-run-artifact <id> --provider local-sandbox --execute --confirm <id>
kairon deploy status <execution-id>
kairon discord http start [--profile loopback|reverse-proxy] [--host 127.0.0.1] [--port 18777]
kairon discord http status
kairon start
kairon start --daemon [--interval-ms <ms>] [--max-ticks <count>] [--max-idle-ticks <count>]
kairon daemon task status [--task-name <name>] [--project-root <path>]
kairon daemon task install [--dry-run] [--task-name <name>] [--project-root <path>]
kairon daemon task uninstall [--dry-run] [--task-name <name>] [--project-root <path>]
kairon daemon task restart [--task-name <name>] [--project-root <path>]
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
kairon release check
kairon release validate
kairon release pack [--output <path>]
kairon release verify <package.tgz> [--manifest <manifest.json>]
kairon release notes --since <ref> [--write]
kairon release bump --version <version> [--write]
kairon readiness manifest --evidence <GATE_ID=path>
kairon readiness check [--manifest <path>]
kairon readiness report [--format json|markdown] [--output <path>]
kairon workflow run <workflow-id> --task-id <task-id>
kairon workflow show <workflow-id>
kairon workflow recover <workflow-id> --dry-run
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
kairon doctor --format json
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
- daemon health
- Board secret scan
- RAG index status
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

`warning` は運用前に確認すべき注意、`error` は通常運用前に解消すべき問題を示す。外部設定が不足するcheckはdetailに`status=setup_required`を含み、`next_action`に再実行するCLI commandと関連guide pathを表示する。`--format json`でも同じ`next_action`をsnake_case fieldとして返す。secret値はtext/JSONのどちらにも含めない。

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
update .kairon/sessions/YYYY-MM-DD/{agent}/health.json
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
health=.kairon/sessions/2026-05-26/codex/health.json
```

実CLIを起動するため、unit testではcommand runner mockで検証し、実Agent smokeは手動運用テストとして扱う。

## kairon agent session

当日のAgent session状態とhealthを確認し、必要に応じて証跡を残したままresetする。

```text
kairon agent session list [--date YYYY-MM-DD]
kairon agent session show codex|claude|gemini [--date YYYY-MM-DD]
kairon agent session reset codex|claude|gemini --date YYYY-MM-DD
```

`session show` は `health_status`、連続失敗回数、retry backoff秒数、`health_next_retry_at`、現在再試行可能かを表示する。履歴は `.kairon/sessions/YYYY-MM-DD/{agent}/health.json` に最大25件保存し、`setup_required`、permission、rate/usage limit、timeout、no outputなどの理由をrun単位で追跡する。成功時は連続失敗とbackoffをresetするが、履歴とsetup_required累計は保持する。

dispatcherは既定でbackoff中の `degraded` / `blocked` sessionを避ける。内部dispatch requestで `avoidUnhealthyAgents=false` を明示した場合、または `health_next_retry_at` を経過した場合は候補へ戻す。

`session reset` はAgent directory全体を `.archived-*` へrenameするため、`session.json`、`health.json`、context manifest、scratchを削除せず保存する。

## kairon agent health / suspend / resume

provider単位のunattended実行可否、同時実行数、cooldown、日次run上限、手動停止状態を確認・操作する。

```text
kairon agent health
kairon agent health --agent codex|claude|gemini
kairon agent suspend --agent codex|claude|gemini --reason <text>
kairon agent resume --agent codex|claude|gemini --reason <text>
```

policyは `.kairon/config/agents.json` の `provider_policies`、runtime状態は `.kairon/runtime/agents/{agent}-health.json` に保存する。quota / rate limitは対象providerだけをcooldownし、auth / setup / compliance / 未分類エラーはfail closedでsuspendする。dispatcherは利用可能な別providerへfallbackする。

`suspend` と `resume` は `--reason` が必須で、actor・理由・時刻を `.kairon/audit/provider-policy.jsonl` に追記する。resumeは日次上限をresetせず、operatorが確認したprovider停止だけを解除する。Kaironはquota回避目的のaccount切替、credential rotation、request分割を行わない。

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

Git transactionが出力した `.kairon/git/pr-candidates/*.json` を確認し、Pull Request作成と、承認済みPull Requestのmergeを行う。

```text
kairon git pr list
kairon git pr show GTX-0001
kairon git pr create GTX-0001 --dry-run
kairon git pr create GTX-0001 --execute --approval-id APR-0001
kairon merge dry-run --candidate-id GTX-0001 --source codex/t149 --target main --check build:passed
kairon approval decide APR-0002 --action approve
kairon git pr merge GTX-0001 --dry-run --follow-up-id FUP-APR-0002-approve-merge.execute_preflight
kairon git pr merge GTX-0001 --execute --confirm GTX-0001 --follow-up-id FUP-APR-0002-approve-merge.execute_preflight
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

`git pr merge` は、候補IDに紐付いたmerge dry-run approvalとfollow-upを必須とする。live GitHub APIからPR状態、base/head SHA、draft、merge conflict、branch protectionのstrict required status checks、最新head SHAへのrequired reviewsを再取得し、すべて一致した場合だけ許可されたmerge methodを実行する。既定methodは`squash`である。結果は候補artifactの`merge_execution`へ保存し、tokenやraw GitHub responseは保存しない。通信結果が不明な再実行ではPR状態を再取得し、merge済みならAPIを再送せず冪等に成功へ収束する。

## kairon merge / deploy

top-levelのmerge / deploy commandはdry-run artifactと高リスクapprovalを作成し、実行前preflightで安全条件を確認する。top-levelの`merge execute`は実処理を行わず、実際のGitHub Pull Request mergeは、より厳格なcandidate-bound契約を持つ`kairon git pr merge`だけが担当する。`deploy execute`はprovider-bound dry-runだけを対象とし、既定で許可された`local-sandbox` providerに限って実行できる。production providerはpolicy上の明示許可がない限り候補作成時と実行直前の両方で拒否する。

```text
kairon merge dry-run --candidate-id GTX-0001 --source codex/t149 --target main --check build:passed
kairon merge execute --dry-run-artifact APR-0001 --preflight --required-check build
kairon deploy dry-run --target main --environment local-sandbox --provider local-sandbox --check smoke:passed
kairon deploy execute --dry-run-artifact APR-0002 --preflight --provider local-sandbox --required-check smoke
kairon deploy execute --dry-run-artifact APR-0002 --provider local-sandbox --execute --approval-id APR-0002 --confirm APR-0002 --required-check smoke
kairon deploy status DEP-0002
```

`execute` preflight の主な確認項目。

```text
dry-run artifactが対象operationと一致すること
approval recordが存在し、approve済みであること
deploy approvalがlocal CLIで再認証・confirmation済みであること
required approvalsがpolicy上presentであること
required checksがpassedであること
providerとenvironmentがallowlist内であること
provider、environment、target、commit rangeのinput digestとapproval bindingが一致すること
expected head shaとobserved head shaが一致すること
rollback hintがartifactに残っていること
```

主なoption。

```text
--dry-run-artifact <idOrPath>   APR-xxxx または .kairon/deploy/dry-runs/*.json
--preflight                     実行せずguardrail確認だけを表示する。既定動作。
--execute                       deploy guardrail通過後、provider operationを1回だけ実行する。mergeでは実行しない。
--provider <name>               dry-run artifactに固定されたprovider。既定許可はlocal-sandboxのみ。
--expected-head-sha <sha>       対象branch headが動いていないことを確認する期待SHA。
--actual-head-sha <sha>         運用テスト用に観測SHAを明示する。未指定時はgit rev-parseで確認する。
--required-check <name>         passed必須のdry-run check。複数指定可。
--approval-id <approvalId>      artifactと一致すべき承認ID。
--confirm <dryRunId>            deploy実行時にdry-run IDとの完全一致を要求する。
```

deploy executionは`.kairon/deploy/executions/<execution-id>.json`へstatusとoperation IDだけを保存し、raw provider responseやcredentialは保存しない。完了時は`.kairon/deploy/rollback-plans/<execution-id>.json`へrollback planを作成する。timeoutや通信結果不明の再実行では同じoperation IDを照会し、providerの`execute`を再送しない。

## kairon board

read-only Board projectionを出力またはloopback HTTPで表示する。

```text
kairon board export
kairon board export --output .kairon/board/projection.json --recent 20
kairon board serve --host 127.0.0.1 --port 8787 --recent 20
kairon board access issue --ttl-minutes 15
kairon board serve --profile remote-readonly --host 127.0.0.1 --port 18778
kairon board access revoke <access-id>
```

処理。

```text
read canonical Kairon state
redact large output and secret-like fields
summarize approvals, queue, runs, reviews, recovery, cleanup, Discord decision audit
write .kairon/board/projection.json
serve HTML and projection.json on loopback only when requested
serve an authenticated remote-readonly profile behind a trusted HTTPS reverse proxy
```

`serve` は `127.0.0.1` または `localhost` のようなloopback hostだけを許可する。
Discord approval messageからBoardを開く場合も、MVPではこのloopback URLを在宅時の詳細確認導線として扱う。
Boardはread-onlyであり、approval action、merge、deploy、protected branch pushは実行しない。
public Board公開やスマートフォン最適化の安全要件は `docs/board-public-safety-v0.md` に固定し、認証なし公開やpublic bindは対象外とする。

`remote-readonly`はKairon自体をpublic bindせず、`notifications.json`の`board`にHTTPS `external_base_url`、`trusted_proxies`、`allowed_origins`、`identity_header`、`rate_limit_per_minute`を設定して使う。reverse proxyはTLSと外部認証を担当し、`X-Forwarded-Proto`、`X-Forwarded-Host`、設定したverified identity header、`Authorization: Bearer <token>`をloopback backendへ渡す。tokenは`board access issue`で一度だけ表示され、hashだけが`.kairon/runtime/board/access/<access-id>.json`へ保存される。remote access auditは`.kairon/audit/board-access.jsonl`へ保存され、token、cookie、Authorization header、raw identityは含めない。

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

## kairon discord http

Discord HTTP Interactions endpointをloopbackにbindして起動し、最新status artifactを確認する。

```text
kairon discord http start --profile loopback --host 127.0.0.1 --port 18777
kairon discord http start --profile reverse-proxy --host 127.0.0.1 --port 18777
kairon discord http status
```

- `loopback`は既定profileであり、公開URLやforwarded headerを必要としない。
- `reverse-proxy`もpublic addressへbindせず、TLS終端reverse proxyからの接続だけを受ける。
- `reverse-proxy`にはHTTPS `external_base_url`、`trusted_proxies` CIDR、Discord public key secretが必要。
- `/health`はliveness、`/ready`はreadinessを返す。
- forwarded headerはtrusted proxyから届いた場合だけ採用する。

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

## kairon daemon task

Windows Task Scheduler上のKairon daemon登録を管理する。

```text
kairon daemon task status
kairon daemon task install --dry-run
kairon daemon task install
kairon daemon task uninstall --dry-run
kairon daemon task uninstall
kairon daemon task restart
```

`install`と`uninstall`の`--dry-run`はTask Schedulerを変更せず、helperへ渡す登録・解除planを表示する。CLIは`scripts/kairon-daemon-task.ps1`へ固定引数だけを渡し、secret値をコマンドライン引数へ展開しない。Task未登録時の`status`は`task.exists=false`を返して成功扱いとする。Windows以外では`status=setup_required`を返し、Task Scheduler操作は実行しない。

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
kairon rag query "approval routing" --type approval --limit 5 --explain
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
--explain
```

`--explain` は通常のranked resultに加えて、lexical score、matched terms、term hit、source modified timestamp、indexed timestamp、stale source warningを表示する。
`--explain` を付けない場合、既存のquery出力形式を維持する。

初回refreshは`mode=full`、既存indexに対する通常refreshは`mode=incremental`、filter付きrefreshは`mode=scoped`となる。incremental refreshはsource manifestの`file_mtime_ms`と`file_size_bytes`が一致するsource/chunkを再利用し、metadataが変わったsourceだけcontent hashを確認する。`rag refresh`はscanned / added / updated / unchangedと理由別skip / prune件数を表示する。

`rag status`は`freshness=fresh|stale|not_indexed`と、`pending_added_sources` / `pending_changed_sources` / `pending_missing_sources`を表示する。RAG indexは `.kairon/rag/index.json` に保存し、secret-like path、protected path、generated pathはindex対象から除外する。

## kairon release

release readiness、release notes、version bumpを補助する。

```text
kairon release check
kairon release validate
kairon release pack
kairon release pack --output C:\tmp\kairon-beta
kairon release verify .\release-artifacts\0.1.0\kairon-0.1.0.tgz
kairon release notes --since v0.1.0
kairon release notes --since v0.1.0 --write
kairon release bump --version 0.2.0
kairon release bump --version 0.2.0 --write
kairon release bump --type patch
```

`release validate` は `package.json.version` と `KAIRON_VERSION` のcore SemVer形式と同期、
release checklistの必須marker、release notesの`Unreleased` markerと現在version entryを
まとめて検査する。検査失敗時は `validation.ok=false` を出力し、exit codeを1にする。

`release pack`はrelease validationとbuild済みentrypointを確認して`npm pack`を実行し、tarballのSHA-256、size、file inventoryを`.sha256.json`へ保存する。`release verify`はmanifestだけでなくtar path、link、必須file、禁止path、package metadataを再検証する。public npm registryへのpublishは行わない。

`release notes` は既定ではdry-runで、`--write` を付けた場合のみ
`docs/release-notes-v0.md` の `<!-- kairon:release-notes-unreleased -->` 直下へappendする。

`release bump` は既定ではdry-runで、`--write` を付けた場合のみ `package.json` と
`src/index.ts` を同時に更新する。`--version` と `--type` は同時指定しない。

write modeの安全条件。

```text
tracked worktreeがcleanであること
backup artifactを.kairon/release/backups/<timestamp>/へ作成すること
npm publish / git tag / GitHub Releaseは実行しないこと
```

## kairon readiness

T145以降のoperation test、doctor、daemon certification、backup rehearsal、GitHub / Discordのlive確認、RAG verify、provider compliance、local beta lifecycleなどの証跡を集約し、Beta配布可否を機械判定する。

```powershell
kairon readiness manifest `
  --evidence BUILD_UNIT_INTEGRATION=.\operation-test-results\summary.json `
  --evidence CONFIG_MIGRATION_DOCTOR=.\.kairon\reports\doctor.json `
  --evidence PACKAGE_LIFECYCLE=.\release-artifacts\0.1.0\verification.json

kairon readiness check
kairon readiness report --format json --output .kairon\reports\readiness\latest.json
kairon readiness report --format markdown --output .kairon\reports\readiness\latest.md
```

`manifest`は各証跡のrelative path、artifact kind、判定status、source commit、実行時刻、有効期限、SHA-256、sizeを`.kairon/readiness/evidence-manifest.json`へ記録する。`GATE_ID=path`は複数指定できるが、project root外のpathは拒否する。

必須gate IDは`BUILD_UNIT_INTEGRATION`、`CONFIG_MIGRATION_DOCTOR`、`RUNTIME_RESILIENCE`、`GITHUB_MERGE_DEPLOY_GUARD`、`WORKFLOW_RECOVERY_CONTROL`、`DISCORD_BOARD_SECURITY`、`RAG_INTEGRITY`、`PROVIDER_QUOTA_COMPLIANCE`、`PACKAGE_LIFECYCLE`、`SECRET_ARTIFACT_INTEGRITY`。`KNOWN_LIMITATIONS`は任意gateで、証跡未登録時は`OPTIONAL`となる。

`check`と`report`は証跡を再読込し、checksum、size、status、source commit、有効期限を再検証する。必須gateがすべて`PASS`の場合だけexit code 0となる。外部credentialやlive環境がない場合は`SETUP_REQUIRED`、期限切れ・別commit・改変・解析不能は`UNKNOWN`であり、自動的に`PASS`へ昇格しない。

reportはraw token、環境変数値、Discord payload、GitHub response bodyを含めない。出力前後にsecret scanを行い、redactionが必要だった場合は`SECRET_ARTIFACT_INTEGRITY=UNPASSED`とする。

## kairon workflow

task、approval、queue item、resource lockを永続workflow状態として管理する。production実行はfeature flag配下で行い、run artifactと遷移ごとのcheckpointから再起動後に継続できる。

```text
kairon workflow run WF-0001 --task-id TASK-0001
kairon workflow run WF-0002 --task-id TASK-0002 --approval-id APR-0001 --resource-lock src/shared.ts --retry-max-attempts 3
kairon workflow show WF-0001
kairon workflow recover WF-0001 --dry-run
kairon workflow recover WF-0001
```

production runtimeの有効化条件。

```text
KAIRON_WORKFLOW_RUNTIME=1
```

`run`は未作成workflowを`--task-id`から開始し、既存workflowではapproval・queue状態を照合して続行する。`recover --dry-run`はartifactを変更せず復旧候補だけを表示する。実際の`recover`とRuntimeLoop起動時のrecoveryは、完了nodeを再投入せず未完了nodeだけを進める。

- run artifact: `.kairon/workflows/runs/<workflow_id>.json`
- checkpoint: `.kairon/workflows/checkpoints/<workflow_id>-<sequence>.json`
- queue itemは`workflow/node/attempt`のidempotency keyを持つ。
- nodeはattempt、queue item ID、run ID、input/output digest、fencing tokenを保持する。
- approval待ちは`waiting_approval`、resource lock競合は`paused`として永続化する。
- feature flag無効時はproduction workflow itemをRuntimeLoopがclaimしない。

experimental candidateとの互換経路も維持する。

```text
kairon workflow run --candidate --dry-run
kairon workflow run --candidate --dry-run --workflow-id EXP-WF-CANDIDATE-0001 --queue-item-id JOB-0001 --approval-id APR-0001
kairon workflow run --candidate --connect-queue --workflow-id EXP-WF-CONNECT-0001 --task-id TASK-0001 --approval-id APR-0001
```

candidate経路の有効化条件。

```text
KAIRON_EXPERIMENTAL_WORKFLOW_RUNTIME=1
```

主なoption。

```text
--candidate                 production candidate adapterを評価する。
--dry-run                   production runtimeへ接続せずexperimental artifactだけを書く。既定動作。
--connect-queue             candidate taskをagent.run itemへ変換する。task idが必須。
--workflow-id <workflowId>  EXP-WF- prefixのworkflow id。未指定時はtimestampから生成。
--task-id <taskId>          task placeholderとしてtask fileをread-only参照する。
--queue-item-id <jobId>     queue itemをclaimせずread-only参照する。
--approval-id <approvalId>  approval gateとしてapproval fileをread-only参照する。
--objective <text>          candidate評価の目的。
```

candidate artifactは `.kairon/experimental/workflows/<workflow_id>.json` に保存する。
dry-runは `WorkQueue` のenqueue / claim / complete / fail、approval作成、TaskRunner起動、StateApplier適用を行わない。

`--connect-queue` は次の境界で動作する。

- `--task-id`で指定した既存taskだけを`TaskRunner.enqueueTask`経由でqueue item化する。
- taskがapproval必須の場合、`--approval-id`がapprove済みでなければenqueueしない。
- queue itemへapproval gate、exclusive resource lock、retry policy、recovery artifact pathを保存する。
- recovery artifactは `.kairon/experimental/workflows/<workflow_id>-recovery.json` に保存する。
- RuntimeLoopはfeature flagが無効なら接続済みitemをclaimしない。有効時だけ通常の`agent.run` handlerへ渡す。

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
