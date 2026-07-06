# LangGraph Runtime Spike v0

## Purpose

T110 evaluates whether Kairon should introduce a LangGraph-style workflow runtime
without changing the production file-based runtime.

This is a spike document. It is not a production runtime design.

## Current Production Boundary

The current Kairon runtime is intentionally file-based.

- `WorkQueue` owns queued work state in `.kairon/state/queue.json`.
- `RuntimeLoop` claims queue items and dispatches handlers by item type.
- `TaskRunner` executes agent jobs and applies outboxes.
- `ReviewLoopExecutor` runs reviewer jobs and queues git transactions after approval.
- `StateApplier` is the only path that appends events and materializes canonical state.

The experimental workflow runtime must not call these production components
implicitly.

## Spike Scope

Implemented scope:

- Task intake placeholder.
- Agent run placeholder.
- Approval gate placeholder.
- Graph-shaped nodes and edges.
- Artifact output under `.kairon/experimental/workflows/`.
- Explicit `experimental=true` requirement.

Out of scope:

- No LangGraph package dependency.
- No production `RuntimeLoop` integration.
- No queue claims.
- No task execution.
- No review loop mutation.
- No approval creation.
- No state event application.

## Artifact

The spike writes:

```text
.kairon/experimental/workflows/<workflow_id>.json
```

The artifact records:

- workflow id
- task id
- graph status
- nodes
- edges
- production boundary flags
- dependency assessment

The artifact is intentionally separate from canonical state.

## Dependency Decision

Current decision: defer dependency adoption.

Reasons:

- The current file-based queue already provides explicit recovery and audit points.
- LangGraph value is not proven for Kairon until a real multi-step workflow requires
  graph-level branching or durable graph replay.
- Adding a dependency now would affect CI and packaging before the operational value
  is measurable.

## Continue / Hold / Reject Criteria

Continue if:

- A future workflow needs branching, retries, and replay that are awkward in the
  current queue model.
- A graph runtime can preserve Kairon's state boundary and approval policy.
- The dependency works cleanly with Node ESM and Windows CI.

Hold if:

- The graph only mirrors current queue behavior.
- The dependency increases CI/runtime complexity without reducing implementation risk.

Reject if:

- The graph runtime needs to own canonical state.
- It bypasses `StateApplier`, approval gates, or runtime recovery.
- It makes queue recovery less explicit.

## Verification

```powershell
cd C:\Users\hikar\Documents\AutoRunner
npm run build
npx vitest run tests\workflow-runtime-spike.test.ts
```
