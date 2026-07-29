import { describe, expect, it } from 'vitest'
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
})
