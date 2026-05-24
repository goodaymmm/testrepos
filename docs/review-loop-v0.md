# Kairon Review Loop v0

## 目的

Kairon ではコード作成・コード変更を伴う run はレビュー必須とする。
実装 Agent が作成した変更は、設定された review quality gate を満たすまで feedback loop を繰り返す。

## 基本方針

- code-producing job は review を通過するまで done にしない。
- commit / push は review gate 通過後にだけ許可する。
- Merge / Deploy は review gate 通過後でも approval 必須。
- 推奨 review pair は Claude + Codex。
- Claude Code Opus が実装した場合、Codex は `codex-plugin-cc` 経由でレビューする。
- Gemini は Google ecosystem、multimodal、large-context QA / research の強みがある task で review / QA に参加する。

## Review Loop

```text
implementation.completed
  -> review.requested
  -> reviewer runs
  -> review.result
  -> quality gate
    -> pass: review.approved
    -> fail: changes.requested
      -> implementer fix
      -> review.requested
```

最大反復回数に達しても gate を満たさない場合は approval queue に escalated review として積む。

## Code-Producing Job

次のいずれかに該当する job は code-producing として扱う。

- source code を作成または変更する。
- test code を作成または変更する。
- build / lint / test / runtime config を変更する。
- migration、schema、workflow、CI を変更する。
- executable script を作成または変更する。

Markdown の調査メモや daily report のみを作る job は code-producing ではない。

## Reviewer Selection

```text
if implementer == claude and model_class == opus:
  reviewers = [codex]
  integration = codex-plugin-cc
elif implementer == codex:
  reviewers = [claude]
elif implementer == gemini:
  reviewers = [codex, claude]
else:
  reviewers = [codex, claude]

if task.tags contains google_ecosystem or multimodal:
  reviewers += [gemini]
```

推奨設定は Claude + Codex の 2 review line。
Gemini は常時 reviewer にするのではなく、適性が高い task で参加させる。

## Gemini Role

Gemini は次の task で優先する。

| Trigger | Gemini の役割 |
| --- | --- |
| Google ecosystem | Firebase、GCP、Android、Chrome、Workspace、Google API 関連の調査 / QA |
| Multimodal | screenshot、UI画像、PDF、動画、図表を含む review |
| Large context QA | 長い log、広い test output、複数文書の横断確認 |
| Research | 仕様比較、公式 docs 確認、互換性調査 |

Gemini が code implementation を担当する場合も、review gate は必須とする。

## Quality Gate

品質水準は user が事前設定できる。
MVP の推奨値は次の通り。

```json
{
  "review": {
    "required_for_code": true,
    "recommended_reviewers": ["claude", "codex"],
    "max_iterations": 3,
    "minimum_score": 0.85,
    "block_on_severity": ["critical", "high"],
    "allow_medium_findings": 0,
    "require_tests_for_code": true,
    "require_secret_scan": true,
    "require_reviewer_agreement": true,
    "escalate_on_max_iterations": true
  }
}
```

`minimum_score` は reviewer の structured output から算出する。
score の内訳は `correctness`、`safety`、`test_coverage`、`maintainability`、`policy_compliance` とする。

## Review Result Schema

```json
{
  "schema_version": "0.1",
  "review_id": "REV-0001",
  "task_id": "TASK-0001",
  "run_id": "RUN-0004",
  "reviewer": "codex",
  "target": {
    "branch": "auto/TASK-0001/claude",
    "commit_sha": "abc1234",
    "diff_path": ".kairon/runs/RUN-0004/artifacts/diff.patch"
  },
  "status": "changes_requested",
  "score": {
    "overall": 0.74,
    "correctness": 0.8,
    "safety": 0.9,
    "test_coverage": 0.5,
    "maintainability": 0.75,
    "policy_compliance": 0.9
  },
  "findings": [
    {
      "severity": "medium",
      "file": "src/example.ts",
      "line": 42,
      "body": "Missing regression test for rejected approval."
    }
  ],
  "required_changes": [
    "Add regression test for rejected approval."
  ],
  "created_at": "2026-05-24T12:00:00+09:00"
}
```

## Feedback Loop State

```json
{
  "schema_version": "0.1",
  "task_id": "TASK-0001",
  "loop_id": "RLOOP-0001",
  "status": "running",
  "iteration": 2,
  "max_iterations": 3,
  "implementer": "claude",
  "reviewers": ["codex"],
  "integration": "codex-plugin-cc",
  "quality_gate": ".kairon/config/policies.json#review",
  "history": [
    { "run_id": "RUN-0001", "type": "implementation" },
    { "run_id": "RUN-0002", "type": "review" },
    { "run_id": "RUN-0003", "type": "fix" },
    { "run_id": "RUN-0004", "type": "review" }
  ]
}
```

## Events

- `review.requested`
- `review.completed`
- `review.approved`
- `review.changes_requested`
- `review.loop.started`
- `review.loop.iterated`
- `review.loop.failed`
- `review.loop.escalated`

## Done Criteria

- code-producing outbox が review queue に流れる。
- reviewer selection が policy から決まる。
- Claude Opus 実装時に Codex review が選ばれる。
- review result が structured JSON として保存される。
- quality gate を満たさない場合に fix job が作られる。
- max iteration 超過時に approval queue へ escalated review が作られる。
