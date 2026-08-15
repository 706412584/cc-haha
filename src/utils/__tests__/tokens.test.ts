import { describe, expect, test } from 'bun:test'
import {
  getCurrentUsage,
  getTokenCountFromUsage,
  tokenCountWithEstimation,
} from '../tokens.js'

describe('getCurrentUsage', () => {
  test('skips zero placeholder usage and returns the latest meaningful usage', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          model: 'gpt-5.5',
          content: [{ type: 'text', text: 'older' }],
          usage: {
            input_tokens: 123,
            output_tokens: 45,
            cache_creation_input_tokens: 6,
            cache_read_input_tokens: 7,
          },
        },
      },
      {
        type: 'assistant',
        message: {
          model: 'gpt-5.5',
          content: [{ type: 'text', text: 'placeholder' }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ] as const

    expect(getCurrentUsage(messages as never)).toEqual({
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 7,
    })
  })

  test('skips output-only relay usage and keeps the previous prompt anchor', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          model: 'relay-model',
          content: [{ type: 'text', text: 'trusted' }],
          usage: {
            input_tokens: 1_000,
            output_tokens: 100,
          },
        },
      },
      {
        type: 'assistant',
        message: {
          model: 'relay-model',
          content: [{ type: 'text', text: 'partial' }],
          usage: {
            input_tokens: 0,
            output_tokens: 20,
          },
        },
      },
    ] as const

    expect(getCurrentUsage(messages as never)).toMatchObject({
      input_tokens: 1_000,
      output_tokens: 100,
    })
  })
})

describe('tokenCountWithEstimation', () => {
  const realUsage = {
    input_tokens: 200_000,
    output_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 40_000,
  }
  const zeroUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const assistant = (text: string, usage: object) => ({
    type: 'assistant',
    message: {
      model: 'k3-256k',
      content: [{ type: 'text', text }],
      usage,
    },
  })

  test('anchors on the last non-placeholder usage, skipping all-zero usage (#1162)', () => {
    const messages = [
      assistant('real answer', realUsage),
      assistant('tail after compaction placeholder', zeroUsage),
    ] as never

    // 241,000 from the real anchor, plus a rough estimate of the skipped tail.
    // Before the fix this anchored on the all-zero usage and returned ~0.
    expect(tokenCountWithEstimation(messages)).toBeGreaterThanOrEqual(241_000)
  })

  test('falls back to full estimation when only placeholder usage exists', () => {
    const messages = [
      { type: 'user', message: { content: 'x'.repeat(400_000) } },
      assistant('tail', zeroUsage),
    ] as never

    // A ~100K-token conversation must not read as empty just because a proxy
    // emitted an all-zero usage object on the last assistant message.
    expect(tokenCountWithEstimation(messages)).toBeGreaterThan(50_000)
  })

  test('does not let output-only relay usage discard the previous context anchor', () => {
    const messages = [
      assistant('trusted response', realUsage),
      { type: 'user', message: { content: 'next question' } },
      assistant('partial relay response', {
        input_tokens: 0,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ] as never

    expect(tokenCountWithEstimation(messages)).toBeGreaterThanOrEqual(241_000)
  })

  test('does not use invalid relay usage as a context anchor', () => {
    const messages = [
      assistant('trusted response', realUsage),
      assistant('invalid relay response', {
        input_tokens: '200000',
        output_tokens: -10,
        cache_creation_input_tokens: Number.NaN,
        cache_read_input_tokens: 0,
      }),
    ] as never

    expect(tokenCountWithEstimation(messages)).toBeGreaterThanOrEqual(241_000)
  })

  test('estimates visible output when a relay only reports prompt usage', () => {
    const messages = [assistant('x'.repeat(400), {
      input_tokens: 1_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })] as never

    expect(tokenCountWithEstimation(messages)).toBeGreaterThan(1_000)
  })

  test('counts interleaved tool results without recounting assistant siblings', () => {
    const responseId = 'msg_parallel'
    const sibling = (content: object[], usage: object) => ({
      type: 'assistant',
      message: {
        id: responseId,
        model: 'gpt-5.6-terra',
        content,
        usage,
      },
    })
    const encryptedReasoning = {
      type: 'redacted_thinking',
      data: `cc-haha:openai-reasoning:v1:${JSON.stringify({
        summary: [],
        encrypted_content: 'x'.repeat(400_000),
      })}`,
    }
    const messages = [
      sibling([encryptedReasoning], zeroUsage),
      sibling(
        [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }],
        zeroUsage,
      ),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'r'.repeat(400),
            },
          ],
        },
      },
      sibling([encryptedReasoning], zeroUsage),
      sibling([{ type: 'text', text: 'done' }], {
        input_tokens: 2_000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 500,
      }),
      { type: 'user', message: { content: 'n'.repeat(40) } },
    ] as never

    expect(tokenCountWithEstimation(messages)).toBe(3_110)
  })
})

describe('getTokenCountFromUsage', () => {
  test('never concatenates strings or propagates invalid numeric usage', () => {
    expect(getTokenCountFromUsage({
      input_tokens: '120000',
      output_tokens: -5,
      cache_creation_input_tokens: Number.NaN,
      cache_read_input_tokens: Number.POSITIVE_INFINITY,
    } as never)).toBe(0)
  })
})
