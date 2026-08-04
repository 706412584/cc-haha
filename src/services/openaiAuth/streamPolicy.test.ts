import { describe, expect, test } from 'bun:test'
import {
  OPENAI_CODEX_STREAM_MARKER_HEADER,
  canRetryOpenAICodexStreamWithBufferedContent,
  resolveOpenAICodexFirstTokenTimeoutMs,
} from './streamPolicy.js'

describe('resolveOpenAICodexFirstTokenTimeoutMs', () => {
  test('does not change third-party stream timeouts', () => {
    expect(resolveOpenAICodexFirstTokenTimeoutMs(
      new Response(null),
      120_000,
    )).toBe(120_000)
  })

  test('gives OpenAI OAuth reasoning a five-minute minimum', () => {
    const response = new Response(null, {
      headers: { [OPENAI_CODEX_STREAM_MARKER_HEADER]: '1' },
    })

    expect(resolveOpenAICodexFirstTokenTimeoutMs(response, 120_000)).toBe(300_000)
    expect(resolveOpenAICodexFirstTokenTimeoutMs(response, 600_000)).toBe(600_000)
  })

  test('supports a dedicated OpenAI OAuth override', () => {
    const response = new Response(null, {
      headers: { [OPENAI_CODEX_STREAM_MARKER_HEADER]: '1' },
    })

    expect(resolveOpenAICodexFirstTokenTimeoutMs(
      response,
      120_000,
      '180000',
    )).toBe(180_000)
  })
})

describe('canRetryOpenAICodexStreamWithBufferedContent', () => {
  const oauthResponse = new Response(null, {
    headers: { [OPENAI_CODEX_STREAM_MARKER_HEADER]: '1' },
  })

  test('allows buffered OAuth reasoning to retry before tool side effects', () => {
    expect(canRetryOpenAICodexStreamWithBufferedContent(oauthResponse, false)).toBe(true)
    expect(canRetryOpenAICodexStreamWithBufferedContent(oauthResponse, true)).toBe(false)
  })

  test('does not expand retries for third-party streams', () => {
    expect(canRetryOpenAICodexStreamWithBufferedContent(new Response(null), false)).toBe(false)
  })
})
