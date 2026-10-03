import { describe, expect, it } from 'bun:test'
import { isBlankFileContent } from '../services/blankFileContent.js'

describe('isBlankFileContent', () => {
  // Nothing in these holds data a reader could lose.
  const blank: Array<[string, string]> = [
    ['an empty string', ''],
    ['spaces, tabs and newlines', ' \t\r\n '],
    ['a lone UTF-8 BOM', '﻿'],
    ['NUL padding (a zero-filled file after a crash mid-write)', '\0'.repeat(713)],
    ['a BOM followed by NULs and whitespace', '﻿\0\0 \n\0'],
  ]
  for (const [name, content] of blank) {
    it(`treats ${name} as blank`, () => {
      expect(isBlankFileContent(content)).toBe(true)
    })
  }

  // Anything with content stays a parse problem to be reported, never a blank file.
  const notBlank: Array<[string, string]> = [
    ['valid JSON', '{"tasks": []}'],
    ['truncated JSON', '{"tasks": ['],
    ['NULs in front of real data', '\0\0{"tasks": []}'],
    ['NULs behind real data', '{"tasks": []}\0\0'],
    ['a BOM in front of real data', '﻿{"tasks": []}'],
    ['a bare JSON scalar', '0'],
    ['the JSON literal null', 'null'],
  ]
  for (const [name, content] of notBlank) {
    it(`does not treat ${name} as blank`, () => {
      expect(isBlankFileContent(content)).toBe(false)
    })
  }
})
