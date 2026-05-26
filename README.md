# Kairon

Kairon は、既存プロジェクトにドッキングして、人間と AI Agent が共生しながら作業を進めるためのローカル運用基盤です。

名前は Kairos、Symbiosis、Drive を組み合わせたものです。通常の時間を、AI と人間の協調によって価値ある決定的な作業時間へ駆動する、という意図を持っています。

## 現在の位置づけ

このリポジトリは MVP の基盤実装です。現在は運用テストで不足を洗い出しながら、実 CLI 接続、タスク投入、レビュー実行経路を順次固めている段階です。

現時点で実装済みの主な範囲:

- `.kairon/` の生成と初期設定
- runtime lock、schedule、status、leave
- queue、command inbox、state applier
- Agent dispatcher、context builder、session host
- Codex / Claude / AntigravityCLI 公式 CLI へ接続する runner 境界
- review loop / quality gate の実行経路
- git workspace / diff snapshot / transaction metadata の実行境界
- Discord approval gateway の正規化・idempotency・message payload
- approval queue CLI
- runtime loop scheduler の1 tick実行、schedule別queue制御、maintenance重複防止
- daily report、agent handoff、cleanup proposal

現時点で未完成または後続作業の範囲:

- 24 時間常駐daemonとしてのloop運用
- live Discord Gateway 接続と実メッセージ投稿
- Board UI
- persistent PTY の本格運用
- LangGraph / RAG の本実装
- Git transaction の task runner / review runner 連携
- merge / deploy の自動実行

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

Git、`.gitignore`、config、公式CLI、API key混入、Discord設定、safety policyを確認し、`pass` / `warning` / `error` と次の対応を表示します。

### Agent Smoke

```powershell
kairon agent smoke --agent codex
kairon agent smoke --agent claude
kairon agent smoke --agent gemini
```

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

通過した場合は loop を `approved` にし、基準未満の場合は修正用の queue item を作成します。最大反復回数に達した場合は approval queue にエスカレーションします。実行結果は `.kairon/reviews/loops/` と `.kairon/reviews/results/` に残ります。

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
```

runtime lock を取得し、現在のscheduleに基づいて runtime tick を1回実行します。

- `active_work`: ready queue item を処理します。
- `standby_work`: command inboxを優先し、standby指定または承認済みの安全なqueue itemだけを処理します。
- `maintenance`: 日次メンテナンスを同一日1回だけ実行し、重複時はskipします。

実行結果は `.kairon/runtime/last-tick.json` に記録されます。現時点では24時間常駐daemonの完成版ではなく、runtime loopのschedule境界を検証可能にした段階です。

### 状態確認

```powershell
kairon status
```

schedule mode、runtime lock、queue、approval の状態を表示します。

### Active Work 終了

```powershell
kairon leave
```

本日の Active Work を終了し、以降を standby 相当に切り替える schedule override を作ります。runtime 自体は停止しません。

### 日次メンテナンス

```powershell
kairon maintenance run
```

次の artifact を作成します。

- `.kairon/reports/daily/YYYY-MM-DD.json`
- `.kairon/sessions/YYYY-MM-DD/{agent}/handoff.json`
- `.kairon/sessions/YYYY-MM-DD/{agent}/handoff.md`
- `.kairon/cleanup/proposals/YYYY-MM-DD.json`

cleanup は直接削除せず、Morning Review で確認する proposal として作成されます。

### 停止

```powershell
kairon stop
```

runtime lock を解放します。

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

## 推奨する次の進め方

1. 検証用プロジェクトに `kairon init`
2. `config/*.json` を確認
3. `kairon start` / `kairon status` / `kairon leave` / `kairon stop` を確認
4. `kairon maintenance run` で daily report / handoff / cleanup proposal を確認
5. 実 CLI 接続と job 投入は、現在の runner 境界を使った小さい smoke から確認
6. 不足を T11 以降のタスクとして切り出す

## 関連ドキュメント

- [docs/mvp-plan-v0.md](docs/mvp-plan-v0.md)
- [docs/architecture-v0.md](docs/architecture-v0.md)
- [docs/workflow-v0.md](docs/workflow-v0.md)
- [docs/cli-commands-v0.md](docs/cli-commands-v0.md)
- [docs/project-docking-v0.md](docs/project-docking-v0.md)
- [docs/subscription-compliance-v0.md](docs/subscription-compliance-v0.md)
