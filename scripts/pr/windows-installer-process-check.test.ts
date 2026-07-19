import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('Windows installer process matching', () => {
  test('uses a directory-boundary-aware process helper', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8')
    const processHelper = readFileSync(
      'desktop/build/check-install-processes.ps1',
      'utf8',
    )

    expect(installerHook).not.toContain('!insertmacro _CHECK_APP_RUNNING')
    expect(installerHook).toContain('check-install-processes.ps1')
    expect(installerHook).toContain('!macro CcHahaFindInstallProcess')
    expect(installerHook).toContain('!macro CcHahaKillInstallProcess')
    expect(installerHook).toContain('-InstallerPid "$pid"')
    expect(installerHook).toContain('-InstallerParentPid "$1"')
    expect(installerHook).toContain('tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH >')
    expect(installerHook).toContain('tasklist process enumeration failed')
    expect(installerHook).toContain('fallback process filtering failed')
    expect(installerHook).toMatch(
      /tasklist process enumeration failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toMatch(
      /fallback process filtering failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toContain('claude-sidecar-x86_64-pc-windows-msvc.exe')
    expect(installerHook).toContain('claude-sidecar-aarch64-pc-windows-msvc.exe')
    expect(installerHook).toContain('/C:"OpenConsole.exe"')
    expect(installerHook).toContain('/C:"winpty-agent.exe"')
    expect(installerHook).toContain('/C:"rg.exe"')
    expect(installerHook).toContain('bundled terminal/search helper')
    expect(installerHook).toContain('Differently named child processes cannot be attributed')
    expect(installerHook).not.toContain('| "$FindPath"')

    expect(processHelper).toContain('function Test-PathInsideInstallDirectory')
    expect(processHelper).toContain(
      '$rootWithSeparator = $resolvedRoot + [IO.Path]::DirectorySeparatorChar',
    )
    expect(processHelper).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(processHelper).toContain('$process.ProcessId -eq $InstallerPid')
    expect(processHelper).not.toContain('$process.ProcessId -eq $InstallerParentPid')
    expect(processHelper).toContain('Matched protected install process:')
    expect(processHelper).toContain('Blocked unknown-path application process:')
    expect(processHelper).toContain('$unknownPathMatches.Add($process)')
    expect(installerHook).not.toContain('taskkill')
    expect(installerHook).toContain('refusing to terminate by image name')
    expect(installerHook.match(/SetErrorLevel 22/g)).toHaveLength(2)
    expect(installerHook).toMatch(
      /MessageBox MB_OKCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
    expect(installerHook).toMatch(
      /MessageBox MB_RETRYCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
  })

  test('keeps sibling-prefix and real install process cases in Windows smoke', () => {
    const installerSmoke = readFileSync(
      'desktop/scripts/windows-installer-smoke.ps1',
      'utf8',
    )

    expect(installerSmoke).toContain("$siblingDir = \"$installDir Tools\"")
    expect(installerSmoke).toContain("$siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'")
    expect(installerSmoke).toContain('Sibling-prefix process remains running')
    expect(installerSmoke).toContain('Install-directory parent process detection')
    expect(installerSmoke).toContain('Install-directory process was not terminated')
    expect(installerSmoke).toContain("$bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'")
    expect(installerSmoke).toContain('No-CLR external bundled-helper process reinstall')
    expect(installerSmoke).toMatch(
      /No-CLR external bundled-helper process reinstall' -ExpectedExitCode 22/,
    )
    expect(installerSmoke).toContain('No-CLR exact-image fallback terminated an external bundled-helper')
  })
})
