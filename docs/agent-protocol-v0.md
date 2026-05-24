# Kairon Agent Protocol v0

## 目的

Kairon は 24 時間自律可能な Agent 群を前提にする。
Orchestrator は Agent を止めるための仕組みでも、Agent を選ぶスイッチャーでもない。
Orchestrator は Agent が迷わず安全に動くための制御プロトコルである。

この protocol の目的は次の 4 点に絞る。

1. 複数 Agent が同じプロジェクト状態を読めること。
2. 複数 Agent が競合せず、必要なら相互レビューできること。
3. Commit / Push までは条件付きで自動化できること。
4. Merge / Deploy / 高リスク操作は承認 Queue に集約できること。

## 基本方針

- Canonical source は JSON / JSONL / MD ファイルで管理する。
- Board UI は canonical data を projection して表示する。人間向け要約文を canonical data に追加しない。
- Agent は原則として canonical state を直接更新しない。Agent は run outbox に結果を書き、State Applier が検証して反映する。
- 各実装 Job は専用 Git worktree と専用 branch で実行する。
- Commit / Push は branch 制約と policy check を満たす場合に自動承認できる。
- Merge / Deploy は必ず escalation / approval を必要とする。

## ディレクトリ構造

```text
.kairon/
  config/
    schedule.json
    agents.json
    policies.json
    dispatch.json
    notifications.json
    rag.json
  events/
    2026-05-22.jsonl
  tasks/
    TASK-0001/
      task.json
      context.md
      artifacts/
  approvals/
    APR-0001.json
  messages/
    TASK-0001.jsonl
  runs/
    RUN-0001/
      run.json
      outbox.json
      stdout.log
      stderr.log
  locks/
    repo-file-src-app-tsx.json
  sessions/
    2026-05-24/
      codex/
        session.json
        context_manifest.json
        scratch.md
      claude/
      gemini/
  cleanup/
    proposals/
      2026-05-22.json
  reports/
    daily/
      2026-05-22.json
  tmp/
```

## Agent Persona

Agent には Job persona を付与する。persona は能力と判断範囲を狭めるための契約であり、Agent の人格設定ではない。

| Persona | 主責務 | 書き込み | 自動 commit/push |
| --- | --- | --- | --- |
| planner | task 分解、依存関係整理、次 action 作成 | state proposal のみ | 不可 |
| implementer | 承認済み task の実装 | worktree | 可 |
| reviewer | diff review、risk 指摘、merge 前確認 | review artifact | 不可 |
| qa | test 生成、test 実行、品質チェック | test / report / worktree | 条件付き可 |
| researcher | 調査、比較、根拠収集 | research artifact | 不可 |
| maintainer | cleanup 候補作成、構造整理、依存関係点検 | proposal / tmp | 条件付き可 |
| reporter | board / daily report 用 projection 作成 | report | 不可 |

## Schedule Mode

Schedule は固定ではなく設定可能にする。

```json
{
  "timezone": "Asia/Tokyo",
  "active_work_time": [{ "start": "07:00", "end": "18:00" }],
  "standby_work_time": [{ "start": "18:00", "end": "01:00" }],
  "maintenance_time": [{ "start": "01:00", "end": "07:00" }],
  "active_start_agenda": ["morning_review", "cleanup_triage", "approval_review"]
}
```

### Active Work Time

- Morning Review は独立 mode ではなく Active Work Time の先頭 agenda として扱う。
- approval queue、夜間 QA、cleanup proposals、当日 plan を表示する。
- 承認済み task は implementer / qa / reviewer が通常稼働する。

### Standby Work Time

- 承認済み Queue を中心に非常勤的に処理する。
- 新規高リスク判断は approval queue に積む。
- 実装中 task が完了した場合は記録、commit、push、review request まで進める。

### Maintenance Time

- QA、調査、設計案、テスト生成、差分レビュー、承認待ち作成を主務にする。
- cleanup は直接削除せず `cleanup/proposals/YYYY-MM-DD.json` にリスト化する。
- tmp 移行は Morning Review の `cleanup_triage` task として扱う。
- maintenance 中の write 権限は Job capability で個別付与する。

## Task Schema

```json
{
  "id": "TASK-0001",
  "title": "Add approval queue board",
  "status": "ready",
  "priority": 50,
  "risk_level": "medium",
  "owner_agent": null,
  "personas_allowed": ["planner", "implementer", "qa", "reviewer"],
  "objective": {
    "goal": "承認待ち item を board 上で確認し、approve/reject できる",
    "non_goals": ["deploy 自動化"]
  },
  "resources": [
    "repo:path:src/**",
    "state:approvals"
  ],
  "dependencies": [],
  "acceptance": [
    "approval item が status 別に表示される",
    "approve/reject decision が event log に記録される"
  ],
  "git": {
    "branch": null,
    "commits": []
  },
  "created_at": "2026-05-22T07:00:00+09:00",
  "updated_at": "2026-05-22T07:00:00+09:00",
  "version": 1
}
```

## Message Schema

Agent 間の疎通は message bus を介する。直接会話できる Agent 同士も、最終的な成果と判断は message に残す。

```json
{
  "id": "MSG-0001",
  "task_id": "TASK-0001",
  "run_id": "RUN-0001",
  "from": "codex.implementer",
  "to": ["claude.reviewer", "gemini.qa"],
  "type": "review.request",
  "payload": {
    "branch": "auto/TASK-0001/codex",
    "commit_sha": "abc1234",
    "focus": ["regression", "security", "tests"]
  },
  "created_at": "2026-05-22T10:15:00+09:00"
}
```

### Message Types

- `task.propose`
- `task.claim`
- `task.update`
- `research.finding`
- `implementation.result`
- `review.request`
- `review.result`
- `qa.result`
- `approval.requested`
- `approval.decided`
- `git.commit`
- `git.push`
- `cleanup.proposal`
- `handoff`
- `schedule.transition`

## Run Output Contract

Agent は run 完了時に `runs/RUN-xxxx/outbox.json` を出力する。

```json
{
  "run_id": "RUN-0001",
  "task_id": "TASK-0001",
  "agent": "codex",
  "persona": "implementer",
  "status": "completed",
  "events": [
    {
      "type": "implementation.result",
      "payload": {
        "changed_files": ["src/approval-board.tsx"],
        "tests": [{ "command": "npm test", "status": "passed" }]
      }
    }
  ],
  "messages": [
    {
      "type": "review.request",
      "to": ["claude.reviewer", "gemini.qa"],
      "payload": {
        "focus": ["behavior", "test coverage"]
      }
    }
  ],
  "approvals": [],
  "git": {
    "branch": "auto/TASK-0001/codex",
    "commit_sha": "abc1234",
    "parent_sha": "def5678",
    "pushed": true,
    "rollback": {
      "preferred": "revert",
      "command": "git revert abc1234"
    }
  },
  "next_jobs": [
    {
      "persona": "reviewer",
      "agent_preference": "claude",
      "reason": "implementation completed"
    }
  ]
}
```

## Approval Schema

```json
{
  "id": "APR-0001",
  "task_id": "TASK-0001",
  "type": "merge",
  "status": "pending",
  "risk_level": "high",
  "requested_by": "claude.reviewer",
  "decision_required": ["approve", "reject", "request_changes"],
  "subject": {
    "branch": "auto/TASK-0001/codex",
    "commit_sha": "abc1234",
    "target": "main"
  },
  "checks": [
    { "name": "tests", "status": "passed" },
    { "name": "review", "status": "passed" }
  ],
  "created_at": "2026-05-22T17:30:00+09:00",
  "expires_at": null
}
```

## Lock / Lease

競合防止は lock/lease で扱う。

```json
{
  "resource": "repo:path:src/approval-board.tsx",
  "owner_run_id": "RUN-0001",
  "owner_agent": "codex.implementer",
  "task_id": "TASK-0001",
  "fencing_token": 42,
  "expires_at": "2026-05-22T10:45:00+09:00"
}
```

- write job は resource lock が必要。
- read-only job は lock 不要。
- 同一 file glob に対する implementer の同時 write は不可。
- reviewer / qa は同一 resource を read できる。
- lease 期限切れ後も fencing token が古い write は拒否する。

## Git Policy

Commit / Push は次の条件を満たす場合に自動承認できる。

- branch が `auto/*`, `codex/*`, `claude/*`, `gemini/*` のいずれか。
- protected branch へ直接 push しない。
- `.env`, secret, credential, billing, deploy key を変更しない。
- deletion / rename が policy threshold を超えない。
- lock を取得済み。
- run log に test / lint / review 結果を記録する。
- outbox に `commit_sha`, `parent_sha`, `branch`, `rollback` を記録する。

Merge / Deploy は常に approval 必須。

## Cleanup Policy

Maintenance Time では削除や大規模移動を直接行わない。

1. maintainer が cleanup proposal を作成する。
2. Morning Review の `cleanup_triage` で user または承認済み Agent が確認する。
3. 低リスクな generated file / cache / obsolete tmp のみ自動 tmp 移行できる。
4. source, config, migration, docs, test fixture の削除や移動は approval 必須。

## Mobile Approval

出先承認は複雑な AI app 連携や常時公開された Board UI を必須にしない。
個人運用の MVP では Discord を primary channel にする。

MVP では次の構成を優先する。

- approval 発生時に通知を送る。
- 通知は Discord message component を第一候補にする。
- user は Discord 上で approve / reject / request changes / snooze を選ぶ。
- 在宅時は Discord 通知から Board を開き、詳細を確認する。
- 外出時は Discord の簡易表示で判断する。
- スマートフォン向け Board は将来対応とする。
- decision は `approval.decided` event として記録する。

Discord connector は approval id、nonce、actor、decision、timestamp を検証する。
ChatGPT / Claude / Gemini app 連携は、まず通知と deeplink 補助として扱う。

詳細は `docs/discord-approval-v0.md` に分離する。

## MVP 成立条件

MVP は単一 Agent ではなく、複数 Agent 疎通を必須にする。

- Codex / Claude Code / Gemini CLI の adapter を持つ。
- 3 Agent が同じ task / message / approval / run schema を読み書きできる。
- Agent は直接会話できない場合も message bus で疎通できる。
- 1 task について planner -> implementer -> reviewer -> qa -> approval の流れを実行できる。
- 実装 job は専用 worktree / branch を使う。
- code-producing job は review gate を通過するまで done / commit / push に進まない。
- Commit / Push は review gate 通過後に自動、Merge / Deploy は approval に止まる。
- Discord と file-based projection で task、run、approval、review、cleanup proposal を確認できる。

## 関連仕様

- `docs/control-plane-v0.md`
- `docs/architecture-v0.md`
- `docs/workflow-v0.md`
- `docs/mvp-plan-v0.md`
- `docs/config-schema-v0.md`
- `docs/cli-commands-v0.md`
- `docs/session-host-v0.md`
- `docs/state-store-v0.md`
- `docs/review-loop-v0.md`
- `docs/git-workspace-v0.md`
- `docs/discord-gateway-v0.md`
- `docs/implementation-skeleton-v0.md`
- `docs/mvp-implementation-tasks-v0.md`
- `docs/technology-stack-v0.md`
- `docs/installed-architecture-v0.md`
- `docs/agent-runtime-v0.md`
- `docs/discord-approval-v0.md`
- `docs/project-docking-v0.md`
- `docs/rag-memory-v0.md`
- `docs/subscription-compliance-v0.md`
