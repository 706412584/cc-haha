import { describe, expect, test } from 'bun:test'
import { getCurrentUsage, tokenCountWithEstimation } from '../tokens.js'

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
})
