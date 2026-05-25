# Kairon

Kairon は、既存プロジェクトにドッキングして、人間と AI Agent が共生しながら作業を進めるためのローカル運用基盤です。

名前は Kairos、Symbiosis、Drive を組み合わせたものです。通常の時間を、AI と人間の協調によって価値ある決定的な作業時間へ駆動する、という意図を持っています。

## 現在の位置づけ

このリポジトリは MVP の基盤実装です。T0 から T10 までの事前定義タスクが完了しており、次は運用テストで不足を洗い出す段階です。

現時点で実装済みの主な範囲:

- `.kairon/` の生成と初期設定
- runtime lock、schedule、status、leave
- queue、command inbox、state applier
- Agent dispatcher、context builder、session host
- Codex / Claude / AntigravityCLI 公式 CLI へ接続する runner 境界
- review loop / quality gate の骨格
- git workspace / diff snapshot の骨格
- Discord approval gateway の正規化・idempotency・message payload
- daily report、agent handoff、cleanup proposal

現時点で未完成または後続作業の範囲:

- 24 時間常駐 loop の完成
- `kairon task create` / `kairon task run` の実処理
- live Discord Gateway 接続と実メッセージ投稿
- Board UI
- persistent PTY の本格運用
- LangGraph / RAG の本実装
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

### ドッキング解析

```powershell
kairon docking analyze
```

対象プロジェクトのtop-level構成をscanし、`project.json` 向けの `protected` / `generated` / `source` 候補をJSON proposalとして表示します。configは直接書き換えません。

### 起動

```powershell
kairon start
```

runtime lock を取得します。現時点の `start` は常駐 loop 全体を起動する完成版ではなく、runtime 起動状態を表す lock を作る段階です。

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
5. `kairon start`、`kairon status`、`kairon leave`、`kairon stop` を確認する。
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
