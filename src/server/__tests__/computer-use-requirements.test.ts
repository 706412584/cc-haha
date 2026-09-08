import { describe, expect, test } from 'bun:test'

import win32Requirements from '../../../runtime/requirements-win.txt' with { type: 'text' }

/**
 * These pins exist because the newer major versions drop the Python releases
 * the helper still has to run on, and pip resolves that as a confusing install
 * failure rather than a version complaint. There is only one requirements file
 * now: macOS drives Computer Use through the native `cu-helper` daemon and
 * never installs a Python runtime, so the darwin list (and `mac_helper.py`
 * with it) was removed.
 */
function findRequirement(requirements: string, packageName: string): string | undefined {
  return requirements
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.startsWith(`${packageName}`))
}

describe('computer use requirements', () => {
  test('pins mss to the last Python 3.8-compatible major version', () => {
    expect(findRequirement(win32Requirements, 'mss')).toBe('mss>=9.0.2,<10')
  })

  test('pins Pillow to the Python 3.9-compatible 11.x major line', () => {
    expect(findRequirement(win32Requirements, 'Pillow')).toBe('Pillow>=11.3.0,<12')
  })

  test('carries the Windows-only dependencies the helper imports', () => {
    // win_helper.py imports these directly. A missing pin here surfaces as an
    // ImportError inside the helper subprocess, which reaches the user as an
    // opaque "helper failed" rather than a missing dependency.
    for (const pkg of ['pywin32', 'psutil', 'pyperclip', 'screeninfo', 'pyautogui']) {
      expect(findRequirement(win32Requirements, pkg)).toBeDefined()
    }
  })
})
