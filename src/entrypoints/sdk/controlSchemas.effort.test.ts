import { describe, expect, test } from 'bun:test'
import { SDKControlGetSettingsResponseSchema } from './controlSchemas.js'

describe('SDKControlGetSettingsResponseSchema effort', () => {
  test('accepts every runtime named effort level including xhigh', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        SDKControlGetSettingsResponseSchema().safeParse({
          effective: {},
          sources: [],
          applied: {
            model: 'gpt-5.6-sol',
            effort,
          },
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown runtime effort values', () => {
    expect(
      SDKControlGetSettingsResponseSchema().safeParse({
        effective: {},
        sources: [],
        applied: {
          model: 'gpt-5.6-sol',
          effort: 'extreme',
        },
      }).success,
    ).toBe(false)
  })
})
