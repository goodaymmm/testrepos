# Kairon

Kairon は、既存プロジェクトにドッキングして、人間と AI Agent が共生しながら作業を進めるためのローカル運用基盤です。

名前は Kairos、Symbiosis、Drive を組み合わせたものです。通常の時間を、AI と人間の協調によって価値ある決定的な作業時間へ駆動する、という意図を持っています。

## 現在の位置づけ

このリポジトリは MVP の基盤実装です。現在はローカル運用の主要経路を実装し、運用テストで残る外部接続条件や長時間稼働条件を確認している段階です。

現時点で実装済みの主な範囲:

- `.kairon/` の生成と初期設定
- runtime lock、schedule、status、leave
- queue、command inbox、state applier
- Agent dispatcher、context builder、session host
- Codex / Claude / AntigravityCLI 公式 CLI へ接続する runner 境界
- review loop / quality gate の実行経路
- git workspace / diff snapshot / transaction metadata / review承認後の `git.transaction` queue連携
- GitHub branch protection 診断
- Discord approval gateway の正規化・idempotency・message payload・live接続・decision audit
- approval queue CLI
- runtime loop scheduler、daemon tick、schedule別queue制御、maintenance重複防止、runtime recovery
- daily report、agent handoff、cleanup proposal、cleanup apply / archive
- read-only Board projection / loopback Board server
- local lexical RAG index、RAG query CLI、context builder連携

T67-T75完了後も残る主な後続作業の範囲:

- private repositoryでbranch protection APIが403になる場合の診断文言改善
- 24時間以上の連続daemon運用エビデンス取得とWindows常駐手順の固定
- Board運用ビュー、Discord通知とBoard linkの対応追跡強化
- RAG index pruning / compaction など長期運用メンテナンス
- operation test結果の自動集計とPASS反映支援
- LangGraph workflow runtime の本格導入
- merge / deploy の自動実行
- cloud / public HTTP endpoint でのDiscord Interactions運用

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
  reports/
  recovery/
  rag/
  board/
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
```

Git、`.gitignore`、config、公式CLI、API key混入、Discord設定、GitHub branch protection、runtime recovery、safety policyを確認し、`pass` / `warning` / `error` と次の対応を表示します。

GitHub branch protectionのlive確認は、`GH_TOKEN` または `GITHUB_TOKEN` を使って GitHub REST API を確認します。両方ある場合は `GH_TOKEN` を優先します。Windowsでは `KAIRON_GH_TOKEN_CREDENTIAL_TARGET` / `KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET` でWindows Credential Manager targetを指定すると、envが未設定の場合だけfallbackとして読み取れます。fine-grained PATを使う場合は対象repositoryへのRepository accessと、AdministrationのRead-only権限が必要です。GitHub Freeのprivate repositoryではbranch protection APIが403になる場合があるため、live API疎通はpublic sandbox repositoryで確認する運用にしています。手順は [docs/github-branch-protection-sandbox-v0.md](docs/github-branch-protection-sandbox-v0.md) を参照してください。

### Agent Smoke

```powershell
kairon agent smoke --agent codex
kairon agent smoke --agent claude
kairon agent smoke --agent gemini
```

Antigravity は互換性維持のため CLI 引数では `--agent gemini` を使います。実際に起動する公式 CLI は `agy` です。

設定済みの公式CLIへ最小promptを送り、`.kairon/runs/RUN-xxxx/` に `stdin.md`、`stdout.log`、`stderr.log`、`runner.json`、`outbox.json` を記録します。CLIが見つからない場合は実行せず `setup_required` としてoutboxへ記録します。

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

### 承認待ち確認と決定

```powershell
kairon approval list
kairon approval show APR-0001
kairon approval decide APR-0001 --action approve --reason "内容を確認済み"
kairon approval decide APR-0001 --action request_changes --reason "テスト追加が必要"
kairon approval decide APR-0001 --action snooze --until 2026-05-26T09:00:00.000Z
```

`approval list` は既定で pending の承認だけを表示します。`show` は diff、log、stdout、stderr、secret-like key を過剰表示しない安全な詳細表示です。`decide` は `approve`、`reject`、`request_changes`、`snooze` を state に反映します。すでに決定済みの approval へ再決定しようとした場合は拒否します。

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

`config propose` はドッキング解析結果を `.kairon/config/proposals/` に保存します。`config apply` は保存済みproposalを `project.json` に反映します。実適用時は事前に `.bak-YYYYMMDDHHMMSS` backupを作り、proposalが古い場合や対象projectが違う場合は拒否します。

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
```

approval、queue、run、review、recovery、cleanup、Discord decision auditをredaction済みのread-only projectionとして出力します。HTML dashboardにはcompact viewがあり、狭い画面でもapproval、failed/setup_required run、recovery、daemon healthを先に確認できます。`serve` はloopback hostだけを許可し、既定では `http://127.0.0.1:8787/` でHTML dashboardと `projection.json` を提供します。

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

stale lock、expired claim、partial outbox、Discord gateway mid-state、Git transaction mid-stateを検出します。安全に再queue可能なものだけ自動処理し、ambiguousなものはapprovalへ回します。resolve / acknowledgeはfingerprint単位で記録され、同じtargetを未解決として残し続けないために使います。

### RAG

```powershell
kairon rag refresh
kairon rag status
kairon rag query "approval routing" --type approval --limit 5
```

local lexical RAG indexを `.kairon/rag/index.json` に作成し、metadata filter付きで検索します。context builderは必要に応じてRAG検索結果をrun contextへ含めます。secret-like pathやprotected pathはindex対象から除外します。

### 状態確認

```powershell
kairon status
```

schedule mode、runtime lock、daemon health、queue、approval、recovery target、session、Discord gateway、最新artifact の状態を表示します。
daily report / cleanup proposal / recovery artifact / next-day plan / board projection / daemon log が存在する場合は、次に確認するパスも `artifacts.*` として表示します。

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
`scripts/kairon-daemon-task.ps1` でTask登録、開始、停止、再起動、状態確認、登録解除を補助します。Discord / GitHub tokenなどのsecretはTask引数に書かず、ユーザー環境変数または明示設定したWindows Credential Manager targetから読み取ります。

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
release notesは [docs/release-notes-v0.md](docs/release-notes-v0.md) に手動で記録します。現在のbaseline versionは `0.1.0` で、versionを変更する場合は `package.json` と `src/index.ts` の `KAIRON_VERSION` を同時に更新します。

### T11-T15 運用テスト対象

T11からT15では、初期ドッキング後の運用に必要なCLI経路を追加しています。運用テストでは、次の単位で確認します。

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

T11-T15時点では対象外だったが、T67-T75までに実装済みまたは運用テストPASS済みになった範囲:

- T12-03 persistent PTY / same-day session state
- T12-04 usage limit / permission detector
- T13-03 GitHub branch protection validation
- T14-02 live Discord Gateway / Discord decision audit
- T15-02 daily maintenance expansion / next-day plan / RAG refresh
- T15-03 backup / tmp proposal management / cleanup apply / archive
- Board projection / loopback Board server
- Runtime recovery target list / resolve / acknowledge

### T67-T75 運用テスト結果の扱い

T67-T75では、local runtimeだけでなくGitHub / Discordを含む外部接続条件も確認しています。外部サービス側の権限やプラン制約で対象project上のlive確認ができない場合は、public sandbox repositoryや手動目視を使って代替エビデンスを残します。

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

## 推奨する次の進め方

1. 検証用プロジェクトに `kairon init`
2. `config/*.json` を確認
3. `kairon start` / `kairon status` / `kairon leave` / `kairon stop` を確認
4. `kairon maintenance run` で daily report / handoff / cleanup proposal を確認
5. 実 CLI 接続、review loop、Git transaction連携は小さい smoke から確認
6. 不足は次の運用テスト結果から後続タスクとして切り出す

## 関連ドキュメント

- [docs/mvp-plan-v0.md](docs/mvp-plan-v0.md)
- [docs/architecture-v0.md](docs/architecture-v0.md)
- [docs/workflow-v0.md](docs/workflow-v0.md)
- [docs/cli-commands-v0.md](docs/cli-commands-v0.md)
- [docs/github-branch-protection-sandbox-v0.md](docs/github-branch-protection-sandbox-v0.md)
- [docs/project-docking-v0.md](docs/project-docking-v0.md)
- [docs/subscription-compliance-v0.md](docs/subscription-compliance-v0.md)
