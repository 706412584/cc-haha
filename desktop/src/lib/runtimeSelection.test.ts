import { describe, expect, it } from 'vitest'
import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import { normalizeRuntimeSelection, resolveDefaultRuntimeSelection } from './runtimeSelection'

describe('runtime selection defaults', () => {
  it('omits effort for an official model that explicitly disables it', () => {
    const model = {
      id: 'claude-haiku-4-5',
      name: 'Haiku 4.5',
      description: 'Fast model',
      context: '200k',
      supportedReasoningEfforts: [],
    }

    expect(resolveDefaultRuntimeSelection(null, null, [], model, 'max')).toEqual({
      providerId: null,
      modelId: 'claude-haiku-4-5',
    })
  })

  it.each([
    [OPENAI_OFFICIAL_PROVIDER_ID, OPENAI_OFFICIAL_DEFAULT_MODEL_ID],
    [GROK_OFFICIAL_PROVIDER_ID, GROK_OFFICIAL_DEFAULT_MODEL_ID],
  ])('uses the built-in default model for %s', (providerId, modelId) => {
    expect(resolveDefaultRuntimeSelection(providerId, null, [], null, 'max')).toEqual({
      providerId,
      modelId,
      effortLevel: 'max',
    })
  })

  it('uses the Claude default model for an unrecognized provider without a model', () => {
    expect(resolveDefaultRuntimeSelection('custom-provider', null, [], null)).toEqual({
      providerId: 'custom-provider',
      modelId: OFFICIAL_DEFAULT_MODEL_ID,
    })
  })
})

describe('normalizeRuntimeSelection', () => {
  it.each([
    ['Claude Official', null],
    ['ChatGPT Official', 'openai-official'],
  ])('keeps xhigh for %s', (_name, providerId) => {
    const selection = {
      providerId,
      modelId: providerId ? 'gpt-5.6-sol' : 'claude-opus-4-8',
      effortLevel: 'xhigh' as const,
    }

    expect(normalizeRuntimeSelection(selection)).toBe(selection)
  })

  it('preserves xhigh for a Claude-compatible custom provider', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    })
  })

  it('does not apply vendor-specific aliases or denies to compatible providers', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'deepseek-provider',
      modelId: 'deepseek-v4-pro',
      effortLevel: 'medium',
    }, 'anthropic')).toEqual({
      providerId: 'deepseek-provider',
      modelId: 'deepseek-v4-pro',
      effortLevel: 'medium',
    })

    expect(normalizeRuntimeSelection({
      providerId: 'minimax-provider',
      modelId: 'MiniMax-M3[1m]',
      effortLevel: 'high',
    }, 'anthropic')).toEqual({
      providerId: 'minimax-provider',
      modelId: 'MiniMax-M3[1m]',
      effortLevel: 'high',
    })

    expect(normalizeRuntimeSelection({
      providerId: 'custom-provider',
      modelId: 'future-model',
      effortLevel: 'high',
    }, 'openai_responses')).toEqual({
      providerId: 'custom-provider',
      modelId: 'future-model',
      effortLevel: 'high',
    })
  })

  it('preserves unknown persisted selections until their provider protocol is available', () => {
    const selection = {
      providerId: 'custom-provider',
      modelId: 'relay-specific-model',
      effortLevel: 'high' as const,
    }

    expect(normalizeRuntimeSelection(selection)).toBe(selection)
  })

  it('uses the Grok model default when xhigh is unsupported', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-4.5',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-4.5',
      effortLevel: 'high',
    })
  })

  it('removes effort from a non-reasoning Grok model', () => {
    expect(normalizeRuntimeSelection({
      providerId: 'grok-official',
      modelId: 'grok-composer-2.5-fast',
      effortLevel: 'xhigh',
    })).toEqual({
      providerId: 'grok-official',
      modelId: 'grok-composer-2.5-fast',
    })
  })
})