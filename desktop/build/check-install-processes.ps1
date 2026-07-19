[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [ValidateSet('Find', 'Kill', 'KillForce')][string]$Action = 'Find',
  [int]$InstallerPid = 0,
  [int]$InstallerParentPid = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-PathInsideInstallDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $rootWithSeparator = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
  return $resolvedCandidate.StartsWith(
    $rootWithSeparator,
    [StringComparison]::OrdinalIgnoreCase)
}

try {
  $matches = New-Object 'System.Collections.Generic.List[object]'
  $unknownPathMatches = New-Object 'System.Collections.Generic.List[object]'
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.ProcessId -eq $InstallerPid) {
      continue
    }

    $executablePath = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($executablePath)) {
      if (([string]$process.Name).Equals($ProcessName, [StringComparison]::OrdinalIgnoreCase)) {
        $unknownPathMatches.Add($process)
      }
      continue
    }

    if (Test-PathInsideInstallDirectory -Root $InstallDir -Candidate $executablePath) {
      $matches.Add($process)
    }
  }

  foreach ($process in $matches) {
    $path = if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      '<path unavailable>'
    } else {
      [string]$process.ExecutablePath
    }
    [Console]::Out.WriteLine(
      "Matched protected install process: PID=$($process.ProcessId); Name=$($process.Name); Path=$path")
  }

  foreach ($process in $unknownPathMatches) {
    [Console]::Out.WriteLine(
      "Blocked unknown-path application process: PID=$($process.ProcessId); Name=$($process.Name); close it manually")
  }

  if ($matches.Count -eq 0 -and $unknownPathMatches.Count -eq 0) {
    exit 1
  }
  if ($Action -eq 'Find') {
    exit 0
  }

  $force = $Action -eq 'KillForce'
  foreach ($process in $matches) {
    Stop-Process -Id $process.ProcessId -Force:$force -ErrorAction Stop
  }
  exit 0
} catch {
  $message = ([string]$_.Exception.Message) -replace '[\r\n]+', ' '
  [Console]::Out.WriteLine("Install process check failed closed: $message")
  exit 0
}
