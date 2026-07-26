param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Manifest = "",
  [string]$StagingRoot = (Join-Path $env:TEMP "kairon-beta-install-staging"),
  [string]$DiagnosticRoot = (Join-Path $env:TEMP "kairon-beta-diagnostics"),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-beta-common.ps1")

$stage = "preflight"
$installed = $false
$resolvedStagingRoot = $null
try {
  $packageInfo = Assert-KaironLocalBetaPackage -PackagePath $Package -ManifestPath $Manifest
  $prerequisites = Assert-KaironLocalBetaPrerequisites
  $existing = Get-Command kairon -ErrorAction SilentlyContinue

  Write-Host "Kairon local beta install."
  Write-Host "dry_run=$($DryRun.IsPresent.ToString().ToLowerInvariant())"
  Write-Host "package=$($packageInfo.PackagePath)"
  Write-Host "manifest=$($packageInfo.ManifestPath)"
  Write-Host "version=$($packageInfo.PackageVersion)"
  Write-Host "sha256=$($packageInfo.Sha256)"
  Write-Host "node_version=$($prerequisites.NodeVersion)"
  Write-Host "powershell_version=$($prerequisites.PowerShellVersion)"
  Write-Host "existing_kairon=$($null -ne $existing)"
  Write-Host "project_state_mutation=none"

  if ($null -ne $existing -and -not $DryRun) {
    throw "Kairon is already installed. Use update-local-beta.ps1 so rollback evidence is created."
  }

  if ($DryRun) {
    Write-Host "install.action=would_stage_verify_and_install_global_package"
    return
  }

  $stage = "staging_health"
  $resolvedStagingRoot = Join-Path $StagingRoot (Get-Date -Format "yyyyMMdd-HHmmss-fff")
  $null = Test-KaironStagedPackage `
    -PackageInfo $packageInfo `
    -Prerequisites $prerequisites `
    -StagingRoot $resolvedStagingRoot
  Write-Host "transaction.staging_health=passed"

  $stage = "npm_install"
  $installOutput = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("install", "--global", $packageInfo.PackagePath)
  $installOutput | ForEach-Object { Write-Host $_ }
  $installed = $true

  $stage = "verify_cli"
  $kairon = Get-KaironRequiredCommand -Name "kairon"
  $verifyOutput = Invoke-KaironLocalBetaCommand `
    -Command $kairon.Source `
    -Arguments @("release", "verify", $packageInfo.PackagePath, "--manifest", $packageInfo.ManifestPath)
  $verifyOutput | ForEach-Object { Write-Host $_ }
  $versionOutput = Invoke-KaironLocalBetaCommand `
    -Command $kairon.Source `
    -Arguments @("--version")
  Write-Host "installed_version=$(($versionOutput -join '').Trim())"
  Write-Host "install.status=completed"
  Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  if ($installed) {
    try {
      $prerequisites = Assert-KaironLocalBetaPrerequisites
      $null = Invoke-KaironLocalBetaCommand `
        -Command $prerequisites.NpmCommand `
        -Arguments @("uninstall", "--global", "kairon")
    } catch {
      # Diagnostic output below records the original stage without leaking command output.
    }
  }
  $diagnostic = Write-KaironLocalBetaDiagnostic `
    -DiagnosticRoot $DiagnosticRoot `
    -Operation "install" `
    -Stage $stage `
    -Message $_.Exception.Message
  Write-Host "diagnostic_bundle=$diagnostic"
  if (-not [string]::IsNullOrWhiteSpace($resolvedStagingRoot)) {
    Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
}
