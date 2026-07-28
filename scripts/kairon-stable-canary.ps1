param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$Verification = "",
  [string]$OutputRoot = "",
  [string]$NodeRuntimeRoot = "",
  [string]$GitRuntimeRoot = "",
  [ValidateRange(60, 86400)][int]$TimeoutSeconds = 1800,
  [switch]$KeepOnFailure,
  [string]$CredentialProvider = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repositoryRoot "dist\cli\main.js"
$node = Get-Command node -ErrorAction Stop
$git = Get-Command git -ErrorAction Stop

function Resolve-KaironRuntimeRoot {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $resolved -Force
  if (
    -not [string]::IsNullOrWhiteSpace([string]$item.LinkType) -and
    $null -ne $item.Target
  ) {
    $target = @($item.Target)[0]
    if (-not [string]::IsNullOrWhiteSpace([string]$target)) {
      return [System.IO.Path]::GetFullPath(
        $(if ([System.IO.Path]::IsPathRooted([string]$target)) {
          [string]$target
        } else {
          Join-Path $item.Parent.FullName ([string]$target)
        })
      )
    }
  }
  return $resolved
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Kairon build is missing. Run npm run build before the Stable canary."
}
if ([string]::IsNullOrWhiteSpace($NodeRuntimeRoot)) {
  $NodeRuntimeRoot = Resolve-KaironRuntimeRoot (
    Split-Path -Parent $node.Source
  )
}
if ([string]::IsNullOrWhiteSpace($GitRuntimeRoot)) {
  $gitCommandRoot = Split-Path -Parent $git.Source
  $GitRuntimeRoot = if (
    (Split-Path -Leaf $gitCommandRoot) -in @("cmd", "bin")
  ) {
    Split-Path -Parent $gitCommandRoot
  } else {
    $gitCommandRoot
  }
}

function Invoke-KaironCanaryCli {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = @(& $node.Source $cliPath @Arguments 2>&1)
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
  }
}

$prepareArgs = @(
  "test", "stable-canary", "prepare",
  "--node-runtime-root", $NodeRuntimeRoot,
  "--git-runtime-root", $GitRuntimeRoot,
  "--timeout-seconds", $TimeoutSeconds.ToString(),
  "--format", "json"
)
if (-not [string]::IsNullOrWhiteSpace($Verification)) {
  $prepareArgs += @("--verification", $Verification)
}
if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
  $prepareArgs += @("--output", $OutputRoot)
}
if ($KeepOnFailure.IsPresent) {
  $prepareArgs += "--keep-on-failure"
}
if (-not [string]::IsNullOrWhiteSpace($CredentialProvider)) {
  $prepareArgs += @("--credential-provider", $CredentialProvider)
}

Push-Location -LiteralPath $ProjectRoot
try {
  $prepared = Invoke-KaironCanaryCli -Arguments $prepareArgs
  if ($prepared.ExitCode -ne 0) {
    throw "Stable canary preparation failed."
  }
  $preparation = $prepared.Output | ConvertFrom-Json

  $existingSandbox = @(
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessName -in @(
          "WindowsSandbox",
          "WindowsSandboxClient",
          "WindowsSandboxRemoteSession"
        )
      }
  )
  if ($existingSandbox.Count -gt 0) {
    Write-Host "Kairon Stable canary setup required."
    Write-Host "status=SETUP_REQUIRED"
    Write-Host "reason=windows_sandbox_already_running"
    Write-Host "unknown_sandbox_action=refuse"
    Write-Host "sandbox_config=$($preparation.sandbox_config_path)"
    exit 2
  }

  $sandboxExecutable = Join-Path $env:SystemRoot "System32\WindowsSandbox.exe"
  if (-not (Test-Path -LiteralPath $sandboxExecutable -PathType Leaf)) {
    Write-Host "Kairon Stable canary setup required."
    Write-Host "status=SETUP_REQUIRED"
    Write-Host "reason=windows_sandbox_not_available"
    Write-Host "unknown_sandbox_action=refuse"
    exit 2
  }

  Write-Host "Kairon Stable canary starting."
  Write-Host "canary_id=$($preparation.manifest.canary_id)"
  Write-Host "sandbox_config=$($preparation.sandbox_config_path)"
  Write-Host "unknown_sandbox_action=refuse"
  $sandboxProcess = Start-Process `
    -FilePath $sandboxExecutable `
    -ArgumentList @("`"$($preparation.sandbox_config_path)`"") `
    -PassThru

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  while (
    [DateTimeOffset]::UtcNow -lt $deadline -and
    -not (Test-Path -LiteralPath $preparation.sandbox_result_path -PathType Leaf)
  ) {
    Start-Sleep -Seconds 2
    $sandboxProcess.Refresh()
    if ($sandboxProcess.HasExited) {
      break
    }
  }

  if (-not (Test-Path -LiteralPath $preparation.sandbox_result_path -PathType Leaf)) {
    Write-Host "Stable canary result was not produced before the timeout."
    Write-Host "launched_sandbox_action=leave_running"
  }

  $finalized = Invoke-KaironCanaryCli -Arguments @(
    "test", "stable-canary", "finalize",
    "--input", $preparation.manifest_path,
    "--format", "json"
  )
  $finalResult = $finalized.Output | ConvertFrom-Json
  Write-Host "Kairon Stable canary completed."
  Write-Host "status=$($finalResult.status)"
  Write-Host "canary_id=$($finalResult.canary_id)"
  Write-Host "source_verification_id=$($finalResult.source_verification_id)"
  Write-Host "version=$($finalResult.version)"
  Write-Host "result=$($preparation.final_result_path)"
  Write-Host "unknown_sandbox_terminated=$($finalResult.cleanup.unknown_sandbox_terminated.ToString().ToLowerInvariant())"
  foreach ($check in @($finalResult.checks)) {
    Write-Host "$($check.status.ToUpperInvariant()) $($check.id) reason=$($check.reason)"
  }

  if ($finalResult.status -eq "PASS") {
    exit 0
  }
  if ($finalResult.status -eq "SETUP_REQUIRED") {
    exit 2
  }
  exit 1
} finally {
  Pop-Location
}
