# Kairon Operation Test Harness v0

T23で追加した `scripts/kairon-operation-test.ps1` は、T11-T15で手動実行していた運用テストを再実行しやすくするためのPowerShell harnessです。

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

一部だけ実行する場合:

```powershell
.\scripts\kairon-operation-test.ps1 `
  -KaironRoot "C:\Users\hikar\Documents\AutoRunner" `
  -TargetRoot "M:\EnglishApp" `
  -Test Build,Doctor,RuntimeActive
```

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
