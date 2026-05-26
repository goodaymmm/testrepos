# Kairon Review: T12-01 Agent Smoke

## Scope

- `src/agents/smoke-runner.ts`
- `src/cli/commands/agent.ts`
- `src/cli/main.ts`
- `tests/agent-smoke.test.ts`
- `tests/cli.test.ts`
- `README.md`
- `docs/cli-commands-v0.md`

## Reviewer

- Reviewer: Codex
- Review type: self-review
- Claude review: not run. Live cross-agent review execution is not wired into this local test pass yet.

## Checks

```text
npm run typecheck: passed
npm test -- tests\agent-smoke.test.ts tests\cli.test.ts tests\cli-session-runner.test.ts: passed
npm test: passed
npm run build: passed
node .\dist\cli\main.js --help: passed
node .\dist\cli\main.js agent --help: passed
node .\dist\cli\main.js agent smoke --help: passed
```

## Coverage

- `kairon agent smoke --agent codex|claude|gemini` is exposed.
- Smoke creates a task artifact under `.kairon/tasks/TASK-xxxx/task.json`.
- Smoke creates run artifacts under `.kairon/runs/RUN-xxxx/`.
- Codex, Claude, and Antigravity invocations are verified through command runner mocks.
- Agent-written outbox is preserved when valid.
- Missing CLI returns `setup_required` without invoking the command runner.
- Missing CLI writes a failure outbox with `cli_command_missing`.

## Findings

No blocking findings remain.

## Residual Risk

- Real CLI smoke execution is intentionally left to manual operation tests because it consumes local subscription CLI usage.
- The current smoke command uses the existing non-interactive runner path, not persistent PTY session reuse. Persistent session reuse remains T12-03 scope.
- CLI output detectors for login required, usage limits, permission prompts, and timeout states remain T12-04 scope.

## Decision

Approved for T12-01 implementation.
