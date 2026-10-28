import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_CODE_COMPAT_VERSION,
  CLAUDE_CODE_WIRE_ENTRYPOINT,
} from './claudeCodeCompatibility.js'
import { getAttributionHeader } from './system.js'

function withEntrypoint<T>(value: string | undefined, run: () => T): T {
  const original = process.env.CLAUDE_CODE_ENTRYPOINT
  if (value === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = value
  try {
    return run()
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = original
  }
}

describe('getAttributionHeader', () => {
  test('tracks the audited upstream Claude Code compatibility release', () => {
    expect(CLAUDE_CODE_COMPAT_VERSION).toBe('2.1.288')
  })

  test('uses Claude Code compatibility version and always includes CCH placeholder', () => {
    withEntrypoint('cli', () => {
      expect(getAttributionHeader('abc')).toBe(
        'x-anthropic-billing-header: cc_version=2.1.288.abc; cc_entrypoint=cli; cch=00000;',
      )
    })
  })

  test('reports the CLI entrypoint upstream even when the host sets claude-desktop', () => {
    // CLAUDE_CODE_ENTRYPOINT=claude-desktop is an internal switch for the
    // desktop host; it must not leak into the billing header.
    expect(CLAUDE_CODE_WIRE_ENTRYPOINT).toBe('cli')
    for (const hostValue of ['claude-desktop', 'sdk-cli', undefined]) {
      withEntrypoint(hostValue, () => {
        expect(getAttributionHeader('abc')).toContain('cc_entrypoint=cli;')
      })
    }
  })
})
