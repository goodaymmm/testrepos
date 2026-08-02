# Kairon Review: T14-01 Approval Queue CLI

## Scope

- `src/approvals/approval-queue.ts`
- `src/cli/commands/approval.ts`
- `src/cli/main.ts`
- `src/core/events/event-types.ts`
- `src/state/state-applier.ts`
- `src/state/materializers.ts`
- `tests/approval-queue.test.ts`
- `tests/state-applier.test.ts`
- `tests/cli.test.ts`
- `README.md`
- `docs/cli-commands-v0.md`

## Reviewer

- Reviewer: Codex
- Review type: self-review
- Claude review: not run. Live cross-agent review execution should be validated once the local approval CLI is used in operation tests.

## Checks

```text
npm run typecheck: passed
npm test -- tests\approval-queue.test.ts tests\state-applier.test.ts tests\cli.test.ts tests\command-inbox.test.ts tests\discord-interactions.test.ts: passed
npm test: passed
npm run build: passed
node .\dist\cli\main.js --help: passed
node .\dist\cli\main.js approval --help: passed
node .\dist\cli\main.js approval decide --help: passed
```

## Coverage

- `kairon approval list` lists pending approvals by default.
- `kairon approval list --status all` can include non-pending approvals.
- `kairon approval show APR-xxxx` displays sanitized details.
- Raw diff/log/stdout/stderr/body fields are omitted in CLI detail output.
- Secret-like keys are redacted in CLI detail output.
- `approve`, `reject`, and `request_changes` materialize final decisions.
- `snooze` materializes `approval.snoozed` and keeps the approval resumable.
- Duplicate final decisions are rejected when approval status is no longer pending or snoozed.
- CLI command registration includes top-level `approval`.

## Findings

No blocking findings remain.

## Residual Risk

- This slice is local CLI only. Live Discord message posting and interaction ACK remain T14-02 scope.
- Approval-specific follow-up actions, such as push resume after approval, remain owned by the corresponding transaction/runtime slices.
- Board UI approval handling remains T16 scope.

## Decision

Approved for T14-01 implementation.
