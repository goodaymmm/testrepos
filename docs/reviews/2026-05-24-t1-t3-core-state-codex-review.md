# Kairon Review: T1-T3 Core State

## Scope

- T1 Core File State
- T2 Config defaults / validation / `kairon init`
- T3 Event log / materializers / State Applier

## Reviewer

- Reviewer: Codex
- Review type: self-review
- Claude review: not run. Claude CLI / codex-plugin-cc review loop is not implemented yet.

## Checks

```text
npm run typecheck: passed
npm test: passed
npm run build: passed
node dist/cli/main.js --help: passed
```

## Coverage

- Path traversal rejection
- Atomic JSON write
- JSONL append/read
- Lock acquire/release
- Counter monotonic IDs
- Corrupt counter rejection
- `.kairon/` initialization
- Config validation
- Existing root rule preservation
- Existing Kairon config preservation
- `task.created` materialization
- `message.created` materialization
- `approval.requested` / `approval.decided` materialization
- `schedule.close_active_work` command materialization
- Outbox runtime validation

## Findings

No blocking findings remain.

Issues found and fixed during review:

- `initializeProject` overwrote existing config files on repeated init.
  - Fix: write config and rule files only when missing.
- Counter recovery silently reset invalid `counters.json`.
  - Fix: initialize only on missing file, reject corrupt counters.
- `applyOutbox` relied on TypeScript types without runtime schema validation.
  - Fix: validate outbox with Zod before applying events.

## Residual Risk

- State Applier appends events before materialization. If materialization fails, recovery needs to replay materializers from event log.
- Queue / Command Inbox idempotency is not implemented yet; it belongs to T4.
- Real CLI Agent sessions are not connected yet; this slice is file-state and CLI init only.

## Decision

Approved for T1-T3 implementation.
