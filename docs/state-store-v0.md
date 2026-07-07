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
MVP では restore 実行と snapshot archive 作成は未実装とし、対象確認のみを提供する。

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
