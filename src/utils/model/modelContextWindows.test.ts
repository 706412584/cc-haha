import { describe, expect, test } from 'bun:test'

import {
  getConfiguredOrBuiltInModelContextWindow,
  getModelContextWindowFromEnvValue,
} from './modelContextWindows.js'

describe('model context windows', () => {
  test('recognizes updated domestic coding model context windows', () => {
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-k2.7-code')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('kimi-k2.7-code-highspeed')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-5.2')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('glm-4.7')).toBe(200_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen/qwen3.6-27b')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3.6:27b')).toBe(262_144)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3.7-plus-2026-02-15')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3-coder-plus')).toBe(1_000_000)
    expect(getConfiguredOrBuiltInModelContextWindow('qwen3-coder-next')).toBe(262_144)
  })

  test('matches configured base model windows for Claude Code 1m aliases', () => {
    expect(getModelContextWindowFromEnvValue(
      'MiniMax-M3[1m]',
      JSON.stringify({ 'MiniMax-M3': 1_000_000 }),
    )).toBe(1_000_000)
    expect(getModelContextWindowFromEnvValue(
      'glm-5.2[1m]',
      JSON.stringify({ 'glm-5.2': 1_000_000 }),
    )).toBe(1_000_000)
  })
})
