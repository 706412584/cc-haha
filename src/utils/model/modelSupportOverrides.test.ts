import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
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
    clearCapabilityCache()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) restoreEnv(key, originalEnv[key])
    clearCapabilityCache()
  })

  test('[1m] markers are NOT stripped by this version — match pinned model exactly', () => {
    // This fork's modelSupportOverrides.ts does not normalize [1m] markers
    // (upstream added that in a later commit past v0.5.2). The string match
    // is case-insensitive but marker-sensitive.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-flash[1m]'
    clearCapabilityCache()

    expect(get3PModelCapabilityOverride('deepseek-v4-flash[1m]', 'thinking')).toBe(true)
    expect(get3PModelCapabilityOverride('deepseek-v4-flash', 'thinking')).toBeUndefined()
  })
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
