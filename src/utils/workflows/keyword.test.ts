import { describe, expect, test } from 'bun:test'
import { findKeywordRanges, hasWorkflowKeyword } from './keyword.js'

describe('ultracode keyword matcher', () => {
  test.each([
    ['bare', 'ultracode: audit every endpoint'],
    ['mid-sentence', 'please ultracode this repo'],
    ['capitalised', 'Ultracode the migration'],
    ['after a comma', 'ok, ultracode, go'],
    ['at the end', 'audit the routes ultracode'],
  ])('fires on %s', (_label, text) => {
    expect(hasWorkflowKeyword(text)).toBe(true)
  })

  test.each([
    ['inside backticks', 'run `ultracode` to see the keyword'],
    ['inside double quotes', 'the word "ultracode" opts a turn in'],
    ['inside single quotes', "the word 'ultracode' opts a turn in"],
    ['inside a tag', '<ultracode> is not a real tag'],
    ['inside braces', 'config is { mode: ultracode }'],
    ['inside brackets', 'see [ultracode] in the docs'],
    ['inside parens', 'the flag (ultracode) exists'],
    ['as a path segment', 'open docs/ultracode/readme.md'],
    ['as a filename', 'edit ultracode.ts'],
    ['as a flag', 'pass --ultracode to the CLI'],
    ['hyphenated', 'the ultracode-runner package'],
    ['as a question', 'what is ultracode?'],
    ['as a substring', 'superultracoded is a different word'],
  ])('does not fire %s', (_label, text) => {
    expect(hasWorkflowKeyword(text)).toBe(false)
  })

  test('an apostrophe inside a word does not open a quoted span', () => {
    expect(hasWorkflowKeyword("don't stop — ultracode this")).toBe(true)
  })

  test('reports the range so the composer can highlight it', () => {
    const ranges = findKeywordRanges('please Ultracode this repo')
    expect(ranges).toEqual([{ word: 'Ultracode', start: 7, end: 16 }])
  })

  test('finds every standalone occurrence', () => {
    expect(findKeywordRanges('ultracode now, ultracode later')).toHaveLength(2)
  })

  test('empty and missing input never fires', () => {
    expect(hasWorkflowKeyword('')).toBe(false)
    expect(hasWorkflowKeyword(null)).toBe(false)
    expect(hasWorkflowKeyword(undefined)).toBe(false)
  })
})
