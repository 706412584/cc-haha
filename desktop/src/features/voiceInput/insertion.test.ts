import { describe, expect, it } from 'vitest'
import {
  normalizeDictationText,
  placeDictationResult,
  withDictationSpacing,
} from './insertion'

describe('normalizeDictationText', () => {
  it('trims and folds line breaks into single spaces', () => {
    expect(normalizeDictationText('  hello \n\n world\r\n')).toBe('hello world')
  })

  it('reduces whitespace-only output to nothing', () => {
    expect(normalizeDictationText(' \n \t ')).toBe('')
  })
})

describe('withDictationSpacing', () => {
  it('separates two latin words that would otherwise fuse', () => {
    expect(withDictationSpacing('hello', 'big', ' world')).toBe(' big')
    expect(withDictationSpacing('hello', 'big', 'world')).toBe(' big ')
  })

  it('leaves CJK text flush against its neighbours', () => {
    expect(withDictationSpacing('你好', '世界', '再见')).toBe('世界')
  })

  it('does not double an existing space', () => {
    expect(withDictationSpacing('hello ', 'big', ' world')).toBe('big')
  })

  it('adds a space after sentence punctuation before a latin word', () => {
    expect(withDictationSpacing('Done.', 'Next', '')).toBe(' Next')
  })

  it('adds nothing at the edges of an empty draft', () => {
    expect(withDictationSpacing('', 'hello', '')).toBe('hello')
  })
})

describe('placeDictationResult', () => {
  const base = { revisionAtStart: 3, revisionNow: 3, blocked: false, composing: false }

  it('inserts when nothing changed', () => {
    expect(placeDictationResult(base)).toBe('insert')
  })

  it('holds when the draft moved on, even if it was later restored', () => {
    expect(placeDictationResult({ ...base, revisionNow: 5 })).toBe('hold')
  })

  it('holds while the composer is blocked by a send or a pending question', () => {
    expect(placeDictationResult({ ...base, blocked: true })).toBe('hold')
  })

  it('holds during an IME composition even when nothing else changed', () => {
    expect(placeDictationResult({ ...base, composing: true })).toBe('hold')
  })
})
