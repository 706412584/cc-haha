[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [ValidateSet('x64')][string]$Arch = 'x64'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:CI -ne 'true') {
  throw 'This installer smoke mutates Windows installer registry state and may run only on an ephemeral CI runner.'
}

$resolvedArtifactsDir = (Resolve-Path -LiteralPath $ArtifactsDir).Path
$installers = @(Get-ChildItem -LiteralPath $resolvedArtifactsDir -File |
  Where-Object { $_.Name -like "Claude-Code-Haha-*-win-$Arch.exe" })
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows $Arch installer in $resolvedArtifactsDir, found $($installers.Count)."
}
$installer = $installers[0].FullName
$packageJson = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$productName = [string]$packageJson.build.productName
if ([string]::IsNullOrWhiteSpace($productName)) {
  throw 'desktop/package.json must define build.productName for installer smoke validation.'
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "cc-haha-installer-smoke-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $testRoot 'Claude Code Haha'
$appData = Join-Path $testRoot 'AppData\Roaming'
$localAppData = Join-Path $testRoot 'AppData\Local'
$userProfile = Join-Path $testRoot 'UserProfile'
$appExe = Join-Path $installDir "$productName.exe"
$uninstaller = Join-Path $installDir "Uninstall $productName.exe"
$recoveryHelper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\recover-legacy-install-data.ps1')).Path
$processHelper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\check-install-processes.ps1')).Path
$siblingProcess = $null
$installProcess = $null
$bundledHelperProcess = $null

$savedEnvironment = @{}
foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CC_HAHA_APP_PORTABLE_DIR', 'COMPLUS_Version')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-ProcessExpectFailure {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$ExpectedExitCode,
    [int]$TimeoutSeconds = 180
  )

  [Console]::Out.WriteLine("$Stage starting...")
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Stage timed out after $TimeoutSeconds seconds."
    }
    if ($PSBoundParameters.ContainsKey('ExpectedExitCode')) {
      if ($process.ExitCode -ne $ExpectedExitCode) {
        throw "$Stage expected process exit code $ExpectedExitCode, received $($process.ExitCode)."
      }
    } elseif ($process.ExitCode -eq 0) {
      throw "$Stage unexpectedly succeeded with process exit code 0."
    }
    [Console]::Out.WriteLine("$Stage failed safely with process exit code $($process.ExitCode).")
  } finally {
    $process.Dispose()
  }
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutSeconds = 180
  )

  [Console]::Out.WriteLine("$Stage starting...")
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Stage timed out after $TimeoutSeconds seconds."
    }
    if ($process.ExitCode -ne 0) {
      throw "$Stage failed with process exit code $($process.ExitCode)."
    }
    [Console]::Out.WriteLine("$Stage completed successfully.")
  } finally {
    $process.Dispose()
  }
}

function Test-IsProcessElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  } finally {
    $identity.Dispose()
  }
}

function Invoke-ProcessHelperExpectExit {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][int]$ExpectedExitCode,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  [Console]::Out.WriteLine("$Stage starting...")
  & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $processHelper @Arguments
  if ($LASTEXITCODE -ne $ExpectedExitCode) {
    throw "$Stage expected exit code $ExpectedExitCode, received $LASTEXITCODE."
  }
  [Console]::Out.WriteLine("$Stage completed with expected exit code $ExpectedExitCode.")
}

function Invoke-LegacyRecoveryDiagnostic {
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $recoveryHelper,
    '-PerUserInstallDir',
    $installDir,
    '-CandidateInstallDir',
    $installDir,
    '-UserDataDir',
    (Join-Path $appData 'Claude Code Haha'),
    '-RecoveryRoot',
    (Join-Path $userProfile 'Claude Code Haha Data\Recovered'),
    '-ProcessName',
    "$productName.exe",
    '-InstallerIdentitySafety',
    'trusted-user'
  )

  [Console]::Out.WriteLine('Direct legacy recovery diagnostic starting...')
  $output = @(& $windowsPowerShell @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) {
    [Console]::Out.WriteLine([string]$line)
  }
  if ($exitCode -ne 0) {
    throw "Direct legacy recovery diagnostic failed with exit code $exitCode."
  }
  [Console]::Out.WriteLine('Direct legacy recovery diagnostic completed successfully.')
}

try {
  New-Item -ItemType Directory -Path $appData, $localAppData, $userProfile -Force | Out-Null
  $env:APPDATA = $appData
  $env:LOCALAPPDATA = $localAppData
  $env:USERPROFILE = $userProfile
  Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:CC_HAHA_APP_PORTABLE_DIR -ErrorAction SilentlyContinue

  Invoke-CheckedProcess -FilePath $installer -Stage 'Fresh install' -Arguments @('/S', '/currentuser', "/D=$installDir")
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Fresh install did not create the application executable: $appExe"
  }

  $processProbeSource = Join-Path $env:SystemRoot 'System32\ping.exe'
  $siblingDir = "$installDir Tools"
  $siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'
  New-Item -ItemType Directory -Path $siblingDir -Force | Out-Null
  Copy-Item -LiteralPath $processProbeSource -Destination $siblingProbe
  $siblingProcess = Start-Process -FilePath $siblingProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  Invoke-CheckedProcess -FilePath $installer -Stage 'Sibling-prefix process reinstall' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if ($siblingProcess.HasExited) {
    throw 'Sibling-prefix process was mistaken for an install-directory process.'
  }
  [Console]::Out.WriteLine('Sibling-prefix process remains running after reinstall.')

  $installProbe = Join-Path $installDir 'install-process-probe.exe'
  Copy-Item -LiteralPath $processProbeSource -Destination $installProbe
  $installProcess = Start-Process -FilePath $installProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  Invoke-ProcessHelperExpectExit `
    -Stage 'Install-directory parent process detection' `
    -ExpectedExitCode 0 `
    -Arguments @(
      '-InstallDir', $installDir,
      '-ProcessName', 'Claude Code Haha.exe',
      '-Action', 'Find',
      '-InstallerPid', [string]$PID,
      '-InstallerParentPid', [string]$installProcess.Id
    )
  Invoke-CheckedProcess -FilePath $installer -Stage 'Install-directory process reinstall' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if (-not $installProcess.HasExited) {
    throw 'Install-directory process was not terminated before reinstall.'
  }

  Invoke-LegacyRecoveryDiagnostic
  Stop-Process -Id $siblingProcess.Id -Force
  $siblingProcess.WaitForExit()
  $siblingProcess.Dispose()
  $siblingProcess = $null

  $bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'
  Copy-Item -LiteralPath $processProbeSource -Destination $bundledHelperProbe
  $bundledHelperProcess = Start-Process -FilePath $bundledHelperProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  Invoke-ProcessExpectFailure -FilePath $installer -Stage 'No-CLR external bundled-helper process reinstall' -ExpectedExitCode 22 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if ($bundledHelperProcess.HasExited) {
    throw 'No-CLR exact-image fallback terminated an external bundled-helper process.'
  }
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  Stop-Process -Id $bundledHelperProcess.Id -Force
  $bundledHelperProcess.WaitForExit()
  $bundledHelperProcess.Dispose()
  $bundledHelperProcess = $null

  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  if (Test-IsProcessElevated) {
    Invoke-ProcessExpectFailure -FilePath $installer -Stage 'Elevated default-mode reinstall without CLR' -ExpectedExitCode 20 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  } else {
    Invoke-CheckedProcess -FilePath $installer -Stage 'Trusted-user default-mode reinstall without CLR' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  }
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Reinstall removed the application executable: $appExe"
  }

  $legacyDir = Join-Path $installDir 'CLAUDE_CONFIG_DIR'
  $legacySentinel = Join-Path $legacyDir 'settings.json'
  New-Item -ItemType Directory -Path $legacyDir -Force | Out-Null
  Set-Content -LiteralPath $legacySentinel -Value 'must-survive-failed-upgrade' -NoNewline
  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  Invoke-ProcessExpectFailure -FilePath $installer -Stage 'Portable reinstall without CLR' -ExpectedExitCode 20 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  if ((Get-Content -LiteralPath $legacySentinel -Raw) -ne 'must-survive-failed-upgrade') {
    throw 'Portable reinstall without CLR modified legacy data instead of failing closed.'
  }

  [Console]::Out.WriteLine('Windows installer fresh-install, no-CLR default reinstall, and fail-closed portable reinstall smoke passed.')
} finally {
  foreach ($probeProcess in @($installProcess, $siblingProcess, $bundledHelperProcess)) {
    if ($null -ne $probeProcess) {
      if (-not $probeProcess.HasExited) {
        Stop-Process -Id $probeProcess.Id -Force -ErrorAction SilentlyContinue
      }
      $probeProcess.Dispose()
    }
  }
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Invoke-CheckedProcess -FilePath $uninstaller -Stage 'Cleanup uninstall' -Arguments @('/S', '/KEEP_APP_DATA', '/currentuser') -TimeoutSeconds 120
  }
  foreach ($name in $savedEnvironment.Keys) {
    $value = $savedEnvironment[$name]
    if ($null -eq $value) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    } else {
      [Environment]::SetEnvironmentVariable($name, [string]$value, 'Process')
    }
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
