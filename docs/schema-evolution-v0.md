# Kairon Schema Evolution Contract v0

## 目的

Kaironのconfigとcanonical stateを、version付きmigration、dry-run plan、fresh backup、post-checkで安全に更新する。Configとstate artifactは別のversion policyを持ち、unknown newer schemaを自動的に書き換えたりdowngradeしたりしない。

## Schema Registry

| Domain | 対象 | Current | Minimum readable | Minimum writable | Rewrite policy |
|---|---|---:|---:|---:|---|
| config | `.kairon/config/{project,runtime,schedule,agents,dispatch,policies,notifications,rag}.json` | `0.3.0` | `0.1` | `0.2.0` | explicit migration |
| state | event、task、run、approval、workflow、git、review、incident、backup、update、release等 | `0.1` | `0.1` | `0.1` | reader compatibility |

Append-only event / audit recordはmigrationで一括rewriteしない。Readerがminimum readable versionを維持し、unknown newer state recordはstate integrity errorにする。

## Migration Graph

Config migrationは次のforward-only graphとして扱う。

```text
0.1   -+
       +-> 0.3.0
0.2.x -+
```

`0.1`と`0.2.x`は読み取り可能だが、current configへ書き込む前に`0.3.0`へ移行する。`0.3.0`より新しいschemaはdefault denyする。Automatic downgrade、tagのようなversion強制変更、backupなしのrewriteは行わない。

## Plan

```powershell
kairon stop
kairon migrate plan
```

Planは`.kairon/migrations/plans/MIG-xxxx.json`へ保存する。各stepは次を固定する。

- config file
- `from_schema_version` / `to_schema_version`
- input / output SHA-256
- 変更pathとadd / update / remove区分
- reversible flag
- runtime停止、backup要否
- plan全体のdigest

Plan artifactへconfig本文やsecret値を複製しない。Plan後に変更対象または変更対象外configのdigestが変化した場合、applyは開始しない。

## Apply

```powershell
kairon migrate apply MIG-0001 --confirm MIG-0001
```

Applyは次の順序を固定する。

1. plan ID完全一致とplan digestを検証
2. runtimeが停止済みであることを検証
3. 全config inventoryとstep input digestを再検証
4. fresh state backupを作成
5. `.kairon/migrations/in-progress.json`へmarkerを作成
6. deterministic transformを再計算し、output digest一致後にatomic write
7. config validation、state integrity、doctorの必須checkを実行
8. 成功resultを`.kairon/migrations/results/`へ保存しmarkerを削除

既に全output digestが一致する場合は`already_applied`とし、backupや二重writeを行わない。

## Failure / Recovery

Runtime稼働中、backup失敗、input drift、unknown newer schemaはconfigを書き換える前に`blocked`となる。Atomic write開始後にpost-checkが失敗した場合はmarkerを`failed`へ更新し、backup IDと明示restore commandを保存する。

```powershell
kairon state backup verify <backup-id>
kairon state backup rehearse <backup-id>
kairon state backup restore <backup-id> --confirm <backup-id>
```

自動rollbackは行わない。Operatorがmarker、result、backup verify / rehearsalを確認してからrestoreする。

## Validation

- Config validationは旧readable schemaをwarning、unknown newer / unsupported older / malformed versionをerrorにする。
- State integrityは旧configをmigration-required warning、unknown newer config/stateをerrorにする。
- Doctorは旧runtime configをmigration-required warningとして案内し、unknown schemaをerrorにする。
- Multi-project registry / supervisorはminimum readable範囲の`project.json`だけを受理する。
