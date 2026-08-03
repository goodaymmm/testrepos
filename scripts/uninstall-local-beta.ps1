param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$DiagnosticRoot = (Join-Path $env:TEMP "kairon-beta-diagnostics"),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-beta-common.ps1")

$stage = "preflight"
try {
  $prerequisites = Assert-KaironLocalBetaPrerequisites
  $resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $statePath = Join-Path $resolvedProject ".kairon"
  $statePresentBefore = Test-Path -LiteralPath $statePath
  $existing = Get-Command kairon -ErrorAction SilentlyContinue

  Write-Host "Kairon local beta uninstall."
  Write-Host "dry_run=$($DryRun.IsPresent.ToString().ToLowerInvariant())"
  Write-Host "package=kairon"
  Write-Host "existing_kairon=$($null -ne $existing)"
  Write-Host "project_root=$resolvedProject"
  Write-Host "project_state_present=$statePresentBefore"
  Write-Host "project_state_action=preserve"

  if ($DryRun) {
    Write-Host "uninstall.action=would_remove_global_package_only"
    return
  }

  $stage = "npm_uninstall"
  $uninstallOutput = Invoke-KaironLocalBetaCommand `
    -Command $prerequisites.NpmCommand `
    -Arguments @("uninstall", "--global", "kairon")
  $uninstallOutput | ForEach-Object { Write-Host $_ }

  if ($statePresentBefore -and -not (Test-Path -LiteralPath $statePath)) {
    throw "Project .kairon state was removed unexpectedly."
  }
  Write-Host "project_state_preserved=true"
  Write-Host "uninstall.status=completed"
} catch {
  $diagnostic = Write-KaironLocalBetaDiagnostic `
    -DiagnosticRoot $DiagnosticRoot `
    -Operation "uninstall" `
    -Stage $stage `
    -Message $_.Exception.Message
  Write-Host "diagnostic_bundle=$diagnostic"
  throw
}
