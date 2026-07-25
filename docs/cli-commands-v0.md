# Kairon CLI Commands v0

## 目的

この文書はT166時点のLocal Betaで実装済みの`kairon` CLI command仕様を定義する。歴史的なMVP判断は該当節に残すが、Command Listと各command節は現行実装を基準とする。

## Command List

```text
kairon init
kairon migrate
kairon doctor
kairon projects register <root> [--format text|json]
kairon projects unregister <project-id> [--format text|json]
kairon projects list [--format text|json]
kairon projects show <project-id> [--format text|json]
kairon projects doctor [--format text|json]
kairon support bundle [--dry-run] [--output <directory>]
kairon support verify <bundle.zip>
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
kairon incident list [--status all|open|acknowledged|recovering|resolved]
kairon incident show <incident-id>
kairon incident acknowledge <incident-id> --reason <reason>
kairon incident bundle <incident-id> [--dry-run] [--output <directory>]
kairon incident recover <incident-id> --dry-run
kairon incident recover <incident-id> --approval-id <approval-id> --confirm <plan-id>
kairon incident resolve <incident-id> --reason <reason>
kairon leave
kairon maintenance run
kairon maintenance run --build-rag
kairon rag refresh
kairon rag status
kairon rag query <query>
kairon release check
kairon release validate
kairon release pack [--output <path>]
kairon release manifest --package <package.tgz> --manifest <manifest.json> [--output <path>]
kairon release verify <package.tgz> [--manifest <manifest.json>] [--release-manifest <release-manifest.json>]
kairon release notes --since <ref> [--write]
kairon release bump --version <version> [--write]
kairon update channel show
kairon update channel set stable|beta|pinned --repository <owner/repo> [--version <version>] [--write --confirm <value>]
kairon update check [--token-env <envName>]
kairon update download <version> [--token-env <envName>]
kairon update apply <download-id> --confirm <download-id> [--dry-run]
kairon update rollback --to <version> --confirm <version> [--dry-run]
kairon readiness manifest --evidence <GATE_ID=path>
kairon readiness check [--manifest <path>]
kairon readiness report [--format json|markdown] [--output <path>]
kairon workflow config show
kairon workflow config propose --enable|--disable
kairon workflow validate <definition-file>
kairon workflow run --definition <definition-file>
kairon workflow run <workflow-id> --task-id <task-id>
kairon workflow show <workflow-id>
kairon workflow recover <workflow-id> --dry-run
kairon workflow checkpoint status
kairon workflow checkpoint verify
kairon workflow checkpoint rebuild --dry-run
kairon workflow checkpoint rebuild --confirm <rebuild-id>
kairon workflow compensate <workflow-id> --dry-run
kairon workflow compensate <workflow-id> --approval-id <approval-id> --confirm <plan-id>
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

## kairon projects

複数のdocked projectをuser-local registryへ登録し、project stateを書き換えずに一覧・診断する。

```text
kairon projects register <root> [--format text|json]
kairon projects unregister <project-id> [--format text|json]
kairon projects list [--format text|json]
kairon projects show <project-id> [--format text|json]
kairon projects doctor [--format text|json]
```

registry pathは次の優先順で解決する。

1. `KAIRON_PROJECTS_REGISTRY_PATH`
2. `KAIRON_USER_DATA_DIR/projects.json`
3. Windows: `%LOCALAPPDATA%/Kairon/projects.json`
4. `XDG_STATE_HOME/kairon/projects.json`
5. `~/.kairon/projects.json`

`register`は`.kairon/config/project.json`、project ID、rootを検証し、同じrootはidempotentに更新する。同じIDの既存rootが存在する場合は拒否し、既存rootが消失済みの場合だけ移動として再登録する。registry更新はadjacent lockとatomic renameを使い、破損registryを自動上書きしない。

`projects doctor`はproject config validation、runtime縮約summary、Board / Discord HTTP runtime endpoint、provider policy上限を順次readする。portとexternal URLを複数projectで比較し、衝突をwarningとして出す。診断結果はregistryの`last_doctor_summary`へ保存するが、各projectの`.kairon/`へは書かない。aggregate provider limitは表示だけで、自動配分やAgent切替は行わない。

registryにtoken、cookie、approval detail、task本文、raw environment、source、stdout / stderrを保存しない。Board URLはuserinfo、query、fragmentを除去してから保存する。

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

## kairon support

local-onlyのsanitized incident bundleを計画、生成、検証する。

```text
kairon support bundle --dry-run
kairon support bundle --output <directory>
kairon support verify <bundle.zip>
```

`bundle --dry-run`は収録予定file、category、推定payload size、除外理由を表示し、counter、plan、ZIPを変更しない。実生成時は`.kairon/support/plans/SUP-xxxx.json`へplanを保存し、指定先または`.kairon/support/bundles/`へ`kairon-support-SUP-xxxx.zip`をatomic finalizeする。

収録対象はsystem、runtime、queue、provider、workflow、notification、integrityのsanitized JSONと`summary.md`だけである。project source、protected path、raw log、agent stdout / stderr、prompt、diffはdirectory単位でcopyしない。`manifest.json`と`hashes.sha256`が各payloadのsizeとSHA-256をbindし、生成前とarchive parse後のsecret scanに失敗した場合はZIPを残さない。`verify`はZIP traversal、duplicate、link、CRC、allowlist、manifest hash、secret findingを検査する。upload処理は持たない。詳細は`docs/support-bundle-v0.md`を参照する。

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
kairon agent session budget codex|claude|gemini [--date YYYY-MM-DD]
kairon agent session compact codex|claude|gemini [--date YYYY-MM-DD] --dry-run
kairon agent session compact codex|claude|gemini [--date YYYY-MM-DD] --confirm <plan-id>
kairon agent session rotate codex|claude|gemini [--date YYYY-MM-DD] --reason <text>
kairon agent session reset codex|claude|gemini --date YYYY-MM-DD
```

`session show` は `health_status`、連続失敗回数、retry backoff秒数、`health_next_retry_at`、現在再試行可能かを表示する。履歴は `.kairon/sessions/YYYY-MM-DD/{agent}/health.json` に最大25件保存し、`setup_required`、permission、rate/usage limit、timeout、no outputなどの理由をrun単位で追跡する。成功時は連続失敗とbackoffをresetするが、履歴とsetup_required累計は保持する。

`session budget` はprompt byte数、job数、経過秒数、compaction回数と、その値がprovider観測かKairon推定かを表示する。soft limitはcompaction planを作成し、hard limitは以後のdispatchを停止する。

`session compact --dry-run` はsource hash付きplanを作るだけでsessionを変更しない。実行時は表示されたplan IDを `--confirm` へ完全一致で指定する。sourceが変化したplanはstaleとして拒否する。

`session rotate` はidle sessionだけを対象に、監査理由とsanitized handoffを保存して新しいsession IDへ切り替える。provider内部contextやcredentialを操作しない。artifactと復旧手順は `docs/session-context-budget-v0.md` を参照する。

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

保存済み`project.json`またはworkflow `runtime.json` config proposalを人間確認後に適用する。

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

`git pr merge` は、候補IDに紐付いたmerge dry-run approvalとfollow-upを必須とする。live GitHub APIからPR状態、base/head SHA、draft、merge conflict、branch protectionのstrict required status checks、required review policyを再取得し、すべて一致した場合だけ許可されたmerge methodを実行する。required approving review countが0のsingle-operator repositoryではKairon approvalを承認境界とし、1以上の場合は最新head SHAへのGitHub approvalも要求する。既定methodは`squash`である。結果は候補artifactの`merge_execution`へ保存し、tokenやraw GitHub responseは保存しない。通信結果が不明な再実行ではPR状態を再取得し、merge済みならAPIを再送せず冪等に成功へ収束する。

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
- forwarded headerはtrusted proxyから届いた場合だけ採用する。`X-Forwarded-Host`を省略するproxyでは標準`Host`を検証対象として使用する。
- approval interactionの初回受付では元メッセージの操作ボタンを除去し、同じapproval actionの再押下を防止する。
- HTTPでqueueされたDiscord approval commandはsingle tickまたはdaemonで適用し、完了・失敗を`.kairon/runtime/discord/decision-interactions.jsonl`へ記録する。

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

## kairon watchdog

runtime異常を評価し、deduplicate済みalertを確認・解決する。

```text
kairon watchdog check
kairon watchdog list
kairon watchdog list --status open
kairon watchdog show <alert-id>
kairon watchdog resolve <alert-id> --reason <text>
```

`check`はdaemon heartbeat、fatal error、restart loop、queue backlog、Discord通知失敗、provider suspend、Task Scheduler登録状態を評価する。alertは`.kairon/watchdog/alerts/ALT-*.json`、集計状態は`.kairon/watchdog/state.json`へ保存する。同じruleとresourceはdeterministic fingerprintでまとめ、severity escalation、cooldown後のreminder、回復時のresolved通知だけを新しい通知対象にする。

`resolve`はoperator reasonを必須とする。原因が残った状態で次回`check`を実行すると、同じalertをopenへ戻す。Watchdogは自動再起動、queue mutation、provider切替を行わない。詳細は`docs/runtime-watchdog-v0.md`を参照する。

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
- watchdog alert counts and highest severity
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

## kairon capability evaluate / explain

task、Agent support、project / persona policy、Approval、connector trust宣言から
effective capabilityをread-only評価する。

```text
kairon capability evaluate --task TASK-0001
kairon capability explain --task TASK-0001 --agent codex
kairon capability explain --task TASK-0001 --agent codex --format json
```

`evaluate`はstatusとeffective / denied / approval_required / setup_requiredを表示する。
`explain`はrequested、supported、policy_allowed、approved、reasonを追加表示する。
CLI自体はApprovalを作成せず、`task run`の実行前gateが必要なApprovalを作成する。
未知capability、未知connector、過剰scopeはdefault denyである。

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
evaluate capability / connector trust policy
write capability-decision.json
stop before Agent launch when approval_required / setup_required / denied
build run context
invoke CliSessionRunner
collect required outbox
apply outbox through StateApplier
complete or fail queue item
```

実行結果は `.kairon/runs/RUN-xxxx/runner.json`、`.kairon/runs/RUN-xxxx/outbox.json`、
`.kairon/runs/RUN-xxxx/capability-decision.json` に残る。
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

`resolve` と `acknowledge` は `.kairon/recovery/resolutions/*.json` にfingerprint単位で記録する。`resolve`だけがtargetを解決済みとして次回検査から除外する。`acknowledge`はoperatorが確認した監査事実であり、healthやrecovery targetを解決しない。

## kairon incident

<!-- kairon:incident-lifecycle -->
Watchdog alertとruntime recovery targetを一つのcorrelated incident timelineへ集約し、承認付き復旧を実行する。

```text
kairon incident list
kairon incident list --status open
kairon incident show INC-0001
kairon incident acknowledge INC-0001 --reason "operator review started"
kairon incident bundle INC-0001 --dry-run
kairon incident bundle INC-0001 --output <directory>
kairon incident recover INC-0001 --dry-run
kairon incident recover INC-0001 --approval-id APR-0001 --confirm IRP-INC-0001-0123456789ab
kairon incident resolve INC-0001 --reason "source cleared and verification passed"
```

`list`と`show`はsourceを再照合してIncident、resource reference、correlation ID、append-only timelineを表示する。canonical artifactは`.kairon/incidents/INC-*.json`、timelineは`.kairon/incidents/INC-*-timeline.jsonl`、復旧planは`.kairon/incidents/plans/IRP-*.json`である。元alert、recovery、approval、support bundleのpayloadは複製せずrelative artifact pathとsanitized metadataだけを保持する。

`acknowledge`は確認済み状態へ移すだけで、active alertやrecovery targetを解決しない。`resolve`はactive source、未解決recovery target、failed verificationが一つでも残る場合に拒否する。同じfingerprintが解決後に再発した場合は同じIncidentをreopenし、`recurrence_count`を増やす。

`recover --dry-run`は対象fingerprint、action、risk、source digest、有効期限、専用approval ID、exact confirmation用plan IDを生成する。実行時はapprovalが`approve`済みであること、Incident・plan・source digestのbinding、plan期限、target freshness、`--confirm`完全一致を再検証する。安全に自動復旧できないtargetは既存runtime recovery approvalへ接続し、Incidentは`partial`として残す。実行済みplanの再利用、無承認実行、stale plan、source変更後の実行は拒否する。

`bundle`は通常のallowlist、redaction、pre/post secret scan、CRC、SHA-256 manifestを維持したまま`diagnostics/incident.json`を追加する。自動upload、外部ITSM write、destructive recovery、Boardからの状態変更は行わない。詳細は`docs/incident-lifecycle-v0.md`を参照する。

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

local lexical/vector RAG indexを作成、状態確認、検索、品質評価する。

```text
kairon rag refresh
kairon rag status
kairon rag provider status
kairon rag vector build --dry-run
kairon rag vector build --execute --confirm <build-id>
kairon rag query "approval routing" --mode lexical --type approval --limit 5
kairon rag query "approval routing" --mode hybrid --type approval --limit 5 --explain
kairon rag evaluate --profile default
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
--mode <lexical|vector|hybrid>
--explain
```

`--explain` は通常のranked resultに加えて、lexical/vector/hybrid score、normalized score、freshness、source diversity penalty、matched terms、source timestamp、stale source warningを表示する。
`--explain` を付けない場合、既存のquery出力形式を維持する。

`rag provider status`はlocal-only providerの`READY|SETUP_REQUIRED`、model ID、dimensionを表示し、外部networkを使用しない。vector buildはdry-runで発行されたbuild IDのexact confirmationを要求し、source manifestまたはlexical indexが変化した場合は再planを要求する。vector runtime未設定・index missing・drift時の`vector|hybrid` queryはlexicalへfallbackし、`status=degraded`と`fallback_reason`を表示する。

`rag evaluate`は`rag.json.evaluation.profiles`のrepresentative queryを実行し、expected path hit、forbidden path hit、precision@K、fallback statusを`.kairon/rag/evaluations/<evaluation-id>.json`へ保存する。golden answer本文とembedding値はartifactへ保存しない。

初回refreshは`mode=full`、既存indexに対する通常refreshは`mode=incremental`、filter付きrefreshは`mode=scoped`となる。incremental refreshはsource manifestの`file_mtime_ms`と`file_size_bytes`が一致するsource/chunkを再利用し、metadataが変わったsourceだけcontent hashを確認する。`rag refresh`はscanned / added / updated / unchangedと理由別skip / prune件数を表示する。

`rag status`は`freshness=fresh|stale|not_indexed`と、`pending_added_sources` / `pending_changed_sources` / `pending_missing_sources`を表示する。lexical indexは`.kairon/rag/index.json`、vector manifestは`.kairon/rag/vector/manifest.json`に保存し、secret-like path、protected path、generated pathはどちらのindex対象からも除外する。

## kairon state

file-based canonical stateのintegrity、snapshot、event compaction、deterministic backupを扱う。

```text
kairon state check
kairon state snapshot --dry-run
kairon state snapshot
kairon state snapshot restore <snapshot-id> --dry-run
kairon state snapshot restore <snapshot-id> --confirm <snapshot-id>
kairon state events compact --dry-run
kairon state events compact --confirm <checkpoint-id>
kairon state events verify <checkpoint-id>
kairon state backup create --dry-run
kairon state backup create --output <directory>
kairon state backup verify <backup-id>
kairon state backup rehearse <backup-id>
kairon state backup restore <backup-id> --confirm <backup-id>
```

`state check`はevent、materialized task / approval / queue、snapshot targetの参照整合性を検査する。snapshot restore、event compaction、backup restoreはdry-runまたはexact confirmationを要求し、実行前にrollback可能なartifactを作る。backupはmanifest、payload set、size、SHA-256を検証し、`rehearse`は隔離したtemporary projectへ展開するため元projectを変更しない。

## kairon test

operation testのPowerShell command、test list / command document、result summaryを生成する。

```text
kairon test commands --range T145-T159
kairon test commands --profile branch-protection-public-sandbox --format powershell
kairon test docs --range T145-T159 --dry-run
kairon test summarize <log-file>
kairon test summarize --result-root <directory> --test-list <test-list.md> --suggest --patch-preview
```

`commands`と`docs`はcredential値を埋め込まず、必要なenvironment variable名とsetup条件だけを出力する。`summarize`は既定でMarkdownを変更せず候補を表示し、`--apply-pass`を明示した場合もPASS候補だけをbackup付きで反映する。`FAIL`、`SETUP_REQUIRED`、`OPTIONAL`を自動的にPASSへ変更しない。

## kairon release

release readiness、release notes、version bumpを補助する。

```text
kairon release check
kairon release validate
kairon release pack
kairon release pack --output C:\tmp\kairon-beta
kairon release manifest --package .\release-artifacts\0.2.0\kairon-0.2.0.tgz --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json
kairon release verify .\release-artifacts\0.2.0\kairon-0.2.0.tgz --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json --release-manifest .\release-artifacts\0.2.0\release-manifest.json
kairon release notes --since v0.1.0
kairon release notes --since v0.1.0 --write
kairon release bump --version 0.3.0
kairon release bump --version 0.3.0 --write
kairon release bump --type patch
kairon release github plan --version 0.2.0 --repository owner/repo
kairon release github publish REL-0001 --approval-id APR-0001 --confirm REL-0001
kairon release github verify --version 0.2.0 --repository owner/repo
```

`release validate` は `package.json.version` と `KAIRON_VERSION` のcore SemVer形式と同期、
release checklistの必須marker、release notesの`Unreleased` markerと現在version entryを
まとめて検査する。検査失敗時は `validation.ok=false` を出力し、exit codeを1にする。

`release pack`はrelease validationとbuild済みentrypointを確認して`npm pack`を実行し、tarballのSHA-256、size、file inventoryを`.sha256.json`へ保存する。`release manifest`はclean tracked sourceのcommit SHA、runtime support、artifact / checksum manifest hash、sorted inventoryを`release-manifest.json`へ保存する。`release verify --release-manifest`はtar path、link、必須file、禁止path、package metadataに加えてrelease manifestとのbindingを再検証する。public npm registryへのpublishは行わない。

`release github plan`は検証済みの`release-artifacts/<version>/`、cleanなlocal HEAD、remote base branch SHA、既存tag / release / assetを照合し、高risk approvalへbindした`.kairon/release/github/plans/<plan-id>.json`を作る。既定はprereleaseで、stable releaseは`--stable`を明示する。tokenは`--token-env`、`GH_TOKEN`、`GITHUB_TOKEN`、明示設定したWindows Credential Manager参照の順で解決し、値はartifactやCLI出力へ保存しない。

`release github publish`はplanに一致するapproved approval、`--confirm`の完全一致、local / remote source SHA、asset hashを再検証してからtag、draft release、3つのasset、release公開を順に実行する。同じtag / release / assetが完全一致する再実行は成功し、途中までuploadされた場合は検証済みassetを再利用する。同名assetの内容不一致、重複、source driftはmutationを続行せずblockedにする。`release github verify`はremote assetを再downloadし、sizeとSHA-256をlocal release manifestへ照合する。

`release notes` は既定ではdry-runで、`--write` を付けた場合のみ
`docs/release-notes-v0.md` の `<!-- kairon:release-notes-unreleased -->` 直下へappendする。

`release bump` は既定ではdry-runで、`--write` を付けた場合のみ `package.json`、
存在する`package-lock.json`、`src/index.ts` を同時に更新する。`--version` と `--type` は同時指定しない。

write modeの安全条件。

```text
tracked worktreeがcleanであること
backup artifactを.kairon/release/backups/<timestamp>/へ作成すること
npm publishは実行しないこと
git tag / GitHub Releaseは承認済み`release github publish`だけが実行すること
```

## kairon update

検証済みGitHub Releaseを手動で選択し、user-local cacheを経由して既存Windows package lifecycleへ渡す。background check、silent update、schedulerは実行しない。

```powershell
kairon update channel show
kairon update channel set beta --repository owner/repo --dry-run
kairon update channel set beta --repository owner/repo --write --confirm beta
kairon update channel set pinned --repository owner/repo --version 0.2.0 --write --confirm pinned@0.2.0
kairon update check
kairon update download 0.2.0
kairon update apply UPD-0001 --confirm UPD-0001 --dry-run
kairon update apply UPD-0001 --confirm UPD-0001
kairon update rollback --to 0.1.0 --confirm 0.1.0
```

`update check`はconfigured channelに合うpublished releaseを照合し、release manifest、tag SHA、Node runtime条件をmemory上で検証する。filesystemとregistryは変更しない。`stable`はprereleaseを除外し、`beta`はstable / prereleaseを許可し、`pinned`は指定versionだけを許可する。

`update download`は`.tgz`、checksum manifest、release manifestを`%LOCALAPPDATA%\Kairon\updates`配下のpartial directoryへ取得する。package hash、inventory、manifest hash、source commitを検証した後だけatomic renameし、project側には`.kairon/update/downloads/UPD-*.json`のsecret-free metadataを保存する。tokenは`--token-env`、`GH_TOKEN`、`GITHUB_TOKEN`、明示したWindows Credential Manager参照の順で解決し、artifactへ保存しない。

`update apply`と`update rollback`はcache済みartifactを再検証してから`scripts/update-local-beta.ps1`を起動する。exact `--confirm`が必要で、PowerShell lifecycleがtarget versionを確認した場合だけ`.kairon/update/registry.json`のinstalled、previous、last successful versionを更新する。失敗時はregistryを成功扱いにせず、既存scriptがpackage / state rollbackとdiagnostic bundleを処理する。rollback targetは事前に`update download`でcache済みでなければならない。

## kairon readiness

T145以降のoperation test、doctor、daemon certification、backup rehearsal、GitHub / Discordのlive確認、RAG verify、provider compliance、local beta lifecycleなどの証跡を集約し、Beta配布可否を機械判定する。

```powershell
kairon readiness manifest `
  --evidence BUILD_UNIT_INTEGRATION=.\operation-test-results\summary.json `
  --evidence CONFIG_MIGRATION_DOCTOR=.\.kairon\reports\doctor.json `
  --evidence PACKAGE_LIFECYCLE=.\release-artifacts\0.2.0\verification.json

kairon readiness check
kairon readiness report --format json --output .kairon\reports\readiness\latest.json
kairon readiness report --format markdown --output .kairon\reports\readiness\latest.md
```

`manifest`は各証跡のrelative path、artifact kind、判定status、source commit、実行時刻、有効期限、SHA-256、sizeを`.kairon/readiness/evidence-manifest.json`へ記録する。`GATE_ID=path`は複数指定できるが、project root外のpathは拒否する。

必須gate IDは`BUILD_UNIT_INTEGRATION`、`CONFIG_MIGRATION_DOCTOR`、`RUNTIME_RESILIENCE`、`GITHUB_MERGE_DEPLOY_GUARD`、`WORKFLOW_RECOVERY_CONTROL`、`DISCORD_BOARD_SECURITY`、`RAG_INTEGRITY`、`PROVIDER_QUOTA_COMPLIANCE`、`PACKAGE_LIFECYCLE`、`SECRET_ARTIFACT_INTEGRITY`。`KNOWN_LIMITATIONS`は任意gateで、証跡未登録時は`OPTIONAL`となる。

`check`と`report`は証跡を再読込し、checksum、size、status、source commit、有効期限を再検証する。必須gateがすべて`PASS`の場合だけexit code 0となる。外部credentialやlive環境がない場合は`SETUP_REQUIRED`、期限切れ・別commit・改変・解析不能は`UNKNOWN`であり、自動的に`PASS`へ昇格しない。

reportはraw token、環境変数値、Discord payload、GitHub response bodyを含めない。出力前後にsecret scanを行い、redactionが必要だった場合は`SECRET_ARTIFACT_INTEGRITY=UNPASSED`とする。

## kairon workflow

task、approval、queue item、resource lockを永続workflow状態として管理する。production実行は正式config配下で行い、run artifactと遷移ごとのcheckpointから再起動後に継続できる。

```text
kairon workflow config show
kairon workflow config propose --enable
kairon workflow config propose --disable
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx --dry-run
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx
kairon workflow validate .\workflow-definition.json
kairon workflow run --definition .\workflow-definition.json
kairon workflow run WF-0001 --task-id TASK-0001
kairon workflow run WF-0002 --task-id TASK-0002 --approval-id APR-0001 --resource-lock src/shared.ts --retry-max-attempts 3
kairon workflow show WF-0001
kairon workflow recover WF-0001 --dry-run
kairon workflow recover WF-0001
kairon workflow checkpoint status
kairon workflow checkpoint verify
kairon workflow checkpoint rebuild --dry-run
kairon workflow checkpoint rebuild --confirm WCR-20260723010203004-0123456789ab
kairon workflow compensate WF-0001 --dry-run
kairon workflow compensate WF-0001 --approval-id APR-0002 --confirm WF-0001-COMP-000006
```

production runtimeの正式な有効化設定。

```json
{
  "workflow": {
    "enabled": true,
    "mode": "production",
    "checkpoint_store": "file",
    "checkpoint_sqlite_path": ".kairon/workflows/checkpoints.sqlite",
    "checkpoint_sqlite_busy_timeout_ms": 5000
  }
}
```

`workflow config show`は設定値、実効値、`config` / `environment` / `default`のsource、競合、legacy fallback、checkpoint / retry設定を表示する。`propose`は`runtime.json`を直接変更せず、riskとrestart要否を含むproposalを保存する。`KAIRON_WORKFLOW_RUNTIME`は`workflow.enabled`がない旧projectだけの互換fallbackである。

`checkpoint_store=file`はcanonical JSON checkpointだけを使用する既定値である。`file+sqlite`はcanonical file write成功後にNode 22標準SQLiteへ検索用rowをmirrorする。SQLite更新失敗はworkflow runを失敗させず、store statusを`degraded`または`rebuild_required`へ更新する。`checkpoint verify`はfileとrowのworkflow ID、sequence、state hash、fencing token、pathを比較する。`checkpoint rebuild --dry-run`はcanonical fileのdigestを固定したplanを作成し、同じrebuild IDを`--confirm`した場合だけSQLite indexを置換する。

`validate`はdefinition schema、duplicate / missing / cycle / unreachable edge、condition依存、parallel branch、join policyを検証し、任意JavaScript、shell、`eval`を受理しない。`run --definition`は検証済みdefinitionをcanonical definition artifactへ保存し、condition、parallel、manual gate、join、taskをrun artifactへ展開する。同時にreadyとなったbranch taskはnode単位idempotency keyとresource lockでdispatchされ、restart後も同じqueue itemを再利用する。

従来の`run`は未作成workflowを`--task-id`から開始し、既存workflowではapproval・queue状態を照合して続行する。`recover --dry-run`はartifactを変更せず復旧候補だけを表示する。実際の`recover`とRuntimeLoop起動時のrecoveryは、完了nodeを再投入せず未完了nodeだけを進める。

- run artifact: `.kairon/workflows/runs/<workflow_id>.json`
- definition artifact: `.kairon/workflows/definitions/<workflow_id>.json`
- checkpoint: `.kairon/workflows/checkpoints/<workflow_id>-<sequence>.json`
- compensation plan: `.kairon/workflows/compensations/<plan_id>.json`
- queue itemは`workflow/node/attempt`のidempotency keyを持つ。
- nodeはattempt、queue item ID、run ID、input/output digest、fencing tokenを保持する。
- approval待ちは`waiting_approval`、join待ちは`join_waiting:<policy>:<completed>/<total>`、resource lock競合は`paused`として永続化する。
- compensationは完了済みnodeを逆トポロジ順にplan化する。`--dry-run`ではqueueへ投入せず、approve済みapprovalと`--confirm <plan-id>`が揃った場合だけ1 stepずつidempotentにdispatchする。
- workflow config無効時はproduction workflow itemをRuntimeLoopがclaimしない。

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

## Operational Notes

- `kairon start` はforeground single tickとdaemon modeの両方を持つ。
- `kairon task run` は現段階では同期実行の最小経路として動く。queue itemの非同期処理はruntime loop経由でも進められる。
- `kairon stop` は terminal session を閉じる前に handoff を書く。
- Discord が disabled の場合、approval は `.kairon/approvals` に file として残す。
- `kairon leave` は Runtime を停止しない。本日の Active Work だけを閉じる。
