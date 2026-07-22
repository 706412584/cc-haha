import { describe, expect, test } from 'bun:test'
import { inputSchema } from './AgentTool.js'

describe('AgentTool model schema', () => {
  test('accepts the official fable model alias', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'fable',
      }).success,
    ).toBe(true)
  })

  test('continues to reject unsupported per-call model values', () => {
    expect(
      inputSchema().safeParse({
        description: 'Review model routing',
        prompt: 'Inspect the agent model selection path.',
        model: 'mythos',
      }).success,
    ).toBe(false)
  })
})
