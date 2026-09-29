import { describe, expect, test } from 'bun:test'
import { createUnparsedToolInput, isUnparsedToolInput } from './unparsedToolInput.js'

describe('unparsed tool input marker', () => {
  test('bounds the raw argument prefix while retaining original length', () => {
    const raw = '{' + 'x'.repeat(3000)
    expect(createUnparsedToolInput(raw)).toEqual({ __unparsedToolInput: { raw: raw.slice(0, 2048), len: raw.length } })
    expect(isUnparsedToolInput(createUnparsedToolInput(raw))).toBe(true)
  })

  test.each([null, [], {}, { __unparsedToolInput: null }, { __unparsedToolInput: 'bad' },
    { __unparsedToolInput: { raw: 'bad', len: '3' } },
    { __unparsedToolInput: { raw: 'bad', len: 3 }, legitimate: true },
  ].map(input => [input]))('does not treat ordinary or malformed objects as the reserved marker: %j', input => {
    expect(isUnparsedToolInput(input)).toBe(false)
  })
})
