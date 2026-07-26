# Disaster Recovery v0

<!-- kairon:off-device-disaster-recovery -->

この文書は、Kairon canonical state backupをproject外へ複製し、別ディレクトリで復旧可能性を検証する運用手順です。Kaironはcloud storageへ自動uploadしません。保存先はoperatorが用意した別drive、外付け媒体、またはmount済みdirectoryを使用します。秘密情報を含み得る運用証跡を保護するため、BitLockerなどで暗号化されたvolumeを推奨します。

## 安全境界

- 保存先はsource projectと同一、またはsource project配下にできません。
- 保存先rootと既存の親directoryにsymbolic linkを含められません。
- copy前後でmanifest、file set、size、SHA-256を検証します。
- copyは`.partial` directoryへ書き、検証完了後だけ最終名へatomic renameします。
- 中断したcopyはcatalogへ登録せず、`.partial`を削除します。
- catalogはproject外のuser-local領域へ保存し、backup ID、project ID、保存先、digest、検証時刻だけを保持します。
- retentionは最新の検証済み世代と`min_keep`世代を削除しません。
- rehearsalは一時projectへ展開し、config、canonical state、workflow checkpoint replay readinessを検査した後に削除します。
- off-device copyはrestoreを自動実行しません。restoreはruntime停止と別の完全一致確認が必要です。

既定catalogはprojects registryと同じuser-local Kairon directoryの`backup-catalog.json`です。運用テストでは`KAIRON_DR_CATALOG_PATH`または`--catalog-path`で隔離できます。

## Backup作成

最初にsource projectでdeterministic backupを作成します。

```powershell
$TARGET = "M:\EnglishApp"
$DESTINATION = "E:\KaironDisasterRecovery"

cd $TARGET
kairon stop
$backup = kairon state backup create --format json | ConvertFrom-Json
$BACKUP_ID = $backup.backup_id
```

`$DESTINATION`は事前に作成し、十分な空き容量があることを確認します。USB driveなどを使う場合はdrive letterが意図したvolumeを指していることも確認してください。

## Planとcopy

planはsource backupと保存先を検証し、copy後に削除候補となる世代を表示します。planだけでは保存先を変更しません。

```powershell
$plan = kairon state backup dr plan $BACKUP_ID `
  --destination $DESTINATION `
  --minimum-free-bytes 536870912 `
  --verification-interval-days 30 `
  --max-backups 12 `
  --max-age-days 180 `
  --min-keep 2 `
  --format json |
  ConvertFrom-Json

$PLAN_ID = $plan.plan.plan_id
$plan.plan.retention_candidates
```

内容を確認した後、plan IDを完全一致させてcopyします。

```powershell
kairon state backup dr copy $PLAN_ID `
  --confirm $PLAN_ID `
  --format json |
  ConvertFrom-Json
```

`status=copied`または、同一digestの保存済みpackageに対する`status=already_copied`を確認します。保存先切断、容量不足、source変更、copy中断、destination改ざん、未対応schemaは区別して拒否されます。

## 定期verify

保存媒体を接続した状態で定期verifyを実行します。

```powershell
kairon state backup dr verify $BACKUP_ID --format json |
  ConvertFrom-Json
kairon doctor |
  Select-String -Pattern "state.disaster_recovery|verified_generations|missing_packages|stale_verifications"
```

同じbackup IDが複数保存先にある場合は`--package <absolute-package-path>`でcatalog entryを選択します。`doctor`は保存先pathを表示せず、切断件数、検証失敗件数、期限超過件数を表示します。

## 隔離rehearsal

rehearsalはsource projectを変更せず、off-device packageだけでconfig、state integrity、workflow replay readinessを検証します。

```powershell
kairon state backup dr rehearse $BACKUP_ID --format json |
  ConvertFrom-Json
```

次を確認します。

- `status=passed`
- `cleaned_up=true`
- `integrity.status=ok`
- `config_validation.ok=true`
- `workflow_replay.status=ready`

四半期ごと、またはschema migration前後に、別Windows環境かClean Windowsでも同じrehearsalを実行します。

## Restore drill

off-device rehearsalがPASSしたpackageをrestoreする場合も、先にsource projectのruntimeを停止します。restoreは現行stateのpre-restore snapshotを自動作成します。

```powershell
$PACKAGE = "E:\KaironDisasterRecovery\kairon-dr\<project-id>\<backup-id>"

cd $TARGET
kairon stop
kairon state backup verify $BACKUP_ID --source $PACKAGE
kairon state backup restore $BACKUP_ID `
  --source $PACKAGE `
  --confirm $BACKUP_ID
kairon state check
```

restore失敗時は再試行前に`kairon recovery list`と`.kairon/runtime/state-backup-restore.json`を確認します。

## 障害時の判断

| 状態 | 対応 |
| --- | --- |
| `destination_missing` | 正しいdriveまたはmountを接続し、同じplanを作り直す |
| `insufficient_space` | 容量を確保する。未検証世代を手動削除せずretention planを確認する |
| `copy_interrupted` | 接続とfilesystemを確認し、source backupを再verifyしてplanから再実行する |
| `destination_tampered` | packageを隔離し、正常な別世代をverifyする。唯一の検証済み世代は削除しない |
| `backup_schema_unsupported` | 対応versionのKaironでverifyし、migration手順を確認する |
| `catalog_corrupt` | catalogのbackupを復旧する。外部packageを推測で削除しない |
