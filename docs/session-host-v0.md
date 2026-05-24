# Kairon Session Host v0

## 目的

Session Host は、公式 CLI Agent を Terminal-backed Session として起動し、日次メンテ終了まで保持するコンポーネントである。
Agent Runner は Session Host が保持する session に job prompt を投入し、stdout / stderr / outbox を収集する。

この文書は MVP で実装する Session Host の contract を定義する。

## 基本方針

- 標準 mode は `persistent_terminal_session`。
- Codex の実 CLI session から実装する。
- Claude / Gemini も MVP では実 CLI session を起動し、3 CLI の連携と競合チェックを確認する。
- Terminal window が見えているかどうかは policy boundary にしない。
- 公式 CLI process、stdin、stdout、stderr、pid、terminal session id を追跡する。
- session は日次メンテ終了時に close する。
- 翌日は前日 handoff から新しい session に bootstrap context を投入する。

## Component Boundary

```text
Session Manager
  -> asks Session Host to open/attach/close sessions

Session Host
  -> owns terminal process / pty
  -> keeps streams open
  -> records terminal state

Agent Runner
  -> sends job prompt to Session Host
  -> watches run output
  -> collects outbox
```

Session Host は Agent を選ばない。
Session Host は outbox を canonical state に反映しない。

## Session Lifecycle

```text
create
  -> bootstrap
  -> ready
  -> running_job
  -> ready
  -> compacting
  -> ready
  -> closing
  -> closed
```

### create

```text
resolve agent adapter
verify official CLI binary
verify policy preconditions
open terminal / pty
start CLI process
write session.json
```

### bootstrap

```text
build daily bootstrap context
send bootstrap prompt
wait until session ready marker
record loaded sources
```

### running_job

```text
receive run_id and context.md
wrap context in job prompt envelope
send prompt to terminal session
stream output to run logs
detect completion marker or outbox
return run result
```

### compacting

```text
summarize current session state
write scratch.md
write context_manifest.json
send compacted memory prompt if needed
```

### closing

```text
flush logs
write handoff
write session closed state
terminate CLI process gracefully
```

## session.json

```json
{
  "schema_version": "0.1",
  "date": "2026-05-24",
  "agent": "codex",
  "adapter": "codex_cli",
  "mode": "persistent_terminal_session",
  "status": "ready",
  "terminal": {
    "terminal_id": "TERM-codex-20260524",
    "pid": 12345,
    "started_at": "2026-05-24T07:00:00+09:00",
    "last_input_at": "2026-05-24T10:00:00+09:00",
    "last_output_at": "2026-05-24T10:02:30+09:00"
  },
  "native": {
    "resume_id": null,
    "thread_id": null,
    "resume_supported": false
  },
  "active_run_id": null,
  "last_run_id": "RUN-0004",
  "loaded_bootstrap_hash": "sha256:...",
  "context_manifest": ".kairon/sessions/2026-05-24/codex/context_manifest.json",
  "scratch": ".kairon/sessions/2026-05-24/codex/scratch.md",
  "expires_at": "2026-05-25T07:00:00+09:00"
}
```

## Terminal State

```text
.kairon/runtime/terminals/
  TERM-codex-20260524.json
```

```json
{
  "schema_version": "0.1",
  "terminal_id": "TERM-codex-20260524",
  "agent": "codex",
  "session_path": ".kairon/sessions/2026-05-24/codex/session.json",
  "pid": 12345,
  "cwd": ".kairon/worktrees/TASK-0001-codex",
  "stdin_open": true,
  "stdout_log": ".kairon/runtime/terminals/TERM-codex-20260524.stdout.log",
  "stderr_log": ".kairon/runtime/terminals/TERM-codex-20260524.stderr.log",
  "status": "ready"
}
```

## Prompt Envelope

Agent Runner は raw context をそのまま流さない。
Session Host は job prompt envelope を使う。

```text
KAIRON_JOB_START RUN-0001
Task: TASK-0001
Persona: implementer
Expected outbox: .kairon/runs/RUN-0001/outbox.json

Instructions:
- Use the current project session context.
- Read the attached job context.
- Write the required outbox JSON.
- Do not modify canonical state directly.

Context path:
.kairon/runs/RUN-0001/context.md

KAIRON_JOB_END RUN-0001
```

完了検出は次の順で行う。

1. expected outbox file exists and validates.
2. CLI output contains completion marker.
3. process exits.
4. timeout produces failure outbox.

## Bootstrap Prompt

```text
KAIRON_DAILY_BOOTSTRAP_START 2026-05-24

You are running as the Codex Agent inside Kairon.
This terminal session should stay active until maintenance end.
Use the provided project rules and daily context.
Do not treat this session memory as canonical state.
Important decisions must be written to outbox / messages / scratch.

Bootstrap context:
.kairon/sessions/2026-05-24/codex/bootstrap.md

KAIRON_DAILY_BOOTSTRAP_END 2026-05-24
```

## Session Host API

MVP では内部 API として扱う。

```text
open_session(agent, date) -> session_id
attach_session(agent, date) -> session_id
send_job(session_id, run_id, context_path) -> run_handle
read_output(run_handle) -> stream
mark_ready(session_id)
compact_session(session_id)
close_session(session_id)
```

## Failure Handling

| Failure | 対応 |
| --- | --- |
| CLI binary missing | setup approval / doctor failure |
| login required | foreground terminal setup に誘導 |
| terminal process died | resume id があれば recovery、なければ bootstrap 再投入 |
| no output timeout | graceful interrupt、failure outbox |
| permission prompt | approval queue |
| context overflow suspected | compact_session |
| outbox missing | fallback failure outbox |

## MVP Implementation Notes

- Windows では最初は foreground PowerShell / terminal-backed process でよい。
- pty 抽象化は後から差し替え可能にする。
- stdout / stderr は terminal-level log と run-level log の両方に残す。
- run-level log は `RUN-xxxx` に切り出す。
- session scratch は run ごとに更新する。

## Done Criteria

- `kairon start` が Codex terminal session を作る。
- `session.json` と terminal state が作られる。
- bootstrap prompt が投入される。
- `kairon task run TASK-xxxx` が既存 session に job prompt を送る。
- run stdout / stderr が保存される。
- outbox が検出されるか failure outbox が作られる。
- `kairon stop` が handoff を書いて session を close する。
