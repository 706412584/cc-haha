import { describe, expect, test } from 'bun:test'
import {
  createSystemStreamingFallbackMessage,
  streamingFallbackRetryFields,
} from '../messages.js'

describe('streamingFallbackRetryFields', () => {
  test('returns empty object for missing or empty meta', () => {
    expect(streamingFallbackRetryFields()).toEqual({})
    expect(streamingFallbackRetryFields(null)).toEqual({})
    expect(streamingFallbackRetryFields({})).toEqual({})
  })

  test('copies only finite numbers and non-empty errorMessage', () => {
    expect(
      streamingFallbackRetryFields({
        attempt: 2,
        maxRetries: 4,
        retryDelayMs: 150,
        errorMessage: 'stream disconnected',
      }),
    ).toEqual({
      attempt: 2,
      maxRetries: 4,
      retryDelayMs: 150,
      errorMessage: 'stream disconnected',
    })

    expect(
      streamingFallbackRetryFields({
        attempt: Number.NaN,
        maxRetries: Number.POSITIVE_INFINITY,
        retryDelayMs: undefined,
        errorMessage: '',
      } as Partial<{
        attempt: number
        maxRetries: number
        retryDelayMs: number
        errorMessage: string
      }>),
    ).toEqual({})
  })

  test('createSystemStreamingFallbackMessage attaches stream_retry meta', () => {
    const message = createSystemStreamingFallbackMessage('stream_retry', {
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 10,
      errorMessage: 'disconnected',
    })
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'stream_retry',
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 10,
      errorMessage: 'disconnected',
    })

    const bare = createSystemStreamingFallbackMessage('stream_error')
    expect(bare.cause).toBe('stream_error')
    expect('attempt' in bare).toBe(false)
  })
})
