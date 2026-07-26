[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Register", "Verify", "Unregister")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TaskName,

  [string]$RegistryPath,
  [string]$KaironCommand = "kairon",
  [ValidateRange(1, 10080)]
  [int]$IntervalMinutes = 60,
  [ValidateRange(1, 3600000)]
  [int]$ProjectTimeoutMs = 5000,
  [ValidateRange(1, 64)]
  [int]$Concurrency = 4,
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 30,
  [ValidateSet("warning", "error")]
  [string]$AlertThreshold = "warning",
  [ValidateRange(1, 100000)]
  [int]$ProviderPressureThreshold = 8
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Quote-TaskArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Show-TaskStatus {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Output "task.exists=false"
    Write-Output "task.name=$TaskName"
    return
  }

  Write-Output "task.exists=true"
  Write-Output "task.name=$TaskName"
  Write-Output "task.state=$($task.State)"
}

switch ($Action) {
  "Verify" {
    Show-TaskStatus
    break
  }

  "Unregister" {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Show-TaskStatus
    break
  }

  "Register" {
    if ([string]::IsNullOrWhiteSpace($RegistryPath)) {
      throw "RegistryPath is required for registration."
    }

    $arguments = @(
      "projects",
      "health",
      "scan",
      "--registry-path",
      (Quote-TaskArgument $RegistryPath),
      "--project-timeout-ms",
      [string]$ProjectTimeoutMs,
      "--concurrency",
      [string]$Concurrency,
      "--retention-days",
      [string]$RetentionDays,
      "--alert-threshold",
      $AlertThreshold,
      "--provider-pressure-threshold",
      [string]$ProviderPressureThreshold
    ) -join " "

    $taskAction = New-ScheduledTaskAction `
      -Execute $KaironCommand `
      -Argument $arguments
    $trigger = New-ScheduledTaskTrigger `
      -Once `
      -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
      -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet `
      -StartWhenAvailable `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $taskAction `
      -Trigger $trigger `
      -Settings $settings `
      -Description "Kairon read-only scheduled multi-project health scan" `
      -Force | Out-Null

    Show-TaskStatus
    break
  }
}
