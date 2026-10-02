import { describe, expect, it } from 'vitest'
import { OFFICIAL_DEFAULT_MODEL_ID, OFFICIAL_MODELS } from './modelCatalog'

describe('Claude official model catalog', () => {
  it('offers Opus 5.5 with its launch effort and context for OAuth selection', () => {
    expect(OFFICIAL_DEFAULT_MODEL_ID).toBe('claude-opus-5-5')
    expect(OFFICIAL_MODELS.find(model => model.id === 'claude-opus-5-5')).toMatchObject({
      name: 'Opus 5.5',
      context: '1m',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('offers Sonnet 5.5 with the Claude Code default effort and context for OAuth selection', () => {
    expect(OFFICIAL_MODELS.find(model => model.id === 'claude-sonnet-5-5')).toMatchObject({
      name: 'Sonnet 5.5',
      context: '1m',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('lists Sonnet 5.5 ahead of the Sonnet 5 it supersedes', () => {
    const ids = OFFICIAL_MODELS.map(model => model.id)
    expect(ids.indexOf('claude-sonnet-5-5')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('claude-sonnet-5-5')).toBeLessThan(ids.indexOf('claude-sonnet-5'))
  })

  it('keeps older explicit model selections available', () => {
    expect(OFFICIAL_MODELS.map(model => model.id)).toEqual(expect.arrayContaining([
      'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5',
    ]))
  })
})
