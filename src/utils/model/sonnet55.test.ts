import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSimpleEnvInfo } from '../../constants/prompts.js'
import { clearOAuthTokenCache } from '../auth.js'
import { sanitizeModelName } from '../commitAttribution.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../context.js'
import {
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} from '../effort.js'
import { calculateCostFromTokens, getModelPricingString } from '../modelCost.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { resolveSideQueryThinkingConfig } from '../sideQuery.js'
import {
  modelRequiresThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  modelUsesBoundThinking,
} from '../thinking.js'
import { resolveModelCosts } from '../usageAccounting.js'
import { ALL_MODEL_CONFIGS } from './configs.js'
import {
  firstPartyNameToCanonical,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model.js'
import { getMaxSonnet46_1MOption, getSonnet46_1MOption } from './modelOptions.js'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CC_HAHA_SEND_DISABLED_THINKING',
] as const
let savedEnv: (string | undefined)[]
let temporaryHome: string

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  for (const key of envKeys) delete process.env[key]
  temporaryHome = mkdtempSync(join(tmpdir(), 'sonnet55-model-test-'))
  process.env.HOME = temporaryHome
  process.env.CLAUDE_CONFIG_DIR = join(temporaryHome, 'config')
  resetSettingsCache()
  clearOAuthTokenCache()
  clearCapabilityCache()
})

afterEach(() => {
  resetSettingsCache()
  clearOAuthTokenCache()
  clearCapabilityCache()
  rmSync(temporaryHome, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const SONNET_55_VARIANTS = [
  'claude-sonnet-5-5',
  'claude-sonnet-5-5[1m]',
  'us.anthropic.claude-sonnet-5-5',
  'anthropic.claude-sonnet-5-5',
]

describe('Sonnet 5.5 identity', () => {
  test('registers the official IDs without absorbing the Sonnet 5 it supersedes', () => {
    expect(ALL_MODEL_CONFIGS.sonnet55).toMatchObject({
      firstParty: 'claude-sonnet-5-5',
      vertex: 'claude-sonnet-5-5',
      foundry: 'claude-sonnet-5-5',
    })
    expect(ALL_MODEL_CONFIGS.sonnet55.bedrock).toMatch(/anthropic\.claude-sonnet-5-5$/)

    for (const model of SONNET_55_VARIANTS) {
      expect(firstPartyNameToCanonical(model)).toBe('claude-sonnet-5-5')
      expect(sanitizeModelName(model)).toBe('claude-sonnet-5-5')
    }
    // `claude-sonnet-5` is a prefix of `claude-sonnet-5-5`; each keeps its own identity.
    for (const model of ['claude-sonnet-5', 'anthropic.claude-sonnet-5']) {
      expect(firstPartyNameToCanonical(model)).toBe('claude-sonnet-5')
      expect(sanitizeModelName(model)).toBe('claude-sonnet-5')
    }
  })

  test('renders distinct public and marketing names', () => {
    expect(getPublicModelDisplayName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(getPublicModelDisplayName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M context)')
    expect(getMarketingNameForModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(getMarketingNameForModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (with 1M context)')
    expect(getPublicModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
  })

  test('tells the model its own name, ID and June 2026 knowledge cutoff', async () => {
    const info = await computeSimpleEnvInfo('claude-sonnet-5-5')
    expect(info).toContain(
      'You are powered by the model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.',
    )
    expect(info).toContain('Assistant knowledge cutoff is June 2026.')
  })
})

describe('Sonnet alias resolution', () => {
  test('resolves the sonnet alias to Sonnet 5.5 and keeps explicit pins untouched', () => {
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5-5')
    expect(parseUserSpecifiedModel('sonnet')).toBe('claude-sonnet-5-5')
    expect(parseUserSpecifiedModel('sonnet[1m]')).toBe('claude-sonnet-5-5[1m]')
    expect(parseUserSpecifiedModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(parseUserSpecifiedModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(renderDefaultModelSetting('opusplan')).toBe('Opus 5.5 in plan mode, else Sonnet 5.5')
  })

  test('keeps lag-safe third-party defaults and honors provider overrides', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-4-5-20250929')
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'provider-custom-sonnet'
    expect(parseUserSpecifiedModel('sonnet')).toBe('provider-custom-sonnet')
  })

  test('describes the alias with its actual resolved generation and price', () => {
    expect(getClaudeAiUserDefaultModelDescription()).toBe('Sonnet 5.5 · Best for everyday tasks')
    expect(getSonnet46_1MOption().description).toBe('Sonnet 5.5 for long sessions · $2/$10 per Mtok')
    expect(getMaxSonnet46_1MOption().description).toBe('Sonnet 5.5 with 1M context · $2/$10 per Mtok')

    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    expect(getSonnet46_1MOption().description).toBe('Sonnet 4.6 for long sessions')
  })
})

describe('Sonnet 5.5 runtime limits and thinking', () => {
  test('exposes the native 1M window and the 128K output limit', () => {
    for (const model of SONNET_55_VARIANTS) {
      expect(modelSupports1M(model)).toBe(true)
    }
    expect(getContextWindowForModel('claude-sonnet-5-5')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-sonnet-5-5[1m]')).toBe(1_000_000)
    expect(getModelMaxOutputTokens('claude-sonnet-5-5')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokens('claude-sonnet-5')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })

  test('always runs adaptive thinking because the API rejects thinking: disabled', () => {
    for (const model of SONNET_55_VARIANTS) {
      expect(modelSupportsThinking(model)).toBe(true)
      expect(modelSupportsAdaptiveThinking(model)).toBe(true)
      expect(modelRequiresThinking(model)).toBe(true)
    }
    expect(modelUsesBoundThinking('claude-sonnet-5-5')).toBe(false)
    // Sonnet 5 still accepts an explicit disable.
    expect(modelRequiresThinking('claude-sonnet-5')).toBe(false)
  })

  test('never lets a side query send disabled thinking to Sonnet 5.5', () => {
    expect(resolveSideQueryThinkingConfig(false, 1024, 'claude-sonnet-5-5')).toEqual({
      type: 'adaptive',
    })
    expect(resolveSideQueryThinkingConfig(undefined, 1024, 'claude-sonnet-5-5[1m]')).toEqual({
      type: 'adaptive',
    })
    expect(resolveSideQueryThinkingConfig(false, 1024, 'claude-sonnet-5')).toEqual({
      type: 'disabled',
    })
  })

  test('respects an explicit third-party capability opt-out', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.invalid'
    process.env.ANTHROPIC_API_KEY = 'fixture-key'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = ''
    clearCapabilityCache()
    expect(modelRequiresThinking('claude-sonnet-5-5')).toBe(false)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-5-5')).toBe(false)

    // A provider that declares the capabilities keeps the required adaptive mode.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,required_thinking,adaptive_thinking'
    clearCapabilityCache()
    expect(modelRequiresThinking('claude-sonnet-5-5')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-sonnet-5-5')).toBe(true)
  })

  test('defaults to medium effort while supporting every effort level', () => {
    expect(getDefaultEffortForModel('claude-sonnet-5-5')).toBe('medium')
    expect(getDefaultEffortForModel('claude-sonnet-5-5[1m]')).toBe('medium')
    expect(modelSupportsEffort('claude-sonnet-5-5')).toBe(true)
    expect(modelSupportsXHighEffort('claude-sonnet-5-5')).toBe(true)
    expect(modelSupportsMaxEffort('claude-sonnet-5-5')).toBe(true)
  })
})

describe('Sonnet 5.5 pricing', () => {
  test('uses the published $2/$10 pricing, $2.50 cache writes and $0.20 cached reads', () => {
    expect(getModelPricingString('claude-sonnet-5-5')).toBe('$2/$10 per Mtok')
    for (const model of SONNET_55_VARIANTS) {
      expect(
        calculateCostFromTokens(model, {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
        }),
      ).toBeCloseTo(14.7, 10)
    }
  })

  test('prices activity stats at the Sonnet 5.5 rate instead of the Sonnet 5 prefix rate', () => {
    const expected = {
      inputTokens: 2,
      outputTokens: 10,
      promptCacheWriteTokens: 2.5,
      promptCacheReadTokens: 0.2,
      webSearchRequests: 0.01,
    }
    for (const model of ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5-20260928']) {
      expect(resolveModelCosts(model)).toEqual(expected)
    }
  })
})
