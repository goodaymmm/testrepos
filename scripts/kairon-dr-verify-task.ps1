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

function Quote-TaskArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-ExpectedTaskArguments {
  $scriptPath = $PSCommandPath
  return @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Quote-TaskArgument $scriptPath),
    "-Action",
    "Run",
    "-ProjectRoot",
    (Quote-TaskArgument $ProjectRoot),
    "-CatalogPath",
    (Quote-TaskArgument $CatalogPath),
    "-KaironCommand",
    (Quote-TaskArgument $KaironCommand),
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
    [System.IO.Path]::GetFileName([string]$taskAction.Execute) -ieq
      "powershell.exe" -and
    $taskAction.Arguments -eq (Get-ExpectedTaskArguments)
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
  Write-Output "task.exists=true"
  Write-Output "task.name=$TaskName"
  Write-Output "task.managed=$($managed.ToString().ToLowerInvariant())"
  Write-Output "task.state=$($task.State)"
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

    $taskAction = New-ScheduledTaskAction `
      -Execute "powershell.exe" `
      -Argument (Get-ExpectedTaskArguments)
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
