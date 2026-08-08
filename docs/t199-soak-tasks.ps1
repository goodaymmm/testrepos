param(
  [ValidateSet("Install", "Start", "Stop", "Status", "Uninstall")]
  [string]$Action = "Status",
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [string]$StartWindowFrom = "",
  [string]$StartWindowTo = "",
  [string]$DailyWorkloadAt = "",
  [string]$DiscordOwnerUserId = "",
  [string]$DiscordAllowedUserIds = "",
  [switch]$AllowLegacyCleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$TaskSchedulerCommon = Join-Path $RepositoryRoot "scripts\kairon-task-scheduler-common.ps1"
. $TaskSchedulerCommon
$Node = if (Test-Path "C:\nvm4w\nodejs\node.exe") {
  "C:\nvm4w\nodejs\node.exe"
} else {
  (Get-Command node -ErrorAction Stop).Source
}
$DaemonHelper = Join-Path $RepositoryRoot "scripts\kairon-daemon-task.ps1"
$KaironWrapper = Join-Path $PSScriptRoot "t199-kairon.cmd"
$RemoteSupervisor = Join-Path $PSScriptRoot "t199-remote-supervisor.mjs"
$DailyWorkload = Join-Path $PSScriptRoot "t199-daily-workload.mjs"
$RuntimeTask = "Kairon T199 Runtime"
$RemoteTask = "Kairon T199 Remote Services"
$DailyTask = "Kairon T199 Daily Workload"
$SchedulePath = Join-Path $ProjectRoot ".kairon\config\t199-soak-schedule.json"
$RuntimeLockPath = Join-Path $ProjectRoot ".kairon\runtime\lock.json"

function ConvertTo-KaironTimeOfDay {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  if ($Value -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') {
    throw "$Name must use HH:mm format. actual=$Value"
  }
  return [TimeSpan]::ParseExact(
    $Value,
    "hh\:mm",
    [Globalization.CultureInfo]::InvariantCulture
  )
}

function Assert-KaironSchedule {
  param([Parameter(Mandatory = $true)]$Schedule)

  $from = ConvertTo-KaironTimeOfDay "start_window_from" ([string]$Schedule.start_window_from)
  $to = ConvertTo-KaironTimeOfDay "start_window_to" ([string]$Schedule.start_window_to)
  $daily = ConvertTo-KaironTimeOfDay "daily_workload_at" ([string]$Schedule.daily_workload_at)
  $windowEnd = if ($to -lt $from) {
    $to.Add([TimeSpan]::FromDays(1))
  } else {
    $to
  }
  $dailyStart = if ($daily -le $from) {
    $daily.Add([TimeSpan]::FromDays(1))
  } else {
    $daily
  }
  if ($dailyStart -le $windowEnd) {
    throw "The daily workload must start after the T199 start window closes."
  }
  if ([string]$Schedule.discord_owner_user_id -notmatch '^\d{17,20}$') {
    throw "The T199 schedule contains an invalid Discord owner user id."
  }
  $allowed = @(
    [string]$Schedule.discord_allowed_user_ids -split '[,\s]+' |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  if ($allowed.Count -eq 0 -or @($allowed | Where-Object { $_ -notmatch '^\d{17,20}$' }).Count -gt 0) {
    throw "The T199 schedule contains invalid Discord allowed user ids."
  }
}

function New-KaironScheduleFromParameters {
  if (
    [string]::IsNullOrWhiteSpace($StartWindowFrom) -or
    [string]::IsNullOrWhiteSpace($StartWindowTo) -or
    [string]::IsNullOrWhiteSpace($DailyWorkloadAt)
  ) {
    throw "Install requires -StartWindowFrom, -StartWindowTo, and -DailyWorkloadAt."
  }
  $ownerUserId = if (-not [string]::IsNullOrWhiteSpace($DiscordOwnerUserId)) {
    $DiscordOwnerUserId.Trim()
  } else {
    ([string]$env:KAIRON_DISCORD_OWNER_USER_ID).Trim()
  }
  $allowedUserIds = if (-not [string]::IsNullOrWhiteSpace($DiscordAllowedUserIds)) {
    $DiscordAllowedUserIds.Trim()
  } else {
    ([string]$env:KAIRON_DISCORD_ALLOWED_USER_IDS).Trim()
  }
  if ($ownerUserId -notmatch '^\d{17,20}$') {
    throw "Install requires a valid -DiscordOwnerUserId or KAIRON_DISCORD_OWNER_USER_ID."
  }
  $allowed = @($allowedUserIds -split '[,\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($allowed.Count -eq 0 -or @($allowed | Where-Object { $_ -notmatch '^\d{17,20}$' }).Count -gt 0) {
    throw "Install requires valid -DiscordAllowedUserIds or KAIRON_DISCORD_ALLOWED_USER_IDS."
  }
  $schedule = [ordered]@{
    schema_version = "0.1"
    start_window_from = $StartWindowFrom
    start_window_to = $StartWindowTo
    daily_workload_at = $DailyWorkloadAt
    discord_owner_user_id = $ownerUserId
    discord_allowed_user_ids = $allowed -join ","
    updated_at = [DateTimeOffset]::UtcNow.ToString("o")
  }
  Assert-KaironSchedule $schedule
  return $schedule
}

function Read-KaironSchedule {
  if (-not (Test-Path -LiteralPath $SchedulePath -PathType Leaf)) {
    throw "T199 schedule is not registered. Run Install with explicit times first."
  }
  $schedule = Get-Content -LiteralPath $SchedulePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-KaironSchedule $schedule
  return $schedule
}

function Write-KaironSchedule {
  param([Parameter(Mandatory = $true)]$Schedule)

  New-Item -ItemType Directory -Force (Split-Path -Parent $SchedulePath) | Out-Null
  [IO.File]::WriteAllText(
    $SchedulePath,
    ($Schedule | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
  )
}

function New-KaironPrincipal {
  $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ([string]::IsNullOrWhiteSpace($userId)) {
    throw "Current Windows security principal could not be resolved."
  }
  return New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited
}

function New-KaironSettings {
  return New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
}

function Register-KaironTasks {
  param([Parameter(Mandatory = $true)]$Schedule)

  $principal = New-KaironPrincipal
  $settings = New-KaironSettings
  $logRoot = Join-Path $ProjectRoot ".kairon\logs\daemon"
  New-Item -ItemType Directory -Force $logRoot | Out-Null
  $recoveryTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 30)

  $runtimeArguments = @(
    "-File", $DaemonHelper,
    "-Action", "Run",
    "-ProjectRoot", $ProjectRoot,
    "-KaironCommand", $KaironWrapper,
    "-IntervalMs", "60000",
    "-LogRoot", $logRoot
  )
  $runtimeSpec = Get-KaironBackgroundPowerShellActionSpec `
    -ArgumentList $runtimeArguments `
    -WorkingDirectory $ProjectRoot
  $runtimeAction = New-KaironBackgroundTaskAction -Spec $runtimeSpec
  Register-ScheduledTask `
    -TaskName $RuntimeTask `
    -Action $runtimeAction `
    -Trigger $recoveryTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Kairon 60-second production daemon for T199 Stable soak." `
    -Force `
    -ErrorAction Stop | Out-Null

  $remoteSpec = Get-KaironBackgroundProcessActionSpec `
    -Executable $Node `
    -ArgumentList @($RemoteSupervisor, "--project-root", $ProjectRoot) `
    -WorkingDirectory $ProjectRoot
  $remoteAction = New-KaironBackgroundTaskAction -Spec $remoteSpec
  Register-ScheduledTask `
    -TaskName $RemoteTask `
    -Action $remoteAction `
    -Trigger $recoveryTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Kairon Board and Discord HTTP supervisor for T199 Stable soak." `
    -Force `
    -ErrorAction Stop | Out-Null

  $dailySpec = Get-KaironBackgroundProcessActionSpec `
    -Executable $Node `
    -ArgumentList @($DailyWorkload, "--project-root", $ProjectRoot) `
    -WorkingDirectory $ProjectRoot
  $dailyAction = New-KaironBackgroundTaskAction -Spec $dailySpec
  Register-ScheduledTask `
    -TaskName $DailyTask `
    -Action $dailyAction `
    -Trigger (New-ScheduledTaskTrigger -Daily -At ([string]$Schedule.daily_workload_at)) `
    -Principal $principal `
    -Settings $settings `
    -Description "Kairon daily real-path SLO samples for T199 Stable soak." `
    -Force `
    -ErrorAction Stop | Out-Null

  foreach ($name in @($RuntimeTask, $RemoteTask, $DailyTask)) {
    Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
  }
  Write-Host "tasks.installed=true"
  Write-Host "tasks.enabled=false"
  Write-Host "start_window=$($Schedule.start_window_from)-$($Schedule.start_window_to)"
  Write-Host "daily_workload.next_run=$($Schedule.daily_workload_at)"
}

function Test-KaironProcessExists {
  param([object]$ProcessId)

  $parsed = 0
  return (
    [int]::TryParse([string]$ProcessId, [ref]$parsed) -and
    $parsed -gt 0 -and
    $null -ne (Get-Process -Id $parsed -ErrorAction SilentlyContinue)
  )
}

function Assert-NoResidualServices {
  if (Test-Path -LiteralPath $RuntimeLockPath -PathType Leaf) {
    $lock = Get-Content -LiteralPath $RuntimeLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-KaironProcessExists $lock.pid) {
      throw "A Kairon runtime process is still active. Run Stop before Start. pid=$($lock.pid)"
    }
  }

  $remoteStatusPath = Join-Path $ProjectRoot ".kairon\runtime\t199-remote-supervisor.json"
  if (Test-Path -LiteralPath $remoteStatusPath -PathType Leaf) {
    $remote = Get-Content -LiteralPath $remoteStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($remote.status -ne "stopped" -and (Test-KaironProcessExists $remote.supervisor_pid)) {
      throw "The T199 remote supervisor is still active. Run Stop before Start. pid=$($remote.supervisor_pid)"
    }
  }

  foreach ($port in @(18776, 18777, 18778, 18779)) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $pending = $client.ConnectAsync("127.0.0.1", $port)
      if ($pending.Wait(250) -and $client.Connected) {
        throw "A T199 loopback port is already in use. port=$port"
      }
    } finally {
      $client.Dispose()
    }
  }
}

function Stop-KaironRuntime {
  $exitCode = 1
  Push-Location -LiteralPath $ProjectRoot
  try {
    & $KaironWrapper stop
    $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "Kairon runtime stop request failed. exit_code=$exitCode"
  }
  $timeoutSeconds = if ($AllowLegacyCleanup) { 10 } else { 90 }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($timeoutSeconds)
  while ((Test-Path -LiteralPath $RuntimeLockPath -PathType Leaf) -and [DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path -LiteralPath $RuntimeLockPath -PathType Leaf) {
    if (-not $AllowLegacyCleanup) {
      throw "Kairon runtime did not release its lock within $timeoutSeconds seconds."
    }
    Stop-KaironLegacyRuntime
  }
}

function Stop-KaironLegacyRuntime {
  $lock = Get-Content -LiteralPath $RuntimeLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not (Test-KaironProcessExists $lock.pid)) {
    Remove-Item -LiteralPath $RuntimeLockPath -Force
    Write-Host "runtime.legacy_cleanup=stale_lock_removed pid=$($lock.pid)"
    return
  }

  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($lock.pid)" -ErrorAction Stop
  $expectedCli = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "dist\cli\main.js"))
  if (
    $null -eq $process -or
    $process.Name -ine "node.exe" -or
    [string]::IsNullOrWhiteSpace($process.CommandLine) -or
    $process.CommandLine.IndexOf($expectedCli, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
    $process.CommandLine -notmatch '(?i)(?:^|\s)start(?:\s|$)' -or
    $process.CommandLine -notmatch '(?i)(?:^|\s)--daemon(?:\s|$)'
  ) {
    throw "Refusing to terminate an unverified legacy runtime process. pid=$($lock.pid)"
  }

  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  & $taskkill /PID ([string]$lock.pid) /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Legacy Kairon runtime process tree cleanup failed. pid=$($lock.pid) exit_code=$LASTEXITCODE"
  }
  Remove-Item -LiteralPath $RuntimeLockPath -Force
  Write-Host "runtime.legacy_cleanup=stopped pid=$($lock.pid)"
}

function Stop-KaironRemoteServices {
  & $Node $RemoteSupervisor `
    --project-root $ProjectRoot `
    --request-stop `
    --timeout-ms 30000
  if ($LASTEXITCODE -ne 0) {
    if (-not $AllowLegacyCleanup) {
      throw "T199 remote supervisor stop request failed. Rerun with -AllowLegacyCleanup only for a supervisor created before T207. exit_code=$LASTEXITCODE"
    }
    Stop-KaironLegacyRemoteServices
  }
}

function Stop-KaironLegacyRemoteServices {
  $expectedScript = [IO.Path]::GetFullPath($RemoteSupervisor)
  $expectedRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $matches = @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.Name -ieq "node.exe" -and
        -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
        $_.CommandLine.IndexOf($expectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.IndexOf($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
  )
  if ($matches.Count -eq 0) {
    Write-Host "remote_supervisor.legacy_cleanup=not_running"
    return
  }

  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  foreach ($process in $matches) {
    & $taskkill /PID ([string]$process.ProcessId) /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "Legacy T199 remote process tree cleanup failed. pid=$($process.ProcessId) exit_code=$LASTEXITCODE"
    }
    Write-Host "remote_supervisor.legacy_cleanup=stopped pid=$($process.ProcessId)"
  }

  $remoteStatusPath = Join-Path $ProjectRoot ".kairon\runtime\t199-remote-supervisor.json"
  if (Test-Path -LiteralPath $remoteStatusPath -PathType Leaf) {
    $status = Get-Content -LiteralPath $remoteStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $status.status = "stopped"
    $status | Add-Member -NotePropertyName stopped_by -NotePropertyValue "legacy_cleanup" -Force
    $status.updated_at = [DateTimeOffset]::UtcNow.ToString("o")
    [IO.File]::WriteAllText(
      $remoteStatusPath,
      ($status | ConvertTo-Json -Depth 20) + [Environment]::NewLine,
      [Text.UTF8Encoding]::new($false)
    )
  }
}

function Stop-KaironTasks {
  foreach ($name in @($DailyTask, $RuntimeTask, $RemoteTask)) {
    Disable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null
  }

  $errors = [Collections.Generic.List[string]]::new()
  try {
    Stop-KaironRuntime
  } catch {
    $errors.Add("runtime=$($_.Exception.Message)")
  }
  try {
    Stop-KaironRemoteServices
  } catch {
    $errors.Add("remote=$($_.Exception.Message)")
  }
  finally {
    foreach ($name in @($DailyTask, $RuntimeTask, $RemoteTask)) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    }
  }
  if ($errors.Count -gt 0) {
    throw "T199 service cleanup failed: $($errors -join '; ')"
  }
}

function Show-KaironTasks {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentUserId = $currentIdentity.Name
  $currentUserSid = $currentIdentity.User.Value
  foreach ($name in @($RuntimeTask, $RemoteTask, $DailyTask)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      Write-Host "task=$name exists=false"
      continue
    }
    $info = Get-ScheduledTaskInfo -TaskName $name
    $principalSid = try {
      ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      $null
    }
    $principalMatchesCurrent = (
      -not [string]::IsNullOrWhiteSpace($principalSid) -and
      $principalSid -eq $currentUserSid
    )
    Write-Host "task=$name exists=true state=$($task.State) user_id=$($task.Principal.UserId) current_user_id=$currentUserId principal_matches_current=$($principalMatchesCurrent.ToString().ToLowerInvariant()) logon_type=$($task.Principal.LogonType) last_result=$($info.LastTaskResult) last_run=$($info.LastRunTime) next_run=$($info.NextRunTime)"
  }
}

switch ($Action) {
  "Install" {
    $schedule = New-KaironScheduleFromParameters
    Write-KaironSchedule $schedule
    Register-KaironTasks $schedule
    Show-KaironTasks
  }
  "Start" {
    $schedule = Read-KaironSchedule
    Assert-NoResidualServices
    foreach ($name in @($RemoteTask, $RuntimeTask, $DailyTask)) {
      Enable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
    }
    Start-ScheduledTask -TaskName $RemoteTask
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskName $RuntimeTask
    Write-Host "daily_workload.next_run=$($schedule.daily_workload_at)"
    Show-KaironTasks
  }
  "Stop" {
    Stop-KaironTasks
    Show-KaironTasks
  }
  "Status" { Show-KaironTasks }
  "Uninstall" {
    $stopError = $null
    try {
      Stop-KaironTasks
    } catch {
      $stopError = $_
    } finally {
      foreach ($name in @($DailyTask, $RuntimeTask, $RemoteTask)) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
      }
      Remove-Item -LiteralPath $SchedulePath -Force -ErrorAction SilentlyContinue
    }
    Show-KaironTasks
    if ($null -ne $stopError) {
      throw $stopError
    }
  }
}
