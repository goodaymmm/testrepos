Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-KaironRedactedText {
  param([string]$Value)

  if ($null -eq $Value) {
    return ""
  }

  $redacted = $Value -replace '(?i)(api[_-]?key|api[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*["'']?[^"'',;\s]+', '$1=[redacted]'
  $redacted = $redacted -replace '(?i)\bBearer\s+[A-Za-z0-9._-]+', 'Bearer [redacted]'
  if ($redacted.Length -gt 1000) {
    return $redacted.Substring(0, 1000)
  }
  return $redacted
}

function Get-KaironLocalBetaManifestPath {
  param(
    [string]$PackagePath,
    [string]$ManifestPath
  )

  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    return "$PackagePath.sha256.json"
  }
  return $ManifestPath
}

function Assert-KaironLocalBetaPackage {
  param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [string]$ManifestPath = ""
  )

  $resolvedPackage = (Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).Path
  if ([System.IO.Path]::GetExtension($resolvedPackage).ToLowerInvariant() -ne ".tgz") {
    throw "Local beta package must use the .tgz extension."
  }

  $candidateManifest = Get-KaironLocalBetaManifestPath `
    -PackagePath $resolvedPackage `
    -ManifestPath $ManifestPath
  $resolvedManifest = (Resolve-Path -LiteralPath $candidateManifest -ErrorAction Stop).Path
  $manifest = Get-Content -LiteralPath $resolvedManifest -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $propertyNames = @($manifest.PSObject.Properties.Name)
  foreach ($required in @(
    "schema_version",
    "artifact_kind",
    "package_name",
    "package_version",
    "package_file",
    "sha256",
    "size_bytes"
  )) {
    if ($propertyNames -notcontains $required) {
      throw "Checksum manifest is missing required field: $required"
    }
  }

  if ($manifest.schema_version -ne "0.1" -or
      $manifest.artifact_kind -ne "local_beta_package" -or
      $manifest.package_name -ne "kairon") {
    throw "Checksum manifest is not a Kairon local beta manifest."
  }
  if ($manifest.package_file -ne [System.IO.Path]::GetFileName($resolvedPackage)) {
    throw "Checksum manifest does not match the selected package filename."
  }

  $packageInfo = Get-Item -LiteralPath $resolvedPackage -ErrorAction Stop
  if ([long]$manifest.size_bytes -ne $packageInfo.Length) {
    throw "Package size does not match the checksum manifest."
  }
  $actualHash = (Get-FileHash -LiteralPath $resolvedPackage -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) {
    throw "Package SHA-256 does not match the checksum manifest."
  }

  return [PSCustomObject]@{
    PackagePath = $resolvedPackage
    ManifestPath = $resolvedManifest
    PackageName = [string]$manifest.package_name
    PackageVersion = [string]$manifest.package_version
    Sha256 = $actualHash
    SizeBytes = $packageInfo.Length
  }
}

function Get-KaironRequiredCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw "Required command is not available: $Name"
  }
  return $command
}

function Assert-KaironLocalBetaPrerequisites {
  $node = Get-KaironRequiredCommand -Name "node"
  $npm = Get-KaironRequiredCommand -Name "npm"
  $git = Get-KaironRequiredCommand -Name "git"
  $nodeVersionText = @(& $node.Source --version 2>&1) -join ""
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to determine the Node.js version."
  }
  $nodeVersion = [version]($nodeVersionText.Trim().TrimStart("v"))
  if ($nodeVersion -lt [version]"22.0.0") {
    throw "Kairon local beta requires Node.js 22 or later."
  }
  if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Kairon local beta requires PowerShell 5.1 or later."
  }

  return [PSCustomObject]@{
    NodeCommand = $node.Source
    NpmCommand = $npm.Source
    GitCommand = $git.Source
    NodeVersion = $nodeVersion.ToString()
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
  }
}

function Invoke-KaironLocalBetaCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )

  $output = @()
  if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $output = @(& $Command @Arguments 2>&1)
  } else {
    Push-Location -LiteralPath $WorkingDirectory
    try {
      $output = @(& $Command @Arguments 2>&1)
    } finally {
      Pop-Location
    }
  }
  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) {
    $summary = ConvertTo-KaironRedactedText -Value ($output -join " ")
    throw "Command failed with exit code ${exitCode}: $summary"
  }
  return $output
}

function Write-KaironLocalBetaDiagnostic {
  param(
    [Parameter(Mandatory = $true)][string]$DiagnosticRoot,
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message,
    [hashtable]$Additional = @{}
  )

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $bundle = Join-Path $DiagnosticRoot "kairon-beta-$Operation-$timestamp"
  New-Item -ItemType Directory -Force -Path $bundle | Out-Null
  $record = [ordered]@{
    schema_version = "0.1"
    artifact_kind = "local_beta_diagnostic"
    operation = $Operation
    stage = $Stage
    message = ConvertTo-KaironRedactedText -Value $Message
    created_at = (Get-Date).ToUniversalTime().ToString("o")
  }
  foreach ($key in $Additional.Keys) {
    $record[$key] = $Additional[$key]
  }
  $json = $record | ConvertTo-Json -Depth 10
  $path = Join-Path $bundle "diagnostic.json"
  [System.IO.File]::WriteAllText(
    $path,
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
  return $bundle
}
