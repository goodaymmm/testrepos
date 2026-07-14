# Windows Daemon Ops v0

この文書は、Windows環境で `kairon start --daemon` を日常運用するための手順です。
Task Schedulerにはsecret値を渡さず、ユーザー環境変数からKaironが読み取る前提にします。
通常の状態確認・登録・登録解除・再起動は `kairon daemon task` を使います。
CLIは内部で `scripts/kairon-daemon-task.ps1` へ固定引数を渡します。helperの直接実行手順も障害調査用として残します。

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
- `.kairon/logs/daemon/*.log` と `.kairon/runtime/daemon/*.jsonl` はlocal evidenceであり、原則commitしない。
- `.kairon/runtime/lock.json` を手動削除する前に `kairon recovery run` を使う。
- 変更後は短い `--max-ticks` daemon testではなく、Task Scheduler経由で起動・停止を1回ずつ確認する。
