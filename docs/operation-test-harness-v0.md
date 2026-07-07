# Kairon Operation Test Harness v0

`scripts/kairon-operation-test.ps1` は、T11-T15で手動実行していた運用テストを再実行しやすくするために追加し、その後のDiscord live / runtime recovery検証まで拡張したPowerShell harnessです。

## 目的

- Kairon repoのbuild / linkと、対象project上の主要operation testを一括実行する。
- 対象projectの `.kairon` stateを実行前にbackupし、デフォルトで実行後にrestoreする。
- PASS / FAIL summaryをJSONとMarkdownの両方で出力する。

## 基本実行

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp"
```

出力先:

```text
operation-test-results/<yyyyMMdd-HHmmss>/summary.json
operation-test-results/<yyyyMMdd-HHmmss>/summary.md
operation-test-results/<yyyyMMdd-HHmmss>/backup/kairon-state/
```

## Result summaryとテストリストalias

`kairon test summarize --test-list <md> --suggest` は、operation test resultからPASS / FAIL / SETUP_REQUIRED / OPTIONAL候補を抽出し、テストリストへの反映候補を表示します。
ログ由来の汎用IDがテストリストの `OT-*` / `RET-*` IDと一致しない場合は、テストリスト側にalias commentを置いて対応付けできます。

```markdown
<!-- kairon:alias GIT_BRANCH_PROTECTION=OT-T99-01-04 -->
<!-- kairon:alias KAIRON_TASK_RUN=RET-T102-01-02 -->
```

aliasはsummary候補のIDを既存テスト行へ解決するためだけに使います。
`--patch-preview` は該当行の置換案を表示しますが、テストリストを直接書き換えません。
同じsource IDに複数aliasがある場合は後勝ちで解決し、warningを出します。

## Command profile generator

`kairon test commands` は、operation test用のPowerShell commandをprofile registryから生成します。
手書きdocsの長いコマンドを直接コピーする代わりに、profile IDまたはtask rangeを指定して再生成できます。

```powershell
kairon test commands --profile t116-alias
kairon test commands --range T116-T118
kairon test commands --profile branch-protection-public-sandbox --format powershell
```

生成コマンドは、既定で次の共通変数を用意します。

```powershell
$KAIRON
$TARGET
$RUN_STAMP
$RESULT_ROOT
```

`$KAIRON` は既定で現在のdirectory、`$TARGET` は既定で `$KAIRON` です。
別projectを対象にする場合は、実行前に `KAIRON_ROOT` / `KAIRON_TARGET_ROOT` を環境変数として指定できます。

Node.jsを使うfixture生成は、`node -e` ではなく `$RESULT_ROOT` 配下の一時 `.mjs` ファイルを生成して実行する形式にします。
`GH_TOKEN` / `GITHUB_TOKEN` などのsecretは値を出さず、必要なenv名だけを表示します。

## 実行対象

デフォルトでは次をすべて実行します。

| Test | 内容 |
|---|---|
| `Build` | `npm run build` と `npm link` |
| `Doctor` | `kairon doctor` |
| `AgentSmoke` | `codex` / `claude` / `gemini`互換agent smoke |
| `TaskRun` | operation-test tag付きtask create / run |
| `ReviewLoop` | review loop create / run |
| `RuntimeActive` | Active Work scheduleでruntime tick確認。実行前にready状態のoperation/manual test queue itemを隔離し、harnessが投入した `maintenance.run` の `item_id` が処理されたことまで確認 |
| `RuntimeReview` | runtime tick経由でreview queue itemを処理し、review result / loop stateを確認 |
| `DiscordLiveReady` | Discord envとGateway live readinessを確認。env不足は `SETUP_REQUIRED` として扱う |
| `DiscordInvalidEnv` | 一時的にinvalid envを注入し、診断とsecret非漏洩を確認 |
| `DiscordSetupError` | 権限不足や設定不一致のsetup errorを誘発し、raw Discord errorやsecretが出ないことを確認 |
| `ApprovalNotificationAudit` | Discord approval notification audit artifactを検査 |
| `DiscordDecisionAuditLive` | 手動Discord button/modal操作後に `decision-interactions.jsonl` が記録されることを確認。timeout未指定時はOPTIONAL、timeout指定後にdecision auditが無い場合はSETUP_REQUIRED |
| `RuntimeRecovery` | stale gateway / stale git transactionをseedし、runtime recovery evidenceとapproval生成を確認 |
| `BranchProtectionPublicSandbox` | public sandbox repositoryでGitHub branch protection live API疎通を確認。token不足や403/404は `SETUP_REQUIRED` として扱う |

一部だけ実行する場合:

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test Build,Doctor,RuntimeActive
```

Discord decision auditをliveで確認する場合は、approvalをseedしてDiscord上で期待actionをクリックするまで待機させます。
manual timeout未指定で実行した場合は `decision_audit.status=missing` と `decision_audit.next_action=click Discord approval button and rerun DiscordDecisionAuditLive` を出してOPTIONAL扱いにします。
timeout指定後も `decision-interactions.jsonl` に対象approval / decisionが記録されない場合は、コードFAILではなく手動操作またはDiscord疎通の外部条件不足としてSETUP_REQUIREDにします。

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test DiscordDecisionAuditLive `
  -DiscordDecisionAuditExpectedAction approve `
  -DiscordDecisionAuditTimeoutSeconds 120
```

`DiscordSetupError` では実tokenを使いつつ、存在しないguild / channel idを一時注入してsetup errorを確認できます。出力にはraw token、guild id、channel idを残さない方針です。

## GitHub branch protection live確認

T67のGitHub branch protection live確認は、private repositoryのGitHubプラン制約で403になる場合があるため、public sandbox repositoryで代替確認します。手順の詳細は [docs/github-branch-protection-sandbox-v0.md](github-branch-protection-sandbox-v0.md) を参照してください。

必要な前提:

- `GH_TOKEN` または `GITHUB_TOKEN` が設定されていること。両方ある場合、Kaironは `GH_TOKEN` を優先します。
- fine-grained PATの場合、対象public sandbox repositoryへのRepository accessがあること。
- Administration permissionがRead-onlyで付与されていること。
- sandbox repositoryの対象branchにBranch protection ruleが設定され、required pull request reviewsとrequired status checksが有効であること。
- token値を出力しない。`GH_TOKEN` / `GITHUB_TOKEN` は値ではなく `present` / `missing` のみ記録します。

既定fixtureは `Goodaymmm14Forge` です。`-BranchProtectionSandboxRepoUrl` を省略した場合は `https://github.com/goodaymmm/14Forge.git`、branchは `main` を使います。別のpublic sandbox repositoryを使う場合は `-BranchProtectionSandboxFixture Custom` と `-BranchProtectionSandboxRepoUrl` を指定します。

期待する `kairon doctor` evidence:

```text
PASS git.branch_protection GitHub branch protection
  - api_status=ok
  - branch_protection=enabled
  - required_pull_request_reviews=present
  - required_status_checks=present
```

profile実行例:

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test BranchProtectionPublicSandbox `
  -BranchProtectionSandboxRoot "$env:TEMP\kairon-branch-protection-sandbox" `
  -BranchProtectionSandboxFixture Goodaymmm14Forge `
  -BranchProtectionSandboxBranch main `
  -BranchProtectionRequireToken
```

`BranchProtectionPublicSandbox` は `GH_TOKEN` を優先し、未設定時に `GITHUB_TOKEN` を使います。token未設定、403、404、required gate未設定は、コード不具合ではなく外部条件不足として `SETUP_REQUIRED` に記録します。
EnglishAppなどの個人アカウントprivate repositoryで `api_status=plan_or_permission_error` / `http_status=403` になる場合も、public sandbox repositoryで `api_status=ok` を確認できればKairon実装側のlive API疎通は確認済みとして扱います。

## Restore方針

実行開始時に `TargetRoot\.kairon` をbackupします。`-SkipRestore` を付けない限り、script終了時に現在の `TargetRoot\.kairon` を削除してbackupから復元します。

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -SkipRestore
```

`-SkipRestore` は、実行後の `.kairon` artifactを対象project側に残して調査したい場合だけ使います。

## 終了コード

- すべてPASS: `0`
- 1件以上FAIL: `1`

## 判定メモ

- `codex` smokeは `completed` をPASS条件にする。
- `claude` smokeは provider quota / rate limit を考慮し、`completed` または `setup_required` をPASS条件にする。
- `gemini`互換agentはAntigravity (`agy`) のPTY adapter状態に依存するため、`completed` または `setup_required` をPASS条件にする。
- review loopは `approved` / `changes_requested` / `setup_required` を許容するが、CLI引数エラーや `review_result`欠落・schema validation失敗を evidenceに含む場合はFAILにする。
- RuntimeActiveは `base_mode=active_work`、`active_work_closed=False`、`action=processed-item` に加え、`tick.item_type=maintenance.run` と `expected_item_id == tick.item_id` をPASS条件にする。
- Discord系profileはenv不足や手動操作待ちを `SETUP_REQUIRED` / `OPTIONAL` として扱い、secret漏洩があればFAILにする。
- Discord decision auditは、timeout未指定のmissingを `OPTIONAL`、timeout指定後のmissingを `SETUP_REQUIRED` として扱う。Boardでは `decision_audit.status` と `decision_audit.next_action` を確認する。
- RuntimeRecoveryは `git_transaction_issues` と `approvals_requested` または既存approvalの検出をevidenceとして確認する。
