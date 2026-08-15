import { describe, expect, it } from 'vitest'

import { BUNDLED_PROVIDER_PRESETS, presetMatchesBaseUrl, selectableProviderPresets } from './providerPresets'
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
  it('defaults MiniMax to the China endpoint while retaining the global endpoint', () => {
    const minimax = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')

    expect(minimax?.baseUrl).toBe('https://api.minimaxi.com/anthropic')
    expect(minimax?.regionalEndpoints).toEqual([
      { region: 'cn_zh', baseUrl: 'https://api.minimaxi.com/anthropic' },
      { region: 'global_en', baseUrl: 'https://api.minimax.io/anthropic' },
    ])
  })

  it('matches the MiniMax preset for either regional endpoint', () => {
    const minimax = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')

    expect(minimax && presetMatchesBaseUrl(minimax, 'https://api.minimax.io/anthropic')).toBe(true)
    expect(minimax && presetMatchesBaseUrl(minimax, 'https://api.minimaxi.com/anthropic')).toBe(true)
  })

  it('defaults Zhipu GLM to China while retaining its official global endpoint', () => {
    const zhipu = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'zhipuglm')

    expect(zhipu?.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(zhipu?.regionalEndpoints).toEqual([
      { region: 'cn_zh', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      { region: 'global_en', baseUrl: 'https://api.z.ai/api/anthropic' },
    ])
    expect(zhipu && presetMatchesBaseUrl(zhipu, ' HTTPS://API.Z.AI/api/anthropic/ ')).toBe(true)
  })

  it('keeps Kimi Code on its only official Anthropic-compatible endpoint', () => {
    const kimi = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')

    expect(kimi?.baseUrl).toBe('https://api.kimi.com/coding/')
    expect(kimi?.regionalEndpoints).toBeUndefined()
  })

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
    expect(selectableIds).toContain('jiekouai')
    expect(selectableIds).toContain('custom')
  })

  // Both gateways mount the Anthropic protocol on the bare host; a /v1 or
  // /anthropic suffix here would double up with the path Claude Code appends.
  // Keep runtime roots resolvable even after the sponsor chips are retired.
  it('keeps retired sponsored gateways resolvable at Anthropic-compatible roots', () => {
    const fennoai = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'fennoai')
    const qiniuai = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'qiniuai')

    expect(fennoai?.deprecated).toBe(true)
    expect(fennoai?.baseUrl).toBe('https://api.fenno.ai')
    expect(fennoai && presetMatchesBaseUrl(fennoai, ' HTTPS://API.Fenno.AI/ ')).toBe(true)
    expect(qiniuai?.deprecated).toBe(true)
    expect(qiniuai?.baseUrl).toBe('https://api.qnaigc.com')
    expect(qiniuai && presetMatchesBaseUrl(qiniuai, ' HTTPS://API.QNAIGC.COM/ ')).toBe(true)
  })

  it('hides the sponsored featured row while keeping 接口AI selectable without promo', () => {
    const featuredIds = BUNDLED_PROVIDER_PRESETS
      .filter((preset) => preset.featured && !preset.deprecated)
      .map((p) => p.id)
    expect(featuredIds).toEqual([])

    for (const id of ['teamorouter', 'xuanshuapi', 'fennoai', 'qiniuai']) {
      const preset = BUNDLED_PROVIDER_PRESETS.find((candidate) => candidate.id === id)
      expect(preset?.deprecated).toBe(true)
      expect(preset?.apiKeyUrl).toBeUndefined()
      expect(preset?.promoText).toBeUndefined()
      expect(preset?.featured).toBeUndefined()
    }

    const jiekouai = BUNDLED_PROVIDER_PRESETS.find((preset) => preset.id === 'jiekouai')
    expect(jiekouai?.deprecated).toBeUndefined()
    expect(jiekouai?.apiKeyUrl).toBeUndefined()
    expect(jiekouai?.promoText).toBeUndefined()
    expect(jiekouai?.featured).toBeUndefined()

    const selectableIds = selectableProviderPresets(BUNDLED_PROVIDER_PRESETS).map((p) => p.id)
    expect(selectableIds).toContain('jiekouai')
    expect(selectableIds).not.toContain('teamorouter')
    expect(selectableIds).not.toContain('xuanshuapi')
    expect(selectableIds).not.toContain('fennoai')
    expect(selectableIds).not.toContain('qiniuai')
  })

  it('does not bundle the removed TeamoRouter preset', () => {
    expect(BUNDLED_PROVIDER_PRESETS.some((preset) => preset.id === 'teamorouter')).toBe(false)
  })
})
