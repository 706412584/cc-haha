import { describe, expect, test } from 'bun:test'
import { getSupportedEffortLevelsForModel } from '../../utils/effort.js'
import { ModelInfoSchema } from './coreSchemas.js'

describe('ModelInfoSchema effort capabilities', () => {
  test('accepts model-specific effort levels emitted by CLI initialization', () => {
    const cases = [
      {
        value: 'sonnet',
        model: 'claude-sonnet-4-6',
        expected: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'fable',
        model: 'claude-fable-5',
        expected: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ]

    for (const { value, model, expected } of cases) {
      const supportedEffortLevels = getSupportedEffortLevelsForModel(model)
      expect(supportedEffortLevels).toEqual(expected)
      expect(
        ModelInfoSchema().safeParse({
          value,
          displayName: value,
          description: `${value} model`,
          supportsEffort: true,
          supportedEffortLevels,
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown effort capabilities', () => {
    expect(
      ModelInfoSchema().safeParse({
        value: 'fable',
        displayName: 'Fable',
        description: 'Most capable for complex agent tasks',
        supportsEffort: true,
        supportedEffortLevels: ['extreme'],
      }).success,
    ).toBe(false)
  })
})
