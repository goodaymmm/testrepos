# Kairon

Kairon は、既存プロジェクトにドッキングして、人間と AI Agent が共生しながら作業を進めるためのローカル運用基盤です。

名前は Kairos、Symbiosis、Drive を組み合わせたものです。通常の時間を、AI と人間の協調によって価値ある決定的な作業時間へ駆動する、という意図を持っています。

## 現在の位置づけ

<!-- kairon:t159-beta-baseline -->
このリポジトリは、T159までの実装とoperation testを完了した個人運用向けLocal Betaです。build、unit / integration test、state integrity、secret scanに加え、24時間daemon、GitHub / Discord live経路、remote read-only Board、production workflow、Windows package lifecycleを検証済みです。

Kaironは対象projectの`.kairon/`をcanonical stateとして使い、公式Agent CLI、approval、Git / deploy guard、maintenanceをローカルで統合します。外部writeと高リスク操作はdefault disabledまたはapproval requiredであり、Boardはread-onlyを維持します。

現時点で実装済みの主な範囲:

- `.kairon/` の生成と初期設定
- runtime lock、schedule、status、leave
- queue、command inbox、state applier
- Agent dispatcher、context builder、session host
- Codex / Claude / AntigravityCLI 公式 CLI へ接続する runner 境界
- review loop / quality gate の実行経路
- git workspace / diff snapshot / transaction / rollback metadata / guarded PR create・merge
- GitHub branch protection、required checks、single-operator review policy診断
- local-sandbox deploy providerとproduction providerのdefault deny
- Discord Gateway / HTTP Interactions、approval reply、idempotency、decision audit、correlation追跡
- approval queue CLI
- runtime loop、Windows Task Scheduler daemon、24時間certification、runtime recovery
- runtime watchdog、deduplicated alert、cooldown付きDiscord通知
- incident lifecycle、correlated timeline、approval-gated assisted recovery
- daily report、agent handoff、retention、cleanup proposal / apply / archive
- state integrity、snapshot / restore、event compaction、deterministic backup / rehearsal
- read-only Board projection、loopback / remote-readonly server、short-lived access token
- production workflow、checkpoint、resource lock、pause / resume / cancel / recover
- local lexical RAG、incremental refresh、integrity / stats / rebuild / context連携
- provider quota / suspend policy、operation test profile / summary支援
- checksummed private local package、install / update / rollback / uninstall
- reproducible `0.2.0` artifact、approval-gated GitHub Release、verified manual update channel
- allowlist収集、secret scan、hash manifest付きのsanitized support bundle
- evidence manifestとBeta readiness gate

Local Beta後の主な開発範囲:

- workflow branch / join / compensationとdurable checkpoint store
- session context budget、capability / MCP trust policy、hybrid local RAG
- multi-project read-only supervisorと固定remote profile
- Release Candidate readiness gate

## 前提

- Node.js 22 以上
- npm
- Git
- PowerShell
- Codex CLI、Claude Code、AntigravityCLI を使う場合は、それぞれ公式 CLI でログイン済みであること

Kairon は公式 CLI / 公式認証フローだけを使う設計です。OAuth token、cookie、内部 endpoint を抽出して独自 client から叩く運用はしません。

## セットアップ

Kairon リポジトリで依存関係をインストールします。

```powershell
cd C:\Users\hikar\Documents\AutoRunner
npm install
npm run build
npm test
```

CLI のヘルプを確認します。

```powershell
node .\dist\cli\main.js --help
```

開発中は次の形でも実行できます。

```powershell
npm run kairon -- --help
```

## 対象プロジェクトへドッキングする

対象プロジェクトのルートへ移動し、Kairon CLI を実行します。

```powershell
cd C:\path\to\target-project
node C:\Users\hikar\Documents\AutoRunner\dist\cli\main.js init
```

成功すると、対象プロジェクトに `.kairon/` が作成されます。

```text
.kairon/
  config/
  rules/
  events/
  tasks/
  messages/
  approvals/
  runs/
  sessions/
  runtime/
  watchdog/
  incidents/
  reports/
  recovery/
  rag/
  board/
  support/
  cleanup/
  tmp/
```

`.kairon/` は運用 state を含むため、通常は対象プロジェクトの `.gitignore` に追加します。

```gitignore
.kairon/
```

## npm link で kairon コマンド化する

毎回 `node ...\dist\cli\main.js` を打つ代わりに、ローカル CLI として link できます。

```powershell
cd C:\Users\hikar\Documents\AutoRunner
npm link
```

その後、対象プロジェクトで次のように実行できます。

```powershell
cd C:\path\to\target-project
kairon init
kairon status
```

## 基本コマンド

### 初期化

```powershell
kairon init
```

対象プロジェクトに `.kairon/` と初期設定を作成します。既存の root `AGENTS.md` などは上書きしません。

### 設定マイグレーション

```powershell
kairon migrate --dry-run
kairon migrate
```

既存 `.kairon/config/*.json` を現在のschemaやCLI名に合わせて移行します。実行時は対象configのbackupを `.kairon/config/*.bak-YYYYMMDDHHmmss` として作成します。

### 診断

```powershell
kairon doctor
kairon doctor --format json
```

Git、`.gitignore`、config、公式CLI、API key混入、Discord設定、GitHub branch protection、runtime recovery、daemon health、Board secret scan、RAG index、safety policyを確認し、`pass` / `warning` / `error` と具体的な`next_action`を表示します。`--format json`でも同じ`next_action`、関連CLI command、guide pathを機械可読形式で取得できます。外部設定不足はdetailの`status=setup_required`として示し、tokenなどのsecret値はtext/JSONのどちらにも出力しません。

GitHub branch protectionのlive確認は、`GH_TOKEN` または `GITHUB_TOKEN` を使って GitHub REST API を確認します。両方ある場合は `GH_TOKEN` を優先します。Windowsでは `KAIRON_GH_TOKEN_CREDENTIAL_TARGET` / `KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET` でWindows Credential Manager targetを指定すると、envが未設定の場合だけfallbackとして読み取れます。fine-grained PATを使う場合は対象repositoryへのRepository accessと、AdministrationのRead-only権限が必要です。GitHub Freeのprivate repositoryではbranch protection APIが403になる場合があるため、live API疎通はpublic sandbox repositoryで確認する運用にしています。手順は [docs/github-branch-protection-sandbox-v0.md](docs/github-branch-protection-sandbox-v0.md) を参照してください。

### Support Bundle

```powershell
kairon support bundle --dry-run
kairon support bundle --output C:\path\to\support-output
kairon support verify C:\path\to\support-output\kairon-support-SUP-0001.zip
```

障害調査用bundleはsystem、runtime、queue、provider、workflow、notification、integrityのallowlist済みsummaryだけを収録します。project source、`.env`、credential、raw stdout / stderr、prompt、diff、logはcopyしません。archive生成前後にsecret pattern scanを行い、ZIP内のpath、CRC、SHA-256 manifestも再検証します。自動uploadやclipboard copyは行いません。安全境界と共有前の確認事項は [docs/support-bundle-v0.md](docs/support-bundle-v0.md) を参照してください。

### Agent Smoke

```powershell
kairon agent smoke --agent codex
kairon agent smoke --agent claude
kairon agent smoke --agent gemini
```

Antigravity は互換性維持のため CLI 引数では `--agent gemini` を使います。実際に起動する公式 CLI は `agy` です。

設定済みの公式CLIへ最小promptを送り、`.kairon/runs/RUN-xxxx/` に `stdin.md`、`stdout.log`、`stderr.log`、`runner.json`、`outbox.json` を記録します。CLIが見つからない場合は実行せず `setup_required` としてoutboxへ記録します。

### Agent Session Health

```powershell
kairon agent session list
kairon agent session show codex
kairon agent session reset codex --date 2026-07-14
```

Agentごとのhealth、連続失敗、retry backoff、setup_required履歴を `.kairon/sessions/YYYY-MM-DD/{agent}/health.json` に保存します。dispatcherはbackoff中の不健康なsessionを既定で避け、成功後は連続失敗をresetします。`session reset` はsession directoryをarchiveするため、healthを含む既存証跡は残ります。

### Provider Policy Health

```powershell
kairon agent health
kairon agent health --agent codex
kairon agent suspend --agent claude --reason "terms review required"
kairon agent resume --agent claude --reason "terms reviewed by operator"
```

`agents.json` の `provider_policies` で、providerごとのunattended許可、同時実行数、cooldown秒数、日次run上限を管理します。quota / rate limitは対象providerだけをcooldownし、auth / setup / compliance / 未分類エラーは手動確認までsuspendします。状態は `.kairon/runtime/agents/{agent}-health.json`、手動suspend / resumeを含む監査は `.kairon/audit/provider-policy.jsonl` に保存します。

Kaironはquota回避を目的としたaccount切替、credential rotation、request分割を行いません。手動resumeにはoperatorの理由が必須で、日次上限を迂回する操作にはなりません。

### タスク作成と実行

```powershell
kairon task create --title "調査結果を整理する" --persona researcher --capability research
kairon task run TASK-0001 --timeout-ms 120000
```

`task create` は `.kairon/tasks/TASK-xxxx/task.json` を作成します。`task run` は `agent.run` queue itemを作り、dispatcherでAgentを選択し、既存のCLI runnerへ投入します。Agentが書いた `outbox.json` は State Applier に渡され、message / approval / task status へ反映されます。

### レビュー実行

```powershell
kairon review run REV-0001 --timeout-ms 120000
```

指定した review loop の reviewer を設定から読み込み、公式CLI runnerへ投入します。reviewer の `outbox.json` に含まれる `review_result` を保存し、`minimum_score`、`block_on_severity`、`max_iterations` を使って quality gate を評価します。

通過した場合は loop を `approved` にし、基準未満の場合は修正用の queue item を作成します。最大反復回数に達した場合は approval queue にエスカレーションします。`commit_requested` かつreview承認済みで、対象runのdiff snapshotが存在する場合は `git.transaction` queue itemを作成します。実行結果は `.kairon/reviews/loops/` と `.kairon/reviews/results/` に残ります。

### GitHub PR / Merge / Deploy

```powershell
kairon git pr list
kairon git pr show GTX-0001
kairon git pr create GTX-0001 --dry-run
kairon git pr merge GTX-0001 --dry-run --follow-up-id <follow-up-id>
kairon deploy dry-run --target main --environment local-sandbox --provider local-sandbox --check smoke:passed
```

PR作成、merge、deployはdry-run artifact、approval、fresh preflight、input digestを使って実行対象を固定します。実GitHub mergeはcandidate-boundな`kairon git pr merge`だけが担当し、branch protection、required checks、review policy、head SHAを実行直前に再確認します。deployは既定で`local-sandbox`だけを許可し、production providerはpolicyで明示的に有効化されるまで拒否します。

### 承認待ち確認と決定

```powershell
kairon approval list
kairon approval show APR-0001
kairon approval decide APR-0001 --action approve --reason "内容を確認済み"
kairon approval decide APR-0001 --action request_changes --reason "テスト追加が必要"
kairon approval decide APR-0001 --action snooze --until 2026-05-26T09:00:00.000Z
```

`approval list` は既定で pending の承認だけを表示します。`show` は diff、log、stdout、stderr、secret-like key を過剰表示しない安全な詳細表示です。`decide` は `approve`、`reject`、`request_changes`、`snooze` を state に反映します。すでに決定済みの approval へ再決定しようとした場合は拒否します。

Discord live連携ではGatewayまたは署名検証付きHTTP Interactionsを選択できます。HTTP modeはloopbackを既定とし、外部利用時はTLS reverse proxy、trusted proxy、Discord Public Keyを必須にします。approval requestとdecision replyはmessage referenceで関連付けられ、同じinteractionや決定済みapprovalの再処理を拒否します。詳細は [docs/discord-approval-v0.md](docs/discord-approval-v0.md) と [docs/discord-gateway-v0.md](docs/discord-gateway-v0.md) を参照してください。

### ドッキング解析

```powershell
kairon docking analyze
```

対象プロジェクトのtop-level構成をscanし、`project.json` 向けの `protected` / `generated` / `source` 候補をJSON proposalとして表示します。configは直接書き換えません。

### 設定proposal

```powershell
kairon config propose
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx --dry-run
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx
```

`config propose` はドッキング解析結果を `.kairon/config/proposals/` に保存します。`workflow config propose`はproduction workflow用の`runtime.json` proposalを保存します。`config apply`はどちらの保存済みproposalも対象にでき、実適用時は事前に `.bak-YYYYMMDDHHMMSS` backupを作ります。proposalが古い場合や対象projectが違う場合は拒否します。

### 起動

```powershell
kairon start
kairon start --daemon --interval-ms 1000 --max-ticks 2
```

runtime lock を取得し、現在のscheduleに基づいて runtime tick を実行します。`--daemon` を付けた場合はintervalごとに複数tickを実行し、heartbeatとdaemon logを `.kairon/runtime/daemon/` に残します。

- `active_work`: ready queue item を処理します。
- `standby_work`: command inboxを優先し、standby指定または承認済みの安全なqueue itemだけを処理します。
- `maintenance`: 日次メンテナンスを同一日1回だけ実行し、重複時はskipします。

実行結果は `.kairon/runtime/last-tick.json` に記録されます。daemon実行時は `--max-ticks`、`--max-idle-ticks`、`kairon stop` により停止できます。直近daemonの状態は `kairon status` の `daemon.health.*` と `artifacts.latestDaemonLog` でも確認できます。

### Board

```powershell
kairon board export
kairon board serve --host 127.0.0.1 --port 8787
kairon board serve --require-token --access-token-ttl-seconds 900
```

approval、queue、run、review、recovery、cleanup、Discord decision auditをredaction済みのread-only projectionとして出力します。approval、Discord message / interaction、follow-up、workflowは共通`correlation_id`で関連付けられ、BoardのCorrelation Timelineから一連の状態遷移を確認できます。mappingは`.kairon/correlations/COR-*.json`、追記監査ログは`.kairon/audit/correlation-events.jsonl`に保存され、ID・状態・相対path以外のpayloadやcredentialは保持しません。HTML dashboardにはcompact viewがあり、狭い画面でもapproval、failed/setup_required run、recovery、daemon healthを先に確認できます。`serve` はloopback hostだけを許可し、既定では `http://127.0.0.1:8787/` でHTML dashboardと `projection.json` を提供します。

`--require-token`または`--access-token-ttl-seconds`を指定すると、起動時に短時間有効な`board.read` Bearer tokenを1回だけ表示します。requestには`Authorization: Bearer <token>`を付けます。`.kairon/runtime/board/server.json`にはtoken本体ではなくSHA-256 hash、`expires_at`、scopeだけを保存し、期限切れtokenやread-only以外のscopeは拒否します。認証を有効にしてもBoardはGET/HEAD専用で、approval、merge、deploy操作は実行できません。

外部PC・mobileから確認する場合は、既定のloopbackを維持したまま認証済みHTTPS reverse proxyの背後で`kairon board serve --profile remote-readonly`を使用します。`kairon board access issue --ttl-minutes 15`で短期tokenを発行し、利用後は`kairon board access revoke <access-id>`で失効します。remote profileはtrusted proxy、Origin allowlist、verified identity header、rate limitを必須とし、remote表示から実行・rollback用command hintを除外します。設定と安全境界は[docs/board-public-safety-v0.md](docs/board-public-safety-v0.md)を参照してください。

projectionは出力直前にsecret-like field、Bearer token、GitHub/OpenAI形式のcredentialを再検査し、redaction結果を`meta.secret_scan`へ記録します。BoardへのGET/HEADと拒否されたrequestは`.kairon/runtime/board/access.jsonl`へ記録しますが、raw token、IP、User-Agentは保存しません。`kairon doctor`の`board.secret_scan`で保存済みprojectionを、`correlation.integrity`でmissing artifact、stale Discord message、orphan follow-upを確認できます。日次レポートにもcorrelation integrityの集計が含まれます。

### Cleanup proposal

```powershell
kairon cleanup list
kairon cleanup show 2026-06-01
kairon cleanup apply 2026-06-01 --dry-run
kairon cleanup apply 2026-06-01
kairon cleanup archive 2026-06-01
```

maintenanceが作成したcleanup proposalを確認し、review済み候補だけを `.kairon/tmp/cleanup-.../` へ移動またはarchiveします。protected pathはapply対象にしません。実行結果は `.kairon/cleanup/applied/` または `.kairon/cleanup/archived/` に残ります。

### Runtime recovery

```powershell
kairon recovery run
kairon recovery list
kairon recovery show <target-id-or-fingerprint>
kairon recovery resolve <target-id-or-fingerprint> --reason "手動確認済み"
kairon recovery acknowledge <target-id-or-fingerprint> --reason "手動復旧する"
```

stale lock、expired claim、partial outbox、Discord gateway mid-state、Git transaction mid-stateを検出します。安全に再queue可能なものだけ自動処理し、ambiguousなものはapprovalへ回します。`resolve`はfingerprint単位で復旧済みとして記録します。`acknowledge`はoperatorが確認した事実だけを記録し、targetを解決済みにせず次回検査にも残します。

### Incident lifecycle

```powershell
kairon incident list
kairon incident show INC-0001
kairon incident acknowledge INC-0001 --reason "確認して対応を開始"
kairon incident bundle INC-0001 --dry-run
kairon incident recover INC-0001 --dry-run
kairon incident recover INC-0001 --approval-id APR-0001 --confirm IRP-INC-0001-0123456789ab
kairon incident resolve INC-0001 --reason "原因解消と復旧検証を確認"
```

Watchdog alertとruntime recovery targetをdeterministic fingerprintで同じIncidentへ集約し、元artifactへの参照とappend-only timelineを保持します。acknowledgeだけではactive conditionを解決せず、resolveはalert、recovery target、failed verificationが残る間は拒否されます。復旧はdry-run plan、専用approval、期限内のexact confirmation、target freshness再検証を必須とします。詳細は [docs/incident-lifecycle-v0.md](docs/incident-lifecycle-v0.md) を参照してください。

### State integrity / Backup

```powershell
kairon state check
kairon state snapshot --dry-run
kairon state events compact --dry-run
kairon state backup create --dry-run
kairon state backup verify <backup-id>
kairon state backup rehearse <backup-id>
```

file-based canonical stateの参照整合性、checkpoint、snapshot、backup manifestとSHA-256を検証します。restoreやevent compactionはdry-runとexact confirmationを要求し、backup rehearsalは隔離したtemporary projectへ展開して元projectを変更しません。

### RAG

```powershell
kairon rag refresh
kairon rag status
kairon rag verify
kairon rag stats --duplicates --context-budget
kairon rag rebuild --dry-run --compare
kairon rag rebuild --execute --confirm <rebuild-id>
kairon rag query "approval routing" --type approval --limit 5
```

local lexical RAG indexを `.kairon/rag/index.json` に作成し、metadata filter付きで検索します。2回目以降の通常refreshはsource manifestのmtime・file size・content hashを使うincremental modeになり、変更sourceだけを再構築します。`rag verify`は決定的checksum、source/chunk参照、source driftを検証し、結果を`.kairon/rag/integrity/latest.json`へ保存します。`rag stats`はduplicate比率、推定token、context budget、rebuild期限、retention候補を表示します。

full rebuildは最初に`--dry-run --compare`で現在indexを変更せずcandidateとquery sampleを比較し、発行されたrebuild IDと一致する`--execute --confirm`でのみatomic swapします。plan後にcurrent indexまたはsourceが変わった場合は実行を拒否します。refresh、compact、rebuildは同じresource lockを使用します。`rag status`はpending added / changed / missingとfreshnessを表示し、refresh・maintenance出力はprotected / generated / missing / archivedなどのskip・prune理由を件数で示します。context builderは必要に応じてRAG検索結果をrun contextへ含め、secret-like path、protected path、generated pathはindex対象から除外します。

### Production workflow

```powershell
kairon workflow config show
kairon workflow config propose --enable
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx --dry-run
kairon config apply CFG-YYYYMMDDHHMMSS-xxxxxxxx
kairon workflow list
kairon workflow run WF-0001 --task-id TASK-0001
kairon workflow show WF-0001
kairon workflow recover WF-0001 --dry-run
kairon workflow pause WF-0001 --reason "operator review"
kairon workflow resume WF-0001
```

production workflowは`.kairon/workflows/`へrunとtransition checkpointを保存し、queue idempotency、approval gate、resource lock、retry、pause / resume / cancel / recoverを既存TaskRunner境界へ接続します。`runtime.json.workflow.enabled=true`をproposal経由で適用した場合だけproduction workflow itemをruntimeがclaimし、既定は無効です。旧projectの`KAIRON_WORKFLOW_RUNTIME`はconfigに`enabled`がない場合だけ互換fallbackとして利用されます。`--candidate`を使う`.kairon/experimental/workflows/`経路は互換性とdry-run評価用であり、production canonical stateの代替ではありません。

### Local Beta package / Readiness

```powershell
npm run release:pack
kairon release manifest --package .\release-artifacts\0.2.0\kairon-0.2.0.tgz --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json
kairon release verify .\release-artifacts\0.2.0\kairon-0.2.0.tgz --manifest .\release-artifacts\0.2.0\kairon-0.2.0.tgz.sha256.json --release-manifest .\release-artifacts\0.2.0\release-manifest.json
kairon readiness manifest --evidence <GATE_ID=path>
kairon readiness check
kairon readiness report --format markdown
```

local packageはpublic npm registryへpublishせず、tarball、checksum manifest、release manifest、sorted file inventoryを検証してWindowsへinstallします。release manifestはclean source commit、runtime support、artifact hashをbindします。readinessはevidenceのsource commit、hash、size、freshnessを再検証し、必須gateがすべて`PASS`の場合だけ成功します。外部未設定、別commit、期限切れ、改変済み証跡を自動的にPASSへ昇格しません。

### 状態確認

```powershell
kairon status
```

schedule mode、runtime lock、daemon health、watchdog alert、queue、approval、recovery target、session、Discord gateway、最新artifact の状態を表示します。
daily report / cleanup proposal / recovery artifact / next-day plan / board projection / daemon log が存在する場合は、次に確認するパスも `artifacts.*` として表示します。

### Runtime Watchdog

```powershell
kairon watchdog check
kairon watchdog list --status open
kairon watchdog show <alert-id>
kairon watchdog resolve <alert-id> --reason "operator confirmed recovery"
```

Watchdogはdaemon heartbeat、fatal error、restart loop、queue backlog、Discord通知失敗、provider suspend、Windows Task Scheduler登録状態を評価し、`.kairon/watchdog/`へdeduplicate済みalertを保存します。同じ異常はfingerprintでまとめ、cooldown中の再通知を抑制します。検知失敗はruntime tickの成否を変更せず、Watchdog自身は自動再起動、queue変更、provider切替を行いません。詳細は [docs/runtime-watchdog-v0.md](docs/runtime-watchdog-v0.md) を参照してください。

### Active Work 終了

```powershell
kairon leave
```

本日の Active Work を終了し、以降を standby 相当に切り替える schedule override を作ります。runtime 自体は停止しません。

### 日次メンテナンス

```powershell
kairon maintenance run
kairon maintenance run --build-rag
```

次の artifact を作成します。

- `.kairon/reports/daily/YYYY-MM-DD.json`
- `.kairon/sessions/YYYY-MM-DD/{agent}/handoff.json`
- `.kairon/sessions/YYYY-MM-DD/{agent}/handoff.md`
- `.kairon/cleanup/proposals/YYYY-MM-DD.json`
- `.kairon/recovery/REC-*.json`
- `.kairon/reports/next-day/YYYY-MM-DD.json`
- `.kairon/rag/index.json` (`--build-rag` または `rag.json` 有効時)

cleanup は直接削除せず、Morning Review で確認する proposal として作成されます。
CLI出力には `cleanup_candidates`、`recovery_*`、`rag_status`、`next_status_command`、`next_cleanup_command`、`next_recovery_command`、`next_board_command` が含まれます。maintenance後は `kairon status` で最新artifactを確認し、必要に応じて `kairon cleanup show <date>`、`kairon recovery list`、`kairon board export` を続けます。

### 停止

```powershell
kairon stop
```

runtime lock を解放します。

### Windows 常駐運用

Windows Task Schedulerで `kairon start --daemon` を日常運用する場合は、[docs/windows-daemon-ops-v0.md](docs/windows-daemon-ops-v0.md) を参照してください。
`kairon daemon task status|install|uninstall|restart` からTask Schedulerを操作でき、`install`と`uninstall`は`--dry-run`で変更内容を事前確認できます。CLIは内部で`scripts/kairon-daemon-task.ps1`へ固定引数を渡します。Discord / GitHub tokenなどのsecretはTask引数に書かず、ユーザー環境変数または明示設定したWindows Credential Manager targetから読み取ります。

## 実 CLI の確認

Kairon の Agent Runner は公式 CLI を前提にします。運用テスト前に、対象マシンでそれぞれ確認します。

```powershell
codex --help
claude --help
agy --help
```

CLI が見つからない場合、Kairon は該当 Agent を `setup_required` として扱う設計です。

## 運用テスト

運用テストは、いきなり 24 時間自律稼働に入らず、短い smoke test から始めます。

最初の合格基準は、AI が長時間作業できることではなく、次の安全条件を満たすことです。

- 迷った時に止まる
- approval が必要な操作を勝手に進めない
- stdout / stderr / outbox / report / handoff が残る
- cleanup が直接削除にならない
- merge / deploy が自動実行されない
- 翌日 bootstrap が前日 handoff を読める

最小チェックリスト:

1. Kairon リポジトリで `npm run typecheck`、`npm test`、`npm run build` が通る。
2. 検証用プロジェクトで `kairon init` を実行し、 `.kairon/` が生成される。
3. `.kairon/config/*.json` の schedule、agents、policies、notifications を確認する。
4. `codex --help`、`claude --help`、`agy --help` で公式 CLI の availability を確認する。
5. `kairon start`、`kairon status`、`kairon leave`、`kairon stop` を確認し、`.kairon/runtime/last-tick.json` を確認する。
6. `kairon maintenance run` を実行し、daily report、agent handoff、cleanup proposal が作られることを確認する。
7. cleanup proposal が直接削除・直接移動をしていないことを確認する。
8. merge / deploy / protected branch push が approval required のままになっていることを確認する。
9. 必要に応じて `kairon board export` / `kairon board serve`、`kairon rag refresh`、`kairon recovery run`、`kairon cleanup apply --dry-run` を確認する。

運用テストを再実行する場合は、harnessを使えます。

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp"
```

実行結果は `operation-test-results/<run-id>/summary.json` と `summary.md` に出力されます。対象projectの `.kairon` stateは実行前にbackupされ、既定では終了時にrestoreされます。詳細は [docs/operation-test-harness-v0.md](docs/operation-test-harness-v0.md) を参照してください。

長いPowerShellログや `operation-test-results` の結果を確認する場合は、summaryだけを抽出できます。これは docs の自動書き換えは行わず、PASS / FAIL / SETUP_REQUIRED / OPTIONAL の候補と証跡pathを表示します。

```powershell
kairon test summarize .\operation-test-results\manual-log.txt
kairon test summarize --result-root .\operation-test-results
```

操作テストリストのMarkdownと照合し、PASS反映候補や未PASS候補だけをレビューしたい場合は `--test-list` と `--suggest` を使います。既存のMarkdownは自動更新されません。

```powershell
kairon test summarize .\operation-test-results\manual-log.txt `
  --test-list .\docs\t79-t90-operation-test-list-v0.md `
  --suggest `
  --patch-preview

kairon test summarize --result-root .\operation-test-results `
  --test-list .\docs\t79-t90-operation-test-list-v0.md `
  --suggest `
  --json
```

## PR / Release Checklist

PRごとの基本検証は [.github/workflows/ci.yml](.github/workflows/ci.yml) で自動実行します。CIは `npm ci`、`npm run test:docs`、`npm run build`、`npm test` だけを対象にし、GitHub branch protection live確認、Discord live接続、Board目視確認などの外部環境に依存するoperation testは実行しません。

PR作成時は [.github/pull_request_template.md](.github/pull_request_template.md) を使い、目的、変更内容、テスト、manual / operation test、README更新要否、エビデンス、残課題を記録します。

manual / operation test結果は、まずPR本文に概要を書きます。repo履歴として残す必要がある結果だけ [docs/manual-test-results-v0.md](docs/manual-test-results-v0.md) に追記します。generated summary artifactは原則commitしません。

README更新が必要な代表条件:

- user-facing CLI commandや出力を変更した
- setup、前提tool、認証、インストール手順を変更した
- `.kairon/` の主要artifactやconfig schemaを変更した
- operation testやmanual testの標準手順を変更した
- safety policy、approval、merge/deploy制御に関わる挙動を変更した

詳細は [docs/pr-release-checklist-v0.md](docs/pr-release-checklist-v0.md) を参照してください。

release判断では [docs/release-checklist-v0.md](docs/release-checklist-v0.md) を使い、`npm run build`、`npm test`、対象operation test、secret / generated artifact確認、README更新要否、version同期を確認します。
`kairon readiness manifest`で証跡のSHA-256・source commit・有効期限を固定し、`kairon readiness check`または`kairon readiness report`でBeta gateを判定できます。必須gateがすべて`PASS`の場合だけexit code 0となり、外部未設定は`SETUP_REQUIRED`、期限切れ・別commit・改変済み証跡は`UNKNOWN`として扱います。
release notesは [docs/release-notes-v0.md](docs/release-notes-v0.md) に手動で記録します。現在のLocal Beta versionは `0.2.0` で、versionを変更する場合は `package.json`、`package-lock.json`、`src/index.ts` の `KAIRON_VERSION` を同時に更新します。`kairon release validate` でversion形式・同期、release checklist marker、`Unreleased` marker、現在version entryを一括確認できます。

local betaはpublic npm registryへpublishせず、`npm run release:pack`でchecksummed tarballを生成します。Windowsでのinstall、update/rollback、uninstall手順は [docs/installation.md](docs/installation.md) を参照してください。uninstallはprojectの`.kairon/`を削除しません。

検証済みartifactは`kairon release github plan`で高risk approvalへbindし、承認後に`kairon release github publish`でGitHub Releaseへ配布できます。既定はprereleaseで、publish時にplan IDの完全一致確認、approval binding、local / remote source SHA、asset SHA-256を再検証します。`kairon release github verify`は公開assetを再downloadしてmanifestへ照合します。

利用側は`kairon update channel set`で`stable | beta | pinned`を明示設定し、`update check`、`update download`、`update apply`を分離して実行できます。downloadはuser-local cacheで3 assetとtag SHAを検証し、apply / rollbackはexact confirm後に既存PowerShell lifecycleへ渡します。成功時だけupdate registryを更新し、background auto-updateは行いません。

### 初期運用テストの履歴 (T11-T15)

T11からT15では、初期ドッキング後の運用に必要なCLI経路を次の単位で確認しました。この表は現行scopeではなく、初期baselineの履歴です。

| 区分 | 対象 | 確認内容 |
| --- | --- | --- |
| T11-01 | `kairon migrate` | dry-run、実移行、backup作成、AntigravityCLI設定への移行、再実行時の安全性 |
| T11-02 | `kairon doctor` | Git repo、`.gitignore`、config schema、CLI availability、API key混入、Discord env、policy診断 |
| T11-03 | `kairon docking analyze` | 対象projectの protected / generated / source 候補を提案し、configを直接変更しない |
| T11-04 | `kairon config propose/apply` | proposal保存、dry-run、backup作成、project不一致拒否、stale proposal拒否、適用後validation |
| T12-01 | `kairon agent smoke` | Codex / Claude / AntigravityCLI の実CLI smoke、missing CLI時の `setup_required`、run artifact生成 |
| T12-02 | `kairon task create/run` | task作成、queue投入、dispatcher選択、CLI runner実行、outbox適用、run artifact生成 |
| T13-01 | `kairon review run` | reviewer選択、review result保存、quality gate通過/失敗、fix queue作成、最大反復時のapproval escalation |
| T13-02 | Git transaction | review承認済みdiffのcommit、未承認block、diff変更検知、protected push approval、rollback metadata記録 |
| T14-01 | `kairon approval` | list/show/decide、redaction、approve/reject/request_changes/snooze、二重決定拒否、state反映 |
| T15-01 | `kairon start` runtime tick | Active Work queue処理、Standby Work制限、承認済みitem処理、Maintenance 1日1回実行、`last-tick.json` 記録 |

T11-T15時点では対象外で、その後T67-T75までに実装またはoperation testを完了した範囲:

- T12-03 persistent PTY / same-day session state
- T12-04 usage limit / permission detector
- T13-03 GitHub branch protection validation
- T14-02 live Discord Gateway / Discord decision audit
- T15-02 daily maintenance expansion / next-day plan / RAG refresh
- T15-03 backup / tmp proposal management / cleanup apply / archive
- Board projection / loopback Board server
- Runtime recovery target list / resolve / acknowledge

### 外部連携テストの履歴 (T67-T75)

T67-T75では、local runtimeだけでなくGitHub / Discordを含む外部接続条件を確認しました。次の表は後続実装の未完了一覧ではなく、当時の検証履歴です。

| 区分 | 対象 | 現状 |
| --- | --- | --- |
| T67 | GitHub branch protection診断 | public sandbox `goodaymmm/14Forge` でlive API確認済み。`BranchProtectionPublicSandbox` profileで再実行可能。private repositoryの403は外部条件として扱う |
| T68 | Cleanup apply / archive | dry-run、apply、archive、protected path blockを確認済み |
| T69 | Runtime recovery resolution | stale / partial / ambiguous target、resolve / acknowledge、重複抑止を確認済み |
| T70 | Discord live decision audit | Gateway live接続、approval通知、button decision、audit artifact記録を確認済み |
| T71 | Daemon hardening | heartbeat、stop reason、lock、idle tick、last-tickを確認済み |
| T72 | Board UI | loopback dashboard、projection、redaction、主要state表示を確認済み |
| T73 | Same-day session / setup_required | CLI availability、setup_required分類、session artifactを確認済み |
| T74 | RAG query / context連携 | refresh、query、metadata filter、secret/protected除外、context builder連携を確認済み |
| T75 | Git transaction連携 | review承認後のtransaction queue、metadata、rollback/recovery接続を確認済み |

### T159 Local Beta baseline

T76-T159では初期経路を拡張し、T159 readinessで全11 gate（必須10、任意1）、secret finding 0、未PASS系status 0を確認しました。local operation resultはgenerated evidenceのためrepositoryへcommitせず、再検証時は現在commitに対して生成し直します。

| 分類 | T159時点の検証範囲 |
| --- | --- |
| Runtime | Windows Task Scheduler、24時間daemon certification、retention、recovery、backup rehearsal |
| Controlled execution | guarded PR create / merge、local-sandbox deploy、production workflow、approval follow-up |
| External operations | Discord Gateway / HTTP Interactions、remote-readonly Board、correlation / decision audit |
| Data and policy | state integrity / compaction、RAG integrity / rebuild、provider quota / suspend policy |
| Distribution | checksummed local package、install / update / rollback / uninstall |
| Readiness | evidence hash / freshness / source commitと必須gateの機械判定 |

## 推奨する次の進め方

1. 対象projectで`kairon init`または`kairon migrate`を実行する。
2. `kairon doctor`と`kairon state check`でconfig、CLI、state、external setupを確認する。
3. Agent smokeと小さいtask / reviewから開始し、approval境界を確認する。
4. `kairon start --daemon`またはWindows Task Schedulerを使い、`kairon status`とdaemon reportを監視する。
5. GitHub、deploy、Discord HTTP、remote Boardはdry-run / loopbackから開始し、外部writeを段階的に有効化する。
6. `kairon maintenance run`、backup、cleanup proposal、RAG verifyを定期実行する。
7. 配布前はpackage verifyとreadiness gateを現在commitのevidenceで再生成する。

## 関連ドキュメント

- [docs/mvp-plan-v0.md](docs/mvp-plan-v0.md)
- [docs/architecture-v0.md](docs/architecture-v0.md)
- [docs/workflow-v0.md](docs/workflow-v0.md)
- [docs/cli-commands-v0.md](docs/cli-commands-v0.md)
- [docs/installation.md](docs/installation.md)
- [docs/release-checklist-v0.md](docs/release-checklist-v0.md)
- [docs/windows-daemon-ops-v0.md](docs/windows-daemon-ops-v0.md)
- [docs/discord-approval-v0.md](docs/discord-approval-v0.md)
- [docs/board-public-safety-v0.md](docs/board-public-safety-v0.md)
- [docs/rag-memory-v0.md](docs/rag-memory-v0.md)
- [docs/github-branch-protection-sandbox-v0.md](docs/github-branch-protection-sandbox-v0.md)
- [docs/project-docking-v0.md](docs/project-docking-v0.md)
- [docs/subscription-compliance-v0.md](docs/subscription-compliance-v0.md)
