# Kairon Agent Runtime v0

## 目的

Agent Runtime は、Codex CLI、Claude Code、AntigravityCLI を公式 CLI process として起動し、同日 Session / Context を維持しながら Kairon の run contract に接続する層である。

Control Protocol は「何を満たすべきか」を定義する。
Agent Runtime は「どう起動し、どう読み取り、どう終了または継続するか」を扱う。

## 基本方針

- 公式 CLI だけを起動する。
- token / cookie / OAuth credential を抽出しない。
- 可視 Terminal window の有無を compliance boundary にしない。
- stdin / stdout / stderr / exit code / pid / terminal session id / native resume id を保存する。
- 同日中は Terminal-backed Agent Session を保持する。
- 日次メンテ終了時に handoff artifact を作り、翌日は canonical state から再構築する。

## Runtime Modes

| Mode | 内容 | 用途 |
| --- | --- | --- |
| foreground_terminal | user が見える terminal で CLI を起動 | login、debug、手動承認 run |
| persistent_terminal_session | pty / terminal session を維持して追加入力する | 標準。日次メンテ終了まで同一 Agent session を保持 |
| background_child_process | Kairon が child process として CLI を単発起動 | one-shot fallback、dry run、recovery |
| dry_run | CLI 起動前までを検証する | docking、policy test |

MVP は `persistent_terminal_session` を標準にする。
CLI が interactive approval を要求する場合は、stdout fallbackを使う、その job を止めて approval queue に積む、または `foreground_terminal` / PTY adapter に切り替える。

## Agent Adapter Contract

```json
{
  "agent": "codex",
  "adapter": "codex_cli",
  "supports": {
    "non_interactive": true,
    "json_output": true,
    "resume": true,
    "workspace_write": true,
    "native_mcp": true
  },
  "subscription_mode": true,
  "requires_visible_terminal": false,
  "session_strategy": "terminal_session_primary_resume_for_recovery"
}
```

## Codex Adapter

Codex は Terminal-backed CLI Session を標準にする。
`codex exec` は one-shot fallback、dry run、recovery 用に使う。

```text
codex exec --json -
```

入力は job prompt と embedded context を stdin に渡す。
出力は JSONL として `stdout.log` に保存する。
Agent が file tool で `outbox.json` を作成できない場合、`KAIRON_OUTBOX_JSON_START` / `KAIRON_OUTBOX_JSON_END` に囲んだJSONをstdoutへ出力し、Kaironが `outbox.json` として保存する。
CLI が provider quota や rate limit に到達した場合は通常の実行失敗へ変換せず、`setup_required` として記録する。

```json
{
  "agent": "codex",
  "command": "codex",
  "args": ["exec", "--json", "-"],
  "stdin": ".kairon/runs/RUN-0001/context.md",
  "stdout": ".kairon/runs/RUN-0001/stdout.log",
  "stderr": ".kairon/runs/RUN-0001/stderr.log"
}
```

Codex が resume id / thread id を返す場合は `session.json` に保存する。
これは session crash 時の recovery 補助であり、同日運用の主経路は Terminal-backed CLI Session である。

## Claude Adapter

Claude Code は subscription 利用時、公式 Claude Code の認証状態を使う。
`ANTHROPIC_API_KEY` が存在する場合は API usage になる可能性があるため警告する。

```text
claude -p "<prompt>" --output-format stream-json --verbose
```

MVP では `--bare` を標準にしない。
`--bare` は API key / apiKeyHelper 前提になりやすいため、subscription usage と混ざる可能性がある。

Claude は tool permission を job capability から生成する。

```json
{
  "agent": "claude",
  "command": "claude",
  "args": [
    "-p",
    "Execute the Kairon run described in stdin. Produce the required outbox.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "Read,Edit,Bash(git diff *),Bash(npm test *)"
  ],
  "stdin": ".kairon/runs/RUN-0002/context.md",
  "stdout": ".kairon/runs/RUN-0002/stdout.log",
  "stderr": ".kairon/runs/RUN-0002/stderr.log"
}
```

Claude の unattended continuation は provider terms の境界が残るため、Kairon では `claude_unattended_mode` を `restricted` にする。
Claude Code Opus が code-producing implementation を行った場合、review は Codex に渡す。
Codex 側 review は `codex-plugin-cc` を利用する path を優先する。
Claude reviewer が rate limit に到達した場合、review loop は `review_result` missing の修正要求を作らず、`setup_required` として再実行待ちにする。

## Antigravity Adapter

AntigravityCLI は `agy` を正式な実行対象とし、Kairon 内部の agent id は互換性のため `gemini` を維持する。
現行の `agy --print` は Terminal UI 寄りの挙動で、Node child process pipe からstdoutを安定取得できないため、自動runnerでは PTY adapter が必要である。
T16では non-interactive runner とは別に `interactiveSessionRunner` の接続点を追加し、Antigravity を正式な interactive agent として実行できる runtime path を用意する。
T17では `node-pty` backed runner を追加し、CLI / runtime queue / review loop から `agy --prompt-interactive` をPTY上で起動する。
interactive runner が未設定、またはPTY起動に失敗した場合、Kairon は `setup_required` として扱い、automated task dispatch では non-interactive agent へfallbackする。

```text
agy --add-dir "<run-outbox-directory>" --prompt-interactive "<prompt>"  # PTY adapter path
```

Antigravity は QA、research、large context review を優先する。
加えて、Google ecosystem と multimodal review で優先的に起用する。
AntigravityCLI の背後 service に third-party client で直接アクセスしない。
`agy` に native JSON output flag がないため、Kairon はrun固有markerで囲んだstdout outboxを主経路とし、file outboxも受理する。
PTY runnerはrun idが一致する有効なfile / stdout outboxを検出した時点でgraceful exitを要求し、stdout outboxはTUIがechoしたprompt内の分類用語より優先する。
timeoutまで有効なoutboxが生成されない場合だけrun failedとして記録する。

```json
{
  "agent": "gemini",
  "command": "agy",
  "args": [
    "--prompt-interactive",
    "Execute the Kairon run described in the prompt. Produce the required outbox."
  ],
  "stdin": ".kairon/runs/RUN-0003/context.md",
  "stdout": ".kairon/runs/RUN-0003/stdout.log",
  "stderr": ".kairon/runs/RUN-0003/stderr.log"
}
```

## Run Lifecycle

```text
dispatch decision
  -> resolve agent adapter
  -> attach same-day terminal session
  -> prepare worktree
  -> prepare context.md
  -> build incremental prompt
  -> send prompt to existing CLI session
  -> stream logs
  -> detect prompts / usage limits / permission blocks
  -> collect result
  -> write or synthesize outbox.json
  -> update session scratch
  -> return run result to State Applier
```

## Detectable States

Agent Runner は出力を監視して次の状態を検出する。

| State | 対応 |
| --- | --- |
| normal_progress | stdout/stderr を保存 |
| requires_login | run を停止し setup approval に回す |
| usage_limited | Agent を pause / defer |
| permission_prompt | job を approval queue に積む |
| policy_blocked | State Applier に failure outbox を渡す |
| no_output_timeout | graceful stop 後に retry / handoff |
| outbox_missing | failure outbox を作る |

## Outbox Handling

理想は Agent が `outbox.json` を直接生成すること。
ただし CLI や model の出力が安定しない場合に備え、Runner は次の順で処理する。

1. Agent 生成の `outbox.json` を schema validate。
2. structured output を `outbox.json` に変換。
3. 最終 message から最小 failure / summary outbox を生成。
4. outbox 生成不能なら run failed として記録。

## Same-Day Session Retention

同日中は Agent ごとに Terminal-backed Session を保持する。

```text
sessions/YYYY-MM-DD/{agent}/
  session.json
  context_manifest.json
  scratch.md
```

`scratch.md` は人間向け要約ではなく、同日中に Agent Runtime が次 run の context に混ぜるための作業記憶である。
日次メンテ終了時に `scratch.md` の内容は daily report、handoff、RAG index に反映し、session を close する。

Terminal-backed Session は同日中の主 memory だが、無制限の context 保持を前提にしない。
Agent Runner は一定間隔で session scratch と handoff を更新し、CLI 側の context compaction が起きても再投入できる状態を維持する。

## runtime.json

```json
{
  "default_mode": "persistent_terminal_session",
  "visible_terminal_required": false,
  "official_cli_only": true,
  "session_retention": {
    "scope": "daily",
    "close_at": "maintenance_end",
    "next_day_restore_from": ["daily_report", "handoff", "events", "rag"]
  },
  "agents": {
    "codex": {
      "unattended_mode": "allowed_with_policy",
      "session_strategy": "terminal_session_primary_resume_for_recovery"
    },
    "claude": {
      "unattended_mode": "restricted",
      "session_strategy": "terminal_session_primary_kairon_context_checkpoint"
    },
    "gemini": {
      "unattended_mode": "allowed_with_policy",
      "session_strategy": "terminal_session_primary_kairon_context_checkpoint"
    }
  }
}
```

## 設計上の判断

Terminal window を表示するかどうかは、Kairon の policy 中核ではない。
重要なのは、公式 CLI を正規の認証状態で起動し、provider の usage / permission / rate limit を回避せず、すべての run を追跡可能にすることである。
