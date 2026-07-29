# Windows Daemon Ops v0

この文書は、Windows環境で `kairon start --daemon` を日常運用するための手順です。
Task Schedulerにはsecret値を渡さず、ユーザー環境変数からKaironが読み取る前提にします。
通常の状態確認・登録・登録解除・再起動は `kairon daemon task` を使います。
CLIは内部で `scripts/kairon-daemon-task.ps1` へ固定引数を渡します。helperの直接実行手順も障害調査用として残します。

<!-- kairon:t175-daemon-baseline -->
T175 Release Candidate baselineでは、Task Schedulerの無期限実行、24時間以上のsoak certification、restart / reboot segment分類、heartbeat gap、fatal error、evidence hashに加え、Watchdogのdedupe / cooldown / resolve、Incident lifecycle、approval-gated assisted recoveryまでoperation test済みです。短縮fixtureは回帰test用であり、実時間certificationやlive notificationの代替にはしません。

## 前提

- Kairon repository: `C:\Users\hikar\Documents\AutoRunner`
- Target project: 例 `M:\EnglishApp`
- `npm run build` と `npm link` が完了している
- `kairon doctor` が `doctor.ok=true`、または残課題が把握済み
- Discord / GitHub などのsecretはユーザー環境変数、または明示設定したWindows Credential Manager targetから取得できる

secretをTask Schedulerの引数、説明、ログ名へ直接書かないでください。
Kaironはenv値を優先し、envが未設定でconfigにWindows credential targetがある場合だけCredential Managerをfallbackとして読みます。

## 事前確認

```powershell
$KAIRON = "C:\Users\hikar\Documents\AutoRunner"
$TARGET = "M:\EnglishApp"

cd $KAIRON
npm run build
npm link

cd $TARGET
kairon doctor
kairon status
```

Discord live連携を使う場合は、値の有無だけを確認します。値そのものは表示しません。

```powershell
Get-ChildItem Env:KAIRON_DISCORD_BOT_TOKEN,Env:KAIRON_DISCORD_APPLICATION_ID,Env:KAIRON_DISCORD_GUILD_ID,Env:KAIRON_DISCORD_APPROVAL_CHANNEL_ID,Env:KAIRON_DISCORD_OWNER_USER_ID,Env:KAIRON_DISCORD_ALLOWED_USER_IDS -ErrorAction SilentlyContinue |
  Select-Object Name,@{Name="Present";Expression={-not [string]::IsNullOrWhiteSpace($_.Value)}}
```

Discord bot tokenをWindows Credential Managerから読む場合は、`.kairon/config/notifications.json` のDiscord providerへ次のような参照を追加します。値そのものはconfigへ書きません。

```json
{
  "secrets": {
    "bot_token": {
      "provider": "windows_credential",
      "target": "Kairon/Discord/BotToken"
    }
  }
}
```

GitHub PATをWindows Credential Managerから読む場合は、target名だけを環境変数で指定します。

```powershell
$env:KAIRON_GH_TOKEN_CREDENTIAL_TARGET = "Kairon/GH_TOKEN"
# GITHUB_TOKEN fallbackを使う場合:
$env:KAIRON_GITHUB_TOKEN_CREDENTIAL_TARGET = "Kairon/GITHUB_TOKEN"
```

`kairon doctor` はsecret値ではなく `provider=env` / `provider=windows_credential` と `present` / `missing` だけを表示します。

## CLIからのTask Scheduler操作

まずdry-runで登録内容を確認します。`--dry-run`ではTask Schedulerを変更しません。

```powershell
cd M:\EnglishApp

kairon daemon task install `
  --dry-run `
  --task-name "Kairon Runtime EnglishApp" `
  --project-root "M:\EnglishApp" `
  --interval-ms 60000
```

出力の `task.mutation=skipped` と `secret_values=not_in_task_arguments` を確認してから、`--dry-run`を外して登録します。

```powershell
kairon daemon task install `
  --task-name "Kairon Runtime EnglishApp" `
  --project-root "M:\EnglishApp" `
  --interval-ms 60000
```

`reason=task_scheduler_permission_denied`になった場合は、Windows PowerShellを「管理者として実行」で開き直して同じコマンドを再実行します。Kaironはこの権限不足をstack traceではなく`status=setup_required`として返します。

状態確認、再起動、登録解除もCLIから実行できます。Task未登録時の`status`は`task.exists=false`を返し、コマンド自体は成功扱いです。

```powershell
kairon daemon task status --task-name "Kairon Runtime EnglishApp" --project-root "M:\EnglishApp"
kairon daemon task restart --task-name "Kairon Runtime EnglishApp" --project-root "M:\EnglishApp"
kairon daemon task uninstall --dry-run --task-name "Kairon Runtime EnglishApp" --project-root "M:\EnglishApp"
kairon daemon task uninstall --task-name "Kairon Runtime EnglishApp" --project-root "M:\EnglishApp"
```

Windows以外ではTask Schedulerを操作せず、`status=setup_required`とWindows上で再実行するためのguidanceを返します。

## Task Scheduler登録

helperを直接使う場合はKairon repository側で実行します。

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-daemon-task.ps1 `
  -Action Register `
  -TaskName "Kairon Runtime EnglishApp" `
  -ProjectRoot "M:\EnglishApp" `
  -KaironCommand "kairon" `
  -IntervalMs 60000
```

既定ではlogon時に起動します。OS起動時に登録する場合は `-AtStartup` を追加します。
ただし `-AtStartup` は権限やログオン状態の影響を受けるため、まずはlogon triggerで検証してください。

Task Scheduler helperの起動ログは既定で次に出ます。

```text
<ProjectRoot>\.kairon\logs\daemon\kairon-daemon-YYYYMMDD-HHMMSS.log
```

Kairon runtime daemon自体の正規event logは次に出ます。`kairon status` はこのJSONLを読み、停止後も直近daemonのhealth summaryを表示します。

```text
<ProjectRoot>\.kairon\runtime\daemon\YYYY-MM-DD.jsonl
```

## 起動・停止・再起動

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-daemon-task.ps1 -Action Start -TaskName "Kairon Runtime EnglishApp"
.\scripts\kairon-daemon-task.ps1 -Action Status -TaskName "Kairon Runtime EnglishApp"
.\scripts\kairon-daemon-task.ps1 -Action Stop -TaskName "Kairon Runtime EnglishApp" -ProjectRoot "M:\EnglishApp"
.\scripts\kairon-daemon-task.ps1 -Action Restart -TaskName "Kairon Runtime EnglishApp" -ProjectRoot "M:\EnglishApp"
```

`Stop` と `Restart` はTaskの停止だけでなく、target project上で `kairon stop` も実行します。

## 常駐状態の確認

```powershell
cd M:\EnglishApp
kairon status
kairon status | Select-String -Pattern "runtime.locked|runtime.stale|daemon.health|artifacts.latestDaemonLog|discord.gateway"
Get-Content .kairon\runtime\last-tick.json -Raw | ConvertFrom-Json
Get-ChildItem .kairon\runtime\daemon -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName,Length,LastWriteTime
Get-ChildItem .kairon\logs\daemon -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName,Length,LastWriteTime
```

`daemon.health.status=running` かつ `runtime.locked=true`、`runtime.stale=false` であれば、daemonは稼働中です。
停止後は `daemon.health.status=stopped`、異常終了時は `daemon.health.status=fatal_error` と `daemon.health.lastError*` を確認します。
`runtime.lastErrorCode` や `discord.gateway.errorCode` が出る場合は、先に `kairon doctor` と該当artifactを確認します。

## 長時間運用の証跡pack

24時間以上のdaemon運用結果は、daemon JSONLを直接共有するのではなく、redaction済みのevidence packへ集約します。

```powershell
cd M:\EnglishApp

kairon daemon report --since 24h
kairon daemon report --since 7d --format json
kairon daemon report --since 24h --output .kairon\reports\daemon\daemon-24h.md
```

reportには次を含めます。

- tick / idle / processed / fatal error / stop reasonの集計
- heartbeat gapとstale lock疑い
- 参照した `.kairon/runtime/daemon/*.jsonl` のpath
- token / api key / secret / password をredactしたfailure summary

## 24時間soak certification

`daemon report`で集計した証跡を、固定thresholdに対して機械判定する場合は`daemon certify`を使用します。実時間24時間の認証では、先にTask Scheduler上のdaemonを24時間以上継続させます。

```powershell
cd M:\EnglishApp

kairon daemon certify --since 24h
kairon daemon certify --since 24h --format json
kairon daemon certify --since 24h --output .kairon\reports\daemon\certification-24h.md
```

既定profileはtick interval 60秒、最大heartbeat gap 180秒、最大restart gap 600秒、fatal error許容0件、期待tick数の90%以上です。Task Schedulerのintervalが異なる場合は、実際の設定値に合わせて明示します。

Task Scheduler登録は24時間で強制終了しないよう`ExecutionTimeLimit=PT0S`を使用します。T146以前に登録したTaskは、一度`kairon daemon task uninstall`を実行してから`install`し直し、無期限設定へ更新してください。

```powershell
kairon daemon certify `
  --since 24h `
  --expected-interval-ms 60000 `
  --max-heartbeat-gap-ms 180000 `
  --max-restart-gap-ms 600000 `
  --max-fatal-errors 0 `
  --output .kairon\reports\daemon\certification-24h.md
```

certification statusは次の意味です。

| Status | 意味 |
| --- | --- |
| `PASS` | window、tick、heartbeat、restart、fatal error、stale判定をすべて満たす |
| `UNPASSED` | fatal error、未許可gap、予期しないrestart、staleなどの失敗証跡がある |
| `INCOMPLETE` | daemon証跡はあるが、選択したwindowの先頭または末尾を満たしていない |
| `SETUP_REQUIRED` | 選択window内にdaemon logがなく、外部soak実行が必要 |

`stop_requested`から制限時間内に再度`started`となるpairはscheduled restartとして許可されます。`host_boot_at`が変化した短時間の再開はhost rebootとして許可されます。同一bootでclean stopを伴わない再開、`max_ticks`、`max_idle_ticks`、`fatal_error`による停止は予期しないsequenceとして扱います。

artifactには評価window、全threshold、個別check、restart分類、参照daemon log pathとSHA-256を保存します。raw daemon event、token、環境変数値は保存しません。短縮fixtureはunit test専用であり、実時間24時間のoperation test証跡の代替にはなりません。

## stale lock復旧

daemonを停止した後もlockが残る場合は、次の順で確認します。

```powershell
cd M:\EnglishApp

kairon status
kairon recovery list
kairon recovery run
kairon status
```

`recovery.targets` が残る場合は、対象を確認してから解決またはacknowledgeします。

```powershell
kairon recovery show <target-id>
kairon recovery resolve <target-id> --reason "operator verified stale runtime state"
# または
kairon recovery acknowledge <target-id> --reason "operator will handle this manually"
```

## Runtime artifact retention

長期稼働で増加するrun、session、daemon log、audit、reportは、`policies.json`の`cleanup.retention`で保持上限を設定します。上限を超えたartifactは自動削除されず、既存cleanup proposalへ移動候補として追加されます。

候補だけを確認する場合:

```powershell
cd M:\EnglishApp
kairon cleanup retention plan --dry-run
```

operator review用proposalを保存する場合:

```powershell
kairon cleanup retention plan --write-proposal
kairon cleanup list
kairon cleanup show <retention-proposal-id>
kairon cleanup apply <retention-proposal-id> --dry-run
```

各categoryは`max_age_days`、`max_files`、`max_bytes`、`min_keep`で制御します。最新の成功run、open approvalや未解決recovery targetから参照されるartifact、各categoryの最新`min_keep`件は候補から除外されます。JSONLはfile単位で扱い、途中の行だけを切り出しません。symbolic linkを含むartifact rootは候補化しません。

`kairon maintenance run`も同じretention scannerを使用します。結果の`cleanup_retention_candidates`と`cleanup_retention_candidate_bytes`を確認し、`kairon cleanup apply`の前に必ずdry-runしてください。

## State backup / restore drill

backupはdaemon停止中に作成・復元します。保存先はtarget projectとは別driveまたは同期対象外の外部directoryを推奨します。
長期保管用のoff-device copy、catalog、世代保持、隔離rehearsalは [disaster-recovery-v0.md](disaster-recovery-v0.md) を参照してください。

```powershell
$TARGET = "M:\EnglishApp"
$BACKUP_ROOT = "D:\KaironBackups\EnglishApp"

cd $TARGET
kairon stop
kairon state backup create --dry-run
$backupJson = kairon state backup create --output $BACKUP_ROOT --format json | ConvertFrom-Json
$BACKUP_ID = $backupJson.backup_id
$BACKUP_PACKAGE = $backupJson.package_path

kairon state backup verify $BACKUP_ID --format json | ConvertFrom-Json
kairon state backup rehearse $BACKUP_ID --format json | ConvertFrom-Json
```

`rehearse`の`status=passed`、`cleaned_up=true`、`integrity.summary.errors=0`を確認します。
外部packageを別hostまたはregistryのない状態で検証する場合は`--source`を指定します。

```powershell
kairon state backup verify $BACKUP_ID --source $BACKUP_PACKAGE
kairon state backup rehearse $BACKUP_ID --source $BACKUP_PACKAGE
```

外付けdriveまたは別volumeへ検証付きで複製する場合は、単純なfilesystem copyではなくDR commandを使用します。

```powershell
$plan = kairon state backup dr plan $BACKUP_ID `
  --destination "E:\KaironDisasterRecovery" `
  --format json |
  ConvertFrom-Json
$PLAN_ID = $plan.plan.plan_id
kairon state backup dr copy $PLAN_ID --confirm $PLAN_ID
kairon state backup dr verify $BACKUP_ID
kairon state backup dr rehearse $BACKUP_ID
```

復元前に対象projectを別名へ複製するのではなく、Kaironの確認付きrestoreを使用します。restoreは現行stateのpre-restore snapshotを自動作成します。

```powershell
cd $TARGET
kairon stop
kairon state backup verify $BACKUP_ID --source $BACKUP_PACKAGE
kairon state backup restore $BACKUP_ID `
  --source $BACKUP_PACKAGE `
  --confirm $BACKUP_ID
kairon state check
```

restoreが失敗した場合は、再実行する前にRecovery targetとmarkerを確認します。

```powershell
kairon recovery list
Get-Content .kairon\runtime\state-backup-restore.json -Raw -Encoding UTF8 | ConvertFrom-Json
```

markerの`pre_restore_snapshot_id`を確認し、rollbackを選択した場合だけ次を実行します。

```powershell
$marker = Get-Content .kairon\runtime\state-backup-restore.json -Raw -Encoding UTF8 | ConvertFrom-Json
kairon state snapshot restore $marker.pre_restore_snapshot_id `
  --confirm $marker.pre_restore_snapshot_id
kairon state check
```

rollback後もmarkerは調査証跡として残ります。内容を確認してRecovery targetをresolveまたはacknowledgeし、次のrestoreを開始する前にoperator判断でmarkerを退避してください。backup package、manifest、markerへsecret値を直接書かないでください。

## 登録解除

```powershell
cd C:\Users\hikar\Documents\AutoRunner

.\scripts\kairon-daemon-task.ps1 `
  -Action Unregister `
  -TaskName "Kairon Runtime EnglishApp"
```

登録解除はTask Scheduler登録だけを消します。`.kairon/` のstate、logs、reportsは削除しません。

## 運用上の注意

- Task SchedulerのAction引数にtokenやAPI keyを書かない。
- `kairon doctor` のDiscord表示は `present/missing` のみを確認し、値は共有しない。
- `.kairon/logs/daemon/*.log` と `.kairon/runtime/daemon/*.jsonl` はlocal evidenceであり、原則commitしない。
- `.kairon/runtime/lock.json` を手動削除する前に `kairon recovery run` を使う。
- 変更後は短い `--max-ticks` daemon testではなく、Task Scheduler経由で起動・停止を1回ずつ確認する。

## Scheduled multi-project health

runtime daemonとは別に、read-only supervisor scanをTask Schedulerへ登録できる。登録はplan artifactと完全一致confirmを必須とする。

```powershell
$planText = kairon projects health schedule plan `
  --interval-minutes 60 `
  --project-timeout-ms 5000 `
  --concurrency 4 `
  --retention-days 30

$PLAN_ID = [regex]::Match($planText, "plan_id=([A-Za-z0-9._-]+)").Groups[1].Value
kairon projects health schedule register $PLAN_ID --confirm $PLAN_ID
kairon projects health schedule verify
```

登録解除にも同じplan IDの完全一致confirmを使う。taskが既にない場合も成功する。

```powershell
kairon projects health schedule unregister $PLAN_ID --confirm $PLAN_ID
kairon projects health schedule verify
```

helperは`scripts/kairon-supervisor-health-task.ps1`である。Task Scheduler引数にはregistry pathと数値profileだけを保存し、token、password、Discord credentialは保存しない。登録・解除時に`task_scheduler_permission_denied`となる場合はWindows PowerShellを管理者として実行する。

## Scheduled update check

runtime daemonとは別に、read-only update checkをTask Schedulerへ登録できる。既定は無効で、登録操作は管理者PowerShellから明示的に実行する。

```powershell
cd M:\EnglishApp

kairon update schedule install `
  --interval-hours 24 `
  --timeout-ms 60000 `
  --cooldown-hours 24

kairon update schedule status
kairon update schedule run
```

helperは`scripts/kairon-update-check-task.ps1`である。Task actionにはhelper、project root、Kairon commandだけを保存し、token値やDiscord credentialは保存しない。tokenはTask実行時に`GH_TOKEN`、`GITHUB_TOKEN`、またはWindows Credential Managerから解決する。`status`で`task_status=registered`、`task_managed=true`、credentialの`present/missing`、最終分類、stale判定を確認する。

同一repository、channel、version、release IDの通知は再送しない。quiet hours、maintenance window、daily budget、cooldownで送信を延期または抑制する場合がある。通知監査ログが壊れている場合は重複送信せず`notification_audit_invalid`で失敗する。

解除は完全一致するKairon管理Taskだけを対象にする。

```powershell
kairon update schedule uninstall
kairon update schedule status
```

foreign taskは置換・削除しない。権限不足では管理者PowerShellで再実行する。解除後も`.kairon/update/schedule/`の結果は調査証跡として保持する。scheduled checkはdownload、apply、rollback、runtime restartを実行しない。
