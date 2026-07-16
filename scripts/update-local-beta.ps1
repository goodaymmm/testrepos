param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Manifest = "",
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$TransactionRoot = (Join-Path $env:TEMP "kairon-beta-updates"),
  [string]$DiagnosticRoot = (Join-Path $env:TEMP "kairon-beta-diagnostics"),
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

try {
  $packageInfo = Assert-KaironLocalBetaPackage -PackagePath $Package -ManifestPath $Manifest
  $prerequisites = Assert-KaironLocalBetaPrerequisites
  $resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $currentKairon = Get-Command kairon -ErrorAction SilentlyContinue
  if ($null -eq $currentKairon) {
    throw "Kairon is not installed. Use install-local-beta.ps1 for the first install."
  }
  $projectInitialized = Test-Path -LiteralPath (Join-Path $resolvedProject ".kairon\config")

  Write-Host "Kairon local beta update."
  Write-Host "dry_run=$($DryRun.IsPresent.ToString().ToLowerInvariant())"
  Write-Host "package=$($packageInfo.PackagePath)"
  Write-Host "manifest=$($packageInfo.ManifestPath)"
  Write-Host "target_version=$($packageInfo.PackageVersion)"
  Write-Host "project_root=$resolvedProject"
  Write-Host "project_initialized=$projectInitialized"
  Write-Host "rollback.package=required"
  Write-Host "rollback.state_backup=$projectInitialized"

  if ($DryRun) {
    Write-Host "update.action=would_backup_install_migrate_doctor"
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
  Write-Host "rollback_package=$rollbackPackage"

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

  $stage = "npm_install"
  $installStarted = $true
  $installOutput = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("install", "--global", $packageInfo.PackagePath)
  $installOutput | ForEach-Object { Write-Host $_ }
  $updatedKairon = Get-KaironRequiredCommand -Name "kairon"

  $stage = "verify_package"
  $verifyOutput = Invoke-KaironLocalBetaCommand `
    -Command $updatedKairon.Source `
    -Arguments @("release", "verify", $packageInfo.PackagePath, "--manifest", $packageInfo.ManifestPath)
  $verifyOutput | ForEach-Object { Write-Host $_ }

  if ($projectInitialized) {
    $stage = "migrate"
    $migrateOutput = Invoke-KaironLocalBetaCommand `
      -Command $updatedKairon.Source `
      -Arguments @("migrate") `
      -WorkingDirectory $resolvedProject
    $migrateOutput | ForEach-Object { Write-Host $_ }

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
  }

  $stage = "verify_cli"
  $versionOutput = Invoke-KaironLocalBetaCommand `
    -Command $updatedKairon.Source `
    -Arguments @("--version")
  Write-Host "installed_version=$(($versionOutput -join '').Trim())"
  Write-Host "update.status=completed"
  Write-Host "transaction_root=$transaction"
} catch {
  $originalMessage = $_.Exception.Message
  if ($installStarted -and -not [string]::IsNullOrWhiteSpace($rollbackPackage)) {
    try {
      $prerequisites = Assert-KaironLocalBetaPrerequisites
      $null = Invoke-KaironLocalBetaCommand `
        -Command $prerequisites.NpmCommand `
        -Arguments @("install", "--global", $rollbackPackage)
      $rollbackPackageRestored = $true
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
  Write-Host "diagnostic_bundle=$diagnostic"
  throw $originalMessage
}
