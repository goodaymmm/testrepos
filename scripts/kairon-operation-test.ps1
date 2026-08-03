param(
  [Parameter(Mandatory = $true)]
  [string]$KaironRoot,

  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,

  [string]$OutputRoot,

  [ValidateSet(
    "All",
    "Build",
    "Doctor",
    "AgentSmoke",
    "TaskRun",
    "ReviewLoop",
    "RuntimeActive",
    "RuntimeReview",
    "DiscordLiveReady",
    "DiscordInvalidEnv",
    "DiscordSetupError",
    "ApprovalNotificationAudit",
    "DiscordDecisionAuditLive",
    "RuntimeRecovery",
    "BranchProtectionPublicSandbox",
    "StableAcceptanceManifest"
  )]
  [string[]]$Test = @("All"),

  [int]$TimeoutMs = 120000,

  [string]$DiscordSetupErrorGuildId = "111111111111111111",

  [string]$DiscordSetupErrorApprovalChannelId = "222222222222222222",

  [string]$DiscordDecisionAuditApprovalId = "",

  [ValidateSet("approve", "reject", "request_changes", "snooze")]
  [string]$DiscordDecisionAuditExpectedAction = "approve",

  [int]$DiscordDecisionAuditTimeoutSeconds = 0,

  [string]$BranchProtectionSandboxRoot = "",

  [ValidateSet("Goodaymmm14Forge", "Custom")]
  [string]$BranchProtectionSandboxFixture = "Goodaymmm14Forge",

  [string]$BranchProtectionSandboxRepoUrl = "",

  [string]$BranchProtectionSandboxBranch = "main",

  [string]$BranchProtectionExpectedStatusChecks = "",

  [switch]$BranchProtectionRequireToken,

  [string]$StableAcceptanceManifestPath = "",

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
  $resolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  Write-Utf8NoBom -Path $resolvedPath -Content ($json + [Environment]::NewLine)
}

function Invoke-Captured {
  param([Parameter(Mandatory = $true)][Alias("Script")][scriptblock]$CommandBlock)

  $output = & $CommandBlock 2>&1 | ForEach-Object { $_.ToString() }
  $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }

  [PSCustomObject]@{
    ExitCode = $exitCode
    Output = ($output -join [Environment]::NewLine)
  }
}

function Invoke-InDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][Alias("Script")][scriptblock]$CommandBlock
  )

  Push-Location $Path
  try {
    & $CommandBlock
  } finally {
    Pop-Location
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][Alias("Script")][scriptblock]$CommandBlock
  )

  $global:LASTEXITCODE = 0
  $externalCommand = $CommandBlock
  $result = Invoke-Captured {
    Invoke-InDirectory -Path $WorkingDirectory -CommandBlock $externalCommand
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

function Get-ObjectPropertyValue {
  param(
    $Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  $property.Value
}

function Test-HasProperty {
  param(
    $Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  return ($null -ne $Object) -and ($null -ne $Object.PSObject.Properties[$Name])
}

function New-StepResult {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("PASS", "FAIL", "SETUP_REQUIRED", "OPTIONAL")]
    [string]$Status,

    [Parameter(Mandatory = $true)][string]$Details
  )

  [PSCustomObject]@{
    Status = $Status
    Details = $Details
  }
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

function Invoke-StepScript {
  param([Parameter(Mandatory = $true)][scriptblock]$Script)

  & $Script
}

function Invoke-StepAssert {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Assert,
    [Parameter(Mandatory = $true)][string]$Evidence
  )

  & $Assert $Evidence
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
    $evidence = (Invoke-StepScript -Script $Script | Out-String).Trim()
    $assertion = Invoke-StepAssert -Assert $Assert -Evidence $evidence
    if ($assertion -eq $true) {
      Add-Result -Id $Id -Name $Name -Status "PASS" -Details "passed" -Evidence $evidence
      Write-Host "[$Id] PASS"
      return
    }

    if (Test-HasProperty -Object $assertion -Name "Status") {
      $status = [string](Get-ObjectPropertyValue -Object $assertion -Name "Status")
      $details = [string](Get-ObjectPropertyValue -Object $assertion -Name "Details")
      if ([string]::IsNullOrWhiteSpace($details)) {
        $details = $status
      }
      Add-Result -Id $Id -Name $Name -Status $status -Details $details -Evidence $evidence
      Write-Host "[$Id] $status"
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

function Invoke-KaironCaptured {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Script
  )

  $global:LASTEXITCODE = 0
  Invoke-Captured {
    Invoke-InDirectory -Path $script:TargetRoot -CommandBlock $Script
  }
}

function Invoke-WithEnvOverrides {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Values,
    [Parameter(Mandatory = $true)][scriptblock]$Script
  )

  $previous = @{}
  foreach ($key in $Values.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Values[$key], "Process")
  }

  try {
    & $Script
  } finally {
    foreach ($key in $Values.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Get-FileTextOrEmpty {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return ""
  }

  Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
}

function Start-KaironDaemonForManualDiscordDecision {
  param([Parameter(Mandatory = $true)][int]$TimeoutSeconds)

  $daemonMaxTicks = [Math]::Max(3, $TimeoutSeconds + 10)
  $stdoutPath = Join-Path $script:RunOutputRoot "discord-decision-audit-daemon.stdout.log"
  $stderrPath = Join-Path $script:RunOutputRoot "discord-decision-audit-daemon.stderr.log"

  $job = Start-Job -ScriptBlock {
    param(
      [Parameter(Mandatory = $true)][string]$TargetRoot,
      [Parameter(Mandatory = $true)][int]$MaxTicks
    )

    Set-Location -LiteralPath $TargetRoot
    $global:LASTEXITCODE = 0
    $output = kairon start --daemon --interval-ms 1000 --max-ticks $MaxTicks 2>&1 |
      ForEach-Object { $_.ToString() }
    $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }
    [PSCustomObject]@{
      ExitCode = $exitCode
      Output = ($output -join [Environment]::NewLine)
    }
  } -ArgumentList $script:TargetRoot, $daemonMaxTicks

  [PSCustomObject]@{
    Job = $job
    MaxTicks = $daemonMaxTicks
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    ExitCode = $null
    TimedOut = $false
  }
}

function Stop-KaironDaemonForManualDiscordDecision {
  param($Daemon)

  $stop = Invoke-KaironCaptured { kairon stop }
  if ($null -ne $Daemon) {
    try {
      Wait-Job -Job $Daemon.Job -Timeout 15 | Out-Null
      if ($Daemon.Job.State -eq "Running") {
        $Daemon.TimedOut = $true
        Stop-Job -Job $Daemon.Job -ErrorAction SilentlyContinue
        Wait-Job -Job $Daemon.Job -Timeout 5 | Out-Null
      }
      $received = @(Receive-Job -Job $Daemon.Job -ErrorAction SilentlyContinue)
      $daemonExitCode = ""
      $daemonOutput = @()
      foreach ($item in $received) {
        if (Test-HasProperty -Object $item -Name "ExitCode") {
          $daemonExitCode = Get-ObjectPropertyValue -Object $item -Name "ExitCode"
          $daemonOutput += Get-ObjectPropertyValue -Object $item -Name "Output"
        } else {
          $daemonOutput += $item.ToString()
        }
      }
      $Daemon.ExitCode = $daemonExitCode
      Write-Utf8NoBom -Path $Daemon.StdoutPath -Content (($daemonOutput -join [Environment]::NewLine) + [Environment]::NewLine)
      Write-Utf8NoBom -Path $Daemon.StderrPath -Content ""
      Remove-Job -Job $Daemon.Job -Force -ErrorAction SilentlyContinue
    } catch {
      # Best-effort cleanup; the stop command above is the canonical shutdown path.
    }
  }

  $stop
}

function Hide-NonTargetApprovalsForDiscordDecisionAudit {
  param([Parameter(Mandatory = $true)][string]$ApprovalId)

  $approvalsDir = Join-Path $script:TargetRoot ".kairon\approvals"
  $hiddenDir = Join-Path $script:RunOutputRoot "discord-decision-hidden-approvals"
  $moved = @()
  if (-not (Test-Path -LiteralPath $approvalsDir)) {
    return $moved
  }

  foreach ($file in Get-ChildItem -LiteralPath $approvalsDir -Filter "*.json" -File -ErrorAction SilentlyContinue) {
    if ($file.BaseName -eq $ApprovalId) {
      continue
    }

    New-Directory -Path $hiddenDir
    $destination = Join-Path $hiddenDir $file.Name
    Move-Item -LiteralPath $file.FullName -Destination $destination -Force
    $moved += [PSCustomObject]@{
      Source = $file.FullName
      Destination = $destination
    }
  }

  $moved
}

function Restore-HiddenApprovalsForDiscordDecisionAudit {
  param($MovedApprovals)

  foreach ($moved in @($MovedApprovals)) {
    $source = Get-ObjectPropertyValue -Object $moved -Name "Source"
    $destination = Get-ObjectPropertyValue -Object $moved -Name "Destination"
    if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($destination)) {
      continue
    }
    if (Test-Path -LiteralPath $destination) {
      $parent = Split-Path -Parent $source
      New-Directory -Path $parent
      Move-Item -LiteralPath $destination -Destination $source -Force
    }
  }
}

function Get-DiscordEnvNames {
  $defaults = @(
    "KAIRON_DISCORD_BOT_TOKEN",
    "KAIRON_DISCORD_APPLICATION_ID",
    "KAIRON_DISCORD_GUILD_ID",
    "KAIRON_DISCORD_APPROVAL_CHANNEL_ID",
    "KAIRON_DISCORD_OWNER_USER_ID",
    "KAIRON_DISCORD_ALLOWED_USER_IDS"
  )

  $notificationsPath = Join-Path $script:TargetRoot ".kairon\config\notifications.json"
  if (-not (Test-Path -LiteralPath $notificationsPath)) {
    return $defaults
  }

  try {
    $notifications = Get-Content -LiteralPath $notificationsPath -Raw | ConvertFrom-Json
    $discord = Get-ObjectPropertyValue -Object (Get-ObjectPropertyValue -Object $notifications "providers") "discord"
    $names = @()
    foreach ($propertyName in @(
      "bot_token_env",
      "application_id_env",
      "guild_id_env",
      "approval_channel_id_env",
      "owner_user_id_env",
      "allowed_user_ids_env"
    )) {
      $value = Get-ObjectPropertyValue -Object $discord $propertyName
      if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
        $names += [string]$value
      }
    }

    $envObject = Get-ObjectPropertyValue -Object $discord "env"
    if ($null -ne $envObject) {
      foreach ($property in $envObject.PSObject.Properties) {
        if (-not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
          $names += [string]$property.Value
        }
      }
    }

    if ($names.Count -eq 0) {
      return $defaults
    }

    return @($names | Select-Object -Unique)
  } catch {
    return $defaults
  }
}

function Get-DiscordSecretEnvNames {
  $defaults = @("KAIRON_DISCORD_BOT_TOKEN")

  $notificationsPath = Join-Path $script:TargetRoot ".kairon\config\notifications.json"
  if (-not (Test-Path -LiteralPath $notificationsPath)) {
    return $defaults
  }

  try {
    $notifications = Get-Content -LiteralPath $notificationsPath -Raw | ConvertFrom-Json
    $discord = Get-ObjectPropertyValue -Object (Get-ObjectPropertyValue -Object $notifications "providers") "discord"
    $names = @()

    $botTokenEnv = Get-ObjectPropertyValue -Object $discord "bot_token_env"
    if (-not [string]::IsNullOrWhiteSpace([string]$botTokenEnv)) {
      $names += [string]$botTokenEnv
    }

    $envObject = Get-ObjectPropertyValue -Object $discord "env"
    if ($null -ne $envObject) {
      $legacyBotTokenEnv = Get-ObjectPropertyValue -Object $envObject "bot_token"
      if (-not [string]::IsNullOrWhiteSpace([string]$legacyBotTokenEnv)) {
        $names += [string]$legacyBotTokenEnv
      }
    }

    if ($names.Count -eq 0) {
      return $defaults
    }

    return @($names | Select-Object -Unique)
  } catch {
    return $defaults
  }
}

function Get-MissingEnvNames {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  @($Names | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, "Process"))
  })
}

function Get-DiscordSecretValues {
  param([string[]]$AdditionalValues = @())

  $values = @()
  foreach ($name in Get-DiscordSecretEnvNames) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge 6) {
      $values += $value
    }
  }

  foreach ($value in $AdditionalValues) {
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge 6) {
      $values += $value
    }
  }

  @($values | Select-Object -Unique)
}

function Get-DiscordActorValues {
  $envNames = @(
    "KAIRON_DISCORD_OWNER_USER_ID",
    "KAIRON_DISCORD_ALLOWED_USER_IDS"
  )

  $notificationsPath = Join-Path $script:TargetRoot ".kairon\config\notifications.json"
  if (Test-Path -LiteralPath $notificationsPath) {
    try {
      $notifications = Get-Content -LiteralPath $notificationsPath -Raw | ConvertFrom-Json
      $discord = Get-ObjectPropertyValue -Object (Get-ObjectPropertyValue -Object $notifications "providers") "discord"
      foreach ($propertyName in @("owner_user_id_env", "allowed_user_ids_env")) {
        $value = Get-ObjectPropertyValue -Object $discord $propertyName
        if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
          $envNames += [string]$value
        }
      }

      $envObject = Get-ObjectPropertyValue -Object $discord "env"
      if ($null -ne $envObject) {
        foreach ($propertyName in @("owner_user_id", "allowed_user_ids")) {
          $value = Get-ObjectPropertyValue -Object $envObject $propertyName
          if (-not [string]::IsNullOrWhiteSpace([string]$value)) {
            $envNames += [string]$value
          }
        }
      }
    } catch {
      # Defaults are enough for redaction checks when config cannot be read.
    }
  }

  $values = @()
  foreach ($name in @($envNames | Select-Object -Unique)) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }

    $values += @($value -split "[,\s]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  @($values | Where-Object { $_.Length -ge 6 } | Select-Object -Unique)
}

function Format-DiscordEnvSnapshot {
  $lines = @()
  foreach ($name in Get-DiscordEnvNames) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    $state = if ([string]::IsNullOrWhiteSpace($value)) { "missing" } else { "present" }
    $lines += "$name=$state"
  }

  $lines -join [Environment]::NewLine
}

function Assert-NoSecretLeak {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [string[]]$SecretValues = @()
  )

  foreach ($value in $SecretValues) {
    if (-not [string]::IsNullOrWhiteSpace($value) -and $Text.Contains($value)) {
      return "secret-like value leaked into evidence"
    }
  }

  return $true
}

function Get-GitHubTokenSecretValues {
  $values = @()
  foreach ($name in @("GH_TOKEN", "GITHUB_TOKEN")) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Length -ge 6) {
      $values += $value
    }
  }

  @($values | Select-Object -Unique)
}

function Get-GitHubTokenSource {
  $ghToken = [Environment]::GetEnvironmentVariable("GH_TOKEN", "Process")
  if (-not [string]::IsNullOrWhiteSpace($ghToken)) {
    return "GH_TOKEN"
  }

  $githubToken = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "Process")
  if (-not [string]::IsNullOrWhiteSpace($githubToken)) {
    return "GITHUB_TOKEN"
  }

  return "missing"
}

function Format-GitHubTokenSnapshot {
  $lines = @()
  foreach ($name in @("GH_TOKEN", "GITHUB_TOKEN")) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    $state = if ([string]::IsNullOrWhiteSpace($value)) { "missing" } else { "present" }
    $lines += "$name=$state"
  }
  $lines += "token.source=$(Get-GitHubTokenSource)"

  $lines -join [Environment]::NewLine
}

function Get-BranchProtectionSandboxFixtureConfig {
  if ($BranchProtectionSandboxFixture -eq "Goodaymmm14Forge") {
    return [PSCustomObject]@{
      Name = "Goodaymmm14Forge"
      RepoUrl = "https://github.com/goodaymmm/14Forge.git"
      Branch = "main"
      ExpectedRepository = "goodaymmm/14Forge"
    }
  }

  [PSCustomObject]@{
    Name = "Custom"
    RepoUrl = ""
    Branch = "main"
    ExpectedRepository = ""
  }
}

function Resolve-BranchProtectionSandboxConfig {
  $fixture = Get-BranchProtectionSandboxFixtureConfig
  $repoUrl = if ([string]::IsNullOrWhiteSpace($BranchProtectionSandboxRepoUrl)) {
    [string]$fixture.RepoUrl
  } else {
    $BranchProtectionSandboxRepoUrl.Trim()
  }

  $branch = if ([string]::IsNullOrWhiteSpace($BranchProtectionSandboxBranch)) {
    [string]$fixture.Branch
  } else {
    $BranchProtectionSandboxBranch.Trim()
  }

  [PSCustomObject]@{
    Fixture = [string]$fixture.Name
    RepoUrl = $repoUrl
    Branch = $branch
    ExpectedRepository = [string]$fixture.ExpectedRepository
  }
}

function Get-BranchProtectionExpectedStatusChecks {
  if ([string]::IsNullOrWhiteSpace($BranchProtectionExpectedStatusChecks)) {
    return @()
  }

  @(
    $BranchProtectionExpectedStatusChecks.Split(",") |
      ForEach-Object { [string]$_ } |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_.Length -gt 0 }
  )
}

function Format-BranchProtectionExpectedStatusChecks {
  param([string[]]$Checks)

  if ($Checks.Count -eq 0) {
    return "none"
  }

  $Checks -join ","
}

function Get-BranchProtectionSandboxWorkspace {
  $base = if ([string]::IsNullOrWhiteSpace($BranchProtectionSandboxRoot)) {
    Join-Path $script:RunOutputRoot "branch-protection-public-sandbox"
  } else {
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BranchProtectionSandboxRoot)
  }

  New-Directory -Path $base
  Join-Path $base "workspace-$($script:RunId)"
}

function Set-DiscordProviderEnabled {
  param([Parameter(Mandatory = $true)][bool]$Enabled)

  $notificationsPath = Join-Path $script:TargetRoot ".kairon\config\notifications.json"
  $notifications = Get-Content -LiteralPath $notificationsPath -Raw | ConvertFrom-Json
  $notifications.providers.discord.enabled = $Enabled
  Write-KaironJsonNoBom -Path $notificationsPath -Value $notifications
}

function Get-DiscordGatewaySummary {
  $gatewayPath = Join-Path $script:TargetRoot ".kairon\runtime\discord\gateway.json"
  if (-not (Test-Path -LiteralPath $gatewayPath)) {
    return "discord.gateway.status=missing"
  }

  try {
    $gateway = Get-Content -LiteralPath $gatewayPath -Raw | ConvertFrom-Json
    $keys = @(
      "status",
      "mode",
      "error_code",
      "operation",
      "commands_registered",
      "updated_at",
      "next_action"
    )
    $lines = @("discord.gateway.path=.kairon/runtime/discord/gateway.json")
    foreach ($key in $keys) {
      $value = Get-ObjectPropertyValue -Object $gateway -Name $key
      if ($null -ne $value) {
        $lines += "discord.gateway.$key=$value"
      }
    }
    return $lines -join [Environment]::NewLine
  } catch {
    return "discord.gateway.status=unreadable"
  }
}

function Get-AuditFileSummary {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $filePath = Join-Path $script:TargetRoot ($RelativePath -replace "/", "\")
  if (-not (Test-Path -LiteralPath $filePath)) {
    return "$RelativePath exists=false"
  }

  $lineCount = @(Get-Content -LiteralPath $filePath -ErrorAction SilentlyContinue).Count
  return "$RelativePath exists=true lines=$lineCount path=$RelativePath"
}

function Get-DiscordDecisionAuditRecord {
  param(
    [Parameter(Mandatory = $true)][string]$ApprovalId,
    [Parameter(Mandatory = $true)][string]$Decision
  )

  $decisionAuditPath = Join-Path $script:TargetRoot ".kairon\runtime\discord\decision-interactions.jsonl"
  if (-not (Test-Path -LiteralPath $decisionAuditPath)) {
    return $null
  }

  $lines = @(Get-Content -LiteralPath $decisionAuditPath -ErrorAction SilentlyContinue)
  for ($index = $lines.Count - 1; $index -ge 0; $index--) {
    $line = [string]$lines[$index]
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    try {
      $record = $line | ConvertFrom-Json
      if (
        (Get-ObjectPropertyValue -Object $record -Name "approval_id") -eq $ApprovalId -and
        (Get-ObjectPropertyValue -Object $record -Name "decision") -eq $Decision
      ) {
        return $record
      }
    } catch {
      continue
    }
  }

  return $null
}

function Wait-DiscordDecisionAuditRecord {
  param(
    [Parameter(Mandatory = $true)][string]$ApprovalId,
    [Parameter(Mandatory = $true)][string]$Decision,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSeconds))
  do {
    $record = Get-DiscordDecisionAuditRecord -ApprovalId $ApprovalId -Decision $Decision
    if ($null -ne $record) {
      return $record
    }

    if ((Get-Date) -ge $deadline) {
      return $null
    }

    Start-Sleep -Seconds 1
  } while ($true)
}

function Format-DiscordDecisionAuditRecord {
  param($Record)

  if ($null -eq $Record) {
    return @(
      "decision.audit.record=missing",
      "decision_audit.status=missing",
      "decision_audit.next_action=click Discord approval button and rerun DiscordDecisionAuditLive"
    ) -join [Environment]::NewLine
  }

  $fields = @(
    "approval_id",
    "decision",
    "status",
    "duplicate",
    "actor_hash",
    "message_update_status",
    "message_update_reason",
    "command_status",
    "recorded_at"
  )
  $lines = @(
    "decision.audit.record=found",
    "decision_audit.status=present"
  )
  foreach ($field in $fields) {
    $value = Get-ObjectPropertyValue -Object $Record -Name $field
    if ($null -ne $value) {
      $lines += "decision.audit.$field=$value"
    }
  }

  return $lines -join [Environment]::NewLine
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
const testRunId = process.argv[5] || 'manual';
const input = {
  type,
  priority,
  payload: {
    tags: ['operation-test', 'runtime-active'],
    test_run_id: testRunId
  },
  test_scope: {
    kind: 'operation_test',
    tags: ['operation-test', 'runtime-active', testRunId],
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  }
};
if (scheduleMode) input.schedule_mode = scheduleMode;
const item = await new WorkQueue(root).enqueue(input);
console.log(item.id);
"@

  Invoke-External -WorkingDirectory $script:KaironRoot -Script {
    node --input-type=module -e $code $script:TargetJs $Type $ScheduleMode $Priority $script:RunId
  }
}

function Add-KaironReviewQueueItem {
  param(
    [string]$ScheduleMode = "active_work",
    [int]$Priority = 2147483647,
    [string]$LoopId = ""
  )

  $code = @"
import { WorkQueue } from './dist/queue/work-queue.js';
const root = process.argv[1];
const scheduleMode = process.argv[2] || undefined;
const priority = Number(process.argv[3] || '2147483647');
const testRunId = process.argv[4] || 'manual';
const loopId = process.argv[5] || '';
const payload = {
  tags: ['operation-test', 'runtime-review'],
  test_run_id: testRunId
};
if (loopId) payload.loop_id = loopId;
const input = {
  type: 'review.run',
  priority,
  payload,
  test_scope: {
    kind: 'operation_test',
    tags: ['operation-test', 'runtime-review', testRunId],
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  }
};
if (scheduleMode) input.schedule_mode = scheduleMode;
const item = await new WorkQueue(root).enqueue(input);
console.log(item.id);
"@

  Invoke-External -WorkingDirectory $script:KaironRoot -Script {
    node --input-type=module -e $code $script:TargetJs $ScheduleMode $Priority $script:RunId $LoopId
  }
}

function Clear-ReadyTestQueueItems {
  param(
    [string[]]$ExcludeIds = @(),
    [string]$Message = "Ready test queue item isolated before operation test dispatch.",
    [string]$Code = "operation_test_isolation"
  )

  $excludeIdsJson = if ($ExcludeIds.Count -eq 0) {
    "[]"
  } else {
    @($ExcludeIds) | ConvertTo-Json -Compress
  }

  $code = @"
import { WorkQueue } from './dist/queue/work-queue.js';
const root = process.argv[1];
const excludeIds = JSON.parse(process.argv[2] || '[]');
const message = process.argv[3] || 'Ready test queue item isolated before operation test dispatch.';
const code = process.argv[4] || 'operation_test_isolation';
const expired = await new WorkQueue(root).expireReadyTestItems({
  kinds: ['operation_test', 'manual_test'],
  tags: ['operation-test', 'manual-test'],
  excludeIds,
  message,
  code
});
console.log(expired.map((item) => item.id).join(','));
"@

  Invoke-External -WorkingDirectory $script:KaironRoot -Script {
    node --input-type=module -e $code $script:TargetJs $excludeIdsJson $Message $Code
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
  $failed = @($script:Results | Where-Object { $_.status -eq "FAIL" }).Count
  $setupRequired = @($script:Results | Where-Object { $_.status -eq "SETUP_REQUIRED" }).Count
  $optional = @($script:Results | Where-Object { $_.status -eq "OPTIONAL" }).Count
  $failedIds = @($script:Results | Where-Object { $_.status -eq "FAIL" } | ForEach-Object { $_.id })
  $jsonPath = Join-Path $script:RunOutputRoot "summary.json"
  $mdPath = Join-Path $script:RunOutputRoot "summary.md"
  $artifactPaths = @(
    $script:RunOutputRoot,
    $jsonPath,
    $mdPath
  )
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
      setup_required = $setupRequired
      optional = $optional
      total = $script:Results.Count
    }
    failed_ids = $failedIds
    artifact_paths = $artifactPaths
    results = $script:Results
    created_at = (Get-Date).ToUniversalTime().ToString("o")
  }

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
    "- setup_required: $setupRequired",
    "- optional: $optional",
    "- failed_ids: $($failedIds -join ',')",
    "- artifact_paths: $($artifactPaths -join ',')",
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
        kairon task run $taskId --timeout-ms $TimeoutMs --no-interactive-agents
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
      $isolatedItems = (Clear-ReadyTestQueueItems `
        -Message "Ready test queue item isolated before RuntimeActive operation test." `
        -Code "runtime_active_test_isolation").Trim()
      $itemId = (Add-KaironQueueItem -Type "maintenance.run" -ScheduleMode "active_work" -Priority 2147483647).Trim()
      $startText = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon start }
      $tickPath = Join-Path $script:TargetRoot ".kairon\runtime\last-tick.json"
      $tick = Get-Content -LiteralPath $tickPath -Raw | ConvertFrom-Json
      $queueResult = $tick.queue_result
      $actualItemId = if ($null -eq $queueResult) { "" } else { $queueResult.item_id }
      $actualItemType = if ($null -eq $queueResult) { "" } else { $queueResult.item_type }
      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon stop }
      @(
        "isolated_test_items=$isolatedItems",
        "expected_item_id=$itemId",
        $startText,
        "tick.mode=$($tick.mode)",
        "tick.base_mode=$($tick.base_mode)",
        "tick.active_work_closed=$($tick.active_work_closed)",
        "tick.action=$($tick.action)",
        "tick.item_id=$actualItemId",
        "tick.item_type=$actualItemType"
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $expectedItemId = Get-KaironStatusValue -Text $Evidence -Key "expected_item_id"
      $actualItemId = Get-KaironStatusValue -Text $Evidence -Key "tick.item_id"
      if ($Evidence -notmatch "tick\.base_mode=active_work") { return "base_mode was not active_work" }
      if ($Evidence -notmatch "tick\.active_work_closed=False") { return "active_work_closed was not False" }
      if ($Evidence -notmatch "tick\.action=processed-item") { return "runtime action was not processed-item" }
      if ($Evidence -notmatch "tick\.item_type=maintenance\.run") { return "runtime item_type was not maintenance.run" }
      if ($actualItemId -ne $expectedItemId) { return "runtime processed $actualItemId instead of expected $expectedItemId" }
      return $true
    }
  }

  if (Should-Run "RuntimeReview") {
    Invoke-Step -Id "RUNTIME_REVIEW" -Name "Runtime review.run target tick" -Script {
      $overridePath = Join-Path $script:TargetRoot ".kairon\state\schedule_override.json"
      if (Test-Path -LiteralPath $overridePath) {
        Remove-Item -LiteralPath $overridePath -Force
      }

      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon stop }
      Set-KaironScheduleMode active_work
      $isolatedItems = (Clear-ReadyTestQueueItems `
        -Message "Ready test queue item isolated before RuntimeReview operation test." `
        -Code "runtime_review_test_isolation").Trim()
      $itemId = (Add-KaironReviewQueueItem -Priority 2147483647).Trim()
      $startText = Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon start }
      $tickPath = Join-Path $script:TargetRoot ".kairon\runtime\last-tick.json"
      $tick = Get-Content -LiteralPath $tickPath -Raw | ConvertFrom-Json
      $queueResult = $tick.queue_result
      $actualItemId = if ($null -eq $queueResult) { "" } else { $queueResult.item_id }
      $actualItemType = if ($null -eq $queueResult) { "" } else { $queueResult.item_type }
      $queuePath = Join-Path $script:TargetRoot ".kairon\state\queue.json"
      $queue = Get-Content -LiteralPath $queuePath -Raw | ConvertFrom-Json
      $targetItem = @($queue.items | Where-Object { $_.id -eq $itemId } | Select-Object -First 1)
      $itemStatus = if ($targetItem.Count -eq 0) { "" } else { $targetItem[0].status }
      $itemErrorCode = if ($targetItem.Count -eq 0 -or $null -eq $targetItem[0].error) { "" } else { $targetItem[0].error.code }
      Invoke-External -WorkingDirectory $script:TargetRoot -Script { kairon stop }
      @(
        "isolated_test_items=$isolatedItems",
        "expected_item_id=$itemId",
        $startText,
        "tick.mode=$($tick.mode)",
        "tick.base_mode=$($tick.base_mode)",
        "tick.active_work_closed=$($tick.active_work_closed)",
        "tick.action=$($tick.action)",
        "tick.item_id=$actualItemId",
        "tick.item_type=$actualItemType",
        "queue.item_status=$itemStatus",
        "queue.item_error_code=$itemErrorCode"
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $expectedItemId = Get-KaironStatusValue -Text $Evidence -Key "expected_item_id"
      $actualItemId = Get-KaironStatusValue -Text $Evidence -Key "tick.item_id"
      if ($Evidence -notmatch "tick\.base_mode=active_work") { return "base_mode was not active_work" }
      if ($Evidence -notmatch "tick\.active_work_closed=False") { return "active_work_closed was not False" }
      if ($Evidence -notmatch "tick\.action=processed-item") { return "runtime action was not processed-item" }
      if ($Evidence -notmatch "tick\.item_type=review\.run") { return "runtime item_type was not review.run" }
      if ($actualItemId -ne $expectedItemId) { return "runtime processed $actualItemId instead of expected $expectedItemId" }
      if ($Evidence -notmatch "queue\.item_status=failed") { return "review.run item was not failed as expected" }
      if ($Evidence -notmatch "queue\.item_error_code=handler\.review\.run\.failed") {
        return "review.run failure code was not handler.review.run.failed"
      }
      return $true
    }
  }

  if (Should-Run "DiscordLiveReady") {
    Invoke-Step -Id "DISCORD_LIVE_READY" -Name "Discord live configuration readiness" -Script {
      Set-DiscordProviderEnabled -Enabled $true
      $doctor = Invoke-KaironCaptured { kairon doctor }
      @(
        "discord.env.snapshot",
        (Format-DiscordEnvSnapshot),
        "doctor.exit_code=$($doctor.ExitCode)",
        $doctor.Output
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $missing = @(Get-MissingEnvNames -Names (Get-DiscordEnvNames))
      if ($missing.Count -gt 0) {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing Discord env names: $($missing -join ',')"
      }

      $leak = Assert-NoSecretLeak -Text $Evidence -SecretValues (Get-DiscordSecretValues)
      if ($leak -ne $true) { return $leak }
      if ($Evidence -notmatch "gateway_status=ready") { return "gateway_status=ready was not found" }
      if ($Evidence -notmatch "live_status=ready") { return "live_status=ready was not found" }
      if ($Evidence -notmatch "PASS discord\.config") { return "discord.config did not pass" }
      return $true
    }
  }

  if (Should-Run "DiscordInvalidEnv") {
    Invoke-Step -Id "DISCORD_INVALID_ENV" -Name "Discord invalid env diagnostics" -Script {
      Set-DiscordProviderEnabled -Enabled $true
      $invalidValues = @{
        KAIRON_DISCORD_BOT_TOKEN = "secret-bot-token-for-operation-test"
        KAIRON_DISCORD_APPLICATION_ID = "not-a-snowflake-application"
        KAIRON_DISCORD_GUILD_ID = "not-a-snowflake-guild"
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID = "not-a-snowflake-channel"
        KAIRON_DISCORD_OWNER_USER_ID = "not-a-snowflake-owner"
        KAIRON_DISCORD_ALLOWED_USER_IDS = "not-a-snowflake-allowed"
      }
      Invoke-WithEnvOverrides -Values $invalidValues -Script {
        $doctor = Invoke-KaironCaptured { kairon doctor }
        @(
          "discord.env.snapshot",
          (Format-DiscordEnvSnapshot),
          "doctor.exit_code=$($doctor.ExitCode)",
          $doctor.Output
        ) -join [Environment]::NewLine
      }
    } -Assert {
      param($Evidence)
      $rawInvalidValues = @(
        "secret-bot-token-for-operation-test",
        "not-a-snowflake-application",
        "not-a-snowflake-guild",
        "not-a-snowflake-channel",
        "not-a-snowflake-owner",
        "not-a-snowflake-allowed"
      )
      $leak = Assert-NoSecretLeak -Text $Evidence -SecretValues $rawInvalidValues
      if ($leak -ne $true) { return $leak }
      if ($Evidence -notmatch "gateway_status=setup_required") { return "gateway_status=setup_required was not found" }
      if ($Evidence -notmatch "live_status=setup_required") { return "live_status=setup_required was not found" }
      if ($Evidence -notmatch "KAIRON_DISCORD_APPLICATION_ID") { return "invalid application env name was not reported" }
      if ($Evidence -notmatch "KAIRON_DISCORD_GUILD_ID") { return "invalid guild env name was not reported" }
      if ($Evidence -notmatch "KAIRON_DISCORD_APPROVAL_CHANNEL_ID") { return "invalid channel env name was not reported" }
      return $true
    }
  }

  if (Should-Run "DiscordSetupError") {
    Invoke-Step -Id "DISCORD_SETUP_ERROR" -Name "Discord live setup error classification" -Script {
      $required = @(
        "KAIRON_DISCORD_BOT_TOKEN",
        "KAIRON_DISCORD_APPLICATION_ID",
        "KAIRON_DISCORD_OWNER_USER_ID"
      )
      $missing = @(Get-MissingEnvNames -Names $required)
      if ($missing.Count -gt 0) {
        "setup_required.missing_env=$($missing -join ',')"
        return
      }

      Set-DiscordProviderEnabled -Enabled $true
      $overrides = @{
        KAIRON_DISCORD_GUILD_ID = $DiscordSetupErrorGuildId
        KAIRON_DISCORD_APPROVAL_CHANNEL_ID = $DiscordSetupErrorApprovalChannelId
      }
      if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("KAIRON_DISCORD_ALLOWED_USER_IDS", "Process"))) {
        $ownerId = [Environment]::GetEnvironmentVariable("KAIRON_DISCORD_OWNER_USER_ID", "Process")
        if (-not [string]::IsNullOrWhiteSpace($ownerId)) {
          $overrides["KAIRON_DISCORD_ALLOWED_USER_IDS"] = $ownerId
        }
      }

      Invoke-WithEnvOverrides -Values $overrides -Script {
        Invoke-KaironCaptured { kairon stop } | Out-Null
        $start = Invoke-KaironCaptured { kairon start --daemon --interval-ms 1000 --max-ticks 1 }
        Invoke-KaironCaptured { kairon stop } | Out-Null
        @(
          "discord.env.snapshot",
          (Format-DiscordEnvSnapshot),
          "start.exit_code=$($start.ExitCode)",
          $start.Output,
          (Get-DiscordGatewaySummary)
        ) -join [Environment]::NewLine
      }
    } -Assert {
      param($Evidence)
      if ($Evidence -match "^setup_required\.missing_env=(.+)$") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing Discord env names: $($Matches[1])"
      }

      $leak = Assert-NoSecretLeak -Text $Evidence -SecretValues (Get-DiscordSecretValues -AdditionalValues @($DiscordSetupErrorGuildId, $DiscordSetupErrorApprovalChannelId))
      if ($leak -ne $true) { return $leak }
      if ($Evidence -match "DiscordAPIError\[") { return "raw DiscordAPIError stack was printed" }
      if ($Evidence -match "node_modules\\@discordjs") { return "discord.js stack path was printed" }
      if ($Evidence -notmatch "discord\.gateway\.status=setup_required") { return "gateway status was not setup_required" }
      if ($Evidence -match "discord\.gateway\.status=starting") { return "gateway artifact remained starting" }
      if ($Evidence -notmatch "discord\.gateway\.next_action=") { return "setup guidance next_action was not recorded" }
      return $true
    }
  }

  if (Should-Run "ApprovalNotificationAudit") {
    Invoke-Step -Id "APPROVAL_NOTIFICATION_AUDIT" -Name "Discord approval notification audit artifacts" -Script {
      $approvalAudit = ".kairon/runtime/discord/approval-notifications.jsonl"
      $decisionAudit = ".kairon/runtime/discord/decision-interactions.jsonl"
      @(
        (Get-AuditFileSummary -RelativePath $approvalAudit),
        (Get-AuditFileSummary -RelativePath $decisionAudit)
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      $approvalAuditPath = Join-Path $script:TargetRoot ".kairon\runtime\discord\approval-notifications.jsonl"
      $decisionAuditPath = Join-Path $script:TargetRoot ".kairon\runtime\discord\decision-interactions.jsonl"
      $existing = @(@($approvalAuditPath, $decisionAuditPath) | Where-Object { Test-Path -LiteralPath $_ })
      if ($existing.Count -eq 0) {
        return New-StepResult -Status "OPTIONAL" -Details "Discord audit artifacts do not exist yet"
      }

      $auditText = ""
      foreach ($filePath in $existing) {
        $auditText += [Environment]::NewLine
        $auditText += Get-Content -LiteralPath $filePath -Raw
      }

      $leak = Assert-NoSecretLeak -Text $auditText -SecretValues (Get-DiscordSecretValues)
      if ($leak -ne $true) { return $leak }
      foreach ($needle in @("SHOULD_NOT_LEAK", "SHOULD_BE_REDACTED", "api_token", "bot_token")) {
        if ($auditText -match [regex]::Escape($needle)) {
          return "sensitive marker was found in audit artifacts: $needle"
        }
      }
      return $true
    }
  }

  if (Should-Run "DiscordDecisionAuditLive") {
    Invoke-Step -Id "DISCORD_DECISION_AUDIT_LIVE" -Name "Discord live decision audit" -Script {
      $missing = @(Get-MissingEnvNames -Names (Get-DiscordEnvNames))
      if ($missing.Count -gt 0) {
        "setup_required.missing_env=$($missing -join ',')"
      } else {
        $approvalId = if ([string]::IsNullOrWhiteSpace($DiscordDecisionAuditApprovalId)) {
          "APR-T70-LIVE-$($script:RunId)"
        } else {
          $DiscordDecisionAuditApprovalId
        }

        if ($DiscordDecisionAuditTimeoutSeconds -le 0) {
          @(
            "decision_audit.status=missing",
            "decision_audit.next_action=click Discord approval button and rerun DiscordDecisionAuditLive",
            "manual_action.required=true",
            "manual_action.approval_id=$approvalId",
            "manual_action.expected_decision=$DiscordDecisionAuditExpectedAction",
            "manual_action.next=Run this profile with -DiscordDecisionAuditTimeoutSeconds <seconds>, then click the matching Discord approval action before timeout.",
            "manual_action.skip_restore_recommended=true",
            (Get-AuditFileSummary -RelativePath ".kairon/runtime/discord/decision-interactions.jsonl")
          ) -join [Environment]::NewLine
        } else {
          Set-DiscordProviderEnabled -Enabled $true
          Invoke-KaironCaptured { kairon stop } | Out-Null
          $hiddenApprovals = @()
          $seed = $null
          $daemon = $null
          $stop = $null
          try {
            $hiddenApprovals = @(Hide-NonTargetApprovalsForDiscordDecisionAudit -ApprovalId $approvalId)
            $seed = Invoke-KaironCaptured {
              kairon approval seed $approvalId --redaction-fixture --title "T70 Discord decision audit live"
            }
            $daemon = Start-KaironDaemonForManualDiscordDecision -TimeoutSeconds $DiscordDecisionAuditTimeoutSeconds
            $record = Wait-DiscordDecisionAuditRecord `
              -ApprovalId $approvalId `
              -Decision $DiscordDecisionAuditExpectedAction `
              -TimeoutSeconds $DiscordDecisionAuditTimeoutSeconds
          } finally {
            $stop = Stop-KaironDaemonForManualDiscordDecision -Daemon $daemon
            Restore-HiddenApprovalsForDiscordDecisionAudit -MovedApprovals $hiddenApprovals
          }

          $daemonExitCode = ""
          $daemonStdout = ""
          $daemonStderr = ""
          $daemonMaxTicks = ""
          $daemonJobId = ""
          $daemonStdoutPath = ""
          $daemonStderrPath = ""
          $daemonTimedOut = ""
          if ($null -ne $daemon) {
            $daemonExitCode = $daemon.ExitCode
            $daemonStdout = Get-FileTextOrEmpty -Path $daemon.StdoutPath
            $daemonStderr = Get-FileTextOrEmpty -Path $daemon.StderrPath
            $daemonMaxTicks = $daemon.MaxTicks
            $daemonJobId = $daemon.Job.Id
            $daemonStdoutPath = $daemon.StdoutPath
            $daemonStderrPath = $daemon.StderrPath
            $daemonTimedOut = $daemon.TimedOut
          }

          @(
            "discord.env.snapshot",
            (Format-DiscordEnvSnapshot),
            "approval_id=$approvalId",
            "expected_decision=$DiscordDecisionAuditExpectedAction",
            "timeout_seconds=$DiscordDecisionAuditTimeoutSeconds",
            "hidden_approval_count=$($hiddenApprovals.Count)",
            "seed.exit_code=$($seed.ExitCode)",
            $seed.Output,
            "daemon.job_id=$daemonJobId",
            "daemon.max_ticks=$daemonMaxTicks",
            "daemon.exit_code=$daemonExitCode",
            "daemon.timed_out=$daemonTimedOut",
            "daemon.stdout_path=$daemonStdoutPath",
            "daemon.stderr_path=$daemonStderrPath",
            "daemon.stdout",
            $daemonStdout,
            "daemon.stderr",
            $daemonStderr,
            "stop.exit_code=$($stop.ExitCode)",
            $stop.Output,
            (Get-AuditFileSummary -RelativePath ".kairon/runtime/discord/decision-interactions.jsonl"),
            (Format-DiscordDecisionAuditRecord -Record $record)
          ) -join [Environment]::NewLine
        }
      }
    } -Assert {
      param($Evidence)
      if ($Evidence -match "^setup_required\.missing_env=(.+)$") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing Discord env names: $($Matches[1])"
      }

      $secretValues = @(
        Get-DiscordSecretValues
        Get-DiscordActorValues
      )
      $leak = Assert-NoSecretLeak -Text $Evidence -SecretValues $secretValues
      if ($leak -ne $true) { return $leak }
      if ($Evidence -match "DiscordAPIError\[") { return "raw DiscordAPIError stack was printed" }
      if ($Evidence -match "node_modules\\@discordjs") { return "discord.js stack path was printed" }

      if ($Evidence -match "manual_action\.required=true") {
        return New-StepResult -Status "OPTIONAL" -Details "waiting for manual Discord decision; rerun with -DiscordDecisionAuditTimeoutSeconds and click the expected action"
      }

      if ($Evidence -notmatch "decision\.audit\.record=found") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "decision audit record was not found before timeout; click the expected Discord approval action and rerun"
      }

      if ($Evidence -notmatch "decision\.audit\.approval_id=") { return "approval_id was missing from decision audit" }
      if ($Evidence -notmatch "decision\.audit\.decision=$([regex]::Escape($DiscordDecisionAuditExpectedAction))") {
        return "expected decision was not found in audit"
      }
      if ($Evidence -notmatch "decision\.audit\.status=(applied|rejected|skipped|failed)") { return "decision status was missing from audit" }
      if ($Evidence -notmatch "decision\.audit\.actor_hash=[a-f0-9]{16}") { return "actor_hash was missing or invalid" }
      if ($Evidence -notmatch "decision\.audit\.message_update_status=(updated|skipped|failed|unavailable)") {
        return "message_update_status was missing from audit"
      }
      return $true
    }
  }

  if (Should-Run "BranchProtectionPublicSandbox") {
    Invoke-Step -Id "BRANCH_PROTECTION_PUBLIC_SANDBOX" -Name "GitHub branch protection public sandbox" -Script {
      $sandboxConfig = Resolve-BranchProtectionSandboxConfig
      $repoUrl = $sandboxConfig.RepoUrl
      $branch = $sandboxConfig.Branch
      $expectedStatusChecks = @(Get-BranchProtectionExpectedStatusChecks)
      $expectedStatusChecksText = Format-BranchProtectionExpectedStatusChecks -Checks $expectedStatusChecks

      if ([string]::IsNullOrWhiteSpace($repoUrl)) {
        @(
          "setup_required.missing_repo_url=true",
          "branch_protection.fixture=$($sandboxConfig.Fixture)",
          "branch_protection.require_token=$($BranchProtectionRequireToken.IsPresent)",
          "branch_protection.expected_status_checks=$expectedStatusChecksText",
          "github.env.snapshot",
          (Format-GitHubTokenSnapshot)
        ) -join [Environment]::NewLine
      } elseif ((Get-GitHubTokenSource) -eq "missing") {
        @(
          "setup_required.missing_token=true",
          "branch_protection.require_token=$($BranchProtectionRequireToken.IsPresent)",
          "github.env.snapshot",
          (Format-GitHubTokenSnapshot),
          "branch_protection.fixture=$($sandboxConfig.Fixture)",
          "branch_protection.repo_url=$repoUrl",
          "branch_protection.branch=$branch",
          "branch_protection.expected_status_checks=$expectedStatusChecksText"
        ) -join [Environment]::NewLine
      } else {
        $workspace = Get-BranchProtectionSandboxWorkspace
        New-Directory -Path $workspace

        Invoke-External -WorkingDirectory $workspace -Script { git init } | Out-Null
        Invoke-External -WorkingDirectory $workspace -Script { git branch -M $branch } | Out-Null
        Invoke-External -WorkingDirectory $workspace -Script { git remote add origin $repoUrl } | Out-Null
        Invoke-External -WorkingDirectory $workspace -Script { kairon init } | Out-Null
        $doctorScript = {
          Invoke-Captured {
            Invoke-InDirectory -Path $workspace -CommandBlock { kairon doctor }
          }
        }
        $doctor = if ($expectedStatusChecks.Count -gt 0) {
          Invoke-WithEnvOverrides -Values @{
            KAIRON_GITHUB_EXPECTED_STATUS_CHECKS = $expectedStatusChecksText
          } -Script $doctorScript
        } else {
          & $doctorScript
        }

        @(
          "github.env.snapshot",
          (Format-GitHubTokenSnapshot),
          "branch_protection.workspace=$workspace",
          "branch_protection.fixture=$($sandboxConfig.Fixture)",
          "branch_protection.require_token=$($BranchProtectionRequireToken.IsPresent)",
          "branch_protection.repo_url=$repoUrl",
          "branch_protection.branch=$branch",
          "branch_protection.expected_repository=$($sandboxConfig.ExpectedRepository)",
          "branch_protection.expected_status_checks=$expectedStatusChecksText",
          "doctor.exit_code=$($doctor.ExitCode)",
          $doctor.Output
        ) -join [Environment]::NewLine
      }
    } -Assert {
      param($Evidence)

      $leak = Assert-NoSecretLeak -Text $Evidence -SecretValues (Get-GitHubTokenSecretValues)
      if ($leak -ne $true) { return $leak }

      if ($Evidence -match "setup_required\.missing_repo_url=true") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing -BranchProtectionSandboxRepoUrl"
      }

      if ($Evidence -match "setup_required\.missing_token=true") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing GH_TOKEN or GITHUB_TOKEN"
      }

      if ($Evidence -match "auth=missing") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "GitHub token was not detected by doctor"
      }

      if ($Evidence -match "http_status=(403|404)") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "GitHub branch protection API returned http_status=$($Matches[1])"
      }

      if ($Evidence -notmatch "api_status=ok") {
        return "api_status=ok was not found"
      }
      if ($Evidence -notmatch "branch_protection=enabled") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "branch protection is not enabled on sandbox branch"
      }
      if ($Evidence -notmatch "required_pull_request_reviews=present") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "required pull request reviews are not configured"
      }
      if ($Evidence -notmatch "required_status_checks=present") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "required status checks are not configured"
      }
      $expectedStatusChecks = @(Get-BranchProtectionExpectedStatusChecks)
      if ($expectedStatusChecks.Count -gt 0) {
        $expectedStatusChecksText = Format-BranchProtectionExpectedStatusChecks -Checks $expectedStatusChecks
        if ($Evidence -notmatch "expected_status_checks=$([regex]::Escape($expectedStatusChecksText))") {
          return "expected_status_checks=$expectedStatusChecksText was not found"
        }
        if ($Evidence -match "missing_expected_status_checks=(?!none)(.+)") {
          return New-StepResult -Status "SETUP_REQUIRED" -Details "missing expected status checks: $($Matches[1])"
        }
        if ($Evidence -notmatch "missing_expected_status_checks=none") {
          return New-StepResult -Status "SETUP_REQUIRED" -Details "expected status check validation result was not found"
        }
      }

      return $true
    }
  }

  if (Should-Run "StableAcceptanceManifest") {
    Invoke-Step -Id "STABLE_ACCEPTANCE_MANIFEST" -Name "Stable acceptance evidence manifest" -Script {
      if ([string]::IsNullOrWhiteSpace($StableAcceptanceManifestPath)) {
        "setup_required.missing_manifest_path=true"
      } else {
        $manifestPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
          $StableAcceptanceManifestPath
        )
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
          "setup_required.manifest_not_found=true"
        } else {
          $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
          $cleanupPath = Join-Path $script:KaironRoot $manifest.cleanup_plan_path
          $cleanup = if (Test-Path -LiteralPath $cleanupPath -PathType Leaf) {
            Get-Content -LiteralPath $cleanupPath -Raw -Encoding UTF8 |
              ConvertFrom-Json
          } else {
            $null
          }
          $scenarioIds = @($manifest.scenarios | ForEach-Object { $_.test_id })
          $expectedScenarioIds = @(
            "OT-T176-01-01",
            "OT-T177-01-01",
            "OT-T178-01-01",
            "OT-T179-01-01",
            "OT-T180-01-01",
            "OT-T181-01-01",
            "OT-T182-01-01",
            "OT-T183-01-01",
            "OT-T184-01-01",
            "OT-T185-01-01",
            "OT-T186-01-01",
            "OT-T187-01-01",
            "OT-T188-01-01",
            "OT-T188-01-02",
            "OT-T189-01-01",
            "OT-T189-01-02",
            "OT-T189-01-03",
            "OT-T189-01-04"
          )
          $missingScenarioIds = @(
            $expectedScenarioIds | Where-Object { $scenarioIds -notcontains $_ }
          )
          $unexpectedScenarioIds = @(
            $scenarioIds | Where-Object { $expectedScenarioIds -notcontains $_ }
          )
          $invalidClassifications = @(
            $manifest.scenarios |
              Where-Object { $_.classification -notin @("required", "external_required") }
          )
          $unknownSelectedIds = @(
            $manifest.selected_test_ids |
              Where-Object { $scenarioIds -notcontains $_ }
          )
          $duplicateScenarioIds = @(
            $scenarioIds |
              Group-Object |
              Where-Object { $_.Count -gt 1 } |
              ForEach-Object { $_.Name }
          )
          $unsafeCleanup = if ($null -eq $cleanup) {
            @("missing-cleanup-plan")
          } else {
            @(
              $cleanup.resources |
                Where-Object {
                  $_.created_by_harness -ne $true -or
                  $_.cleanup_status -notin @("not_created", "deleted", "verified_absent")
                }
            )
          }
          @(
            "manifest.kind=$($manifest.kind)",
            "manifest.source_commit=$($manifest.source_commit)",
            "manifest.scenario_count=$($scenarioIds.Count)",
            "manifest.missing_scenario_ids=$($missingScenarioIds -join ',')",
            "manifest.unexpected_scenario_ids=$($unexpectedScenarioIds -join ',')",
            "manifest.invalid_classification_count=$($invalidClassifications.Count)",
            "manifest.unknown_selected_ids=$($unknownSelectedIds -join ',')",
            "manifest.duplicate_scenario_ids=$($duplicateScenarioIds -join ',')",
            "manifest.selected_count=$(@($manifest.selected_test_ids).Count)",
            "manifest.cleanup_plan_present=$($null -ne $cleanup)",
            "manifest.cleanup_exact_ids_only=$($cleanup.safety.exact_ids_only)",
            "manifest.cleanup_created_by_harness_only=$($cleanup.safety.created_by_harness_only)",
            "manifest.cleanup_unsafe_count=$(@($unsafeCleanup).Count)"
          ) -join [Environment]::NewLine
        }
      }
    } -Assert {
      param($Evidence)
      if ($Evidence -match "setup_required\.missing_manifest_path=true") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "missing -StableAcceptanceManifestPath"
      }
      if ($Evidence -match "setup_required\.manifest_not_found=true") {
        return New-StepResult -Status "SETUP_REQUIRED" -Details "stable acceptance manifest was not found"
      }
      if ($Evidence -notmatch "manifest\.kind=stable_acceptance_evidence_manifest") {
        return "stable acceptance manifest kind is invalid"
      }
      if ($Evidence -notmatch "manifest\.source_commit=[a-f0-9]{40,64}") {
        return "stable acceptance source commit is invalid"
      }
      if ($Evidence -notmatch "manifest\.scenario_count=1[89]") {
        return "stable acceptance scenario matrix is incomplete"
      }
      if ($Evidence -notmatch "manifest\.missing_scenario_ids=\r?\n") {
        return "stable acceptance manifest is missing required scenario ids"
      }
      if ($Evidence -notmatch "manifest\.unexpected_scenario_ids=\r?\n") {
        return "stable acceptance manifest contains unexpected scenario ids"
      }
      if ($Evidence -notmatch "manifest\.invalid_classification_count=0") {
        return "stable acceptance classification is invalid"
      }
      if ($Evidence -notmatch "manifest\.unknown_selected_ids=\r?\n") {
        return "stable acceptance selected_test_ids contains an unknown id"
      }
      if ($Evidence -notmatch "manifest\.duplicate_scenario_ids=\r?\n") {
        return "stable acceptance scenario ids are duplicated"
      }
      if ($Evidence -notmatch "manifest\.cleanup_plan_present=True") {
        return "stable acceptance cleanup plan is missing"
      }
      if ($Evidence -notmatch "manifest\.cleanup_exact_ids_only=True") {
        return "cleanup plan does not require exact ids"
      }
      if ($Evidence -notmatch "manifest\.cleanup_created_by_harness_only=True") {
        return "cleanup plan is not limited to harness-created resources"
      }
      if ($Evidence -notmatch "manifest\.cleanup_unsafe_count=0") {
        return "cleanup plan contains unsafe resources"
      }
      return $true
    }
  }

  if (Should-Run "RuntimeRecovery") {
    Invoke-Step -Id "RUNTIME_RECOVERY" -Name "Runtime recovery for gateway and git transaction state" -Script {
      $oldTimestamp = "2026-01-01T00:00:00.000Z"
      $gatewayDir = Join-Path $script:TargetRoot ".kairon\runtime\discord"
      $transactionsDir = Join-Path $script:TargetRoot ".kairon\git\transactions"
      New-Directory -Path $gatewayDir
      New-Directory -Path $transactionsDir

      $gatewayPath = Join-Path $gatewayDir "gateway.json"
      Write-KaironJsonNoBom -Path $gatewayPath -Value ([PSCustomObject]@{
        schema_version = "0.1"
        status = "starting"
        mode = "gateway"
        bot_token = "SHOULD_NOT_LEAK"
        updated_at = $oldTimestamp
      })

      $transactionId = "GTX-HARNESS-$($script:RunId)"
      $transactionPath = Join-Path $transactionsDir "$transactionId.json"
      Write-KaironJsonNoBom -Path $transactionPath -Value ([PSCustomObject]@{
        schema_version = "0.1"
        transaction_id = $transactionId
        task_id = "TASK-HARNESS"
        run_id = "RUN-HARNESS"
        status = "pushing"
        updated_at = $oldTimestamp
        api_token = "SHOULD_NOT_LEAK"
      })

      $recovery = Invoke-KaironCaptured { kairon recovery run }
      @(
        "recovery.exit_code=$($recovery.ExitCode)",
        $recovery.Output,
        (Get-DiscordGatewaySummary)
      ) -join [Environment]::NewLine
    } -Assert {
      param($Evidence)
      if ($Evidence -match "SHOULD_NOT_LEAK") { return "secret fixture leaked into recovery evidence" }
      if ($Evidence -notmatch "gateway_artifacts_recovered=[1-9][0-9]*") { return "gateway_artifacts_recovered was not incremented" }
      if ($Evidence -notmatch "git_transaction_issues=[1-9][0-9]*") { return "git_transaction_issues was not incremented" }
      if ($Evidence -notmatch "approvals_(requested|existing)=[1-9][0-9]*") { return "runtime recovery approval was not requested or detected" }
      if ($Evidence -notmatch "discord\.gateway\.status=stopped") { return "gateway artifact was not recovered to stopped" }
      if ($Evidence -match "discord\.gateway\.status=starting") { return "gateway artifact remained starting" }
      return $true
    }
  }
} finally {
  Restore-StateBackup
  Write-Reports
}

$failed = @($script:Results | Where-Object { $_.status -eq "FAIL" }).Count
if ($failed -gt 0) {
  exit 1
}
