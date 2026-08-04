import { describe, expect, test } from 'bun:test'
import {
  resolveAvailableShellTool,
  resolveShellToolAvailability,
} from './shellToolUtils.js'

describe('resolveShellToolAvailability', () => {
  test('falls back to PowerShell when Git Bash is unavailable on Windows', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: null,
        userType: undefined,
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: false, powershell: true })
  })

  test('keeps the existing external default when Git Bash is available', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        userType: undefined,
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: true, powershell: false })
  })

  test('honors an explicit PowerShell opt-out', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'windows',
        gitBashPath: null,
        userType: undefined,
        powerShellSetting: '0',
      }),
    ).toEqual({ bash: false, powershell: false })
  })

  test('keeps Bash available on non-Windows platforms', () => {
    expect(
      resolveShellToolAvailability({
        platform: 'macos',
        gitBashPath: null,
        userType: undefined,
        powerShellSetting: undefined,
      }),
    ).toEqual({ bash: true, powershell: false })
  })
})

describe('resolveAvailableShellTool', () => {
  test('keeps the preferred shell when it is available', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: true, powershell: true },
      }),
    ).toBe('bash')
  })

  test('falls back to PowerShell when Bash is unavailable', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: true },
      }),
    ).toBe('powershell')
  })

  test('does not reinterpret an explicit shell syntax contract', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: true },
        allowFallback: false,
      }),
    ).toBeNull()
  })

  test('returns null when neither shell is available', () => {
    expect(
      resolveAvailableShellTool({
        preferredShell: 'bash',
        availability: { bash: false, powershell: false },
      }),
    ).toBeNull()
  })
})
