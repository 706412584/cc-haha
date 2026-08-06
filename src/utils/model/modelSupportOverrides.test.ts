import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const

describe('third-party model capability overrides', () => {
  let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map(key => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>
    process.env.ANTHROPIC_API_KEY = 'third-party-key'
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,xhigh_effort,max_effort'
  })

  afterEach(() => {
    for (const key of ENV_KEYS) restoreEnv(key, originalEnv[key])
  })

  test('ignores only 1M context markers when matching pinned provider models', () => {
    const cases = [
      ['deepseek-v4-flash', 'deepseek-v4-flash[1m]'],
      ['k3', 'k3[1m]'],
      ['MiniMax-M3', 'MiniMax-M3[1m]'],
      ['glm-5.2', 'glm-5.2:1m'],
      ['vendor/future-model', 'vendor/future-model[1m]'],
    ] as const

    for (const [runtimeModel, pinnedModel] of cases) {
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = pinnedModel

      expect(get3PModelCapabilityOverride(runtimeModel, 'thinking')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'effort')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'xhigh_effort')).toBe(true)
      expect(get3PModelCapabilityOverride(runtimeModel, 'max_effort')).toBe(true)
    }
  })

  test('does not collapse distinct provider namespaces while removing 1M markers', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'provider-a/shared-model[1m]'

    expect(get3PModelCapabilityOverride('provider-a/shared-model', 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride('provider-b/shared-model', 'effort')).toBeUndefined()
  })

  test('prefers ANTHROPIC_MODEL capabilities over a same-id tier pin', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5'
    process.env.ANTHROPIC_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,effort,adaptive_thinking,max_effort'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'none'

    expect(get3PModelCapabilityOverride('claude-sonnet-5', 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride('claude-sonnet-5', 'max_effort')).toBe(true)
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
