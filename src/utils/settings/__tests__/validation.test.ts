import { describe, expect, it } from 'bun:test'
import { safeParseJSON } from '../../json.js'
import { filterInvalidPermissionRules } from '../validation.js'

const VALID_RULE = 'Bash(ls:*)'
const INVALID_RULE = 'Bash(ls:*' // unbalanced paren fails rule validation

describe('filterInvalidPermissionRules', () => {
  it('drops invalid rules and reports one warning per drop', () => {
    const input = {
      permissions: {
        allow: [VALID_RULE, INVALID_RULE, 42],
        deny: [VALID_RULE],
      },
    }

    const { data, warnings } = filterInvalidPermissionRules(input, '/tmp/settings.json')
    const perms = (data as { permissions: Record<string, unknown> }).permissions

    expect(perms.allow).toEqual([VALID_RULE])
    expect(perms.deny).toEqual([VALID_RULE])
    expect(warnings).toHaveLength(2)
    expect(warnings.every(w => w.file === '/tmp/settings.json')).toBe(true)
  })

  it('passes through data without a permissions object untouched', () => {
    const input = { model: 'sonnet' }
    const { data, warnings } = filterInvalidPermissionRules(input, '/tmp/settings.json')
    expect(data).toBe(input)
    expect(warnings).toEqual([])
  })

  it('never mutates its input (GH #1126 cache-poisoning family)', () => {
    const input = {
      permissions: { allow: [VALID_RULE, INVALID_RULE] },
    }

    filterInvalidPermissionRules(input, '/tmp/settings.json')

    // The caller's object — potentially a shared safeParseJSON cache entry —
    // must keep the invalid rule; only the returned copy is filtered.
    expect(input.permissions.allow).toEqual([VALID_RULE, INVALID_RULE])
  })

  it('keeps byte-identical settings content parsing identically after a filter pass', () => {
    // End-to-end shape of the original bug: parse (shared cache) → filter →
    // a later parse of the same string must still see the invalid rule.
    const content = JSON.stringify({
      permissions: { allow: [VALID_RULE, INVALID_RULE] },
    })

    const first = safeParseJSON(content, false)
    filterInvalidPermissionRules(first, '/tmp/a/settings.json')

    const second = safeParseJSON(content, false) as {
      permissions: { allow: unknown[] }
    }
    expect(second.permissions.allow).toEqual([VALID_RULE, INVALID_RULE])
  })
})
