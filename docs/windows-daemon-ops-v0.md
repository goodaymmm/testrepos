# Windows Daemon Ops v0

この文書は、Windows環境で `kairon start --daemon` を日常運用するための手順です。
Task Schedulerにはsecret値を渡さず、ユーザー環境変数からKaironが読み取る前提にします。

## 前提

- Kairon repository: `C:\Users\hikar\Documents\AutoRunner`
- Target project: 例 `M:\EnglishApp`
- `npm run build` と `npm link` が完了している
- `kairon doctor` が `doctor.ok=true`、または残課題が把握済み
- Discord / GitHub などのsecretはユーザー環境変数に設定済み

secretをTask Schedulerの引数、説明、ログ名へ直接書かないでください。
Windows Credential Manager連携は後続候補です。

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

## Task Scheduler登録

Kairon repository側でhelperを実行します。

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

ログは既定で次に出ます。

```text
<ProjectRoot>\.kairon\logs\daemon\kairon-daemon-YYYYMMDD-HHMMSS.log
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
Get-Content .kairon\runtime\last-tick.json -Raw | ConvertFrom-Json
Get-ChildItem .kairon\logs\daemon -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName,Length,LastWriteTime
```

`runtime.locked=true` かつ `runtime.stale=false` であれば、daemonは稼働中です。
`runtime.lastErrorCode` や `discord.gateway.errorCode` が出る場合は、先に `kairon doctor` と該当artifactを確認します。

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
- `.kairon/logs/daemon/*.log` はlocal evidenceであり、原則commitしない。
- `.kairon/runtime/lock.json` を手動削除する前に `kairon recovery run` を使う。
- 変更後は短い `--max-ticks` daemon testではなく、Task Scheduler経由で起動・停止を1回ずつ確認する。
