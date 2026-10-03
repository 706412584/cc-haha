import { describe, expect, test } from 'bun:test'
import { VoiceProviderRegistry } from '../registry.js'
import { FakeProvider } from './fakeProvider.js'

describe('VoiceProviderRegistry', () => {
  test('registers, looks up and lists providers in insertion order', () => {
    const registry = new VoiceProviderRegistry()
    const a = new FakeProvider({ id: 'a' })
    const b = new FakeProvider({ id: 'b' })
    registry.register(a).register(b)

    expect(registry.get('a')).toBe(a)
    expect(registry.get('b')).toBe(b)
    expect(registry.list()).toEqual([a, b])
  })

  test('returns undefined for unknown ids without falling back to another provider', () => {
    const registry = new VoiceProviderRegistry()
    registry.register(new FakeProvider({ id: 'a' }))

    expect(registry.get('missing')).toBeUndefined()
  })

  test('rejects a duplicate id and keeps the first registration', () => {
    const registry = new VoiceProviderRegistry()
    const first = new FakeProvider({ id: 'dup' })
    registry.register(first)

    expect(() => registry.register(new FakeProvider({ id: 'dup' }))).toThrow('already registered')
    expect(registry.get('dup')).toBe(first)
    expect(registry.list()).toHaveLength(1)
  })
})
