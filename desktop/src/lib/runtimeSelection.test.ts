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
import { resolveDefaultRuntimeSelection } from './runtimeSelection'

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
