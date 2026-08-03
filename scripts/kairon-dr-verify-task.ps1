[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Register", "Verify", "Unregister", "Run")]
  [string]$Action,

  [string]$TaskName,
  [string]$ProjectRoot,
  [string]$CatalogPath,
  [string]$KaironCommand = "kairon",

  [ValidateRange(1, 168)]
  [int]$IntervalHours = 24,

  [ValidateRange(1, 365)]
  [int]$RehearsalIntervalDays = 30,

  [ValidateRange(1000, 3600000)]
  [int]$TimeoutMs = 600000,

  [ValidateRange(1, 100)]
  [int]$MinimumGenerations = 2
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TaskDescription = "Kairon managed scheduled off-device backup verification"
$taskSchedulerCommon = Join-Path $PSScriptRoot "kairon-task-scheduler-common.ps1"
. $taskSchedulerCommon

function Get-ExpectedTaskPowerShellArguments {
  $scriptPath = $PSCommandPath
  return @(
    "-File",
    $scriptPath,
    "-Action",
    "Run",
    "-ProjectRoot",
    $ProjectRoot,
    "-CatalogPath",
    $CatalogPath,
    "-KaironCommand",
    $KaironCommand,
    "-RehearsalIntervalDays",
    [string]$RehearsalIntervalDays,
    "-TimeoutMs",
    [string]$TimeoutMs,
    "-MinimumGenerations",
    [string]$MinimumGenerations
  )
}

function Get-ExpectedTaskSpec {
  return Get-KaironBackgroundPowerShellActionSpec `
    -ArgumentList (Get-ExpectedTaskPowerShellArguments) `
    -WorkingDirectory $ProjectRoot
}

function Get-ExpectedLegacyTaskArguments {
  return @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (ConvertTo-KaironLegacyTaskArgument $PSCommandPath),
    "-Action",
    "Run",
    "-ProjectRoot",
    (ConvertTo-KaironLegacyTaskArgument $ProjectRoot),
    "-CatalogPath",
    (ConvertTo-KaironLegacyTaskArgument $CatalogPath),
    "-KaironCommand",
    (ConvertTo-KaironLegacyTaskArgument $KaironCommand),
    "-RehearsalIntervalDays",
    $RehearsalIntervalDays,
    "-TimeoutMs",
    $TimeoutMs,
    "-MinimumGenerations",
    $MinimumGenerations
  ) -join " "
}

function Test-KaironManagedTask {
  param([Parameter(Mandatory = $true)]$Task)

  $actions = @($Task.Actions)
  if ($Task.Description -ne $TaskDescription -or $actions.Count -ne 1) {
    return $false
  }

  $taskAction = $actions[0]
  return (
    (Test-KaironBackgroundTaskAction `
      -Action $taskAction `
      -ExpectedSpec (Get-ExpectedTaskSpec)) -or
    (Test-KaironLegacyPowerShellTaskAction `
      -Action $taskAction `
      -ExpectedArguments (Get-ExpectedLegacyTaskArguments))
  )
}

function Show-TaskStatus {
  if ([string]::IsNullOrWhiteSpace($TaskName)) {
    throw "TaskName is required."
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "task.exists=false"
    Write-Output "task.name=$TaskName"
    Write-Output "task.managed=false"
    return
  }

  $managed = Test-KaironManagedTask -Task $task
  $windowMode = Get-KaironTaskWindowMode -Action $task.Actions[0]
  Write-Output "task.exists=true"
  Write-Output "task.name=$TaskName"
  Write-Output "task.managed=$($managed.ToString().ToLowerInvariant())"
  Write-Output "task.state=$($task.State)"
  Write-Output "task.window_mode=$windowMode"
  Write-Output "task.migration_required=$(($managed -and $windowMode -ne 'background').ToString().ToLowerInvariant())"
}

if ($Action -eq "Run") {
  if (
    [string]::IsNullOrWhiteSpace($ProjectRoot) -or
    [string]::IsNullOrWhiteSpace($CatalogPath)
  ) {
    throw "ProjectRoot and CatalogPath are required."
  }
  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
  Set-Location -LiteralPath $resolvedRoot
  & $KaironCommand state backup dr schedule run `
    --catalog-path $CatalogPath `
    --rehearsal-interval-days $RehearsalIntervalDays `
    --timeout-ms $TimeoutMs `
    --minimum-generations $MinimumGenerations
  exit $LASTEXITCODE
}

if (
  [string]::IsNullOrWhiteSpace($TaskName) -or
  [string]::IsNullOrWhiteSpace($ProjectRoot) -or
  [string]::IsNullOrWhiteSpace($CatalogPath)
) {
  throw "TaskName, ProjectRoot, and CatalogPath are required."
}

switch ($Action) {
  "Verify" {
    Show-TaskStatus
    break
  }

  "Unregister" {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      if (-not (Test-KaironManagedTask -Task $task)) {
        Show-TaskStatus
        throw "Refusing to remove a task that is not managed by Kairon."
      }
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Show-TaskStatus
    break
  }

  "Register" {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (
      $null -ne $existing -and
      -not (Test-KaironManagedTask -Task $existing)
    ) {
      Show-TaskStatus
      throw "Refusing to replace a task that is not managed by Kairon."
    }

    $taskAction = New-KaironBackgroundTaskAction -Spec (Get-ExpectedTaskSpec)
    $trigger = New-ScheduledTaskTrigger `
      -Once `
      -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
      -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet `
      -StartWhenAvailable `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit (New-TimeSpan -Seconds ([Math]::Ceiling($TimeoutMs / 1000) + 300))

    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $taskAction `
      -Trigger $trigger `
      -Settings $settings `
      -Description $TaskDescription `
      -Force | Out-Null

    Show-TaskStatus
    break
  }
}
