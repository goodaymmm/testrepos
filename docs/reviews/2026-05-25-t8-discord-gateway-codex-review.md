# Kairon Review: T8 Discord Gateway Skeleton

## Scope

- `src/discord/gateway.ts`
- `src/discord/interactions.ts`
- `src/discord/idempotency.ts`
- `src/discord/approval-message.ts`
- `src/queue/command-inbox.ts`
- `src/core/config/defaults.ts`
- `tests/discord-gateway.test.ts`
- `tests/discord-idempotency.test.ts`
- `tests/discord-interactions.test.ts`
- `tests/approval-message.test.ts`

## Reviewer

- Reviewer: Codex
- Review type: self-review
- Claude review: not run. Claude CLI / codex-plugin-cc review loop is not implemented yet.

## Checks

```text
npm run typecheck: passed
npm test: passed
npm run build: passed
```

## Coverage

- Discord Gateway readiness when provider is disabled, env is incomplete, and env is complete.
- Discord idempotency key acceptance, duplicate rejection, and expiry.
- Approval `custom_id` parsing for buttons and request changes modal IDs.
- Actor, guild, channel, approval status, nonce, and action validation.
- Approval decision interaction normalization into Command Inbox.
- `/kairon leave` normalization into `schedule.close_active_work`.
- Approval Discord message payload creation with compact fields and buttons.
- Secret-like text redaction and full diff/log exclusion from Discord payload.

## Findings

No blocking findings remain.

Two issues were found and fixed during review:

- Discord-origin commands did not preserve enough provenance in the command contract.
  - Fix: `source`, `discord`, and `nonce` metadata were added to Command Inbox command types.
- Missing approval files could surface as read exceptions during interaction validation.
  - Fix: missing approvals now return a rejected validation result.

## Residual Risk

- T8 does not connect to the live Discord Gateway or call Discord APIs. It only prepares config, normalization, idempotency, and message payload boundaries.
- Message posting / updating, slash command registration, interaction ACK, and reconnect recovery belong to a later runtime connection slice.
- `approval.snooze` is normalized into Command Inbox, but snooze materialization is still not implemented by State Applier.

## Decision

Approved for T8 implementation.
