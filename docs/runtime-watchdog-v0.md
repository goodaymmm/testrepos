# Runtime Watchdog v0

失敗したDiscord watchdog通知は、bounded self-healing authorization後だけ1回再送する。
詳細は`docs/self-healing-v0.md`を参照する。

<!-- kairon:runtime-watchdog -->

## 目的

Runtime Watchdogは、Kaironの継続運用中に発生する異常を同じ基準で検知し、operatorが追跡可能なalertへ変換する。Watchdogは観測・記録・通知だけを担当し、自動再起動、queue item変更、provider切替、Task Scheduler変更は行わない。

Discord deliveryはlocal alert policyで判定し、defer / aggregateされたtransitionもcanonical alertとIncidentへ保持する。詳細は`docs/alert-policy-v0.md`を参照する。

## CLI

```powershell
kairon watchdog check
kairon watchdog list
kairon watchdog list --status open
kairon watchdog show ALT-0001
kairon watchdog resolve ALT-0001 --reason "原因を確認し復旧済み"
```

- `check`: 現在のartifactを読み、ruleを評価してalert遷移を保存する。
- `list`: 保存済みalertを一覧表示する。`--status`は`open`、`acknowledged`、`resolved`を指定できる。
- `show`: secret-like値を除去した単一alertを表示する。
- `resolve`: operator reason付きでalertを手動解決する。原因が残っていれば次回checkで再度openになる。

## 監視ルール

| Rule | 既定severity | 既定条件 |
| --- | --- | --- |
| `stale_heartbeat` | critical | daemon lockのheartbeatが120秒以上古い |
| `fatal_runtime_error` | critical | fatal errorが1件以上 |
| `restart_loop` | high | 300秒以内にdaemon startが3回以上 |
| `queue_backlog` | warning | ready itemが20件以上 |
| `failed_notifications` | high | 300秒以内にDiscord通知失敗が3件以上 |
| `provider_suspended` | high | suspend中providerが1件以上 |
| `task_scheduler_missing` | warning | 確認済みTask Scheduler登録がmissing、disabled、error |
| `remote_external_unreachable` | high | 最新remote doctorで外部endpointが到達不能 |
| `remote_identity_bypass` | critical | 未認証requestがremote Boardへ2xxで到達 |
| `remote_url_drift` | high | runtime external URLが固定profile URLと不一致 |
| `remote_tunnel_disconnected` | critical | DiscordとBoardの両外部endpointが到達不能 |
| `slo_breach` | high | 保存済みSLO summaryが`CRITICAL`または`CORRUPT_DATA` |

閾値はinclusiveで評価する。未来時刻のheartbeatはclock skewとしてageを0へ丸め、誤検知しない。Task Scheduler ruleは`.kairon/runtime/daemon/task-status.json`が存在する場合だけ評価し、daemon heartbeatとは別の状態として扱う。remote ruleは`kairon remote doctor`が保存した`.kairon/runtime/remote/status.json`、SLO ruleは`.kairon/metrics/slo/latest.json`を評価する。Watchdog自身は外部networkへ接続せず、raw metricの再集約も行わない。

## Config

設定は`.kairon/config/runtime.json`の`watchdog`で管理する。

```json
{
  "watchdog": {
    "enabled": true,
    "cooldown_seconds": 900,
    "rules": {
      "stale_heartbeat": {
        "enabled": true,
        "severity": "critical",
        "threshold_seconds": 120
      },
      "queue_backlog": {
        "enabled": true,
        "severity": "warning",
        "threshold": 20
      }
    }
  }
}
```

各ruleは`enabled`、`severity`、`threshold`を持ち、時間窓を使うruleは`window_seconds`を持つ。alert単位のcooldownはrule指定がなければWatchdog全体の`cooldown_seconds`を使う。

## Artifact

```text
.kairon/watchdog/state.json
.kairon/watchdog/alerts/ALT-xxxx.json
.kairon/watchdog/audit.jsonl
.kairon/runtime/daemon/task-status.json
```

alertは`rule + resource + project_id`から作るdeterministic SHA-256 fingerprintでdeduplicateする。継続する同一異常は同じalert IDを更新し、occurrence countを増やす。状態遷移は次のとおり。

```text
new finding -> open
severity increase -> open / escalated notification
same finding during cooldown -> no notification
same finding after cooldown -> reminder notification
finding absent -> resolved
resolved finding recurs -> same alert ID is reopened
```

reason、evidence、notification errorは保存前にsanitizationを通す。raw token、credential、prompt、stdout、stderrはWatchdog artifactへ保存しない。

## Runtime統合

daemonは各tick後とfatal error記録後にWatchdog checkを実行する。Watchdog側の例外はsanitized `watchdog_error`としてdaemon logへ記録するが、正常なruntime tickを失敗へ変更せず、daemonのstop reasonも上書きしない。

`kairon status`はopen、acknowledged、resolved件数、最高severity、pending notification数、最終check時刻を表示する。`kairon doctor`はactive alertがなければPASS、active alertがある場合または状態を読めない場合はWARNINGを返す。

## Discord通知

Discordが有効な場合、GatewayはWatchdogのpending notificationをscanする。通知対象はopen、escalated、cooldown後のreminder、resolvedであり、同じpending eventを再送しない。Watchdog alertは操作buttonやmentionを付けず、sanitized summaryとartifact IDだけを送る。送信失敗はalert状態やruntime成功を変更せず、次回scanで再試行できる。

## 安全境界

- 自動再起動しない。
- Task Schedulerを自動登録・変更しない。
- queue itemを削除・延期・優先度変更しない。
- providerを自動resumeまたは切り替えない。
- alertをapprovalの代替として扱わない。
- Watchdog失敗をruntime処理失敗へ昇格しない。
