# Kairon CLI Commands v0

## 目的

この文書は MVP で実装する `kairon` CLI のコマンド仕様を定義する。

## Command List

```text
kairon init
kairon migrate
kairon doctor
kairon docking analyze
kairon start
kairon stop
kairon status
kairon task create
kairon task run TASK-0001
kairon leave
kairon maintenance run
```

## kairon init

対象プロジェクトに `.kairon/` を作成する。

```text
kairon init
```

処理。

```text
detect project root
create .kairon directories
generate config files
discover root rules
generate .kairon/rules
run doctor checks
create sample task if requested
```

## kairon migrate

既存 `.kairon/config/*.json` を現在のschemaやCLI名に合わせて移行する。

```text
kairon migrate --dry-run
kairon migrate
```

処理。

```text
load existing config
detect required migrations
show dry-run diff if requested
create .bak-YYYYMMDDHHmmss before writing
write migrated config
validate config
```

MVPでは、旧 Gemini CLI 設定を AntigravityCLI 設定へ移行する。

```text
agents.gemini.adapter: gemini_cli -> antigravity_cli
agents.gemini.command: gemini -> agy
```

## kairon doctor

Kairon が稼働できるかを検査する。

```text
kairon doctor
```

検査項目。

- config schema
- project root
- git repository
- CLI availability
- API key contamination
- Discord env
- protected path policy
- runtime lock

出力。

```text
doctor.ok=true
summary.pass=8
summary.warning=0
summary.error=0
PASS git.repository Git repository
...
```

`warning` は運用前に確認すべき注意、`error` は通常運用前に解消すべき問題を示す。

## kairon docking analyze

対象projectのtop-level構成をscanし、`project.json` 向けのconfig proposalを表示する。

```text
kairon docking analyze
```

処理。

```text
scan top-level files and directories
classify protected / generated / source path candidates
detect primary_language / frameworks / package_managers
print project_config proposal JSON
do not write .kairon/config/project.json
```

MVPでは、`.mcp.json`、`.claude/**`、`.gemini/**`、`.antigravitycli/**` を protected 候補に寄せる。
`tmpclaude-*`、`dist/**`、`build/**`、`coverage/**`、`node_modules/**` は generated 候補に寄せる。

## kairon start

Kairon Runtime を起動する。

```text
kairon start
```

処理。

```text
acquire runtime lock
start queue worker
start session manager
start Agent Session Host
open Codex terminal-backed session
open Claude terminal-backed session
open Antigravity/Gemini terminal-backed session
inject daily bootstrap context
start schedule loop
```

MVP では foreground command として実行してよい。
service 化は Phase 2 以降に回す。

## kairon stop

Kairon Runtime を停止する。

```text
kairon stop
```

処理。

```text
stop dispatching new jobs
flush session scratch
write runtime state
gracefully close terminal sessions
release runtime lock
```

## kairon status

現在の Runtime 状態を表示する。

```text
kairon status
```

表示項目。

- schedule mode
- runtime lock
- active sessions
- queue length
- active runs
- pending approvals
- last daily handoff

## kairon task create

手動で task を作成する。

```text
kairon task create --title "Add approval queue" --persona implementer
```

生成物。

```text
.kairon/tasks/TASK-xxxx/task.json
.kairon/messages/TASK-xxxx.jsonl
task.propose event
```

## kairon task run

指定 task を dispatch する。

```text
kairon task run TASK-0001
```

処理。

```text
load task
build dispatch_request
select session
build incremental context
send prompt to Agent Session
collect outbox
apply state
```

## kairon maintenance run

日次メンテを手動実行する。

```text
kairon maintenance run
```

処理。

```text
run QA / review placeholders
create cleanup proposals
flush session scratch
write daily report
write handoff
prepare next-day bootstrap
```

## kairon leave

本日の Active Work を終了する。

```text
kairon leave
```

処理。

```text
set schedule override active_work_closed_for_today
stop dispatching new active_work jobs
let currently running safe jobs finish or checkpoint
move unresolved decisions to approval queue
notify Discord if enabled
switch runtime behavior to standby_work
```

Discord からは `/kairon leave` を同じ command として扱う。

## Exit Codes

| Code | 意味 |
| --- | --- |
| 0 | success |
| 1 | general failure |
| 2 | config invalid |
| 3 | runtime lock exists |
| 4 | CLI unavailable |
| 5 | policy blocked |
| 6 | approval required |
| 7 | active work closed |

## MVP Notes

- `kairon start` は最初は foreground でよい。
- `kairon task run` は active runtime がない場合、error にする。
- `kairon stop` は terminal session を閉じる前に handoff を書く。
- Discord が disabled の場合、approval は `.kairon/approvals` に file として残す。
- `kairon leave` は Runtime を停止しない。本日の Active Work だけを閉じる。
