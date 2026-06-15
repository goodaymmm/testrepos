param(
  [ValidateSet("Register", "Start", "Stop", "Restart", "Status", "Unregister", "Run")]
  [string]$Action = "Status",

  [string]$TaskName = "Kairon Runtime",
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$KaironCommand = "kairon",
  [int]$IntervalMs = 60000,
  [string]$LogRoot = "",
  [switch]$AtStartup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ProjectRoot {
  param([string]$Path)

  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  return $resolved.Path
}

function Get-LogRoot {
  param(
    [string]$Root,
    [string]$ConfiguredLogRoot
  )

  if ([string]::IsNullOrWhiteSpace($ConfiguredLogRoot)) {
    return Join-Path $Root ".kairon\logs\daemon"
  }

  return $ConfiguredLogRoot
}

function Quote-Argument {
  param([string]$Value)

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-RunArguments {
  param(
    [string]$ScriptPath,
    [string]$Root,
    [string]$Command,
    [int]$TickIntervalMs,
    [string]$DaemonLogRoot
  )

  $parts = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Quote-Argument $ScriptPath),
    "-Action",
    "Run",
    "-ProjectRoot",
    (Quote-Argument $Root),
    "-KaironCommand",
    (Quote-Argument $Command),
    "-IntervalMs",
    [string]$TickIntervalMs,
    "-LogRoot",
    (Quote-Argument $DaemonLogRoot)
  )
  return ($parts -join " ")
}

function Assert-WindowsTaskScheduler {
  $isWindowsHost = ($env:OS -eq "Windows_NT") -or
    ([System.IO.Path]::DirectorySeparatorChar -eq "\")
  if ($isWindowsHost -eq $false) {
    throw "Task Scheduler helper requires Windows."
  }

  $null = Get-Command Register-ScheduledTask -ErrorAction Stop
}

function Invoke-KaironDaemon {
  param(
    [string]$Root,
    [string]$Command,
    [int]$TickIntervalMs,
    [string]$DaemonLogRoot
  )

  New-Item -ItemType Directory -Force -Path $DaemonLogRoot | Out-Null
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $logPath = Join-Path $DaemonLogRoot "kairon-daemon-$timestamp.log"

  Set-Location -LiteralPath $Root
  "started_at=$(Get-Date -Format o)" | Out-File -FilePath $logPath -Encoding utf8
  "project_root=$Root" | Out-File -FilePath $logPath -Encoding utf8 -Append
  "command=$Command start --daemon --interval-ms $TickIntervalMs" |
    Out-File -FilePath $logPath -Encoding utf8 -Append

  & $Command start --daemon --interval-ms $TickIntervalMs *>> $logPath
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  "finished_at=$(Get-Date -Format o)" | Out-File -FilePath $logPath -Encoding utf8 -Append
  "exit_code=$exitCode" | Out-File -FilePath $logPath -Encoding utf8 -Append
  Write-Host "daemon_log=$logPath"
  exit $exitCode
}

function Register-KaironTask {
  param(
    [string]$Name,
    [string]$Root,
    [string]$Command,
    [int]$TickIntervalMs,
    [string]$DaemonLogRoot,
    [bool]$UseStartupTrigger
  )

  Assert-WindowsTaskScheduler
  $scriptPath = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw "Script path is unavailable. Run this helper from a saved .ps1 file."
  }

  New-Item -ItemType Directory -Force -Path $DaemonLogRoot | Out-Null
  $execute = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) {
    "pwsh.exe"
  } else {
    "powershell.exe"
  }
  $arguments = Get-RunArguments `
    -ScriptPath $scriptPath `
    -Root $Root `
    -Command $Command `
    -TickIntervalMs $TickIntervalMs `
    -DaemonLogRoot $DaemonLogRoot
  $trigger = if ($UseStartupTrigger) {
    New-ScheduledTaskTrigger -AtStartup
  } else {
    New-ScheduledTaskTrigger -AtLogOn
  }
  $action = New-ScheduledTaskAction `
    -Execute $execute `
    -Argument $arguments `
    -WorkingDirectory $Root
  $principalUserId = if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) {
    $env:USERNAME
  } else {
    "$env:USERDOMAIN\$env:USERNAME"
  }
  $principal = New-ScheduledTaskPrincipal `
    -UserId $principalUserId `
    -LogonType Interactive `
    -RunLevel LeastPrivilege
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 1)

  Register-ScheduledTask `
    -TaskName $Name `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Runs kairon start --daemon for $Root. Secrets are read from user environment variables." `
    -Force | Out-Null

  Write-Host "task_registered=$Name"
  Write-Host "project_root=$Root"
  Write-Host "log_root=$DaemonLogRoot"
}

function Show-KaironTaskStatus {
  param([string]$Name)

  Assert-WindowsTaskScheduler
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Host "task.exists=false"
    return
  }

  $info = Get-ScheduledTaskInfo -TaskName $Name
  Write-Host "task.exists=true"
  Write-Host "task.name=$Name"
  Write-Host "task.state=$($task.State)"
  Write-Host "task.lastRunTime=$($info.LastRunTime)"
  Write-Host "task.lastTaskResult=$($info.LastTaskResult)"
  Write-Host "task.nextRunTime=$($info.NextRunTime)"
}

$resolvedProjectRoot = Resolve-ProjectRoot $ProjectRoot
$resolvedLogRoot = Get-LogRoot -Root $resolvedProjectRoot -ConfiguredLogRoot $LogRoot

switch ($Action) {
  "Register" {
    Register-KaironTask `
      -Name $TaskName `
      -Root $resolvedProjectRoot `
      -Command $KaironCommand `
      -TickIntervalMs $IntervalMs `
      -DaemonLogRoot $resolvedLogRoot `
      -UseStartupTrigger ([bool]$AtStartup)
  }
  "Start" {
    Assert-WindowsTaskScheduler
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "task_started=$TaskName"
  }
  "Stop" {
    Set-Location -LiteralPath $resolvedProjectRoot
    & $KaironCommand stop
    Assert-WindowsTaskScheduler
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "task_stopped=$TaskName"
  }
  "Restart" {
    Set-Location -LiteralPath $resolvedProjectRoot
    & $KaironCommand stop
    Assert-WindowsTaskScheduler
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "task_restarted=$TaskName"
  }
  "Status" {
    Show-KaironTaskStatus -Name $TaskName
  }
  "Unregister" {
    Assert-WindowsTaskScheduler
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "task_unregistered=$TaskName"
  }
  "Run" {
    Invoke-KaironDaemon `
      -Root $resolvedProjectRoot `
      -Command $KaironCommand `
      -TickIntervalMs $IntervalMs `
      -DaemonLogRoot $resolvedLogRoot
  }
}
