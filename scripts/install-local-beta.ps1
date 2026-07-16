param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Manifest = "",
  [string]$DiagnosticRoot = (Join-Path $env:TEMP "kairon-beta-diagnostics"),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-beta-common.ps1")

$stage = "preflight"
$installed = $false
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
    Write-Host "install.action=would_install_global_package"
    return
  }

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
  throw
}
