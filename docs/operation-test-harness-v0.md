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
| `DiscordDecisionAuditLive` | 手動Discord button/modal操作後に `decision-interactions.jsonl` が記録されることを確認 |
| `RuntimeRecovery` | stale gateway / stale git transactionをseedし、runtime recovery evidenceとapproval生成を確認 |

一部だけ実行する場合:

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test Build,Doctor,RuntimeActive
```

Discord decision auditをliveで確認する場合は、approvalをseedしてDiscord上で期待actionをクリックするまで待機させます。

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test DiscordDecisionAuditLive `
  -DiscordDecisionAuditExpectedAction approve `
  -DiscordDecisionAuditTimeoutSeconds 120
```

`DiscordSetupError` では実tokenを使いつつ、存在しないguild / channel idを一時注入してsetup errorを確認できます。出力にはraw token、guild id、channel idを残さない方針です。

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
- RuntimeRecoveryは `git_transaction_issues` と `approvals_requested` または既存approvalの検出をevidenceとして確認する。
