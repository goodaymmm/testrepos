# Kairon State Store v0

## 目的

State Store は、Kairon の canonical state を JSON / JSONL / MD ファイルとして保存し、Agent 出力を検証して反映する境界を定義する。

MVP では file-based state store を採用する。
SQLite や外部 DB は Phase 2 以降に回す。

## 基本方針

- canonical source は `.kairon/` 配下の file state。
- event log は append-only JSONL。
- materialized state は event から再生成可能にする。
- Agent は canonical state を直接更新しない。
- Agent は `runs/RUN-xxxx/outbox.json` を出す。
- State Applier が outbox を検証し、event と materialized state に反映する。

## Directory Layout

```text
.kairon/
  events/
    2026-05-24.jsonl
    checkpoints/
      ECP-EVT-000120-abcdef123456.json
    archive/
      ECP-EVT-000120-abcdef123456/
        manifest.json
        2026-05-23.jsonl
  tasks/
    TASK-0001/
      task.json
      context.md
      artifacts/
  messages/
    TASK-0001.jsonl
  approvals/
    APR-0001.json
  runs/
    RUN-0001/
      run.json
      context.md
      context_sources.json
      outbox.json
      stdout.log
      stderr.log
      artifacts/
  sessions/
  reports/
  cleanup/
  state/
    queue.json
    schedule_override.json
  backups/
    index/
      BKP-20260715000000000-abcdef123456.json
    packages/
      BKP-20260715000000000-abcdef123456/
        manifest.json
        files/
  runtime/
```

## Event Log

Event は append-only にする。

```json
{
  "event_id": "EVT-000001",
  "type": "run.completed",
  "task_id": "TASK-0001",
  "run_id": "RUN-0001",
  "actor": "codex.implementer",
  "payload": {
    "status": "completed",
    "outbox": ".kairon/runs/RUN-0001/outbox.json"
  },
  "created_at": "2026-05-24T10:00:00+09:00",
  "schema_version": "0.1"
}
```

### Checkpoint And Compaction

終了済みの日別event segmentは、内容を書き換えずにarchiveへ移動できる。
当日分のsegmentは常にactiveとして扱い、compaction対象にしない。

```text
kairon state events compact --dry-run
kairon state events compact --confirm ECP-EVT-000120-abcdef123456
kairon state events verify ECP-EVT-000120-abcdef123456
```

`--dry-run`はsegment hash、event IDの連続性、materialized state hashを検証し、入力から決定的なcheckpoint IDを生成する。
実行時は同じcheckpoint IDの明示確認を必須とし、次の順序で処理する。

```text
create state snapshot
  -> acquire events resource lock
  -> revalidate source and materialized state hashes
  -> write state-compaction marker
  -> rename closed segments into archive
  -> write archive manifest
  -> write checkpoint
  -> remove state-compaction marker
```

checkpointには最終event ID、source hash、materialized state hash、snapshot、archive manifestを記録する。
`verify`はarchive内の各segment、event ID連続性、source hash、snapshot内の元segment、materialized state hashを再検証する。

処理が途中で停止した場合、移動済みsegmentを自動削除・自動復元しない。
`.kairon/runtime/state-compaction.json`を残し、`kairon recovery list` / `kairon recovery run`でmanual roll-forwardまたはrollbackの対象として扱う。
event historyの読み取りはactive segmentとarchive segmentの両方を追跡する。

## Event Types

- `task.proposed`
- `task.created`
- `task.updated`
- `task.claimed`
- `run.created`
- `run.started`
- `run.completed`
- `run.failed`
- `review.requested`
- `review.completed`
- `review.approved`
- `review.changes_requested`
- `review.loop.started`
- `review.loop.iterated`
- `review.loop.escalated`
- `message.created`
- `approval.requested`
- `approval.decided`
- `discord.gateway.started`
- `discord.gateway.connected`
- `discord.gateway.disconnected`
- `discord.command.registered`
- `discord.interaction.received`
- `discord.interaction.rejected`
- `notification.sent`
- `notification.updated`
- `notification.update_failed`
- `notification.failed`
- `git.worktree.created`
- `git.worktree.resumed`
- `git.branch.created`
- `git.diff.snapshotted`
- `git.transaction.started`
- `git.transaction.checked`
- `git.committed`
- `git.pushed`
- `git.conflict.detected`
- `git.rollback.proposed`
- `git.transaction.failed`
- `session.created`
- `session.updated`
- `session.closed`
- `maintenance.started`
- `maintenance.completed`
- `cleanup.proposed`
- `schedule.override.created`
- `schedule.override.cleared`
- `active_work.closed`

## task.json

```json
{
  "schema_version": "0.1",
  "id": "TASK-0001",
  "title": "Add approval queue",
  "status": "ready",
  "priority": 50,
  "risk_level": "medium",
  "personas_allowed": ["implementer", "reviewer"],
  "objective": {
    "goal": "Discord approval request を作成できる",
    "non_goals": ["deploy"]
  },
  "resources": ["repo:path:src/**", "state:approvals"],
  "acceptance": [
    "approval.requested event が作成される"
  ],
  "git": {
    "branch": null,
    "commits": []
  },
  "version": 1,
  "created_at": "2026-05-24T10:00:00+09:00",
  "updated_at": "2026-05-24T10:00:00+09:00"
}
```

## run.json

```json
{
  "schema_version": "0.1",
  "id": "RUN-0001",
  "task_id": "TASK-0001",
  "agent": "codex",
  "persona": "implementer",
  "status": "running",
  "session_id": "TERM-codex-20260524",
  "context": ".kairon/runs/RUN-0001/context.md",
  "outbox": ".kairon/runs/RUN-0001/outbox.json",
  "stdout": ".kairon/runs/RUN-0001/stdout.log",
  "stderr": ".kairon/runs/RUN-0001/stderr.log",
  "created_at": "2026-05-24T10:00:00+09:00",
  "started_at": "2026-05-24T10:00:10+09:00",
  "completed_at": null
}
```

## outbox.json

```json
{
  "schema_version": "0.1",
  "run_id": "RUN-0001",
  "task_id": "TASK-0001",
  "agent": "codex",
  "persona": "implementer",
  "status": "completed",
  "events": [
    {
      "type": "message.created",
      "payload": {
        "message_type": "implementation.result",
        "body": "Implemented approval request event creation."
      }
    }
  ],
  "approvals": [],
  "git": {
    "branch": "auto/TASK-0001/codex",
    "commit_sha": null,
    "parent_sha": null,
    "pushed": false,
    "rollback": null
  },
  "next_jobs": [
    {
      "persona": "reviewer",
      "agent_preference": "codex",
      "reason": "implementation completed"
    }
  ]
}
```

## State Applier Workflow

```text
load outbox
  -> schema validate
  -> policy validate
  -> acquire state lock
  -> append events
  -> update materialized files
  -> update queue
  -> release state lock
```

## State Lock

MVP では単一 writer lock を使う。

```text
.kairon/runtime/state.lock
```

```json
{
  "owner": "state-applier",
  "pid": 12345,
  "created_at": "2026-05-24T10:00:00+09:00",
  "expires_at": "2026-05-24T10:05:00+09:00"
}
```

Phase 2 では resource-level lock と fencing token を拡張する。

## Materialization Rules

| Event | Materialized update |
| --- | --- |
| `task.created` | create `tasks/TASK-xxxx/task.json` |
| `task.updated` | update `task.json` version |
| `run.started` | create/update `runs/RUN-xxxx/run.json` |
| `run.completed` | update run status and task status |
| `message.created` | append `messages/TASK-xxxx.jsonl` |
| `review.requested` | create review queue item |
| `review.completed` | append review artifact and update loop state |
| `review.approved` | mark code-producing run review-passed |
| `review.changes_requested` | create fix job |
| `approval.requested` | create `approvals/APR-xxxx.json` |
| `approval.decided` | update approval status and append event |
| `discord.interaction.received` | append runtime audit event |
| `notification.sent` | update notification provider metadata |
| `notification.updated` | update notification provider metadata |
| `git.committed` | update task git commits |
| `session.updated` | update session metadata |

## Queue State

```text
.kairon/state/queue.json
```

```json
{
  "schema_version": "0.1",
  "items": [
    {
      "id": "JOB-0001",
      "task_id": "TASK-0001",
      "type": "agent.run",
      "persona": "implementer",
      "status": "ready",
      "priority": 50,
      "created_at": "2026-05-24T10:00:00+09:00"
    }
  ]
}
```

## Schedule Override State

`kairon leave` または Discord `/kairon leave` により、本日の Active Work を閉じる。

```text
.kairon/state/schedule_override.json
```

```json
{
  "schema_version": "0.1",
  "date": "2026-05-24",
  "active_work_closed": true,
  "reason": "user_leave_command",
  "created_by": "user:owner",
  "created_at": "2026-05-24T15:00:00+09:00",
  "expires_at": "2026-05-25T07:00:00+09:00"
}
```

Schedule Engine はこの file が有効な間、現在時刻が Active Work Time 内でも Standby Work 相当の dispatch policy を使う。

## Id Generation

MVP は local monotonic counter を使う。

```text
.kairon/state/counters.json
```

```json
{
  "task": 1,
  "run": 1,
  "event": 1,
  "job": 1,
  "approval": 1,
  "message": 1
}
```

## State Integrity Check

`.kairon/` 配下の file-based state は、次のコマンドで整合性を確認できる。

```text
kairon state check
kairon state check --format json
```

`state check` は以下を検出する。

- JSON / JSONL の parse error
- `schema_version` がない state record
- task / run / approval の missing reference
- path ID と record ID の mismatch
- task / run 配下の orphan artifact

この check は read-only であり、broken state の自動修復はしない。
修復が必要な場合は、検出結果をもとに個別の修正タスクとして扱う。

## State Snapshot Dry Run

snapshot 対象の state file は、次のコマンドで dry-run として確認できる。

```text
kairon state snapshot --dry-run
kairon state snapshot --dry-run --format json
```

dry-run は `.kairon/` 配下の JSON / JSONL / MD state artifact を列挙し、category / file count / total bytes を出力する。
snapshotはhash付きmanifestとpayloadを `.kairon/snapshots/` に保存する。
restoreは事前planとsnapshot IDの明示確認を必須とし、実行前のbackup snapshotを作成してから適用する。

## State Backup And Recovery Drill

snapshotは同一project内の短期rollback用、backupは外部媒体を含むmanifest packageとして扱う。
backup対象はcanonicalなJSON / JSONL / MD stateであり、次は既定で除外する。

- `.kairon/runtime/`、`.kairon/tmp/`、`.kairon/worktrees/`
- `.kairon/rag/`、`.kairon/board/`
- `.kairon/snapshots/`、`.kairon/backups/`
- `*.log`、symbolic link、未対応file type
- path名にtoken、secret、credential、password、`.env`、秘密鍵拡張子を含むfile

```text
kairon state backup create --dry-run
kairon state backup create --output D:\KaironBackups
kairon state backup verify BKP-20260715000000000-abcdef123456
kairon state backup rehearse BKP-20260715000000000-abcdef123456
kairon state backup restore BKP-20260715000000000-abcdef123456 --confirm BKP-20260715000000000-abcdef123456
```

packageは`manifest.json`と`files/`からなり、manifestは各fileのpath、size、SHA-256、category、schema versionとpackage全体の決定的checksumを持つ。
作成後のlocal registryは`.kairon/backups/index/`へ保存される。

local registryが失われた災害復旧では、外部packageを明示する。

```text
kairon state backup verify <backup-id> --source D:\KaironBackups\<backup-id>
kairon state backup rehearse <backup-id> --source D:\KaironBackups\<backup-id>
kairon state backup restore <backup-id> --source D:\KaironBackups\<backup-id> --confirm <backup-id>
```

`verify`はmanifestとpayloadの欠損、余分なfile、size、hash、schema、危険pathを検証する。
`rehearse`はOS temporary directoryへ展開してstate integrity checkを実行し、終了時に必ず隔離directoryを削除する。現在のproject stateは変更しない。

`restore`はruntime停止とbackup IDの完全一致確認を必須とする。適用前に現行state snapshotを作成し、適用後にstate integrity checkを実行する。
restoreが途中停止または失敗した場合は`.kairon/runtime/state-backup-restore.json`を残す。自動継続や自動rollbackは行わず、`kairon recovery list`で確認してからmarker内の`pre_restore_snapshot_id`を使用して明示的にrollbackする。

```text
kairon state snapshot restore <pre-restore-snapshot-id> --confirm <pre-restore-snapshot-id>
```

## Recovery

```text
kairon start
  -> scan runs without completed_at
  -> scan outbox files not applied
  -> compare event log
  -> mark ambiguous runs as failed_or_needs_review
  -> requeue safe jobs only
```

曖昧な run は自動再実行しない。
二重 commit / push を避けるため approval queue に積む。

## MVP Done Criteria

- event JSONL に append できる。
- task / run / message / approval を materialize できる。
- outbox schema validation ができる。
- state lock が機能する。
- queue item を作成・更新できる。
- interrupted run を検出できる。
