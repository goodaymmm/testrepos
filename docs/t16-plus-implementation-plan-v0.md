# T16以降 実装手順 v0

## 運用方針

- 1タスクを1ブランチ、1PRで進める。`T16-1` のような細分化ブランチは作らない。
- ブランチ名は `codex/t16-...`、`codex/t17-...` の形式にする。
- PR本文は日本語で作成し、`目的`、`変更内容`、`テスト`、`残課題` を必ず含める。
- T16を最優先にする。Gemini CLIは運用対象から外し、Antigravity CLI (`agy`) を正式な実行対象にする。
- 既存の内部 agent id `gemini` は互換性維持のため当面残す。ただし user-facing な説明では `Antigravity/Gemini互換ID` と表記する。

## T16: Antigravity interactive session runtime

ブランチ: `codex/t16-pty-session-runtime`

目的:
Antigravity (`agy`) は `--print` の child process pipe では安定して outbox を返せないため、非対話 runner とは別に interactive session runner の接続点を追加する。これにより `agy` を Gemini CLI 置換後の正式 runtime として扱い、PTY実装を後続で差し込める状態にする。

実装手順:
1. `src/agents/interactive-session-runner.ts` を追加し、interactive runner の入力契約を定義する。
2. `CliSessionRunner` に `interactiveSessionRunner` option を追加する。
3. `supports.nonInteractive=false` の agent は、interactive runner がある場合だけ実行し、ない場合は従来どおり `setup_required` にする。
4. daily bootstrap でも `agy --print` の plain pipe path に流さず、runner 未設定時は `setup_required` にする。
5. interactive runner 実行後も、既存の outbox validation、stdout fallback、rate limit classification、terminal state 更新を通す。
6. `runAgentSmoke` と `TaskRunner` に interactive runner option を伝播する。
7. `AgentDispatcher` に `allowInteractiveAgents` を追加し、interactive runner が設定されている場合だけ Antigravity/Gemini互換IDを候補に含める。
8. Codex/Claude の既存非対話 runner の挙動を変えない。
9. targeted tests を追加し、Antigravity が runner 未設定時は `setup_required`、runner 設定時は `completed` になることを確認する。

テスト方針:
- `npm run build`
- `npx vitest run tests/command-runner.test.ts tests/cli-session-runner.test.ts tests/agent-smoke.test.ts tests/task-runner.test.ts tests/dispatcher.test.ts`
- 手動確認では `kairon agent smoke --agent codex` と `kairon agent smoke --agent claude` の completed を維持する。
- `agy` は T16時点では接続点を検証対象にし、実PTY実装は T17 以降で扱う。

PR本文メモ:
```markdown
## 目的
Antigravity (`agy`) を Gemini CLI 置換後の正式 runtime として扱うため、非対話 runner とは別に interactive session runner の接続点を追加しました。

## 変更内容
- interactive session runner の契約を追加
- `CliSessionRunner` / `TaskRunner` / `runAgentSmoke` へ runner option を伝播
- dispatcher が runner 設定時だけ Antigravity/Gemini互換IDを候補に含めるよう変更
- T16対象の単体テストを追加

## テスト
- `npm run build`
- `npx vitest run tests/command-runner.test.ts tests/cli-session-runner.test.ts tests/agent-smoke.test.ts tests/task-runner.test.ts tests/dispatcher.test.ts`

## 残課題
- 実PTY adapter は T17 以降で実装する
```

## T17: Antigravity PTY adapter implementation

ブランチ: `codex/t17-antigravity-pty-adapter`

目的:
T16で追加した interactive runner 接続点に、Windows/Unix 両対応の実PTY adapterを接続する。

実装手順:
1. PTY library の採用可否を確認する。第一候補は `node-pty` だが、Windows native build の失敗リスクを評価する。
2. package 追加が必要な場合は、install / build / CI 影響を別PR内で完結させる。
3. `agy --prompt-interactive` を primary path とし、prompt投入、出力監視、timeout、終了処理を実装する。
4. `outbox.json` 直接生成を主経路にし、stdout fallback marker も維持する。
5. login / permission / timeout / no output を `setup_required` または `failed` に正規化する。
6. `kairon agent smoke --agent gemini` が local setup 済み環境で completed になることを手動確認する。

## T18: Antigravity naming and compatibility cleanup

ブランチ: `codex/t18-antigravity-naming`

目的:
旧 Gemini CLI 表記を、互換IDを除いて Antigravity 中心に整理する。

実装手順:
1. CLI出力、doctor、docs、test名の `Gemini CLI` 表記を `Antigravity` に寄せる。
2. config migration は `gemini_cli/gemini` から `antigravity_cli/agy` への変換を維持する。
3. internal `AgentId = "gemini"` は破壊的変更を避けるため残す。
4. `agents.json` の user-facing explanation を更新する。

## T19: config proposal noise reduction

ブランチ: `codex/t19-config-proposal-normalization`

目的:
`kairon config propose` が順序差分だけで proposal を作る問題を抑える。

実装手順:
1. project analyzer の出力順と既存 config の比較順を正規化する。
2. 配列が同一集合の場合は差分なしとして扱う。
3. `tmpclaude-*` のような手動追加 path を analyzer が削除提案しない policy を検討する。
4. dry-run / apply のテストを追加する。

## T20: runtime queue isolation and cleanup

ブランチ: `codex/t20-runtime-queue-isolation`

目的:
手動テストで残った ready/failed queue が次回 runtime tick に影響しないようにする。

実装手順:
1. operation-test tag や manual-test queue を識別できる metadata を追加する。
2. test queue cleanup command または maintenance cleanup policy を追加する。
3. runtime tick が stale test item を誤処理しないことを確認する。

## T21: approval CLI error handling

ブランチ: `codex/t21-approval-cli-errors`

目的:
重複 decision など想定内の approval error を stack trace ではなく CLI向けエラーに整形する。

実装手順:
1. `ApprovalNotPendingError` を CLI command 層で捕捉する。
2. exit code と user-facing message を定義する。
3. duplicate decision のテストを追加する。

## T22: review loop result robustness

ブランチ: `codex/t22-review-loop-result-robustness`

目的:
reviewer CLI の出力揺れや空 outbox に対する判定を改善する。

実装手順:
1. review result parser の必須項目と fallback 生成を整理する。
2. setup_required と changes_requested を明確に分ける。
3. high finding / tests_passed / secret_scan_passed の gate reason を維持する。

## T23: operation test automation

ブランチ: `codex/t23-operation-test-harness`

目的:
T11-15で手動実施した operation test を再実行しやすい harness にする。

実装手順:
1. PowerShell command を scripts または docs から実行可能な test harness に整理する。
2. `.kairon` state の backup / restore を組み込む。
3. PASS/FAIL summary を JSON と Markdown の両方で出力する。

## T24: PR and release checklist

ブランチ: `codex/t24-pr-release-checklist`

目的:
Kairon の PR作成、manual test結果更新、README更新の抜けを減らす。

実装手順:
1. PR本文テンプレートを日本語で追加する。
2. manual test result の更新先を明文化する。
3. README更新が必要な条件を checklist 化する。
