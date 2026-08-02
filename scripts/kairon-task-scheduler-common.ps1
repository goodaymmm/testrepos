Set-StrictMode -Version Latest

$script:KaironBackgroundLauncher = Join-Path `
  $PSScriptRoot `
  "kairon-background-launcher.vbs"

function ConvertTo-KaironTaskArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  $builder = [System.Text.StringBuilder]::new()
  $quote = [char]34
  $backslash = [char]92
  $slashCount = 0
  [void]$builder.Append($quote)

  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq $backslash) {
      $slashCount += 1
      continue
    }
    if ($character -eq $quote) {
      [void]$builder.Append($backslash, ($slashCount * 2) + 1)
      [void]$builder.Append($quote)
      $slashCount = 0
      continue
    }
    [void]$builder.Append($backslash, $slashCount)
    [void]$builder.Append($character)
    $slashCount = 0
  }

  [void]$builder.Append($backslash, $slashCount * 2)
  [void]$builder.Append($quote)
  return $builder.ToString()
}

function Get-KaironBackgroundProcessActionSpec {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = ""
  )

  if (-not (Test-Path -LiteralPath $script:KaironBackgroundLauncher -PathType Leaf)) {
    throw "Kairon background launcher was not found: $script:KaironBackgroundLauncher"
  }

  $powerShell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) {
    (Get-Command pwsh.exe -ErrorAction Stop).Source
  } else {
    (Get-Command powershell.exe -ErrorAction Stop).Source
  }
  $executableLiteral = ConvertTo-KaironPowerShellLiteral $Executable
  $argumentLiterals = @($ArgumentList | ForEach-Object {
    ConvertTo-KaironPowerShellLiteral ([string]$_)
  })
  $argumentExpression = if ($argumentLiterals.Count -eq 0) {
    "@()"
  } else {
    "@(" + ($argumentLiterals -join ",") + ")"
  }
  $encodedScript = @"
`$ErrorActionPreference = 'Stop'
try {
  `$argumentList = $argumentExpression
  & $executableLiteral @argumentList
  `$exitCode = if (`$LASTEXITCODE -is [int]) { `$LASTEXITCODE } else { 0 }
  exit `$exitCode
} catch {
  [Console]::Error.WriteLine(`$_.Exception.Message)
  exit 1
}
"@
  $encodedCommand = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($encodedScript)
  )

  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $launcherArguments = @(
    "//B",
    "//NoLogo",
    $script:KaironBackgroundLauncher,
    $powerShell,
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encodedCommand
  )
  $serializedArguments = ($launcherArguments |
    ForEach-Object { ConvertTo-KaironTaskArgument ([string]$_) }
  ) -join " "

  return [pscustomobject]@{
    Execute = $wscript
    Arguments = $serializedArguments
    WorkingDirectory = $WorkingDirectory
    WindowMode = "background"
  }
}

function ConvertTo-KaironPowerShellLiteral {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-KaironBackgroundPowerShellActionSpec {
  param(
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [string]$WorkingDirectory = ""
  )

  $powerShell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) {
    (Get-Command pwsh.exe -ErrorAction Stop).Source
  } else {
    (Get-Command powershell.exe -ErrorAction Stop).Source
  }
  $powerShellArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass"
  ) + @($ArgumentList)

  return Get-KaironBackgroundProcessActionSpec `
    -Executable $powerShell `
    -ArgumentList $powerShellArguments `
    -WorkingDirectory $WorkingDirectory
}

function New-KaironBackgroundTaskAction {
  param([Parameter(Mandatory = $true)]$Spec)

  $parameters = @{
    Execute = $Spec.Execute
    Argument = $Spec.Arguments
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$Spec.WorkingDirectory)) {
    $parameters.WorkingDirectory = [string]$Spec.WorkingDirectory
  }

  return New-ScheduledTaskAction @parameters
}

function Test-KaironBackgroundTaskAction {
  param(
    [Parameter(Mandatory = $true)]$Action,
    [Parameter(Mandatory = $true)]$ExpectedSpec
  )

  return (
    [System.IO.Path]::GetFileName([string]$Action.Execute) -ieq "wscript.exe" -and
    [string]$Action.Arguments -eq [string]$ExpectedSpec.Arguments -and
    [string]$Action.WorkingDirectory -eq [string]$ExpectedSpec.WorkingDirectory
  )
}

function ConvertTo-KaironLegacyTaskArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Test-KaironLegacyPowerShellTaskAction {
  param(
    [Parameter(Mandatory = $true)]$Action,
    [Parameter(Mandatory = $true)][string]$ExpectedArguments
  )

  return (
    [System.IO.Path]::GetFileName([string]$Action.Execute) -ieq "powershell.exe" -and
    [string]$Action.Arguments -eq $ExpectedArguments
  )
}

function Get-KaironTaskWindowMode {
  param([Parameter(Mandatory = $true)]$Action)

  if (
    [System.IO.Path]::GetFileName([string]$Action.Execute) -ieq "wscript.exe"
  ) {
    return "background"
  }
  return "foreground_possible"
}
