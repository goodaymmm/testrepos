# Kairon Review: T9 Real CLI Session MVP

## Scope

- `src/agents/command-runner.ts`
- `src/agents/cli-invocation.ts`
- `src/agents/prompt-envelope.ts`
- `src/agents/cli-session-runner.ts`
- `src/agents/session-host.ts`
- `tests/cli-session-runner.test.ts`

## Reviewer

- Reviewer: Codex
- Review type: self-review
- Claude review: not run. T9 adds the CLI runner boundary but the live multi-agent review loop is still not invoked during tests.

## Checks

```text
npm run typecheck: passed
npm test: passed
npm run build: passed
```

## Coverage

- Codex daily bootstrap builds the official `codex exec --json --sandbox workspace-write -` invocation.
- Codex job prompt writes run-level stdin / stdout / stderr and preserves an agent-written `outbox.json`.
- Missing CLI binaries produce `setup_required` metadata and a failure outbox.
- Claude Opus code-producing jobs create the Codex review path through `codex-plugin-cc`.
- Gemini QA / Google ecosystem / multimodal jobs carry capability hints into the prompt.

## Findings

No blocking findings remain.

Two issues were found and fixed during review:

- Optional outbox path narrowing was too loose for strict TypeScript.
  - Fix: the job outbox path is now stored as a concrete local constant before building the run paths object.
- The Codex job fake runner treated bootstrap prompts as job prompts.
  - Fix: the test runner now handles bootstrap prompts separately before checking job outbox instructions.

## Residual Risk

- T9 does not keep a long-lived PTY process alive yet. It uses an injectable official CLI process boundary that can be replaced by persistent PTY reuse later.
- Tests intentionally do not launch real Codex / Claude / Gemini CLI binaries.
- Live login, provider usage-limit detection, and interactive permission prompt handling still need a later runtime connection slice.

## Decision

Approved for T9 implementation.
