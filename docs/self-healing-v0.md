# Bounded Self-Healing Runbooks v0

## 目的

Kaironは、低riskで可逆かつ事前・事後検証できる障害だけをtyped internal actionで処理する。
既定値は`notify_only`であり、設定を変更しない限りself-healing actionは実行されない。

## 安全境界

- arbitrary shell、任意command、任意pathはrunbookへ登録できない。
- Git merge、deploy、release、secret、billing、backup restore、project sourceは変更しない。
- actionごとに`max_attempts`、`cooldown_seconds`、`time_budget_seconds`を必須とする。
- 実行前にtargetとstate digestを固定し、driftがあれば`suspended`とする。
- daemon restart時に`running`だったrunは再実行せず、operator approvalへ送る。
- attempt budget超過、cooldown中、ambiguous state、policy risk threshold以上はapprovalを要求する。
- BoardはIncident timelineに投影された`planned / running / completed / suspended / failed`だけをread-only表示する。

## Allowlist

| Runbook ID | 動作 |
| --- | --- |
| `workflow_checkpoint_index_rebuild` | canonical fileが正常な場合だけderived SQLite checkpoint indexを再構築する |
| `rag_index_verified_rebuild` | candidate integrityとquery比較が通る場合だけderived RAG indexを置換する |
| `discord_notification_retry` | 初回送信失敗したwatchdog通知へ1回分のretry authorizationだけを付与する |
| `stale_runtime_lock_recovery_plan` | lockを消さず、operator確認用のlocal recovery planを作る |
| `read_only_helper_health_plan` | Board / Discord HTTP helperを起動せず、local health planを作る |

Discord retryはauthorization後の送信が再度失敗すると`attempts=2`となり、それ以上は自動再送されない。

## 設定

`.kairon/config/runtime.json`の`self_healing`を使用する。

```json
{
  "self_healing": {
    "mode": "notify_only",
    "approval_threshold": "medium",
    "actions": {
      "discord_notification_retry": {
        "enabled": true,
        "max_attempts": 1,
        "cooldown_seconds": 300,
        "time_budget_seconds": 30
      }
    }
  }
}
```

`mode=bounded_auto`へ変更した場合だけ、runtime tickはallowlistから最大1 actionを処理する。

## CLI

```powershell
kairon recovery self-healing inspect workflow_checkpoint_index_rebuild
kairon recovery self-healing plan workflow_checkpoint_index_rebuild
kairon recovery self-healing list
kairon recovery self-healing run SHR-0123456789abcdef0123 `
  --confirm SHR-0123456789abcdef0123
kairon recovery self-healing tick
```

approvalが必要なrunは、承認後に`--approval-id`を追加する。

## Artifact

- Run: `.kairon/recovery/self-healing/SHR-*.json`
- Approval: `.kairon/approvals/APR-*.json`
- Incident: `.kairon/incidents/INC-*.json`
- Timeline: `.kairon/incidents/INC-*-timeline.jsonl`

Run artifactにはrunbook ID、target ID、source / before / after digest、idempotency key、attempt、policy snapshot、pre / post conditionを保存する。
token、raw environment、raw error、project source、stdout / stderrは保存しない。

## 判定

- `planned`: dry-run artifactが作成済み
- `running`: attemptを先に永続化してからinternal actionを実行中
- `completed`: postconditionがPASS
- `suspended`: drift、budget、cooldown、approval、restart interruptionで停止
- `failed`: actionまたはpostconditionが失敗

`suspended`または`failed`を自動的に成功扱いへ変更しない。
