# Kairon Review: T6 Agent Interfaces

## Scope

- `src/agents/types.ts`
- `src/agents/dispatcher.ts`
- `src/agents/context-builder.ts`
- `src/agents/session-host.ts`
- `src/agents/adapters/codex.ts`
- `src/agents/adapters/claude.ts`
- `src/agents/adapters/gemini.ts`
- `src/agents/adapters/index.ts`
- `tests/dispatcher.test.ts`
- `tests/context-builder.test.ts`
- `tests/session-host.test.ts`

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

- Dispatcher selects an agent from persona, policy, capability, and available session inputs.
- Implementer defaults to Codex when available.
- Persona-compatible fallback works when the preferred agent session is unavailable.
- Gemini is prioritized for Google ecosystem and multimodal work.
- Context Builder creates run and daily bootstrap context artifacts from task, messages, rules, and scratch.
- Context Builder does not add human summaries to canonical task state.
- Session Host creates attachable session metadata without spawning an external process.
- Codex / Claude / Gemini adapter definitions are available and expose CLI command expectations.

## Findings

No blocking findings remain.

Two issues were found and fixed during review:

- Dispatcher initially treated `requiredCapabilities` only as preference signal.
  - Fix: known capability constraints now filter incompatible agents.
- Session Host initially overwrote `context_manifest.json` every time `openSession` ran.
  - Fix: the manifest is created only when missing.

## Residual Risk

- Session Host only creates metadata and checks command availability. It does not start or attach real terminal-backed CLI processes yet.
- Context Builder does not include RAG retrieval or git diff snapshots yet. Those are intentionally left for the later RAG and Git slices.
- Dispatcher scoring is deterministic and rule-based. Historical success scoring belongs to a later runtime intelligence slice.

## Decision

Approved for T6 implementation.
