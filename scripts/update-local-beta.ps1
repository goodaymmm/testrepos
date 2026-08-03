param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Manifest = "",
  [string]$ReleaseManifest = "",
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$TransactionId = "",
  [string]$StagingRoot = "",
  [string]$ExpectedCurrentVersion = "",
  [string]$TransactionRoot = (Join-Path $env:TEMP "kairon-beta-updates"),
  [string]$DiagnosticRoot = (Join-Path $env:TEMP "kairon-beta-diagnostics"),
  [switch]$ApproveSchemaMigration,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-beta-common.ps1")

$stage = "preflight"
$rollbackPackage = $null
$stateBackupId = $null
$stateBackupPackage = $null
$installStarted = $false
$rollbackPackageRestored = $false
$rollbackStateRestored = $false
$switchStarted = $false
$projectInitialized = $false
$resolvedProject = $null
$resolvedStagingRoot = $null

try {
  $packageInfo = Assert-KaironLocalBetaPackage -PackagePath $Package -ManifestPath $Manifest
  $resolvedReleaseManifest = $null
  if (-not [string]::IsNullOrWhiteSpace($ReleaseManifest)) {
    $resolvedReleaseManifest = (Resolve-Path -LiteralPath $ReleaseManifest -ErrorAction Stop).Path
  }
  $prerequisites = Assert-KaironLocalBetaPrerequisites
  $resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $currentKairon = Get-Command kairon -ErrorAction SilentlyContinue
  if ($null -eq $currentKairon) {
    throw "Kairon is not installed. Use install-local-beta.ps1 for the first install."
  }
  $currentVersionOutput = Invoke-KaironLocalBetaCommand `
    -Command $currentKairon.Source `
    -Arguments @("--version")
  $currentVersion = (($currentVersionOutput -join "").Trim())
  if (-not [string]::IsNullOrWhiteSpace($ExpectedCurrentVersion) -and
      $currentVersion -ne $ExpectedCurrentVersion) {
    throw "Installed Kairon version does not match the expected current version."
  }
  $projectInitialized = Test-Path -LiteralPath (Join-Path $resolvedProject ".kairon\config")
  if ([string]::IsNullOrWhiteSpace($TransactionId)) {
    $TransactionId = "local-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')"
  } elseif ($TransactionId -notmatch '^UTX-\d{4,}$') {
    throw "TransactionId must use the UTX-nnnn format."
  }
  if ([string]::IsNullOrWhiteSpace($StagingRoot)) {
    $userLocalRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      $env:TEMP
    } else {
      $env:LOCALAPPDATA
    }
    $StagingRoot = Join-Path $userLocalRoot "Kairon\update-staging\$TransactionId"
  }
  $resolvedStagingRoot = [System.IO.Path]::GetFullPath($StagingRoot)

  Write-Host "Kairon local beta update."
  Write-Host "dry_run=$($DryRun.IsPresent.ToString().ToLowerInvariant())"
  Write-Host "package=$($packageInfo.PackagePath)"
  Write-Host "manifest=$($packageInfo.ManifestPath)"
  Write-Host "release_manifest=$(if ($null -eq $resolvedReleaseManifest) { 'none' } else { $resolvedReleaseManifest })"
  Write-Host "target_version=$($packageInfo.PackageVersion)"
  Write-Host "current_version=$currentVersion"
  Write-Host "transaction_id=$TransactionId"
  Write-Host "project_root=$resolvedProject"
  Write-Host "project_initialized=$projectInitialized"
  Write-Host "rollback.package=required"
  Write-Host "rollback.state_backup=$projectInitialized"
  Write-Host "schema_migration_approved=$($ApproveSchemaMigration.IsPresent.ToString().ToLowerInvariant())"

  if ($DryRun) {
    Write-Host "update.action=would_backup_stage_switch_migrate_post_check"
    Write-Host "rollback.action=would_restore_package_and_state_on_failure"
    return
  }

  $transaction = Join-Path $TransactionRoot (Get-Date -Format "yyyyMMdd-HHmmss-fff")
  $rollbackDirectory = Join-Path $transaction "rollback-package"
  New-Item -ItemType Directory -Force -Path $rollbackDirectory | Out-Null

  $stage = "capture_installed_package"
  $npmRootOutput = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("root", "--global")
  $npmRoot = ($npmRootOutput -join "").Trim()
  $installedPackageRoot = Join-Path $npmRoot "kairon"
  if (-not (Test-Path -LiteralPath (Join-Path $installedPackageRoot "package.json"))) {
    throw "Unable to locate the installed Kairon package for rollback."
  }
  $null = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("pack", $installedPackageRoot, "--pack-destination", $rollbackDirectory)
  $rollbackPackage = Get-ChildItem -LiteralPath $rollbackDirectory -Filter "*.tgz" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if ([string]::IsNullOrWhiteSpace($rollbackPackage)) {
    throw "Failed to create the rollback package."
  }
  $rollbackPackageSha256 = (
    Get-FileHash -LiteralPath $rollbackPackage -Algorithm SHA256
  ).Hash.ToLowerInvariant()
  $rollbackPackageInfo = Get-Item -LiteralPath $rollbackPackage
  if ([string]::IsNullOrWhiteSpace($rollbackPackageSha256) -or
      $rollbackPackageInfo.Length -le 0) {
    throw "Failed to verify the rollback package."
  }
  Write-Host "rollback_package=$rollbackPackage"
  Write-Host "rollback_package_sha256=$rollbackPackageSha256"

  if ($projectInitialized) {
    $stage = "state_backup"
    $stateBackupRoot = Join-Path $transaction "state-backup"
    $backupOutput = Invoke-KaironLocalBetaCommand `
      -Command $currentKairon.Source `
      -Arguments @("state", "backup", "create", "--output", $stateBackupRoot, "--format", "json") `
      -WorkingDirectory $resolvedProject
    $backup = ($backupOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $stateBackupId = [string]$backup.backup_id
    $stateBackupPackage = [string]$backup.package_path
    if ([string]::IsNullOrWhiteSpace($stateBackupId) -or
        [string]::IsNullOrWhiteSpace($stateBackupPackage)) {
      throw "State backup did not return rollback metadata."
    }
    Write-Host "state_backup_id=$stateBackupId"
    Write-Host "state_backup_package=$stateBackupPackage"
  }

  $stage = "staging_health"
  $stagedReleaseManifest = if ($null -eq $resolvedReleaseManifest) {
    ""
  } else {
    $resolvedReleaseManifest
  }
  $null = Test-KaironStagedPackage `
    -PackageInfo $packageInfo `
    -Prerequisites $prerequisites `
    -StagingRoot $resolvedStagingRoot `
    -ReleaseManifest $stagedReleaseManifest `
    -ProjectRoot $resolvedProject
  Write-Host "transaction.staging_health=passed"

  $stage = "switch"
  $switchStarted = $true
  $stage = "npm_install"
  $installStarted = $true
  $installOutput = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("install", "--global", $packageInfo.PackagePath)
  $installOutput | ForEach-Object { Write-Host $_ }
  $updatedKairon = Get-KaironRequiredCommand -Name "kairon"
  Write-Host "transaction.switch=completed"

  $stage = "post_check"
  $verifyArguments = @(
    "release", "verify", $packageInfo.PackagePath,
    "--manifest", $packageInfo.ManifestPath
  )
  if ($null -ne $resolvedReleaseManifest) {
    $verifyArguments += @(
      "--release-manifest",
      $resolvedReleaseManifest,
      "--verification-context",
      "consumer"
    )
  }
  $verifyOutput = Invoke-KaironLocalBetaCommand `
    -Command $updatedKairon.Source `
    -Arguments $verifyArguments
  $verifyOutput | ForEach-Object { Write-Host $_ }

  if ($projectInitialized) {
    $stage = "runtime_stop"
    $stopOutput = Invoke-KaironLocalBetaCommand `
      -Command $updatedKairon.Source `
      -Arguments @("stop") `
      -WorkingDirectory $resolvedProject
    $stopOutput | ForEach-Object { Write-Host $_ }

    $stage = "migration_plan"
    $migrationPlanOutput = Invoke-KaironLocalBetaCommand `
      -Command $updatedKairon.Source `
      -Arguments @("migrate", "plan") `
      -WorkingDirectory $resolvedProject
    $migrationPlanOutput | ForEach-Object { Write-Host $_ }
    $migrationPlanText = $migrationPlanOutput -join [Environment]::NewLine
    $migrationPlanMatch = [regex]::Match(
      $migrationPlanText,
      '(?m)^plan_id=(MIG-\d+)\s*$'
    )
    if ($migrationPlanMatch.Success) {
      $migrationPlanId = $migrationPlanMatch.Groups[1].Value
      if (-not $ApproveSchemaMigration.IsPresent) {
        throw "Schema migration plan $migrationPlanId requires -ApproveSchemaMigration."
      }
      $stage = "migration_apply"
      $migrationApplyOutput = Invoke-KaironLocalBetaCommand `
        -Command $updatedKairon.Source `
        -Arguments @(
          "migrate", "apply", $migrationPlanId,
          "--confirm", $migrationPlanId
        ) `
        -WorkingDirectory $resolvedProject
      $migrationApplyOutput | ForEach-Object { Write-Host $_ }
      $migrationApplyText = $migrationApplyOutput -join [Environment]::NewLine
      if ($migrationApplyText -notmatch '(?m)^status=(applied|already_applied)\s*$') {
        throw "Kairon schema migration did not complete successfully."
      }
    }

    $stage = "doctor"
    $doctorOutput = Invoke-KaironLocalBetaCommand `
      -Command $updatedKairon.Source `
      -Arguments @("doctor") `
      -WorkingDirectory $resolvedProject
    $doctorText = $doctorOutput -join [Environment]::NewLine
    $doctorOutput | ForEach-Object { Write-Host $_ }
    if ($doctorText -notmatch '(?m)^doctor\.ok=true\s*$') {
      throw "Kairon doctor did not report doctor.ok=true after update."
    }

    $stage = "state_integrity"
    $stateCheckOutput = Invoke-KaironLocalBetaCommand `
      -Command $updatedKairon.Source `
      -Arguments @("state", "check", "--format", "json") `
      -WorkingDirectory $resolvedProject
    $stateCheck = ($stateCheckOutput -join [Environment]::NewLine) |
      ConvertFrom-Json
    if ([int]$stateCheck.summary.errors -gt 0) {
      throw "Kairon state integrity check failed after update."
    }
  }

  $stage = "verify_cli"
  $versionOutput = Invoke-KaironLocalBetaCommand `
    -Command $updatedKairon.Source `
    -Arguments @("--version")
  $installedVersion = (($versionOutput -join "").Trim())
  if ($installedVersion -ne $packageInfo.PackageVersion) {
    throw "Installed Kairon version does not match the update target."
  }
  Write-Host "installed_version=$installedVersion"
  Write-Host "transaction.post_check=passed"
  Write-Host "update.status=completed"
  Write-Host "transaction_root=$transaction"
  Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $originalMessage = $_.Exception.Message
  Write-Host "transaction.failed_phase=$(Get-KaironUpdatePhase -Stage $stage)"
  Write-Host "transaction.error_code=update_$($stage)_failed"
  if ($switchStarted -and -not [string]::IsNullOrWhiteSpace($rollbackPackage)) {
    try {
      $prerequisites = Assert-KaironLocalBetaPrerequisites
      $null = Invoke-KaironLocalBetaCommand `
        -Command $prerequisites.NpmCommand `
        -Arguments @("install", "--global", $rollbackPackage)
      $rollbackKairon = Get-KaironRequiredCommand -Name "kairon"
      $rollbackVersionOutput = Invoke-KaironLocalBetaCommand `
        -Command $rollbackKairon.Source `
        -Arguments @("--version")
      $rollbackPackageRestored = (
        (($rollbackVersionOutput -join "").Trim()) -eq $currentVersion
      )
    } catch {
      $rollbackPackageRestored = $false
    }
  }

  if ($rollbackPackageRestored -and
      -not [string]::IsNullOrWhiteSpace($stateBackupId) -and
      -not [string]::IsNullOrWhiteSpace($stateBackupPackage)) {
    try {
      $rollbackKairon = Get-KaironRequiredCommand -Name "kairon"
      try {
        $null = Invoke-KaironLocalBetaCommand `
          -Command $rollbackKairon.Source `
          -Arguments @("stop") `
          -WorkingDirectory $resolvedProject
      } catch {
        # Restore performs its own runtime safety validation.
      }
      $null = Invoke-KaironLocalBetaCommand `
        -Command $rollbackKairon.Source `
        -Arguments @(
          "state", "backup", "restore", $stateBackupId,
          "--source", $stateBackupPackage,
          "--confirm", $stateBackupId
        ) `
        -WorkingDirectory $resolvedProject
      $rollbackStateRestored = $true
    } catch {
      $rollbackStateRestored = $false
    }
  }

  $diagnostic = Write-KaironLocalBetaDiagnostic `
    -DiagnosticRoot $DiagnosticRoot `
    -Operation "update" `
    -Stage $stage `
    -Message $originalMessage `
    -Additional @{
      rollback_package_restored = $rollbackPackageRestored
      rollback_state_restored = $rollbackStateRestored
    }
  Write-Host "rollback.package_restored=$rollbackPackageRestored"
  Write-Host "rollback.state_restored=$rollbackStateRestored"
  $rollbackCompleted = if (-not $switchStarted) {
    "not_required"
  } elseif ($rollbackPackageRestored -and
      (-not $projectInitialized -or $rollbackStateRestored)) {
    "completed"
  } else {
    "failed"
  }
  Write-Host "rollback.status=$rollbackCompleted"
  if ($rollbackCompleted -ne "failed" -and
      -not [string]::IsNullOrWhiteSpace($resolvedStagingRoot)) {
    Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "diagnostic_bundle=$diagnostic"
  throw $originalMessage
}
