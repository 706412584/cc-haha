import { describe, expect, test } from 'bun:test'
import { AgentTool, inputSchema } from './AgentTool.js'

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

  test('completed results do not implicitly recommend reactivating the terminal agent', () => {
    const block = AgentTool.mapToolResultToToolResultBlockParam(
      {
        status: 'completed',
        prompt: 'Inspect the agent model selection path.',
        agentId: 'agent-terminal',
        agentType: 'worker',
        content: [{ type: 'text', text: 'Done.' }],
        totalToolUseCount: 1,
        totalDurationMs: 10,
        totalTokens: 20,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
          cache_creation: null,
        },
      },
      'toolu_agent',
    )

    expect(JSON.stringify(block)).not.toContain('use SendMessage')
    expect(JSON.stringify(block)).toContain('agentId: agent-terminal')
  })
})
