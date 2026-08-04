import { describe, expect, it } from 'vitest'

import { BUNDLED_PROVIDER_PRESETS, selectableProviderPresets } from './providerPresets'
import type { ProviderPreset } from '../types/providerPreset'

function makePreset(overrides: Partial<ProviderPreset> & { id: string }): ProviderPreset {
  return {
    name: overrides.id,
    baseUrl: `https://example.test/${overrides.id}`,
    apiFormat: 'anthropic',
    defaultModels: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
    needsApiKey: true,
    websiteUrl: '',
    ...overrides,
  }
}

describe('selectableProviderPresets', () => {
  it('drops retired presets and keeps the rest in order', () => {
    const presets = [
      makePreset({ id: 'keep-a' }),
      makePreset({ id: 'retired', deprecated: true }),
      makePreset({ id: 'keep-b' }),
    ]

    expect(selectableProviderPresets(presets).map((preset) => preset.id)).toEqual([
      'keep-a',
      'keep-b',
    ])
  })

  it('keeps presets that explicitly opt out of retirement', () => {
    const presets = [makePreset({ id: 'live', deprecated: false })]

    expect(selectableProviderPresets(presets)).toHaveLength(1)
  })
})

describe('bundled provider presets', () => {
  // Retiring a preset must not break providers already configured against it: the
  // bundle keeps the entry so the edit form can still resolve its presetId, while
  // the "add provider" chips are built from selectableProviderPresets.
  it('keeps the retired 胜算云 preset resolvable but not selectable', () => {
    const shengsuanyun = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'shengsuanyun')

    expect(shengsuanyun?.deprecated).toBe(true)
    expect(shengsuanyun?.baseUrl).toBe('https://router.shengsuanyun.com/api')
    expect(shengsuanyun?.authStrategy).toBe('auth_token')
    // No referral link or promo copy left to render while editing.
    expect(shengsuanyun?.apiKeyUrl).toBeUndefined()
    expect(shengsuanyun?.promoText).toBeUndefined()
    expect(shengsuanyun?.featured).toBeUndefined()

    const selectableIds = selectableProviderPresets(BUNDLED_PROVIDER_PRESETS).map((p) => p.id)
    expect(selectableIds).not.toContain('shengsuanyun')
    expect(selectableIds).toContain('teamorouter')
    expect(selectableIds).toContain('custom')
  })

  it('keeps the retired 接口AI preset resolvable but not selectable', () => {
    const jiekouai = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'jiekouai')

    expect(jiekouai?.deprecated).toBe(true)
    expect(jiekouai?.apiKeyUrl).toBeUndefined()
    expect(jiekouai?.promoText).toBeUndefined()
    expect(jiekouai?.featured).toBeUndefined()

    expect(selectableProviderPresets(BUNDLED_PROVIDER_PRESETS).map((p) => p.id))
      .not.toContain('jiekouai')
  })
})
