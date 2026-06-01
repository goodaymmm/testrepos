param(
  [Parameter(Mandatory = $true)]
  [string]$KaironRoot,

  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,

  [string]$OutputRoot,

  [ValidateSet("All", "Build", "Doctor", "AgentSmoke", "TaskRun", "ReviewLoop", "RuntimeActive")]
  [string[]]$Test = @("All"),

  [int]$TimeoutMs = 120000,

  [switch]$SkipRestore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Results = @()
$script:RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$script:KaironRoot = (Resolve-Path -LiteralPath $KaironRoot).Path
$script:TargetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path
$script:TargetJs = ($script:TargetRoot -replace "\\", "/")
$script:OutputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $script:KaironRoot "operation-test-results"
} else {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputRoot)
}
$script:RunOutputRoot = Join-Path $script:OutputRoot $script:RunId
$script:BackupRoot = Join-Path $script:RunOutputRoot "backup"
$script:KaironStateBackup = Join-Path $script:BackupRoot "kairon-state"
$script:KaironStateExisted = $false

function New-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Write-KaironJsonNoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 30
  Write-Utf8NoBom -Path (Resolve-Path -LiteralPath $Path).Path -Content ($json + [Environment]::NewLine)
}

function Invoke-Captured {
  param([Parameter(Mandatory = $true)][scriptblock]$Script)

  $output = & $Script 2>&1 | ForEach-Object { $_.ToString() }
  $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }

  [PSCustomObject]@{
    ExitCode = $exitCode
    Output = ($output -join [Environment]::NewLine)
  }
}

function Invoke-InDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][scriptblock]$Script
  )

  Push-Location $Path
  try {
    & $Script
  } finally {
    Pop-Location
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][scriptblock]$Script
  )

  $global:LASTEXITCODE = 0
  $result = Invoke-Captured {
    Invoke-InDirectory -Path $WorkingDirectory -Script $Script
  }

  if ($result.ExitCode -ne 0) {
    throw "Command failed with exit code $($result.ExitCode): $($result.Output)"
  }

  $result.Output
}

function Get-KaironStatusValue {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Key
  )

  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Key))=(.+)$")
  if (-not $match.Success) {
    return $null
  }

  $match.Groups[1].Value.Trim()
}

function Add-Result {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][string]$Details,
    [string]$Evidence = ""
  )

  $script:Results += [PSCustomObject]@{
    id = $Id
    name = $Name
    status = $Status
    details = $Details
    evidence = $Evidence
  }
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Script,
    [Parameter(Mandatory = $true)][scriptblock]$Assert
  )

  Write-Host "[$Id] $Name"
  try {
    $evidence = (& $Script | Out-String).Trim()
    $assertion = & $Assert $evidence
    if ($assertion -eq $true) {
      Add-Result -Id $Id -Name $Name -Status "PASS" -Details "passed" -Evidence $evidence
      Write-Host "[$Id] PASS"
      return
    }

    Add-Result -Id $Id -Name $Name -Status "FAIL" -Details ([string]$assertion) -Evidence $evidence
    Write-Host "[$Id] FAIL"
  } catch {
    $stackTrace = if ($null -eq $_.ScriptStackTrace) { "" } else { $_.ScriptStackTrace }
    Add-Result -Id $Id -Name $Name -Status "FAIL" -Details ($_.Exception.Message) -Evidence $stackTrace
    Write-Host "[$Id] FAIL"
  }
}

function Initialize-StateBackup {
  New-Directory -Path $script:RunOutputRoot
  New-Directory -Path $script:BackupRoot

  $statePath = Join-Path $script:TargetRoot ".kairon"
  if (Test-Path -LiteralPath $statePath) {
    $script:KaironStateExisted = $true
    Copy-Item -LiteralPath $statePath -Destination $script:KaironStateBackup -Recurse -Force
  }
}

function Restore-StateBackup {
  if ($SkipRestore) {
    return
  }

  $statePath = Join-Path $script:TargetRoot ".kairon"
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Recurse -Force
  }

  if ($script:KaironStateExisted) {
    Copy-Item -LiteralPath $script:KaironStateBackup -Destination $statePath -Recurse -Force
  }
}

function Set-KaironScheduleMode {
  param([ValidateSet("active_work", "standby_work", "maintenance")][string]$Mode)

  $schedulePath = Join-Path $script:TargetRoot ".kairon\config\schedule.json"
  $schedule = Get-Content -LiteralPath $schedulePath -Raw | ConvertFrom-Json
  $schedule.timezone = "UTC"

  if ($Mode -eq "active_work") {
    $schedule.active_work_time = @(@{ start = "00:00"; end = "23:59" })
    $schedule.standby_work_time = @()
    $schedule.maintenance_time = @()
  }

  if ($Mode -eq "standby_work") {
    $schedule.active_work_time = @()
    $schedule.standby_work_time = @(@{ start = "00:00"; end = "23:59" })
    $schedule.maintenance_time = @()
  }

  if ($Mode -eq "maintenance") {
    $schedule.active_work_time = @()
    $schedule.standby_work_time = @()
    $schedule.maintenance_time = @(@{ start = "00:00"; end = "23:59" })
  }

  Write-KaironJsonNoBom -Path $schedulePath -Value $schedule
}

function Add-KaironQueueItem {
  param(
    [Parameter(Mandatory = $true)][string]$Type,
    [string]$ScheduleMode = "",
    [int]$Priority = 1000
  )

  $code = @"
import { WorkQueue } from './dist/queue/work-queue.js';
const root = process.argv[1];
const type = process.argv[2];
const scheduleMode = process.argv[3] || undefined;
const priority = Number(process.argv[4] || '1000');
const input = { type, priority };
if (scheduleMode) input.schedule_mode = scheduleMode;
const item = await new WorkQueue(root).enqueue(input);
console.log(item.id);
"@

  Invoke-External -WorkingDirectory $script:KaironRoot -Script {
    node --input-type=module -e $code $script:TargetJs $Type $ScheduleMode $Priority
  }
}

function New-ReviewLoop {
  param([Parameter(Mandatory = $true)][string]$TaskId)

  $code = @"
import { ReviewLoopManager } from './dist/review/review-loop-manager.js';
const root = process.argv[1];
const taskId = process.argv[2];
const manager = new ReviewLoopManager(root);
const state = await manager.start({
  taskId,
  runId: 'RUN-HARNESS-T13',
  implementer: 'codex',
  codeProducing: true,
  commitRequested: true,
  changedFiles: [{ path: 'src/manual-review-target.ts', status: 'modified' }]
});
console.log(state.loop_id);
"@

  Invoke-External -WorkingDirectory $script:KaironRoot -Script {
    node --input-type=module -e $code $script:TargetJs $TaskId
  }
}

function Write-Reports {
  $passed = @($script:Results | Where-Object { $_.status -eq "PASS" }).Count
  $failed = @($script:Results | Where-Object { $_.status -ne "PASS" }).Count
  $summary = [PSCustomObject]@{
    schema_version = "0.1"
    run_id = $script:RunId
    kairon_root = $script:KaironRoot
    target_root = $script:TargetRoot
    restore_enabled = (-not $SkipRestore.IsPresent)
    backup_path = if ($script:KaironStateExisted) { $script:KaironStateBackup } else { $null }
    summary = [PSCustomObject]@{
      pass = $passed
      fail = $failed
      total = $script:Results.Count
    }
    results = $script:Results
    created_at = (Get-Date).ToUniversalTime().ToString("o")
  }

  $jsonPath = Join-Path $script:RunOutputRoot "summary.json"
  $mdPath = Join-Path $script:RunOutputRoot "summary.md"
  Write-Utf8NoBom -Path $jsonPath -Content (($summary | ConvertTo-Json -Depth 30) + [Environment]::NewLine)

  $lines = @(
    "# Kairon Operation Test Summary",
    "",
    "- run_id: $($script:RunId)",
    "- kairon_root: $($script:KaironRoot)",
    "- target_root: $($script:TargetRoot)",
    "- restore_enabled: $(-not $SkipRestore.IsPresent)",
    "- pass: $passed",
    "- fail: $failed",
    "",
    "| ID | Name | Status | Details |",
    "|---|---|---|---|"
  )

  foreach ($result in $script:Results) {
    $details = ($result.details -replace "\|", "\|" -replace "`r?`n", " ")
    $lines += "| $($result.id) | $($result.name) | $($result.status) | $details |"
  }

  Write-Utf8NoBom -Path $mdPath -Content (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
  Write-Host "summary.json=$jsonPath"
  Write-Host "summary.md=$mdPath"
}

function Should-Run {
  param([Parameter(Mandatory = $true)][string]$Name)
  return ($Test -contains "All") -or ($Test -contains $Name)
}

try {
  Initialize-StateBackup

  if (Should-Run "Build") {
    Invoke-Step -Id "BUILD" -Name "Build and link Kairon" -Script {
      Invoke-External -WorkingDirectory $script:KaironRoot -Script { npm run build }
      Invoke-External -WorkingDirectory $script:KaironRoot -Script { npm link }
    } -Assert {
      param($Evidence)
      return $true
    }
  }

  if (Should-Run "Doctor") {
    Invoke-Step -Id "DOCTOR" -Name "Doctor check" -Script {
      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon doctor }
    } -Assert {
      param($Evidence)
      if ($Evidence -match "doctor\.ok=true") { return $true }
      return "doctor.ok=true was not found"
    }
  }

  if (Should-Run "AgentSmoke") {
    Invoke-Step -Id "AGENT_SMOKE" -Name "Agent smoke" -Script {
      $codex = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon agent smoke --agent codex --timeout-ms $TimeoutMs }
      $claude = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon agent smoke --agent claude --timeout-ms $TimeoutMs }
      $gemini = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon agent smoke --agent gemini --timeout-ms $TimeoutMs }
      @(
        "codex_status=$(Get-KaironStatusValue -Text $codex -Key 'status')",
        "claude_status=$(Get-KaironStatusValue -Text $claude -Key 'status')",
        "gemini_status=$(Get-KaironStatusValue -Text $gemini -Key 'status')",
        "",
        $codex,
        "",
        $claude,
        "",
        $gemini
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $codexStatus = Get-KaironStatusValue -Text $Evidence -Key "codex_status"
      $claudeStatus = Get-KaironStatusValue -Text $Evidence -Key "claude_status"
      $geminiStatus = Get-KaironStatusValue -Text $Evidence -Key "gemini_status"

      if ($codexStatus -ne "completed") { return "codex smoke status was $codexStatus" }
      if (@("completed", "setup_required") -notcontains $claudeStatus) { return "claude smoke status was $claudeStatus" }
      if (@("completed", "setup_required") -notcontains $geminiStatus) { return "gemini smoke status was $geminiStatus" }
      return $true
    }
  }

  if (Should-Run "TaskRun") {
    Invoke-Step -Id "TASK_RUN" -Name "Task create and run" -Script {
      $taskText = Invoke-External -WorkingDirectory $script:TargetRoot -Script {
        kairon task create --title "T23 operation task smoke" --persona researcher --capability research --tag operation-test --priority 60
      }
      $taskId = [regex]::Match($taskText, "task_id=(TASK-\d+)").Groups[1].Value
      $runText = Invoke-External -WorkingDirectory $script:TargetRoot -Script {
        kairon task run $taskId --timeout-ms $TimeoutMs
      }
      @(
        "run_status=$(Get-KaironStatusValue -Text $runText -Key 'status')",
        $taskText,
        "",
        $runText
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $status = Get-KaironStatusValue -Text $Evidence -Key "run_status"
      if ($status -eq "completed") { return $true }
      return "task run status was $status"
    }
  }

  if (Should-Run "ReviewLoop") {
    Invoke-Step -Id "REVIEW_LOOP" -Name "Review loop run" -Script {
      $taskText = Invoke-External -WorkingDirectory $script:TargetRoot -Script {
        kairon task create --title "T23 review loop smoke" --persona implementer --capability coding --code-producing --commit-requested --priority 80
      }
      $taskId = [regex]::Match($taskText, "task_id=(TASK-\d+)").Groups[1].Value
      $loopId = (New-ReviewLoop -TaskId $taskId).Trim()
      $reviewText = Invoke-External -WorkingDirectory $script:TargetRoot -Script {
        kairon review run $loopId --timeout-ms $TimeoutMs
      }
      @("loop_id=$loopId", $reviewText) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $status = Get-KaironStatusValue -Text $Evidence -Key "status"
      $disallowed = @(
        "--output-format=stream-json requires --verbose",
        "review outbox is missing review_result",
        "review_result failed schema validation"
      )
      foreach ($needle in $disallowed) {
        if ($Evidence -like "*$needle*") { return "disallowed review evidence found: $needle" }
      }
      if (@("approved", "changes_requested", "setup_required") -contains $status) { return $true }
      return "review loop status was $status"
    }
  }

  if (Should-Run "RuntimeActive") {
    Invoke-Step -Id "RUNTIME_ACTIVE" -Name "Runtime active work tick" -Script {
      $overridePath = Join-Path $script:TargetRoot ".kairon\state\schedule_override.json"
      if (Test-Path -LiteralPath $overridePath) {
        Remove-Item -LiteralPath $overridePath -Force
      }

      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon stop }
      Set-KaironScheduleMode active_work
      $itemId = (Add-KaironQueueItem -Type "maintenance.run" -ScheduleMode "active_work" -Priority 9999).Trim()
      $startText = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon start }
      $tickPath = Join-Path $script:TargetRoot ".kairon\runtime\last-tick.json"
      $tick = Get-Content -LiteralPath $tickPath -Raw | ConvertFrom-Json
      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon stop }
      @(
        "expected_item_id=$itemId",
        $startText,
        "tick.mode=$($tick.mode)",
        "tick.base_mode=$($tick.base_mode)",
        "tick.active_work_closed=$($tick.active_work_closed)",
        "tick.action=$($tick.action)",
        "tick.item_id=$($tick.queue_result.item_id)"
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      if ($Evidence -notmatch "tick\.base_mode=active_work") { return "base_mode was not active_work" }
      if ($Evidence -notmatch "tick\.active_work_closed=False") { return "active_work_closed was not False" }
      if ($Evidence -notmatch "tick\.action=processed-item") { return "runtime action was not processed-item" }
      return $true
    }
  }
} finally {
  Restore-StateBackup
  Write-Reports
}

$failed = @($script:Results | Where-Object { $_.status -ne "PASS" }).Count
if ($failed -gt 0) {
  exit 1
}
