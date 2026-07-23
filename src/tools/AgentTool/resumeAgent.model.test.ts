import { describe, expect, test } from 'bun:test'
import { resolveResumedAgentModelOverride } from './resumeAgent.js'

describe('resumed Agent model override', () => {
  test('retains a valid per-invocation model alias', () => {
    expect(resolveResumedAgentModelOverride('fable')).toBe('fable')
    expect(resolveResumedAgentModelOverride('haiku')).toBe('haiku')
  })

  test('keeps old or malformed metadata from injecting a model', () => {
    expect(resolveResumedAgentModelOverride(undefined)).toBeUndefined()
    expect(resolveResumedAgentModelOverride('provider-owned-model')).toBeUndefined()
    expect(resolveResumedAgentModelOverride(7)).toBeUndefined()
  })
})
