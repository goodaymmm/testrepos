# Incident Lifecycle v0

<!-- kairon:incident-lifecycle -->

## 目的

Incident Lifecycleは、Watchdog alertとruntime recovery targetを、原因単位の一つの運用timelineへ集約する。元artifactをcanonical sourceとして維持し、IncidentにはID、状態、sanitized summary、相対path、fingerprint、correlation IDだけを記録する。

Incidentは外部ITSMではない。Boardからのwrite、自動的なdestructive recovery、外部systemへのuploadは行わない。

## 状態

| Status | 意味 |
| --- | --- |
| `open` | active sourceが存在する |
| `acknowledged` | operatorが確認した。active sourceは未解決のまま |
| `recovering` | 承認済みassisted recoveryを計画または実行中 |
| `resolved` | active sourceがなく、復旧検証も失敗していない |

`acknowledged`はhealthを回復させず、runtime recovery targetを非表示にしない。`resolved`だけが終了状態である。同じdeterministic fingerprintが再びactiveになった場合は既存Incidentを`open`へ戻し、`recurrence_count`を増やす。

## Canonical artifact

```text
.kairon/incidents/INC-0001.json
.kairon/incidents/INC-0001-timeline.jsonl
.kairon/incidents/plans/IRP-INC-0001-0123456789ab.json
```

Incident resourceは次のkindを参照できる。

- `watchdog_alert`
- `recovery_target`
- `approval`
- `support_bundle`
- `recovery_plan`
- `recovery_result`

同じkindとIDの重複attachは一つにまとめる。内容が変わらない再attachではartifactとtimelineを更新しない。resource本文、raw log、diff、stdout / stderr、credentialはIncidentへ複製しない。

timelineは`incident.created`、`incident.reopened`、acknowledge / resolve、resource更新、bundle生成、recovery plan / start / completed / partial / failedをappend-onlyで記録する。Incident自身も既存correlation storeのmemberとなる。

## CLI

```powershell
kairon incident list
kairon incident list --status acknowledged
kairon incident show INC-0001
kairon incident acknowledge INC-0001 --reason "一次確認を完了"
kairon incident bundle INC-0001 --dry-run
kairon incident bundle INC-0001 --output C:\path\to\support
kairon incident recover INC-0001 --dry-run
kairon incident recover INC-0001 `
  --approval-id APR-0001 `
  --confirm IRP-INC-0001-0123456789ab
kairon incident resolve INC-0001 --reason "原因解消と復旧検証を確認"
```

`list`と`show`の前にはWatchdogとruntime recoveryを再検査し、参照statusを現在値へ同期する。

## AcknowledgeとResolve

`acknowledge`にはreasonが必須である。確認時刻とsanitized reasonを記録するが、active resourceを変更しない。

`resolve`にもreasonが必須である。次のblockerがある場合は拒否する。

- openなWatchdog alert
- unresolvedなruntime recovery target
- failedとなったrecovery verification

operatorがIncidentをresolvedにしても、同じsourceが再発すれば同じIncidentをreopenする。

## Support Bundle

`incident bundle --dry-run`はfileを作らず、収録予定と除外理由を表示する。実生成では通常のsanitized support bundleに`diagnostics/incident.json`を追加し、manifestの`incident_id`と結び付ける。

ZIPは既存のallowlist、path traversal防止、CRC、manifest size / SHA-256、`hashes.sha256`、生成前後secret scanをすべて通過しなければ保存しない。完成後、Incidentにはbundle ID、相対plan path、archive hash、sizeだけをattachする。

## Assisted Recovery

復旧は必ず二段階で行う。

1. `kairon incident recover INC-0001 --dry-run`
2. 作成された専用approvalを確認して`approve`
3. 同じIncident ID、approval ID、plan IDを指定して実行

planは対象fingerprint、action、risk、source digest、30分の有効期限を持つ。実行直前に次を再検証する。

- planが対象Incidentへbindされている
- approvalが`incident_recovery`型で`approve`済み
- approvalのIncident、plan、source digestが一致する
- `--confirm`がplan IDと完全一致する
- planが期限内で未実行
- 現在のtarget setから計算したsource digestがplan時点と一致する

safe stale lock、safe expired claim、stale Discord gatewayは既存runtime recovery境界で処理する。code-producing claim、partial outbox、Git transaction mid-stateなど曖昧な対象は既存runtime recovery approvalへ接続し、結果を`partial`として残す。Incidentのresolveは残存targetがなくなるまで許可しない。

## Board

BoardはIncident件数、active件数、status別件数、最近のIncident、priority itemをread-only表示する。Boardにはacknowledge、recover、resolveのwrite endpointを追加しない。

## 安全境界

- Incident artifactにsecret、raw payload、raw logを保存しない。
- support bundleを自動uploadしない。
- approvalなしでassisted recoveryを実行しない。
- plan後にtargetが変化した場合は実行しない。
- 実行済みまたは期限切れplanを再利用しない。
- acknowledgeをresolveとして扱わない。
- 外部ITSM連携とdestructive recoveryはv0対象外とする。
