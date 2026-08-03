# Kairon Control Plane v0

## 目的

Control Plane は Agent が迷わず動くための制御プロトコルである。
LangGraph を workflow runtime、LangChain を tool / retriever / document integration layer、RAG を project memory として使う。

ただし、Kairon の primary Agent は Codex CLI、Claude Code、AntigravityCLI のような外部 CLI Agent である。
LangGraph / LangChain は外部 CLI Agent を置き換えるものではなく、dispatch contract、state transition、context assembly、review loop、approval loop を安定化するために使う。
Agent 選択と CLI process 制御は Control Plane ではなく、Agent Dispatcher と Agent Runner が担う。

## 設計原則

- Canonical source は `.kairon/` 配下の JSON / JSONL / MD に置く。
- LangGraph checkpoint は graph 実行の復旧点であり、canonical source ではない。
- RAG index は canonical data から再生成可能な derived index として扱う。
- CLI Agent は LangGraph node から外部 process として起動する。
- Agent 間の長期疎通は message bus と canonical state に残す。
- Graph 内の短期 state と、RAG の長期 memory を混ぜない。

## Architecture

```text
Task / Event / Approval JSON
  -> LangGraph Control Graph
    -> Dispatch Contract Node
    -> Context Assembly Node
      -> LangChain Retrievers
      -> Project RAG Index
    -> Agent Runner Contract Node
      -> Codex CLI / Claude Code / AntigravityCLI
    -> Outbox Validation Node
    -> Policy Check Node
    -> Git Node
    -> Review / QA / Approval Node
  -> Canonical Event Log
  -> Board / Discord Projection
```

## LangGraph の役割

LangGraph は Control Plane の状態遷移を明示的に扱う。

```text
START
  -> load_task
  -> classify_risk
  -> build_dispatch_request
  -> handoff_to_agent_dispatcher
  -> receive_dispatch_decision
  -> acquire_locks
  -> assemble_context
  -> run_agent
  -> validate_outbox
  -> policy_check
  -> persist_events
  -> maybe_commit_push
  -> maybe_review
  -> maybe_approval
  -> release_locks
  -> END
```

### Graph State

```json
{
  "thread_id": "TASK-0001:RUN-0001",
  "task_id": "TASK-0001",
  "run_id": "RUN-0001",
  "schedule_mode": "active_work",
  "persona": "implementer",
  "dispatch_request": {
    "eligible_agents": ["codex", "claude"],
    "persona": "implementer",
    "model_class": "coding"
  },
  "dispatch_decision": {
    "selected_agent": "codex",
    "runner_mode": "persistent_terminal_session"
  },
  "model_class": "coding",
  "risk_level": "medium",
  "capabilities": ["filesystem.read", "filesystem.write", "git.commit", "git.push"],
  "locks": ["repo:path:src/**"],
  "retrieval_plan": {
    "collections": ["project_rules", "task_history", "code_index"],
    "filters": {
      "project_id": "example-app",
      "task_id": "TASK-0001"
    }
  },
  "context_bundle_path": ".kairon/runs/RUN-0001/context.md",
  "outbox_path": ".kairon/runs/RUN-0001/outbox.json",
  "approval_requests": []
}
```

## Checkpoint / Store

LangGraph checkpoint は run の途中復旧、time travel、human-in-the-loop のために使う。
本番では SQLite / Postgres / Redis / MongoDB などの永続 store を使う。
MVP では SQLite checkpoint を優先する。

```text
.kairon/runtime/
  langgraph/
    checkpoints.sqlite
    store.sqlite
```

checkpoint に secret、巨大ログ、全文 diff を入れない。
それらは run artifact として保存し、checkpoint には path と hash だけを持たせる。

## LangChain の役割

LangChain は次の用途に限定して使う。

- document loader
- text splitter
- embedding / vector store adapter
- retriever composition
- reranker / compressor
- tool wrapper
- structured output parser

CLI Agent の中心推論を LangChain Agent に置き換えない。
外部 CLI Agent を `Runnable` 相当の adapter として扱い、入出力契約を `outbox.json` に固定する。

## RAG / Project Memory

RAG は Agent 間疎通と長期運用の安定性を上げるために導入する。
主目的は「必要な project context だけを各 job に渡すこと」であり、canonical data の代替ではない。

### Collections

| Collection | 内容 | 更新タイミング |
| --- | --- | --- |
| project_rules | AGENTS.md / CLAUDE.md / GEMINI.md / Kairon rules | docking 時、rule 更新時 |
| task_state | task.json / approvals / current board state | task 更新時 |
| task_history | 完了 task、run outcome、review result | run 完了時 |
| code_index | symbol map、file summary、public API、test map | commit 後、maintenance |
| decisions | approval decision、architecture decision | decision 発生時 |
| incidents | failed run、rollback、policy violation | incident 発生時 |
| external_docs | 公式docs、調査結果、ライブラリ仕様 | researcher job |

### Retrieval Strategy

```text
query intent
  -> collection routing
  -> metadata filter
  -> hybrid search
  -> rerank
  -> context compression
  -> context bundle
```

metadata filter を必須にする。
すべての検索を単一 vector store に投げると、task と無関係な過去情報が混ざる。

```json
{
  "retrieval": {
    "default_top_k": 8,
    "max_context_chars": 24000,
    "collections": {
      "project_rules": { "top_k": 6, "required": true },
      "task_history": { "top_k": 5, "required": false },
      "code_index": { "top_k": 10, "required": false },
      "external_docs": { "top_k": 5, "required": false }
    },
    "filters": ["project_id", "task_id", "resource", "persona", "risk_level"],
    "rerank": true,
    "compress": true
  }
}
```

### Index Storage

MVP は local-first にする。

```text
.kairon/rag/
  manifest.json
  documents/
  vector/
  bm25/
  graph/
```

ここでいう API コストは Discord や CLI Agent の subscription usage ではなく、外部 embedding provider を使う場合の追加 API 課金と project data 送信リスクを指す。
Kairon MVP は subscription CLI の範囲内で運用するため、外部 embedding API を前提にしない。
最初は local embedding を標準にし、必要になった場合だけ provider embedding に切り替えられるよう `embedding_profile` で抽象化する。

```json
{
  "embedding_profiles": {
    "local_default": {
      "provider": "local",
      "model": "bge-m3-or-compatible",
      "dims": null
    },
    "provider_high_quality": {
      "provider": "configured_provider",
      "model": "configured_embedding_model",
      "dims": null
    }
  }
}
```

## Context Bundle

Agent に渡す context は LangChain retriever の結果をそのまま流さない。
Control Plane が context bundle を生成する。

```text
runs/RUN-0001/context.md
  1. task objective
  2. acceptance criteria
  3. active constraints
  4. relevant rules
  5. relevant files
  6. prior decisions
  7. related failures
  8. output contract
```

context bundle には出典を持たせる。

```json
{
  "source_id": "project_rules:AGENTS.md#sha256:...",
  "path": "AGENTS.md",
  "reason": "repo write policy",
  "confidence": 0.92
}
```

## Multi-Agent Graph

MVP では supervisor graph を採用する。
Agent 同士の自由会話ではなく、handoff と message bus で制御する。

```text
planner
  -> implementer
    -> reviewer
      -> qa
        -> approval_or_done
```

別 Agent へ渡す時は LangGraph state に直接長文会話を載せず、handoff message を canonical message bus に書く。
次 Agent は RAG / message bus / task state から context bundle を再構成する。

## Dispatch Contract

Dispatch Contract は hard rule、RAG-assisted context fit、scoring に必要な情報を Agent Dispatcher に渡す。
Control Plane は選択そのものを行わない。

### Hard Rule

- persona が許可されていない Agent には渡さない。
- write job は lock を取得できない場合に開始しない。
- protected resource に触る job は approval がない限り開始しない。
- schedule mode で禁止された job type は開始しない。
- provider quota / local budget を超える Agent には渡さない。

### RAG-Assisted Context Fit

Context Builder は task と resource に対して、過去の成功 / 失敗 / 関連 decision を検索する。
Agent Dispatcher は、単にモデル性能だけでなく、その Agent が過去に同種 task で成功したかを scoring に含める。

### Scoring

```text
score =
  persona_fit
  + model_fit
  + context_fit
  + recent_success
  + cost_efficiency
  + schedule_fit
  - current_queue_pressure
  - recent_failure_penalty
  - risk_penalty
```

## dispatch.json

```json
{
  "default_strategy": "langgraph_supervisor",
  "context_strategy": "rag_context_bundle",
  "personas": {
    "planner": {
      "preferred_agents": ["claude", "codex", "gemini"],
      "model_class": "reasoning",
      "max_parallel": 1
    },
    "implementer": {
      "preferred_agents": ["codex", "claude"],
      "model_class": "coding",
      "max_parallel": 2
    },
    "reviewer": {
      "preferred_agents": ["claude", "codex", "gemini"],
      "model_class": "review",
      "max_parallel": 2
    },
    "qa": {
      "preferred_agents": ["gemini", "codex", "claude"],
      "model_class": "fast_or_large_context",
      "max_parallel": 2
    },
    "researcher": {
      "preferred_agents": ["gemini", "claude"],
      "model_class": "research",
      "max_parallel": 1
    },
    "maintainer": {
      "preferred_agents": ["codex", "claude"],
      "model_class": "coding",
      "max_parallel": 1
    }
  },
  "fallbacks": {
    "on_agent_unavailable": "next_preferred_agent",
    "on_quota_limited": "defer_or_lower_model",
    "on_policy_blocked": "approval.requested",
    "on_repeated_failure": "handoff_to_reviewer"
  }
}
```

## Model Profiles

Model 名を task に直接埋め込まない。
task は `model_class` を要求し、Control Plane が実 Agent 設定に解決する。

```json
{
  "model_profiles": {
    "reasoning": {
      "quality": "high",
      "latency": "medium",
      "use_for": ["planning", "architecture", "risk_analysis"]
    },
    "coding": {
      "quality": "high",
      "latency": "medium",
      "use_for": ["implementation", "refactor", "tests"]
    },
    "review": {
      "quality": "high",
      "latency": "medium",
      "use_for": ["diff_review", "security_review", "regression_review"]
    },
    "fast_or_large_context": {
      "quality": "medium",
      "latency": "low",
      "use_for": ["log_scan", "test_generation", "wide_search"]
    },
    "research": {
      "quality": "medium",
      "latency": "medium",
      "use_for": ["web_research", "library_comparison", "spec_reading"]
    }
  }
}
```

## agents.json

```json
{
  "agents": {
    "codex": {
      "enabled": true,
      "adapter": "codex_cli",
      "command": "codex",
      "node_type": "external_cli",
      "supports": ["workspace_write", "git", "mcp", "skills"],
      "rule_files": ["AGENTS.md", ".kairon/rules/codex/AGENTS.md"],
      "default_personas": ["implementer", "reviewer", "maintainer"]
    },
    "claude": {
      "enabled": true,
      "adapter": "claude_code",
      "command": "claude",
      "node_type": "external_cli",
      "supports": ["workspace_write", "git", "mcp", "skills"],
      "rule_files": ["CLAUDE.md", ".kairon/rules/claude/CLAUDE.md"],
      "default_personas": ["planner", "implementer", "reviewer"]
    },
    "gemini": {
      "enabled": true,
      "adapter": "antigravity_cli",
      "command": "agy",
      "node_type": "external_cli",
      "supports": ["read", "write", "large_context"],
      "rule_files": ["GEMINI.md", ".kairon/rules/gemini/GEMINI.md"],
      "default_personas": ["qa", "researcher", "reviewer"]
    }
  }
}
```

## Master Rules

Project root の既存 rule を尊重し、Kairon 用の補助 rule は `.kairon/rules/{agent}/` に分離する。
初回ドッキング時に既存 rule を壊さず、必要なら追記案を approval に回す。

### Common Rule Contract

全 Agent に共通で注入する内容。

- canonical state の場所。
- context bundle の場所。
- outbox schema。
- direct write 禁止領域。
- commit / push policy。
- approval が必要な操作。
- lock / lease の扱い。
- schedule mode ごとの制約。
- RAG context の出典を尊重すること。
- secrets を出力しないこと。

### Agent Specific Rule

Agent ごとの差分。

- CLI の非対話実行方法。
- sandbox / approval option。
- MCP の使い方。
- Skills の使い方。
- output formatting。
- known limitations。

## Skills / MCP Design

Skills と MCP は project capability として扱う。
Agent に常時すべてを渡さず、job capability に応じて許可する。

```json
{
  "capabilities": {
    "filesystem.read": { "default": true },
    "filesystem.write": { "requires_lock": true },
    "git.commit": { "requires_policy": "auto_commit" },
    "git.push": { "requires_policy": "auto_push" },
    "web.search": { "requires_capability": "research" },
    "browser.test": { "requires_capability": "frontend_qa" },
    "rag.query": { "default": true, "requires_filters": true },
    "rag.index.write": { "requires_policy": "index_update" },
    "mcp.github": { "requires_approval_for": ["merge", "deploy"] },
    "secrets.read": { "default": false }
  }
}
```

MCP は connector ごとに trust level を付ける。

| Trust Level | 例 | 扱い |
| --- | --- | --- |
| local_read | filesystem read, repo index, RAG query | 原則許可 |
| local_write | filesystem write, browser test, RAG index update | lock / policy 必須 |
| external_read | docs, GitHub read | research job で許可 |
| external_write | GitHub write, Discord post | policy 必須 |
| privileged | deploy, secret, billing | approval 必須 |

## Run Lifecycle

```text
task.ready
  -> create LangGraph thread
  -> create dispatch request
  -> receive dispatch decision
  -> acquire lock
  -> create worktree / branch
  -> retrieve project memory
  -> compose context bundle + rules
  -> launch CLI Agent
  -> collect outbox
  -> validate outbox
  -> run policy checks
  -> commit / push if allowed
  -> update RAG index
  -> emit messages / approvals
  -> release lock
```

## Escalation Before Agent Launch

Agent に渡す前に escalation する条件。

- task objective が曖昧で acceptance がない。
- protected resource への write が必要。
- deploy / merge / secret / billing / credential に触る。
- cleanup が source / config / migration を移動または削除する。
- rollback path が定義できない。
- Agent が必要 tool を持っていない。
- RAG retrieval が矛盾した根拠を返し、Control Plane が解決できない。

## MVP Scope

- LangGraph control graph を持つ。
- SQLite checkpoint / store を使える。
- LangChain retriever で project memory を検索できる。
- RAG context bundle を生成できる。
- dispatch.json / agents.json / policies.json / rag.json を読める。
- task から dispatch request を生成できる。
- model_class を実 Agent 設定に解決できる。
- Agent rules を合成して CLI job に渡せる。
- outbox を検証して canonical state に反映できる。
- Skills / MCP を job capability として制限できる。
