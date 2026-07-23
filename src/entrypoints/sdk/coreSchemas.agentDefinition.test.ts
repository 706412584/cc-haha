import { describe, expect, test } from 'bun:test'
import { AgentDefinitionSchema } from './coreSchemas.js'

describe('AgentDefinitionSchema effort', () => {
  test('accepts every named effort level including xhigh', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        AgentDefinitionSchema().safeParse({
          description: 'Review changes',
          prompt: 'Review the implementation.',
          effort,
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown effort values', () => {
    expect(
      AgentDefinitionSchema().safeParse({
        description: 'Review changes',
        prompt: 'Review the implementation.',
        effort: 'extreme',
      }).success,
    ).toBe(false)
  })
})

describe('AgentDefinitionSchema official fields', () => {
  test('preserves hooks, worktree isolation, and color', () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command' as const, command: 'echo checked' }],
        },
      ],
    }
    const result = AgentDefinitionSchema().safeParse({
      description: 'Review changes',
      prompt: 'Review the implementation.',
      hooks,
      isolation: 'worktree',
      color: 'purple',
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toMatchObject({
      hooks,
      isolation: 'worktree',
      color: 'purple',
    })
  })

  test('rejects blank required values and a blank optional model', () => {
    for (const invalid of [
      { description: '   ', prompt: 'Review.' },
      { description: 'Review changes', prompt: '\t' },
      { description: 'Review changes', prompt: 'Review.', model: '  ' },
    ]) {
      expect(AgentDefinitionSchema().safeParse(invalid).success).toBe(false)
    }
  })

  test('trims string values at the SDK boundary', () => {
    const result = AgentDefinitionSchema().parse({
      description: '  Review changes  ',
      prompt: '  Review the implementation.  ',
      model: '  sonnet  ',
    })

    expect(result.description).toBe('Review changes')
    expect(result.prompt).toBe('Review the implementation.')
    expect(result.model).toBe('sonnet')
  })
})
