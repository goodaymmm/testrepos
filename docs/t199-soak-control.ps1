param(
  [ValidateSet("Preflight", "Start", "Status", "Checkpoint", "Stop", "MarkReboot", "Certify")]
  [string]$Action = "Preflight",
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [string]$ReleaseVerification = "",
  [string]$SoakId = "",
  [ValidateSet(3, 24)]
  [int]$CheckpointHours = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Node = if (Test-Path "C:\nvm4w\nodejs\node.exe") {
  "C:\nvm4w\nodejs\node.exe"
} else {
  (Get-Command node -ErrorAction Stop).Source
}
$Cli = Join-Path $RepositoryRoot "dist\cli\main.js"
$TaskHelper = Join-Path $PSScriptRoot "t199-soak-tasks.ps1"
$VerificationPointer = Join-Path $RepositoryRoot "operation-test-results\manual-t199-live\stable-verification-path.txt"
$CheckpointRoot = Join-Path $RepositoryRoot "operation-test-results\manual-t199-live\checkpoints"
$QueueStatePath = Join-Path $ProjectRoot ".kairon\state\queue.json"
$IncidentRoot = Join-Path $ProjectRoot ".kairon\incidents"
$DaemonLogRoot = Join-Path $ProjectRoot ".kairon\runtime\daemon"
$RemoteSupervisorStatusPath = Join-Path $ProjectRoot ".kairon\runtime\t199-remote-supervisor.json"
$BoardServerStatusPath = Join-Path $ProjectRoot ".kairon\runtime\board\server.json"
$DiscordHttpStatusPath = Join-Path $ProjectRoot ".kairon\runtime\discord\http-server.json"
$SchedulePath = Join-Path $ProjectRoot ".kairon\config\t199-soak-schedule.json"

function Resolve-VerificationPath {
  if (-not [string]::IsNullOrWhiteSpace($ReleaseVerification)) {
    return $ReleaseVerification
  }
  if (Test-Path $VerificationPointer) {
    return (Get-Content $VerificationPointer -Raw -Encoding UTF8).Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($env:KAIRON_T199_STABLE_VERIFICATION)) {
    return $env:KAIRON_T199_STABLE_VERIFICATION
  }
  throw "A current PASS Stable verification is required."
}

function Resolve-SoakId {
  if (-not [string]::IsNullOrWhiteSpace($SoakId)) { return $SoakId }
  $latestPath = Join-Path $ProjectRoot ".kairon\runtime\soak\latest.json"
  if (-not (Test-Path $latestPath)) { throw "Stable soak latest artifact is missing." }
  return (Get-Content $latestPath -Raw -Encoding UTF8 | ConvertFrom-Json).soak_id
}

function Invoke-Kairon([string[]]$Arguments) {
  Push-Location $ProjectRoot
  try {
    & $Node $Cli @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Kairon command failed: $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-KaironJson([string[]]$Arguments) {
  Push-Location $ProjectRoot
  try {
    $output = @(& $Node $Cli @Arguments)
    if ($LASTEXITCODE -ne 0) {
      throw "Kairon command failed: $($Arguments -join ' ')"
    }
    try {
      return ($output -join "`n") | ConvertFrom-Json
    } catch {
      throw "Kairon command did not return valid JSON: $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Get-SoakTaskStatus {
  $requiredRunning = @("Kairon T199 Runtime", "Kairon T199 Remote Services")
  $names = @($requiredRunning) + "Kairon T199 Daily Workload"
  return @(
    foreach ($name in $names) {
      $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
      $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
      [ordered]@{
        name = $name
        state = [string]$task.State
        required_running = $requiredRunning -contains $name
        last_result = $info.LastTaskResult
        last_run = $info.LastRunTime.ToString("o")
        next_run = $info.NextRunTime.ToString("o")
      }
    }
  )
}

function Write-CheckpointArtifact([System.Collections.IDictionary]$Artifact) {
  New-Item -ItemType Directory -Force $CheckpointRoot | Out-Null
  $stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
  $path = Join-Path $CheckpointRoot "$($Artifact.soak_id)-$($Artifact.checkpoint_hours)h-$stamp.json"
  $json = $Artifact | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText(
    $path,
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
  return $path
}

function Get-BlockingQueueItems {
  if (-not (Test-Path -LiteralPath $QueueStatePath -PathType Leaf)) {
    return @()
  }
  $state = Get-Content -LiteralPath $QueueStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  return @($state.items | Where-Object { $_.status -in @("ready", "claimed") })
}

function Assert-CleanQueue {
  $blocking = @(Get-BlockingQueueItems)
  foreach ($item in $blocking) {
    Write-Host "queue.blocking_item=$($item.id) status=$($item.status) type=$($item.type) created_at=$($item.created_at)"
  }
  if ($blocking.Count -gt 0) {
    throw "T199 requires an empty ready/claimed queue. Back up and resolve the listed items before Preflight."
  }
  Write-Host "queue.preexisting_ready=0"
  Write-Host "queue.preexisting_claimed=0"
}

function Assert-NoBlockingIncidents {
  if (-not (Test-Path -LiteralPath $IncidentRoot -PathType Container)) {
    Write-Host "incidents.unresolved_high=0"
    Write-Host "incidents.unresolved_critical=0"
    return
  }
  $blocking = @(
    Get-ChildItem -LiteralPath $IncidentRoot -Filter "INC-*.json" -File |
      Where-Object { $_.BaseName -match '^INC-\d{4}$' } |
      ForEach-Object {
        try {
          Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
          throw "Incident artifact is invalid: $($_.FullName)"
        }
      } |
      Where-Object {
        $_.status -ne "resolved" -and $_.severity -in @("high", "critical")
      }
  )
  foreach ($incident in $blocking) {
    Write-Host "incident.blocking=$($incident.incident_id) status=$($incident.status) severity=$($incident.severity) title=$($incident.title)"
  }
  if ($blocking.Count -gt 0) {
    throw "T199 requires all HIGH/CRITICAL incidents to be resolved before Preflight or Start."
  }
  Write-Host "incidents.unresolved_high=0"
  Write-Host "incidents.unresolved_critical=0"
}

function Read-JsonStatus([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Read-T199Schedule {
  if (-not (Test-Path -LiteralPath $SchedulePath -PathType Leaf)) {
    throw "T199 schedule is not registered. Register explicit times after the code build."
  }
  $schedule = Get-Content -LiteralPath $SchedulePath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($name in @("start_window_from", "start_window_to", "daily_workload_at")) {
    $value = [string]$schedule.$name
    if ($value -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') {
      throw "T199 schedule contains an invalid $name value: $value"
    }
  }
  return $schedule
}

function Convert-T199TimeOfDay([string]$Value) {
  return [TimeSpan]::ParseExact(
    $Value,
    "hh\:mm",
    [Globalization.CultureInfo]::InvariantCulture
  )
}

function Get-LatestDaemonStartedAt {
  if (-not (Test-Path -LiteralPath $DaemonLogRoot -PathType Container)) {
    return $null
  }
  $started = @(
    Get-ChildItem -LiteralPath $DaemonLogRoot -Filter "*.jsonl" -File |
      ForEach-Object {
        Get-Content -LiteralPath $_.FullName -Encoding UTF8 |
          ForEach-Object {
            try {
              $event = $_ | ConvertFrom-Json
              if ($event.event -eq "started" -and -not [string]::IsNullOrWhiteSpace($event.created_at)) {
                [DateTimeOffset]::Parse($event.created_at)
              }
            } catch {
              # Ignore a partially written final JSONL record and retry on the next poll.
            }
          }
      }
  )
  return $started | Sort-Object -Descending | Select-Object -First 1
}

function Test-StatusFresh([object]$Status, [DateTimeOffset]$NotBefore) {
  if ($null -eq $Status -or [string]::IsNullOrWhiteSpace($Status.updated_at)) {
    return $false
  }
  return [DateTimeOffset]::Parse($Status.updated_at) -ge $NotBefore
}

function Wait-SoakServices([DateTimeOffset]$NotBefore, [int]$TimeoutSeconds = 180) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastReason = "services_not_checked"
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $daemonStartedAt = Get-LatestDaemonStartedAt
    $supervisor = Read-JsonStatus $RemoteSupervisorStatusPath
    $board = Read-JsonStatus $BoardServerStatusPath
    $discord = Read-JsonStatus $DiscordHttpStatusPath
    $runtimeTask = Get-ScheduledTask -TaskName "Kairon T199 Runtime" -ErrorAction SilentlyContinue
    $remoteTask = Get-ScheduledTask -TaskName "Kairon T199 Remote Services" -ErrorAction SilentlyContinue
    $serviceRecords = if ($null -eq $supervisor) {
      @()
    } else {
      @($supervisor.services.PSObject.Properties.Value)
    }
    $servicesRunning = (
      $serviceRecords.Count -ge 4 -and
      @($serviceRecords | Where-Object { -not [bool]$_.running }).Count -eq 0
    )
    $runtimeTaskRunning = $null -ne $runtimeTask -and $runtimeTask.State -eq "Running"
    $remoteTaskRunning = $null -ne $remoteTask -and $remoteTask.State -eq "Running"
    $supervisorReady = (
      $null -ne $supervisor -and
      $supervisor.status -eq "running" -and
      (Test-StatusFresh $supervisor $NotBefore)
    )
    $boardReady = (
      $null -ne $board -and
      $board.status -eq "ready" -and
      (Test-StatusFresh $board $NotBefore)
    )
    $discordReady = (
      $null -ne $discord -and
      $discord.status -eq "ready" -and
      (Test-StatusFresh $discord $NotBefore)
    )
    $locallyReady = (
      $null -ne $daemonStartedAt -and
      $daemonStartedAt -ge $NotBefore -and
      $runtimeTaskRunning -and
      $remoteTaskRunning -and
      $supervisorReady -and
      $servicesRunning -and
      $boardReady -and
      $discordReady
    )
    if ($locallyReady) {
      try {
        $remote = Invoke-KaironJson @("remote", "doctor", "--format", "json")
        if (
          $remote.status -eq "ready" -and
          $remote.discord.external_readiness -eq "ready" -and
          $remote.board.external_readiness -eq "identity_enforced" -and
          $remote.tunnel.status -eq "connected"
        ) {
          return [ordered]@{
            daemon_started_at = $daemonStartedAt.ToString("o")
            supervisor_updated_at = $supervisor.updated_at
            board_updated_at = $board.updated_at
            discord_updated_at = $discord.updated_at
            remote_status = $remote.status
          }
        }
        $lastReason = "remote_not_ready:$($remote.status):$($remote.issues -join ',')"
      } catch {
        $lastReason = "remote_probe_failed:$($_.Exception.Message)"
      }
    } else {
      $lastReason = @(
        "local_services_not_ready",
        "daemon_fresh=$($null -ne $daemonStartedAt -and $daemonStartedAt -ge $NotBefore)",
        "runtime_task_running=$runtimeTaskRunning",
        "remote_task_running=$remoteTaskRunning",
        "supervisor_ready=$supervisorReady",
        "services_running=$servicesRunning",
        "board_ready=$boardReady",
        "discord_ready=$discordReady"
      ) -join ":"
    }
    Start-Sleep -Seconds 2
  }
  throw "T199 services did not become ready within ${TimeoutSeconds}s. last_reason=$lastReason"
}

switch ($Action) {
  "Preflight" {
    $schedule = Read-T199Schedule
    $verification = Resolve-VerificationPath
    $absolute = if ([System.IO.Path]::IsPathRooted($verification)) {
      $verification
    } else {
      Join-Path $ProjectRoot $verification
    }
    if (-not (Test-Path $absolute)) { throw "Stable verification does not exist: $absolute" }
    $artifact = Get-Content $absolute -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($artifact.status -ne "PASS" -or $artifact.integrity_status -ne "PASS" -or $artifact.currentness_status -ne "PASS") {
      throw "Stable verification is not a current integrity PASS."
    }
    if ([DateTimeOffset]::Parse($artifact.expires_at) -le [DateTimeOffset]::UtcNow) {
      throw "Stable verification is expired. Rerun PublishAndVerify immediately before Start."
    }
    Assert-CleanQueue
    Assert-NoBlockingIncidents
    & $TaskHelper -Action Status -ProjectRoot $ProjectRoot
    Invoke-Kairon @("remote", "profile", "validate")
    Write-Host "preflight.status=ready"
    Write-Host "release_verification=$verification"
    Write-Host "start_window=$($schedule.start_window_from)-$($schedule.start_window_to)"
    Write-Host "daily_workload.next_run=$($schedule.daily_workload_at)"
  }
  "Start" {
    $schedule = Read-T199Schedule
    $verification = Resolve-VerificationPath
    Write-Host "release_verification=$verification"
    $localNow = Get-Date
    $windowFrom = Convert-T199TimeOfDay ([string]$schedule.start_window_from)
    $windowTo = Convert-T199TimeOfDay ([string]$schedule.start_window_to)
    if (
      $localNow.TimeOfDay -lt $windowFrom -or
      $localNow.TimeOfDay -gt $windowTo
    ) {
      throw "Start T199 between $($schedule.start_window_from) and $($schedule.start_window_to) local time so the $($schedule.daily_workload_at) daily workload covers the first and final day."
    }
    Assert-CleanQueue
    Assert-NoBlockingIncidents
    $servicesRequestedAt = [DateTimeOffset]::UtcNow
    try {
      & $TaskHelper -Action Start -ProjectRoot $ProjectRoot
      $readiness = Wait-SoakServices $servicesRequestedAt
      Write-Host "services.readiness=ready"
      Write-Host "services.daemon_started_at=$($readiness.daemon_started_at)"
      Write-Host "services.remote_status=$($readiness.remote_status)"
    } catch {
      $startError = $_
      try {
        & $TaskHelper -Action Stop -ProjectRoot $ProjectRoot
      } catch {
        Write-Warning "T199 cleanup after failed Start also failed: $($_.Exception.Message)"
      }
      throw $startError
    }
    Push-Location $ProjectRoot
    try {
      $output = & $Node $Cli daemon soak start `
        --release-verification $verification `
        --minimum-hours 168
      $output
      if ($LASTEXITCODE -ne 0) { throw "Stable soak start failed." }
      $id = [regex]::Match(($output -join "`n"), 'soak_id=(SSK-[0-9]{14}-[a-f0-9]{12})').Groups[1].Value
      if ([string]::IsNullOrWhiteSpace($id)) { throw "Stable soak id was not emitted." }
      $startedAt = Get-Date
      $dailyWorkloadAt = Convert-T199TimeOfDay ([string]$schedule.daily_workload_at)
      $firstDailyWorkload = $startedAt.Date.Add($dailyWorkloadAt)
      if ($firstDailyWorkload -lt $startedAt) {
        $firstDailyWorkload = $firstDailyWorkload.AddDays(1)
      }
      Write-Host "IMPORTANT: keep the verified Stable release available until certification completes."
      Write-Host "soak_id=$id"
      Write-Host "checkpoint_3h_not_before=$($startedAt.AddHours(3).ToString('o'))"
      Write-Host "checkpoint_24h_not_before=$($firstDailyWorkload.AddDays(1).AddMinutes(15).ToString('o'))"
      Write-Host "certification_168h_not_before=$($firstDailyWorkload.AddDays(7).AddMinutes(15).ToString('o'))"
    } finally {
      Pop-Location
    }
  }
  "Status" {
    $id = Resolve-SoakId
    Invoke-Kairon @("daemon", "soak", "status", $id, "--format", "json")
    Invoke-Kairon @("metrics", "slo", "check")
    Invoke-Kairon @("remote", "doctor", "--format", "json")
    & $TaskHelper -Action Status -ProjectRoot $ProjectRoot
  }
  "Checkpoint" {
    $id = Resolve-SoakId
    $evaluation = Invoke-KaironJson @(
      "daemon", "soak", "status", $id, "--format", "json"
    )
    $remote = Invoke-KaironJson @("remote", "doctor", "--format", "json")
    $tasks = Get-SoakTaskStatus
    $reasons = @($evaluation.reasons)
    $blockingReasons = @(
      $reasons | Where-Object { $_ -ne "minimum_duration_not_reached" }
    )
    $badSloStatuses = @(
      @($evaluation.slo_statuses) |
        Where-Object { $_ -in @("CRITICAL", "CORRUPT_DATA", "INSUFFICIENT_DATA") }
    )
    $taskFailures = @(
      $tasks | Where-Object {
        ($_.required_running -and $_.state -ne "Running") -or
        (-not $_.required_running -and $_.state -notin @("Ready", "Running")) -or
        ($_.name -eq "Kairon T199 Daily Workload" -and $_.last_result -ne 0)
      }
    )
    $durationReached = [double]$evaluation.elapsed_hours -ge $CheckpointHours
    $healthy = (
      $durationReached -and
      $evaluation.evidence_mode -eq "real_time" -and
      $evaluation.status -eq "SETUP_REQUIRED" -and
      [double]$evaluation.coverage_ratio -ge 0.99 -and
      [int]$evaluation.daemon.fatal_errors -eq 0 -and
      [int]$evaluation.daemon.unexpected_restarts -eq 0 -and
      [int]$evaluation.daemon.unexplained_gaps -eq 0 -and
      [int]$evaluation.incidents.high -eq 0 -and
      [int]$evaluation.incidents.critical -eq 0 -and
      -not [bool]$evaluation.release_drift -and
      $blockingReasons.Count -eq 0 -and
      @($evaluation.slo_statuses).Count -gt 0 -and
      $badSloStatuses.Count -eq 0 -and
      $remote.status -eq "ready" -and
      $remote.discord.external_readiness -eq "ready" -and
      $remote.board.external_readiness -eq "identity_enforced" -and
      $remote.tunnel.status -eq "connected" -and
      $taskFailures.Count -eq 0
    )
    $artifact = [ordered]@{
      schema_version = "0.1"
      artifact_kind = "t199_staged_soak_checkpoint"
      soak_id = $id
      checkpoint_hours = $CheckpointHours
      status = if ($healthy) { "PASS" } else { "FAIL" }
      evaluated_at = [DateTimeOffset]::UtcNow.ToString("o")
      soak = $evaluation
      remote = $remote
      tasks = $tasks
      blocking_reasons = $blockingReasons
      bad_slo_statuses = $badSloStatuses
      task_failures = $taskFailures
    }
    $path = Write-CheckpointArtifact $artifact
    Write-Host "checkpoint.status=$($artifact.status)"
    Write-Host "checkpoint.hours=$CheckpointHours"
    Write-Host "checkpoint.elapsed_hours=$($evaluation.elapsed_hours)"
    Write-Host "checkpoint.coverage_ratio=$($evaluation.coverage_ratio)"
    Write-Host "checkpoint.artifact=$path"
    if (-not $healthy) {
      throw "T199 ${CheckpointHours}h checkpoint failed. Stop before continuing to the next stage."
    }
    Write-Host "checkpoint.next_stage=$(if ($CheckpointHours -eq 3) { 'continue_to_24h' } else { 'continue_to_168h' })"
  }
  "Stop" {
    & $TaskHelper -Action Stop -ProjectRoot $ProjectRoot
    Write-Host "soak.runtime_stopped=true"
    Write-Host "IMPORTANT: inspect checkpoint evidence, then run t199-release-fixture.ps1 -Action Cleanup."
  }
  "MarkReboot" {
    $id = Resolve-SoakId
    $from = [DateTimeOffset]::UtcNow.AddMinutes(5)
    $until = $from.AddMinutes(30)
    Invoke-Kairon @(
      "daemon", "soak", "mark", $id,
      "--kind", "planned_reboot",
      "--from", $from.ToString("o"),
      "--until", $until.ToString("o"),
      "--reason", "Planned Windows reboot during T199 Stable soak"
    )
    Write-Host "Reboot Windows between $($from.ToLocalTime()) and $($until.ToLocalTime())."
  }
  "Certify" {
    $id = Resolve-SoakId
    Invoke-Kairon @("daemon", "soak", "certify", $id, "--format", "json")
    Write-Host "After PASS, run t199-release-fixture.ps1 -Action Cleanup."
  }
}
