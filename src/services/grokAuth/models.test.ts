import { describe, expect, test } from 'bun:test'
import {
  GROK_DEFAULT_MAIN_MODEL,
  GROK_MODEL_CATALOG,
  getGrokContextWindowForModel,
  resolveGrokModel,
  resolveGrokReasoningEffort,
} from './models.js'

describe('Grok model catalog', () => {
  test('keeps CLI-only aliases out of the picker fallback and defaults to Grok 4.6', () => {
    expect(GROK_MODEL_CATALOG.map((model) => model.value)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-composer-2.5-fast',
    ])
    expect(GROK_DEFAULT_MAIN_MODEL).toBe('grok-4.6')
    expect(resolveGrokModel('claude-opus-4-1')).toBe(GROK_DEFAULT_MAIN_MODEL)
  })

  test('preserves remote model IDs and resolves only Claude compatibility aliases', () => {
    expect(resolveGrokModel('grok-composer-2.5-fast')).toBe('grok-composer-2.5-fast')
    expect(resolveGrokModel('grok')).toBe(GROK_DEFAULT_MAIN_MODEL)
    expect(resolveGrokModel('grok-next-preview')).toBe('grok-next-preview')
    expect(resolveGrokModel('unknown-model')).toBe('unknown-model')
    expect(getGrokContextWindowForModel('grok-4.6')).toBe(500_000)
    expect(getGrokContextWindowForModel('grok-4.5')).toBe(500_000)
    expect(getGrokContextWindowForModel('unknown-model')).toBeNull()
  })

  test('normalizes reasoning effort through the selected model catalog', () => {
    expect(resolveGrokReasoningEffort('grok-4.6', 'xhigh')).toBe('xhigh')
    expect(resolveGrokReasoningEffort('grok-4.6', 'max')).toBe('high')
    expect(resolveGrokReasoningEffort('grok-4.5', 'low')).toBe('low')
    expect(resolveGrokReasoningEffort('grok-4.5', 'max')).toBe('high')
    expect(resolveGrokReasoningEffort('grok-composer-2.5-fast', 'high')).toBeUndefined()
  })
})
