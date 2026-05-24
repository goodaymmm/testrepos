# Kairon Implementation Skeleton v0

## 目的

この文書は、既存の architecture / workflow / protocol 仕様を、MVP 実装に必要な module 構成、依存方向、起動順、内部 API に落とす。

ここでは business logic の詳細を再定義しない。
各 component の責務を実装単位に切り分け、最初に作るべき骨格を固定する。

## 実装方針

MVP は TypeScript / Node.js を推奨実装とする。

理由。

- Codex / Claude / Gemini CLI は command process として扱いやすい。
- Discord Gateway と相性がよい。
- JSON / JSONL / MD file state を扱いやすい。
- Windows の個人PC常駐運用から始めやすい。

ただし Kairon の仕様は TypeScript 固有にしない。
CLI、process、file state、event schema の境界が守られていれば、将来 Python / Rust / Go に component を差し替えられる。

## MVP Package Layout

```text
project-root/
  package.json
  tsconfig.json
  src/
    cli/
      main.ts
      commands/
        init.ts
        doctor.ts
        start.ts
        stop.ts
        status.ts
        task-create.ts
        task-run.ts
        leave.ts
        maintenance-run.ts
    core/
      config/
        load-config.ts
        validate-config.ts
        defaults.ts
      fs/
        json-file.ts
        jsonl-file.ts
        lock-file.ts
        paths.ts
      ids/
        counter.ts
      schema/
        types.ts
        validators.ts
      events/
        event-log.ts
        event-types.ts
    runtime/
      runtime-host.ts
      runtime-lock.ts
      service-registry.ts
      schedule-engine.ts
      status.ts
    queue/
      work-queue.ts
      command-inbox.ts
      queue-worker.ts
    state/
      state-applier.ts
      materializers.ts
      state-lock.ts
    agents/
      dispatcher.ts
      context-builder.ts
      runner.ts
      session-host.ts
      adapters/
        codex.ts
        claude.ts
        gemini.ts
    git/
      workspace-manager.ts
      diff-snapshot.ts
      transactions.ts
      conflict-detector.ts
    review/
      review-loop-manager.ts
      quality-gate.ts
      reviewer-selection.ts
    discord/
      gateway.ts
      commands.ts
      approval-message.ts
      interactions.ts
      idempotency.ts
    maintenance/
      handoff.ts
      cleanup-proposals.ts
      daily-report.ts
    rag/
      memory-service.ts
      indexer-placeholder.ts
```

MVP で最初に実装するのは `src/cli`、`src/core`、`src/runtime`、`src/state`、`src/queue` の最小骨格である。
Agent / Git / Discord は interface を先に固定し、段階的に実装する。

## Dependency Direction

依存方向は一方向にする。

```text
cli
  -> runtime
  -> queue
  -> state
  -> agents / git / discord / maintenance
  -> core
```

禁止する依存。

- `core` から runtime / agents / discord を呼ばない。
- `State Applier` から Agent Runner を呼ばない。
- `Discord Gateway` から State Store を直接更新しない。
- `Agent Runner` から Git commit / push を直接実行しない。
- `Control Protocol` を実行スイッチャーにしない。

## Component Interfaces

### Runtime Host

```ts
interface RuntimeHost {
  start(options: RuntimeStartOptions): Promise<RuntimeStatus>;
  stop(options: RuntimeStopOptions): Promise<void>;
  status(): Promise<RuntimeStatus>;
}
```

責務。

- runtime lock を取得する。
- config を読み込む。
- schedule mode を判定する。
- service registry を起動する。
- Queue Worker / Agent Session Host / Discord Gateway を起動する。
- stop 時に session scratch / handoff を flush する。

やらないこと。

- Agent を選ばない。
- Git commit / push をしない。
- approval decision を直接反映しない。

### Service Registry

```ts
interface RuntimeService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}
```

MVP service。

- `queue-worker`
- `agent-session-host`
- `discord-gateway`
- `rag-placeholder`

Board Server は MVP では disabled service として扱う。

### Work Queue

```ts
interface WorkQueue {
  enqueue(item: QueueItem): Promise<void>;
  claim(workerId: string): Promise<QueueItem | null>;
  complete(itemId: string, result: QueueResult): Promise<void>;
  fail(itemId: string, error: QueueError): Promise<void>;
  list(filter?: QueueFilter): Promise<QueueItem[]>;
}
```

Queue item type。

- `agent.run`
- `review.run`
- `git.transaction`
- `approval.command`
- `schedule.command`
- `maintenance.run`

MVP は `.kairon/state/queue.json` を単一 writer lock 下で更新する。

### Command Inbox

Discord や CLI から来た lightweight command は command inbox に入れる。

```ts
interface CommandInbox {
  enqueue(command: InternalCommand): Promise<void>;
  claim(workerId: string): Promise<InternalCommand | null>;
}
```

Command type。

- `approval.decide`
- `approval.snooze`
- `schedule.close_active_work`

Command は canonical event ではない。
State Applier が policy check 後に event 化する。

### State Applier

```ts
interface StateApplier {
  applyOutbox(path: string): Promise<ApplyResult>;
  applyCommand(command: InternalCommand): Promise<ApplyResult>;
  appendEvent(event: KaironEvent): Promise<void>;
}
```

責務。

- schema validation
- policy validation
- state lock
- append-only event log
- materialized state update
- queue update

やらないこと。

- Agent process を起動しない。
- Discord message を送らない。
- Git command を実行しない。

### Agent Dispatcher

```ts
interface AgentDispatcher {
  decide(request: DispatchRequest): Promise<DispatchDecision>;
}
```

入力。

- task
- persona
- model_class
- required capabilities
- schedule mode
- available sessions
- policy

出力。

- agent
- persona
- runner mode
- session scope
- reason

Dispatcher は command line を組み立てない。

### Context Builder

```ts
interface ContextBuilder {
  buildRunContext(request: RunContextRequest): Promise<ContextBundle>;
  buildDailyBootstrap(agent: AgentId, date: string): Promise<ContextBundle>;
}
```

入力 source。

- task.json
- messages JSONL
- review result
- git diff snapshot
- run artifact
- same-day scratch
- project rules
- RAG retrieval

Context Builder は human-friendly summary を canonical data に書き足さない。
UI 表示や Discord message 用の投影は projection 側で行う。

### Agent Session Host

```ts
interface AgentSessionHost {
  openSession(agent: AgentId, date: string): Promise<SessionId>;
  attachSession(agent: AgentId, date: string): Promise<SessionId | null>;
  sendJob(sessionId: SessionId, job: AgentJobEnvelope): Promise<RunHandle>;
  closeSession(sessionId: SessionId): Promise<void>;
}
```

MVP では persistent terminal session を標準にする。
one-shot CLI は dry run / recovery / fallback のみ。

### Agent Runner

```ts
interface AgentRunner {
  run(decision: DispatchDecision, context: ContextBundle): Promise<RunResult>;
}
```

責務。

- Session Host に job envelope を渡す。
- stdout / stderr を `runs/RUN-xxxx` に保存する。
- outbox を検出する。
- outbox がない場合は failure outbox を作る。

やらないこと。

- canonical state に直接書かない。
- Git commit / push を実行しない。

### Git Workspace Manager

```ts
interface GitWorkspaceManager {
  allocate(task: Task, agent: AgentId): Promise<GitWorkspace>;
  snapshotDiff(runId: RunId): Promise<DiffSnapshot>;
  startTransaction(request: GitTransactionRequest): Promise<GitTransactionResult>;
  detectConflicts(request: ConflictCheckRequest): Promise<ConflictCheckResult>;
}
```

Git operation は transaction として event 化する。
Review Gate 通過前に commit / push しない。

### Review Loop Manager

```ts
interface ReviewLoopManager {
  start(request: ReviewLoopRequest): Promise<ReviewLoopState>;
  evaluate(result: ReviewResult): Promise<ReviewGateDecision>;
  nextAction(state: ReviewLoopState): Promise<ReviewNextAction>;
}
```

責務。

- code-producing job 判定
- reviewer selection
- quality gate
- fix job 作成
- max_iterations escalation

### Discord Gateway

```ts
interface DiscordGatewayService extends RuntimeService {
  postApproval(approval: Approval): Promise<NotificationRecord>;
  updateNotification(record: NotificationRecord): Promise<void>;
}
```

Gateway は interaction を command に変換する。
State Store を直接変更しない。

## CLI Command Mapping

| CLI | Primary module | 主な処理 |
| --- | --- | --- |
| `kairon init` | `cli/commands/init.ts` | `.kairon/` 生成、config default、rules生成 |
| `kairon doctor` | `cli/commands/doctor.ts` | config / git / CLI / Discord env 検査 |
| `kairon start` | `runtime/runtime-host.ts` | runtime lock、services起動、daily bootstrap |
| `kairon stop` | `runtime/runtime-host.ts` | dispatch停止、scratch flush、session close |
| `kairon status` | `runtime/status.ts` | runtime / queue / session / approval 状態表示 |
| `kairon task create` | `state/state-applier.ts` | task.created event 作成 |
| `kairon task run` | `queue/work-queue.ts` | agent.run item を queue 投入 |
| `kairon leave` | `queue/command-inbox.ts` | schedule.close_active_work command 投入 |
| `kairon maintenance run` | `maintenance/handoff.ts` | daily report / handoff / cleanup proposal |

CLI はなるべく thin wrapper にする。
実際の state mutation は State Applier / Queue Worker 側に寄せる。

## Runtime Startup Sequence

```text
kairon start
  -> load config
  -> validate config
  -> acquire runtime lock
  -> initialize runtime directories
  -> recover interrupted runs
  -> start service registry
  -> start queue worker
  -> start agent session host
  -> open or attach Codex session
  -> open or attach Claude session
  -> open or attach Gemini session
  -> inject daily bootstrap context
  -> start Discord Gateway if enabled
  -> write runtime status
```

`kairon start` は MVP では foreground process でよい。
OS service / scheduled task 化は後続 phase とする。

## Queue Worker Loop

```text
while runtime active
  -> read schedule mode
  -> apply schedule override
  -> claim queue item
  -> route by item.type
    -> agent.run: dispatcher -> context builder -> runner -> state applier
    -> review.run: review loop manager -> state applier
    -> git.transaction: git workspace manager -> state applier
    -> approval.command: state applier
    -> schedule.command: state applier
    -> maintenance.run: maintenance service
  -> mark complete or fail
```

Queue Worker は長時間処理を直接抱えすぎない。
Agent run の stream は Agent Runner に任せる。

## Minimal End-to-End Slice

最初の実装 slice は次にする。

```text
kairon init
  -> .kairon config / dirs generated
kairon start
  -> runtime lock
  -> queue worker running
  -> sessions metadata initialized
kairon task create
  -> task.created event
  -> task.json materialized
kairon task run TASK-0001
  -> queue item
  -> dispatch decision
  -> context bundle
  -> synthetic or real agent runner
  -> outbox
  -> State Applier
```

ただし、MVP 本番では Claude / Gemini も実 CLI session を使う。
最初の local unit test では process を起動しない fake runner を使ってよいが、MVP acceptance では実 CLI session を必須にする。

## Testing Strategy

コード作成時は review 必須である。
Kairon 自体の実装も同じ方針に従う。

### Unit Tests

- config default / validation
- path resolution
- JSON / JSONL read-write
- lock acquire / release
- event append
- materializer
- queue claim / complete
- id counter
- approval decision command validation

### Integration Tests

- `kairon init` creates expected tree
- `task.created` event materializes task
- command inbox `schedule.close_active_work` creates schedule override
- outbox apply creates events / messages / approvals
- diff snapshot blocks commit before review gate
- duplicate Discord interaction is idempotent

### Manual Acceptance

- `kairon doctor`
- `kairon start`
- 3 CLI availability check
- sample task run through real Codex / Claude / Gemini session
- review loop
- Discord approval
- daily handoff

## Review Requirement For Kairon Code

Kairon 本体の code-producing change も review gate を通す。

推奨。

- 実装: Codex または Claude
- Review: Claude + Codex
- Claude Opus 実装時: Codex review via `codex-plugin-cc`
- Gemini: Discord / Google ecosystem / multimodal / large context で追加 review

Review Gate を満たすまで commit しない。

## Initial Implementation Order

1. Project scaffold
2. `.kairon/` directory and config defaults
3. schema types and validators
4. JSON / JSONL / lock utilities
5. event log and materializers
6. queue and command inbox
7. runtime lock and status
8. CLI command thin wrappers
9. schedule engine and `kairon leave`
10. Agent session host interface
11. Codex / Claude / Gemini adapter shell
12. Git workspace interface and diff snapshot
13. Review loop manager skeleton
14. Discord gateway skeleton
15. daily handoff skeleton

この順序なら、早い段階で file-based state と CLI の往復を検証できる。
CLI Agent の制御はその後に接続する。

## Implementation Done Criteria

- `npm test` または同等の test command が通る。
- `kairon init` が `.kairon/` を生成する。
- `kairon doctor` が config / git / CLI / Discord env を検査する。
- `kairon start` が runtime lock と queue worker を開始する。
- `kairon status` が runtime state を表示する。
- `kairon leave` が schedule override を作る。
- `task.created`、`approval.decided`、`active_work.closed` が event log に残る。
- State Applier の二重適用が防止される。
- code-producing implementation は review gate を通過する。
