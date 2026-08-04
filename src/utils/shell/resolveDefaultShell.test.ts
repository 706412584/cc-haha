import { describe, expect, test } from 'bun:test'
import { resolveDefaultShellFromAvailability } from './resolveDefaultShell.js'

describe('resolveDefaultShellFromAvailability', () => {
  test('uses PowerShell for the historical Bash default when Git Bash is absent', () => {
    expect(
      resolveDefaultShellFromAvailability(undefined, {
        bash: false,
        powershell: true,
      }),
    ).toBe('powershell')
  })

  test('keeps Bash as the default when it is available', () => {
    expect(
      resolveDefaultShellFromAvailability(undefined, {
        bash: true,
        powershell: false,
      }),
    ).toBe('bash')
  })

  test('falls back from an unavailable configured shell', () => {
    expect(
      resolveDefaultShellFromAvailability('powershell', {
        bash: true,
        powershell: false,
      }),
    ).toBe('bash')
  })

  test('returns null when the user has no enabled command shell', () => {
    expect(
      resolveDefaultShellFromAvailability(undefined, {
        bash: false,
        powershell: false,
      }),
    ).toBeNull()
  })
})
