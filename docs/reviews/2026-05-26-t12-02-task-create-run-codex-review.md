# Kairon Review: T12-02 Task Create / Run

## Scope

- `src/tasks/task-runner.ts`
- `src/cli/commands/task.ts`
- `src/cli/main.ts`
- `src/queue/work-queue.ts`
- `src/state/materializers.ts`
- `tests/task-runner.test.ts`
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
npm test -- tests\task-runner.test.ts tests\work-queue.test.ts tests\state-applier.test.ts tests\cli.test.ts: passed
npm test: passed
npm run build: passed
node .\dist\cli\main.js task create --help: passed
node .\dist\cli\main.js task run --help: passed
node .\dist\cli\main.js --help: passed
```

## Coverage

- `kairon task create` writes task artifacts under `.kairon/tasks/TASK-xxxx/task.json`.
- Task metadata includes persona, capabilities, tags, approval flag, code-producing flag, commit-requested flag, priority, and schedule mode.
- `kairon task run` enqueues an `agent.run` queue item and claims it by id.
- Task run dispatches through `AgentDispatcher`.
- Task run invokes `CliSessionRunner.runAgentJob`.
- Agent outbox is applied through `StateApplier`.
- `run.completed` now updates the task materialized status and last run metadata.
- Missing selected CLI returns `setup_required` without invoking the command runner.
- Code-producing tasks start the existing review loop path.

## Findings

No blocking findings remain.

## Residual Risk

- `task run` is a synchronous MVP path. Runtime loop integration remains T15-01 scope.
- Persistent PTY session reuse remains T12-03 scope.
- CLI output detectors for login required, usage limits, permission prompts, and timeout states remain T12-04 scope.
- Real CLI execution is covered by smoke/manual operation tests; unit tests use command runner mocks.

## Decision

Approved for T12-02 implementation.
